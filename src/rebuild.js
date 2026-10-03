/**
 * Recall — rebuilding a chat's summaries from a chosen point, in batches.
 *
 * For a long chat whose summary went bad somewhere along the way. By hand that
 * means unhiding everything, hiding all but the first stretch, summarising,
 * unhiding the next stretch, and so on for every summary the chat ever had.
 *
 * None of that hiding is needed. Hiding is only how Summarize now chooses what to
 * read; a batch here is given its messages by index, the way a regenerate is, and
 * each one revises the summary the batch before it wrote. Visibility is fixed
 * once, at the very end, and only if the rebuild got there — so stopping or
 * failing halfway leaves the chat exactly as it was, with the batches that did
 * finish kept in the archive.
 *
 * The rebuild lives in memory. A reload mid-rebuild loses the controller but not
 * the work: every finished batch is an ordinary saved summary, and starting a new
 * rebuild after the last of them carries on where it stopped.
 */

import { chat, getCurrentChatId } from '../../../../../script.js';
import { getSettings } from './settings.js';
import {
    getSummariesRaw,
    getSummaryById,
    getActiveSummary,
    setActiveSummary,
    deleteSummary,
    persist,
} from './store.js';
import {
    summarizeBatch,
    fitBatch,
    setRebuildLock,
    countMessageTokens,
    measureRequestOverhead,
    cancelRun,
    getActiveRun,
    RecallError,
} from './generate.js';
import { syncToSummary } from './coverage.js';
import { getFallbackSummary } from './legacy.js';
import { countTokens } from './tokens.js';
import { uuid } from './util.js';

/**
 * @typedef {{ kind: 'beginning' } | { kind: 'summary', id: string } | { kind: 'message', index: number }} RebuildStart
 *
 * @typedef {object} RebuildOptions
 * @property {RebuildStart} start
 * @property {'active'|'latest'} end
 * @property {'existing'|'fixed'} breaks
 * @property {number} batchSize
 * @property {boolean} review       Pause after every batch for the user to read it.
 * @property {'keep'|'replace'} oldSummaries
 *
 * @typedef {object} RebuildPlan
 * @property {number} from          First message rebuilt.
 * @property {number} to            Last message rebuilt.
 * @property {number[][]} batches   Each batch's messages, without message 0.
 * @property {import('./store.js').RecallSummary|null} basis  What the first batch revises.
 * @property {string} seed          The built-in's summary, when it stands in for a basis.
 * @property {boolean} usedExisting Whether the breaks came from existing summaries.
 * @property {boolean} includesZero Whether message 0 is read with every batch.
 */

/**
 * The rebuild in progress, or null.
 *
 * `status` is what the bar shows: `running` while a batch generates, `review`
 * while one waits to be read, `failed` when one did not finish and can be retried.
 *
 * @type {{
 *   id: string, chatId: string, options: RebuildOptions, plan: RebuildPlan,
 *   queue: number[][], done: import('./store.js').RecallSummary[],
 *   status: 'running'|'review'|'failed', error: string, stopRequested: boolean,
 *   pendingNote?: string,
 * }|null}
 */
let state = null;

/** @type {Set<(event: { type: string, message?: string }) => void>} */
const listeners = new Set();

/**
 * @param {(event: { type: 'change'|'review'|'finished'|'stopped'|'failed', message?: string }) => void} listener
 * @returns {() => void}
 */
export function onRebuildChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function notify(type, message = '') {
    for (const listener of listeners) {
        try {
            listener({ type, message });
        } catch (error) {
            console.error('[Recall] A rebuild listener failed', error);
        }
    }
}

/** @returns {typeof state} The rebuild for the chat now open, if there is one. */
export function getRebuild() {
    return state;
}

/**
 * Drops a rebuild whose chat is no longer open. Called on every chat change: its
 * batches are already saved to that chat, and there is nothing left here that
 * could continue it safely from another one.
 */
export function abandonRebuildIfElsewhere() {
    if (state && state.chatId !== getCurrentChatId()) {
        if (getActiveRun()?.kind === 'rebuild') {
            cancelRun();
        }
        state = null;
        setRebuildLock(false);
        notify('change');
    }
}

// --- Planning ---------------------------------------------------------------

