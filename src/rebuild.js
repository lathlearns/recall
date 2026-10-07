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
 * @property {'existing'|'fixed'|'manual'} breaks  'manual': the user chooses where each batch ends, one at a time.
 * @property {number} batchSize
 * @property {number} [firstEnd]    Where the first batch ends, when cutting by hand. Defaults to batchSize messages.
 * @property {boolean} review       Pause after every batch for the user to read it. Always, when cutting by hand.
 * @property {boolean} [includeForeign] Also read messages hidden by something other than Recall.
 * @property {'keep'|'replace'} oldSummaries
 * @property {string} [note]       Guidance sent with every batch. Not remembered between rebuilds.
 *
 * @typedef {object} RebuildPlan
 * @property {number} from          First message rebuilt.
 * @property {number} to            Last message rebuilt.
 * @property {number[][]} batches   Each batch's messages, without message 0.
 * @property {import('./store.js').RecallSummary|null} basis  What the first batch revises.
 * @property {string} seed          The built-in's summary, when it stands in for a basis.
 * @property {boolean} usedExisting Whether the breaks came from existing summaries.
 * @property {boolean} manual       Cut by hand: `batches` holds only the first, and the rest are chosen in the pauses.
 * @property {number} firstEnd      Where the first batch ends, when cut by hand.
 * @property {boolean} includesZero Whether message 0 is read with every batch.
 * @property {number} foreign       Messages in range hidden by something other than Recall.
 * @property {boolean} includeForeign Whether those are being read.
 * @property {number} skipped       Batches dropped because nothing in them was readable.
 * @property {boolean} empty        Nothing at all to read; the rebuild cannot start.
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
 *   pendingNote?: string, cutShort: { wanted: number, reached: number }|null,
 * }|null}
 *
 * `cutShort` is set when a batch cut by hand did not fit in one request and so
 * stopped before where the user ended it — they chose that end, so they are told.
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
 * ST's own message types (`system_message_types`, ST 1.18), less `narrator`.
 *
 * Everything here is interface rather than story: help and welcome text, a
 * `/comment` note, the Assistant screen. Narrator lines from `/sys` are left off
 * deliberately — they are story text, written into the chat like any other
 * message. The presence of a type cannot stand in for this list: ordinary
 * messages carry one too on some screens (`assistant_message`).
 */
const HOST_SYSTEM_TYPES = new Set([
    'help', 'welcome', 'empty', 'generic', 'comment', 'slash_commands', 'formatting',
    'hotkeys', 'macros', 'welcome_prompt', 'assistant_note', 'assistant_message',
]);

/**
 * A message ST put in the chat for its own purposes, rather than one of the
 * chat's that someone hid. Never read, whatever is chosen.
 */
function isHostSystemMessage(message) {
    return HOST_SYSTEM_TYPES.has(message?.extra?.type);
}

/**
 * Whether a message would be read. Hidden by Recall counts as readable — that is
 * the whole point. Hidden by anything else is read only when the user said so:
 * by default it stays out, as it would from any other pass.
 */
function isReadable(index, owned, includeForeign) {
    const message = chat[index];
    if (!message) {
        return false;
    }
    if (message.is_system !== true || owned.has(index)) {
        return true;
    }
    return includeForeign && !isHostSystemMessage(message);
}

/** The messages from `lo` to `hi` that would be read, message 0 aside. */
function readableBetween(lo, hi, owned, includeForeign) {
    const indices = [];
    for (let i = Math.max(1, lo); i <= hi; i++) {
        if (isReadable(i, owned, includeForeign)) {
            indices.push(i);
        }
    }
    return indices;
}

/**
 * Whether the chat has any Recall summary. Without one, every hidden message was
 * hidden by something else — usually by hand while using the built-in Summarize —
 * so reading them is the sensible default rather than the exception.
 * @returns {boolean}
 */