/** Every index some Recall summary hid. Those are read; anything else hidden is not. */
function recallOwnedHides() {
    const owned = new Set();
    for (const summary of getSummariesRaw()) {
        for (const index of summary.hiddenIndices ?? []) {
            owned.add(index);
        }
    }
    return owned;
}

/**
 * Whether a message would be read. Hidden by Recall counts as readable — that is
 * the whole point — but a message the user hid by hand stays out, as it would
 * from any other pass.
 */
function isReadable(index, owned) {
    const message = chat[index];
    return !!message && (message.is_system !== true || owned.has(index));
}

/**
 * Summaries a rebuild can start after: any that is not stale. Redos included —
 * the redo is often the one worth trusting. Oldest coverage first, which is the
 * order the dialog lists them in.
 *
 * @returns {import('./store.js').RecallSummary[]}
 */
export function startableSummaries() {
    return getSummariesRaw()
        .filter(s => !s.stale && s.coversTo < chat.length)
        .sort((a, b) => a.coversTo - b.coversTo || a.createdAt - b.createdAt);
}

/**
 * The break points existing summaries already chose, within a range.
 *
 * The user's own summaries, when there are any: they ended where the user
 * decided a stretch of story ended. A previous rebuild's batches only stand in
 * when nothing else exists, or two rebuilds' breaks would interleave.
 *
 * @param {number} from
 * @param {number} to
 * @returns {number[]}
 */
function existingBreaks(from, to) {
    const usable = getSummariesRaw().filter(s => !s.stale && !s.regeneratedFrom);
    const own = usable.filter(s => !s.rebuildId);
    const source = own.length ? own : usable;

    return [...new Set(source.map(s => s.coversTo))]
        .filter(c => c >= from && c < to)
        .sort((a, b) => a - b);
}

/**
 * Turns the dialog's choices into batches.
 * @param {RebuildOptions} options
 * @returns {RebuildPlan}
 */
export function planRebuild(options) {
    if (!chat.length) {
        throw new RecallError('The chat is empty — there is nothing to rebuild.', { kind: 'empty' });
    }

    const last = chat.length - 1;
    let from = 0;
    let basis = null;
    let seed = '';

    if (options.start.kind === 'summary') {
        basis = getSummaryById(options.start.id);
        if (!basis) {
            throw new RecallError('That summary no longer exists.', { kind: 'missing' });
        }
        from = basis.coversTo + 1;
    } else if (options.start.kind === 'message') {
        from = Math.max(0, Math.min(last, Math.floor(Number(options.start.index) || 0)));
        // Nothing covers what came before, unless the built-in's summary does —
        // which is exactly the case it is kept for.
        if (from > 0) {
            seed = getFallbackSummary();
        }
    }

    const active = getActiveSummary();
    const to = options.end === 'active' && active ? Math.min(active.coversTo, last) : last;

    if (from > to) {
        throw new RecallError(`There is nothing to rebuild: it would start at message ${from} and end at ${to}.`, { kind: 'empty' });
    }

    const breaks = options.breaks === 'existing' ? existingBreaks(from, to) : [];
    const usedExisting = options.breaks === 'existing' && breaks.length > 0;

    const ranges = [];
    if (usedExisting) {
        let lo = from;
        for (const cut of [...breaks, to]) {
            ranges.push([lo, cut]);
            lo = cut + 1;
        }
    } else {
        const size = Math.max(1, Math.floor(Number(options.batchSize) || 50));
        for (let lo = from; lo <= to; lo += size) {
            ranges.push([lo, Math.min(to, lo + size - 1)]);
        }
    }

    const owned = recallOwnedHides();
    const batches = [];
    for (const [lo, hi] of ranges) {
        const batch = [];
        for (let i = Math.max(1, lo); i <= hi; i++) {
            if (isReadable(i, owned)) {
                batch.push(i);
            }
        }
        // A stretch the user hid entirely has nothing to read. Skipping it is
        // what any other pass would do; it just needs no request of its own.
        if (batch.length) {
            batches.push(batch);
        }
    }

    // Every pass reads message 0, since it is never hidden; a rebuild matches,
    // so the scenario reaches every batch the way it reached every summary.
    const includesZero = isReadable(0, owned);

    if (!batches.length && !(from === 0 && includesZero)) {
        throw new RecallError(`Every message from ${from} to ${to} is hidden by hand, so there is nothing to read.`, { kind: 'empty' });
    }
    if (!batches.length) {
        batches.push([]);
    }

    return { from, to, batches, basis, seed, usedExisting, includesZero };
}

/**
 * What a rebuild will cost, as far as it can be known in advance.
 *
 * The messages, the prompt and the reference material are counted exactly. The
 * summary each batch carries into the next cannot be: it has not been written.
 * It is guessed from the current summary's size, growing evenly from where the
 * rebuild starts — and the result is labelled as resting on that guess.
 *
 * @param {RebuildPlan} plan
 * @returns {Promise<{ batches: number, messages: number, sent: number, written: number, guessedFrom: number }>}
 */
export async function estimateRebuild(plan) {
    const overhead = await measureRequestOverhead();
    const zero = plan.includesZero ? await countMessageTokens(0) : 0;

    let messages = 0;
    for (const batch of plan.batches) {
        const counts = await Promise.all(batch.map(countMessageTokens));
        messages += counts.reduce((a, b) => a + b, 0) + zero;
    }

    const startSize = plan.basis ? await countTokens(plan.basis.content) : await countTokens(plan.seed);
    const guessedFrom = await countTokens(getActiveSummary()?.content ?? plan.basis?.content ?? '');
    const endSize = Math.max(startSize, guessedFrom);

    const n = plan.batches.length;
    let carried = 0;
    let written = 0;
    for (let k = 0; k < n; k++) {
        carried += startSize + ((endSize - startSize) * k) / n;
        written += startSize + ((endSize - startSize) * (k + 1)) / n;
    }

    return {
        batches: n,
        messages,
        sent: Math.round(n * (overhead.system + overhead.reference) + messages + carried),
        written: Math.round(written),
        guessedFrom,
    };
}

// --- Running ----------------------------------------------------------------

/**
 * Starts a rebuild. Returns once it pauses, fails or finishes; the bar follows
 * along through onRebuildChange either way.
 * @param {RebuildOptions} options
 */
export async function startRebuild(options) {
    if (state) {
        throw new RecallError('A rebuild is already in progress.', { kind: 'busy' });
    }

    const plan = planRebuild(options);

    // Carrying on from a batch of an earlier rebuild continues that rebuild, so
    // the archive keeps showing it as one.
    const id = plan.basis?.rebuildId ?? uuid();

    state = {
        id,
        chatId: getCurrentChatId(),
        options,
        plan,
        queue: plan.batches.map(batch => [...batch]),
        done: [],
        status: 'running',
        error: '',
        stopRequested: false,
    };
    setRebuildLock(true);
    notify('change');

    await runQueue();
}

/** The summary the next batch revises: the last one this rebuild wrote, else the plan's. */
function currentBasis() {
    return state.done[state.done.length - 1] ?? state.plan.basis;
}

async function runQueue() {
    while (state && state.queue.length) {
        if (state.stopRequested) {
            return endRebuild(false);
        }

        state.status = 'running';
        state.error = '';
        notify('change');

        const basis = currentBasis();
        const seed = basis ? '' : state.plan.seed;
        const batch = state.queue[0];
        const withZero = state.plan.includesZero ? [0, ...batch] : batch;

        try {
            // Cut where it stops fitting; the rest goes first in the next batch.
            const fits = await fitBatch(withZero, basis?.content ?? seed, state.pendingNote ?? '');
            const minimum = state.plan.includesZero ? 2 : 1;
            if (fits < Math.min(minimum, withZero.length)) {
                throw new RecallError(
                    `Message ${batch[0]} does not fit in a request on top of the summary so far. `
                    + 'Raise the context size or lower the response reserve, then try again.',
                    { kind: 'overflow' },
                );
            }
            const keep = state.plan.includesZero ? fits - 1 : fits;
            if (keep < batch.length) {
                state.queue.splice(0, 1, batch.slice(0, keep), batch.slice(keep));
            }

            const step = state.done.length + 1;
            const record = await summarizeBatch({
                indices: state.plan.includesZero ? [0, ...state.queue[0]] : state.queue[0],
                basis,
                seed,
                rebuildId: state.id,
                step,
                steps: state.done.length + state.queue.length,
                steeringNote: state.pendingNote ?? '',
            });

            state.pendingNote = '';
            state.done.push(record);
            state.queue.shift();
        } catch (error) {
            if (!state) {
                return;
            }
            if (error instanceof RecallError && error.kind === 'cancelled') {
                return endRebuild(false);
            }
            state.status = 'failed';
            state.error = error instanceof RecallError ? error.message : String(error?.message ?? error);
            if (!(error instanceof RecallError)) {
                console.error('[Recall] A rebuild batch failed', error);
            }
            notify('failed', state.error);
            return;
        }

        if (state.stopRequested) {
            return endRebuild(false);
        }

        if (state.options.review) {
            state.status = 'review';
            notify('review');
            return;
        }
    }

    if (state) {
        await endRebuild(true);
    }
}