export function hasOwnSummaries() {
    return getSummariesRaw().length > 0;
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

    const manual = options.breaks === 'manual';
    const breaks = options.breaks === 'existing' ? existingBreaks(from, to) : [];
    const usedExisting = options.breaks === 'existing' && breaks.length > 0;
    const size = Math.max(1, Math.floor(Number(options.batchSize) || 50));
    let firstEnd = to;

    const ranges = [];
    if (manual) {
        // Only the first is planned. Each one after it is chosen once the one
        // before it has been read, so there is nothing further to plan.
        const wanted = options.firstEnd == null ? from + size - 1 : Math.floor(Number(options.firstEnd));
        if (!Number.isFinite(wanted) || wanted < from) {
            throw new RecallError(`The first batch starts at message ${from}, so it has to end there or later.`, { kind: 'empty' });
        }
        firstEnd = Math.min(to, wanted);
        ranges.push([from, firstEnd]);
    } else if (usedExisting) {
        let lo = from;
        for (const cut of [...breaks, to]) {
            ranges.push([lo, cut]);
            lo = cut + 1;
        }
    } else {
        for (let lo = from; lo <= to; lo += size) {
            ranges.push([lo, Math.min(to, lo + size - 1)]);
        }
    }

    const owned = recallOwnedHides();
    const includeForeign = !!options.includeForeign;

    // Counted whatever is chosen, so the dialog can say how many there are
    // before the user decides.
    let foreign = 0;
    for (let i = Math.max(0, from); i <= to; i++) {
        const message = chat[i];
        if (message?.is_system === true && !owned.has(i) && !isHostSystemMessage(message)) {
            foreign++;
        }
    }

    const batches = [];
    let skipped = 0;
    for (const [lo, hi] of ranges) {
        const batch = readableBetween(lo, hi, owned, includeForeign);
        // A stretch with nothing readable needs no request of its own. Counted,
        // so the plan can say so rather than quietly showing fewer batches.
        if (batch.length) {
            batches.push(batch);
        } else {
            skipped++;
        }
    }

    // Every pass reads message 0, since it is never hidden; a rebuild matches,
    // so the scenario reaches every batch the way it reached every summary.
    const includesZero = isReadable(0, owned, includeForeign);

    // A first batch with nothing in it is the user's end being too early, not the
    // whole range being unreadable — so it is said that way, while something later is.
    if (manual && !batches.length && readableBetween(firstEnd + 1, to, owned, includeForeign).length) {
        throw new RecallError(
            `Every message from ${from} to ${firstEnd} is hidden, so the first batch would have nothing to read. End it later.`,
            { kind: 'empty' },
        );
    }

    // Not thrown: the dialog still needs the foreign count to offer the way out.
    const empty = !batches.length && !(from === 0 && includesZero);
    if (!batches.length && !empty) {
        batches.push([]);
    }

    return {
        from, to, batches, basis, seed, usedExisting, manual, firstEnd,
        includesZero, foreign, includeForeign, skipped, empty,
    };
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
    if (plan.empty) {
        throw new RecallError(`Every message from ${plan.from} to ${plan.to} is hidden, so there is nothing to read.`, { kind: 'empty' });
    }

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
        cutShort: null,
    };
    setRebuildLock(true);
    notify('change');

    await runQueue();
}

/**
 * The guidance the next batch is sent with. Two kinds, because a rebuild is one
 * job and also an iterative one: `options.note`, from the dialog, holds for every
 * batch, and `pendingNote`, typed during a pause, is for the next batch only.
 * Both go when both are set, labelled so neither reads as overriding the other.
 * @returns {string}
 */
function batchNote() {
    const whole = String(state.options.note ?? '').trim();
    const once = String(state.pendingNote ?? '').trim();
    if (whole && once) {
        return `For the whole rebuild: ${whole}\n\nFor this batch: ${once}`;
    }
    return whole || once;
}

/** The summary the next batch revises: the last one this rebuild wrote, else the plan's. */
function currentBasis() {
    return state.done[state.done.length - 1] ?? state.plan.basis;
}

// --- Cutting by hand ----------------------------------------------------------
//
// Each batch's end is chosen in the pause before it, so a batch's stretch is
// known from what was read rather than from a plan: one starts right after the
// last message the batch before it read.

/** The stretch the k-th finished batch covered: from where it started to the last message it read. */
function doneRange(k) {
    const lastRead = record => Math.max(...record.sourceIndices);
    return {
        from: k > 0 ? lastRead(state.done[k - 1]) + 1 : state.plan.from,
        to: lastRead(state.done[k]),
    };
}

function readableFrom(lo, hi) {
    return readableBetween(lo, Math.min(hi, state.plan.to), recallOwnedHides(), state.plan.includeForeign);
}

/**
 * Where a rebuild cut by hand stands, for its pause to offer: the batch just
 * written, which a redo can end elsewhere, and the next one, with an end to
 * suggest — the same size as the last. `next` is null once nothing readable is
 * left, which makes the batch under review the last.
 *
 * @returns {{
 *   current: { from: number, to: number }|null,
 *   next: { from: number, suggested: number, left: number }|null,
 *   to: number,
 * }|null} Null unless a rebuild cut by hand is in progress.
 */
export function manualPosition() {
    if (!state?.plan.manual) {
        return null;
    }
    const current = state.done.length ? doneRange(state.done.length - 1) : null;
    const from = current ? current.to + 1 : state.plan.from;
    const left = readableFrom(from, state.plan.to).length;
    const size = current ? current.to - current.from + 1 : state.plan.firstEnd - state.plan.from + 1;
    return {
        current,
        next: left ? { from, suggested: Math.min(state.plan.to, from + size - 1), left } : null,
        to: state.plan.to,
    };
}

/**
 * What is wrong with ending the next batch, or a redo of this one, at `end` —
 * or '' when nothing is.
 * @param {'next'|'redo'} which
 * @param {number|string} end
 * @returns {string}
 */
export function manualEndProblem(which, end) {
    const position = manualPosition();
    const from = which === 'redo' ? position?.current?.from : position?.next?.from;
    if (from == null) {
        return 'There is no batch to end.';
    }
    const value = Math.floor(Number(end));
    if (String(end ?? '').trim() === '' || !Number.isFinite(value)) {
        return 'Give a message number.';
    }
    if (value < from) {
        return `It starts at message ${from}, so it has to end there or later.`;
    }
    if (value > position.to) {
        return `The rebuild ends at message ${position.to}.`;
    }
    if (!readableFrom(from, value).length) {
        return `Every message from ${from} to ${value} is hidden, so there would be nothing to read.`;
    }
    return '';
}

/**
 * The size of the next batch, or of a redo of this one, if it ended at `end`:
 * how many messages it would read, about how many tokens those are, and where
 * it would stop if they will not all fit in one request.
 *
 * @param {'next'|'redo'} which
 * @param {number|string} end
 * @returns {Promise<{ problem: string, messages?: number, tokens?: number, stopsAt?: number|null }>}
 */
export async function measureManualBatch(which, end) {
    const problem = manualEndProblem(which, end);
    if (problem) {
        return { problem };
    }
    const position = manualPosition();
    const redo = which === 'redo';
    const indices = readableFrom(redo ? position.current.from : position.next.from, Math.floor(Number(end)));
    const basis = redo ? (state.done[state.done.length - 2] ?? state.plan.basis) : currentBasis();
    const seed = basis ? '' : state.plan.seed;
    const withZero = state.plan.includesZero ? [0, ...indices] : indices;

    const counts = await Promise.all(indices.map(countMessageTokens));
    const fits = await fitBatch(withZero, basis?.content ?? seed, batchNote());
    const keep = state.plan.includesZero ? fits - 1 : fits;

    return {
        problem: '',
        messages: indices.length,
        tokens: counts.reduce((a, b) => a + b, 0),
        stopsAt: keep < indices.length ? (indices[keep - 1] ?? null) : null,
    };
}