/** Keep going after a review, or try a failed batch again. */
export async function continueRebuild() {
    if (!state || state.status === 'running') {
        return;
    }
    if (!state.queue.length) {
        return endRebuild(true);
    }
    await runQueue();
}

/**
 * Throws away the batch just reviewed and writes it again, on the same basis.
 * Replaced rather than kept as a sibling: the user has read it and said no, and
 * a rebuild's group is meant to hold one chain, not every attempt at it.
 * @param {string} [steeringNote]
 */
export async function redoRebuildBatch(steeringNote = '') {
    if (!state || state.status !== 'review') {
        return;
    }
    const last = state.done.pop();
    if (!last) {
        return;
    }

    state.queue.unshift(last.sourceIndices.filter(i => i !== 0 || !state.plan.includesZero));
    deleteSummary(last.id);
    state.pendingNote = String(steeringNote ?? '').trim();

    await runQueue();
}

/**
 * Stops. Mid-batch, the request is cancelled where the connection allows it and
 * otherwise allowed to land and kept; in a pause, it ends straight away.
 */
export async function stopRebuild() {
    if (!state) {
        return;
    }
    if (state.status === 'running') {
        state.stopRequested = true;
        cancelRun();
        notify('change');
        return;
    }
    await endRebuild(false);
}

/**
 * Ends the rebuild.
 *
 * Only a finished rebuild changes anything outside its own batches: the last of
 * them becomes active, every Recall-hidden message it covers is handed to it,
 * and the chat is synced to it. A stopped one changes nothing — the summary it
 * got to covers less than the one already active, and making it active would
 * unhide a stretch of chat in the middle of a story.
 *
 * @param {boolean} complete
 */
async function endRebuild(complete) {
    if (!state) {
        return;
    }

    const { done, options, plan } = state;
    const final = done[done.length - 1] ?? null;
    let message;

    if (complete && final) {
        // One summary owns a hidden range. Everything Recall hid up to where the
        // new chain ends belongs to its last link now, so a later delete or sync
        // of the old summaries cannot pull messages back into view.
        for (const other of getSummariesRaw()) {
            if (other.id === final.id) {
                continue;
            }
            const moving = (other.hiddenIndices ?? []).filter(i => i <= final.coversTo);
            if (moving.length) {
                final.hiddenIndices = [...new Set([...(final.hiddenIndices ?? []), ...moving])].sort((a, b) => a - b);
                other.hiddenIndices = other.hiddenIndices.filter(i => i > final.coversTo);
            }
        }

        setActiveSummary(final.id);
        await syncToSummary(final);

        let removed = 0;
        if (options.oldSummaries === 'replace') {
            const doomed = getSummariesRaw().filter(s =>
                s.rebuildId !== final.rebuildId
                && s.id !== plan.basis?.id
                && s.coversTo >= plan.from
                && s.coversTo <= plan.to);
            for (const summary of doomed) {
                deleteSummary(summary.id);
                removed++;
            }
            // deleteSummary may have moved the pointer off a deleted active one.
            setActiveSummary(final.id);
        }

        await persist({ immediate: true });

        message = `Rebuilt messages ${plan.from}–${final.coversTo} in ${done.length} batch${done.length === 1 ? '' : 'es'}. `
            + 'The last one is active and the chat is synced to it.'
            + (removed ? ` ${removed} old summar${removed === 1 ? 'y was' : 'ies were'} replaced.` : '');
    } else {
        message = done.length
            ? `Rebuild stopped after ${done.length} batch${done.length === 1 ? '' : 'es'}. They are kept in the archive; `
                + 'nothing else changed. To carry on, start a rebuild after the last of them.'
            : 'Rebuild stopped. Nothing was saved or changed.';
    }

    state = null;
    setRebuildLock(false);
    notify(complete ? 'finished' : 'stopped', message);
}