async function runQueue() {
    while (state && state.queue.length) {
        if (state.stopRequested) {
            return endRebuild(false);
        }

        state.status = 'running';
        state.error = '';
        state.cutShort = null;
        notify('change');

        const basis = currentBasis();
        const seed = basis ? '' : state.plan.seed;
        const batch = state.queue[0];
        const withZero = state.plan.includesZero ? [0, ...batch] : batch;

        try {
            // Cut where it stops fitting; the rest goes first in the next batch.
            const fits = await fitBatch(withZero, basis?.content ?? seed, batchNote());
            const minimum = state.plan.includesZero ? 2 : 1;
            if (fits < Math.min(minimum, withZero.length)) {
                throw new RecallError(
                    `Message ${batch[0]} does not fit in a request on top of the summary so far. `
                    + 'Raise the context size or lower the response reserve, then try again.',
                    { kind: 'overflow' },
                );
            }
            const keep = state.plan.includesZero ? fits - 1 : fits;
            if (keep < batch.length && state.plan.manual) {
                // The rest is not queued: the next batch starts after what was
                // read anyway, and where it ends is the user's to choose again.
                state.queue.splice(0, 1, batch.slice(0, keep));
                state.cutShort = { wanted: batch[batch.length - 1], reached: batch[keep - 1] };
            } else if (keep < batch.length) {
                state.queue.splice(0, 1, batch.slice(0, keep), batch.slice(keep));
            }

            const step = state.done.length + 1;
            const record = await summarizeBatch({
                indices: state.plan.includesZero ? [0, ...state.queue[0]] : state.queue[0],
                basis,
                seed,
                rebuildId: state.id,
                step,
                // Unknown when cut by hand: the user has not chosen the rest yet.
                steps: state.plan.manual ? undefined : state.done.length + state.queue.length,
                steeringNote: batchNote(),
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

        if (state.options.review || state.plan.manual) {
            state.status = 'review';
            notify('review');
            return;
        }
    }

    if (state) {
        await endRebuild(true);
    }
}

/**
 * Keep going after a review, or try a failed batch again.
 *
 * A note given here is for the next batch only. With none, a retry keeps the
 * note the failed batch was given — it is the same batch, asked again — and
 * moving on after a review has none, since the last one was used.
 *
 * Cut by hand, `end` is where the next batch ends; without one it ends where
 * manualPosition suggests. With nothing readable left, keeping going finishes.
 * @param {string} [steeringNote]
 * @param {number} [end]
 */
export async function continueRebuild(steeringNote = '', end) {
    if (!state || state.status === 'running') {
        return;
    }
    if (state.plan.manual && state.status === 'review') {
        const next = manualPosition().next;
        if (!next) {
            return endRebuild(true);
        }
        const until = end ?? next.suggested;
        const problem = manualEndProblem('next', until);
        if (problem) {
            throw new RecallError(problem, { kind: 'empty' });
        }
        state.queue.push(readableFrom(next.from, Math.floor(Number(until))));
    }
    const note = String(steeringNote ?? '').trim();
    if (note) {
        state.pendingNote = note;
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
 *
 * Cut by hand, `end` can move where it ends — "that went too far" is the
 * likeliest reason to redo one. Without it, the same messages are read again.
 * @param {string} [steeringNote]
 * @param {number} [end]
 */
export async function redoRebuildBatch(steeringNote = '', end) {
    if (!state || state.status !== 'review' || !state.done.length) {
        return;
    }

    let indices = null;
    if (state.plan.manual && end != null) {
        const problem = manualEndProblem('redo', end);
        if (problem) {
            throw new RecallError(problem, { kind: 'empty' });
        }
        indices = readableFrom(doneRange(state.done.length - 1).from, Math.floor(Number(end)));
    }

    const last = state.done.pop();
    state.queue.unshift(indices ?? last.sourceIndices.filter(i => i !== 0 || !state.plan.includesZero));
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
