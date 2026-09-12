/**
 * Recall — buffer construction, token budgeting, guards, generation, validation.
 *
 * The central rule everything here follows: Recall summarises everything currently
 * visible in the chat, and nothing else. Visibility is the only control surface.
 * There is no start index, no anchor arithmetic, and no range — messages already
 * covered by a previous summary are hidden, and are therefore excluded by the same
 * rule that excludes everything else hidden.
 */

import {
    chat,
    activateSendButtons,
    deactivateSendButtons,
    generateRawData,
    extractMessageFromData,
    is_send_press,
    main_api,
    streamingProcessor,
    getCurrentChatId,
    this_chid,
    substituteParams,
} from '../../../../../script.js';
import { is_group_generating, selected_group } from '../../../../group-chats.js';
import { getStringHash } from '../../../../utils.js';
import { getTokenCountAsync } from '../../../../tokenizers.js';
import { removeReasoningFromString, extractReasoningFromData } from '../../../../reasoning.js';
import { getFallbackSummary } from './legacy.js';
import { buildContextBlocks } from './context-blocks.js';
import {
    getActiveProfile,
    generateViaProfile,
    getPromptBudget,
    describeTarget,
    suppressStoppingStrings,
    canStreamProfile,
} from './connection.js';

import {
    getSettings,
    assemblePrompt,
    resolveBlocks,
} from './settings.js';
import {
    getActiveSummary,
    getVisibleIndices,
    createSummaryRecord,
    addSummary,
    hideIndices,
    computeRangeHash,
    getSummaryById,
    getSummariesRaw,
    persist,
} from './store.js';

/** Matches the built-in's padding allowance when budgeting. */
const BUDGET_PADDING = 64;

/** Set while a Recall generation is in flight, so a second trigger is refused. */
let inFlight = false;

/**
 * What is running and since when, or null when nothing is.
 *
 * A summary is one request that can take a minute or more — longer with a
 * reasoning model and a 15k output budget — and until it lands the user has no
 * evidence anything is happening at all. The elapsed time is the cheapest honest
 * signal there is: nothing here can predict how long the request will take, so
 * there is no progress to report, only liveness.
 *
 * `content` and `reasoning` fill in as a streamed response arrives, and stay empty
 * on a connection that cannot stream — the UI reads `streaming` to know which it
 * is looking at, rather than inferring it from emptiness, which is also what a
 * model that has not said anything yet looks like.
 *
 * @type {{
 *   kind: 'summarize'|'regenerate', startedAt: number, streaming: boolean,
 *   cancellable: boolean, firstContentAt: number,
 *   content: string, reasoning: string, controller: AbortController,
 * }|null}
 */
let activeRun = null;

/** @type {Set<(run: typeof activeRun) => void>} */
const runListeners = new Set();

/**
 * How often a streamed run is allowed to wake the UI.
 *
 * Chunks arrive many times a second and each one carries the whole response, so
 * repainting per chunk is both wasteful and pointless — nobody reads a pane that
 * reflows thirty times a second. This is fast enough to read as live and slow
 * enough to stay out of the way of the response being assembled.
 */
const PROGRESS_INTERVAL_MS = 120;

/**
 * The reasoning from the most recent run, kept after the run itself is gone.
 *
 * Exists for one case: the model spends its entire output budget thinking and
 * writes no summary. That refusal can currently only assert what happened — the
 * evidence is thrown away at the moment it becomes worth reading, which is also
 * the moment the user has to decide whether to raise the budget or lower the
 * effort. Kept in memory only, never written to chat metadata: it is large, it
 * is about one attempt rather than about the chat, and it is not a summary.
 */
let lastReasoning = '';

/** @returns {string} */
export function getLastReasoning() {
    return lastReasoning;
}

export function isGenerating() {
    return inFlight;
}

/** @returns {typeof activeRun} */
export function getActiveRun() {
    return activeRun;
}

/**
 * Subscribes to starts and finishes.
 *
 * The manager is a popup the user can close mid-run, so the UI cannot be the
 * thing that knows a generation is happening — it has to be able to ask, and to
 * be told when it next opens. Returns its own unsubscribe.
 *
 * @param {(run: typeof activeRun) => void} listener
 * @returns {() => void}
 */
export function onRunChange(listener) {
    runListeners.add(listener);
    return () => runListeners.delete(listener);
}

function notifyRunChange() {
    for (const listener of runListeners) {
        try {
            listener(activeRun);
        } catch (error) {
            // A broken listener must not take the generation down with it: by the
            // time these fire, the request has either been sent or has landed.
            console.error('[Recall] A run listener failed', error);
        }
    }
}

/** @param {'summarize'|'regenerate'} kind */
function beginRun(kind) {
    inFlight = true;
    const profile = getActiveProfile();

    activeRun = {
        kind,
        startedAt: Date.now(),
        streaming: !!profile && canStreamProfile(profile),
        // Every profile request goes through fetch with this signal, streamed or
        // not, so both can be stopped. `generateRawData` takes no signal at all,
        // so the main API path cannot — and the button is hidden there rather
        // than offered and then found to do nothing.
        cancellable: !!profile,
        firstContentAt: 0,
        content: '',
        reasoning: '',
        controller: new AbortController(),
    };
    notifyRunChange();
}

function endRun() {
    inFlight = false;
    activeRun = null;
    notifyRunChange();
}

/**
 * Asks the running generation to stop.
 *
 * The abort propagates into `fetch`, which rejects the read the stream is waiting
 * on, which throws out of the `for await` and unwinds through the same `finally`
 * that a normal finish uses. Nothing is written: a half-streamed summary is not a
 * summary, and one saved as though it were would sit in context looking complete.
 *
 * @returns {boolean} Whether there was anything to cancel.
 */
export function cancelRun() {
    if (!activeRun) {
        return false;
    }
    activeRun.controller.abort(new DOMException('Cancelled by the user', 'AbortError'));
    return true;
}

/**
 * Records streamed progress and wakes the UI, at most every
 * `PROGRESS_INTERVAL_MS`.
 *
 * The run's own fields are updated on every chunk regardless of the throttle, so
 * a listener that paints on some other schedule — the elapsed clock, a manager
 * that has just opened — always reads the latest text rather than the text as of
 * the last notification.
 */
function makeProgressHandler() {
    let lastNotified = 0;

    return ({ content, reasoning }) => {
        if (!activeRun) {
            return;
        }

        // Stamped once, at the transition. A thinking model streams reasoning for
        // most of the run and then the summary, so this is the boundary between
        // the two — and the only point from which "thought for N" can be measured.
        // Read off the clock afterwards it would just be the elapsed total, which
        // keeps growing while the summary is written.
        if (!activeRun.content && content) {
            activeRun.firstContentAt = Date.now();
        }

        activeRun.content = content;
        activeRun.reasoning = reasoning;

        const now = Date.now();
        if (now - lastNotified >= PROGRESS_INTERVAL_MS) {
            lastNotified = now;
            notifyRunChange();
        }
    };
}

/**
 * Thrown for every refusal the user is meant to read and act on. The message is
 * the user-facing text; nothing else wraps or reformats it.
 */
export class RecallError extends Error {
    constructor(message, { kind = 'error' } = {}) {
        super(message);
        this.name = 'RecallError';
        this.kind = kind;
    }
}

/**
 * Formats one message for the buffer.
 * @param {number} index
 * @returns {string}
 */
function formatMessage(index) {
    const message = chat[index];
    return `${message.name}:\n${message.mes}`;
}

/**
 * Wraps the previous summary in the framing strings.
 *
 * The summary prompt branches on whether this block is empty: if it has text,
 * revise in place; if empty, create from scratch. That branch only works if the
 * block is present *even when empty*, so the wrapper is always emitted.
 *
 * @param {string} content
 * @returns {string}
 */
function frameSummary(content) {
    const settings = getSettings();
    return `${settings.framingPrefix}${content}${settings.framingSuffix}`;
}

/**
 * Builds the buffer from a set of message indices.
 * @param {number[]} indices
 * @param {string} previousSummary
 * @returns {string}
 */
function buildBufferFrom(indices, previousSummary, steeringNote = '') {
    const parts = [];

    // Reference material first: it explains who the participants are before the
    // model reads what they did.
    const context = buildContextBlocks();
    if (context.text) {
        parts.push(context.text);
    }

    parts.push(frameSummary(previousSummary));

    for (const index of indices) {
        if (chat[index]) {
            parts.push(formatMessage(index));
        }
    }

    // Last, after the chat. Recency is the whole point — this is a correction to
    // emphasis, competing with a long instruction and a long history, and it is
    // most likely to be obeyed from the position nearest generation. Placing it in
    // the system prompt would also put it after the Quality Check block, which
    // deliberately ends the instruction by telling the model to verify and submit.
    const note = String(steeringNote ?? '').trim();
    if (note) {
        parts.push([
            '--- BEGIN GUIDANCE FOR THIS PASS ---',
            note,
            'This guidance applies to this pass only. It does not replace the required structure '
            + 'or any rule above, and it is not part of the summary.',
            '--- END GUIDANCE FOR THIS PASS ---',
        ].join('\n\n'));
    }

    return parts.join('\n\n');
}

/**
 * The buffer for a fresh **Summarize now**: every visible message, plus the active
 * summary as material.
 * @returns {{ buffer: string, indices: number[], previous: import('./store.js').RecallSummary|null }}
 */
export function buildBuffer(steeringNote = '') {
    const indices = getVisibleIndices();
    const previous = getActiveSummary();

    // With no Recall summary yet, the built-in's stands in if the user enabled the
    // fallback. This is what makes the first summary on a migrated chat a revision
    // rather than a from-scratch rewrite — and it is the real fix for §3.1, since
    // the old summary supplies the history that the already-hidden messages would
    // otherwise have had to.
    const seed = previous?.content ?? getFallbackSummary();

    return {
        buffer: buildBufferFrom(indices, seed, steeringNote),
        indices,
        previous,
        seededFromLegacy: !previous && !!seed,
    };
}

/**
 * Checks the buffer against the available context room.
 *
 * Refuses rather than truncating: trimmed messages would be recorded as covered
 * without ever having been read. And it cannot ask the user to narrow a range,
 * because ranges are not something the user controls — so the message names the
 * remedy that *is* in their hands.
 *
 * @param {string} buffer
 * @param {string} systemPrompt
 * @param {number[]} indices
 */
async function enforceBudget(buffer, systemPrompt, indices) {
    // Sized against whichever connection will actually run the request — the main
    // API's context window is the wrong number when a profile is in use.
    const available = getPromptBudget()
        - await getTokenCountAsync(systemPrompt)
        - BUDGET_PADDING;

    const used = await getTokenCountAsync(buffer);

    if (used <= available) {
        return { used, available };
    }

    // Walk backward from the oldest visible message, counting, until the
    // remainder would fit. Message 0 is never hidden, so it is never offered.
    const hideable = indices.filter(i => i !== 0);
    let reclaimed = 0;
    let count = 0;

    for (const index of hideable) {
        reclaimed += await getTokenCountAsync(formatMessage(index));
        count++;
        if (used - reclaimed <= available) {
            break;
        }
    }

    const advice = used - reclaimed <= available
        ? `Hiding the oldest ${count} visible message${count === 1 ? '' : 's'} would bring it under.`
        : 'Even hiding everything but the first message would not bring it under — raise the context size or lower the response reserve.';

    throw new RecallError(
        `Too much to summarize. The visible messages come to ~${used.toLocaleString()} tokens; the budget is ${Math.max(0, available).toLocaleString()}. ${advice}`,
        { kind: 'overflow' },
    );
}

/**
 * Refuses to start for any reason that would corrupt state or waste a call.
 * @param {{ nothingNew?: boolean }} options
 */
function checkGuards({ nothingNew = false } = {}) {
    if (inFlight) {
        throw new RecallError('A Recall summary is already generating.', { kind: 'busy' });
    }
    if (is_send_press) {
        throw new RecallError('Wait for the current message to finish sending.', { kind: 'busy' });
    }
    if (streamingProcessor && !streamingProcessor.isFinished) {
        throw new RecallError('Wait for streaming to finish.', { kind: 'busy' });
    }
    if (is_group_generating) {
        throw new RecallError('Wait for the group to finish generating.', { kind: 'busy' });
    }
    if (!chat.length) {
        throw new RecallError('The chat is empty — there is nothing to summarize.', { kind: 'empty' });
    }

    if (nothingNew) {
        // With a visible tail the buffer is never empty, so emptiness cannot be the
        // signal. Compare the newest visible message against the active anchor.
        const active = getActiveSummary();
        if (active) {
            const visible = getVisibleIndices();
            const newest = visible[visible.length - 1];
            if (newest !== undefined
                && newest === active.coversTo
                && getStringHash(chat[newest]?.mes ?? '') === active.anchorHash) {
                throw new RecallError(
                    'Nothing new since the last summary. Use Regenerate if you want to redo it over the same material.',
                    { kind: 'nothing-new' },
                );
            }
        }
    }
}

/**
 * Captures the identity of the current chat, so a result generated against a chat
 * the user has since navigated away from is discarded rather than written.
 */
function captureContext() {
    return {
        chatId: getCurrentChatId(),
        groupId: selected_group,
        characterId: this_chid,
    };
}

function contextChanged(snapshot) {
    const now = captureContext();
    return now.chatId !== snapshot.chatId
        || now.groupId !== snapshot.groupId
        || now.characterId !== snapshot.characterId;
}

/**
 * Runs the model and validates what comes back.
 *
 * Uses `generateRawData` rather than `generateRaw` so the raw response object is
 * available: with thinking models, an empty summary and a total failure look
 * identical after reasoning is stripped, and only the presence of reasoning in the
 * response distinguishes "the model spent its whole output budget thinking" from
 * "the call produced nothing."
 *
 * @param {string} buffer
 * @param {string} systemPrompt
 * @returns {Promise<string>}
 */
async function runGeneration(buffer, systemPrompt) {
    const settings = getSettings();
    const { content, reasoning } = getActiveProfile()
        ? await runViaProfile(buffer, systemPrompt)
        : await runViaMainApi(buffer, systemPrompt);

    lastReasoning = String(reasoning ?? '');

    // Checked before the length rules below, because a cancelled run has usually
    // produced *something* — and reporting a deliberate stop as "too short to be a
    // summary" would read as a failure the user did not cause.
    if (wasCancelled()) {
        throw new RecallError('Summary cancelled. Nothing was saved.', { kind: 'cancelled' });
    }

    if (content.length >= settings.minResponseChars) {
        return content;
    }

    if (reasoning.trim().length) {
        throw new RecallError(
            'The model spent its entire output budget reasoning and never wrote a summary. '
            + 'Raise the output budget in Advanced, or lower Reasoning Effort for this API. '
            + `It produced ${reasoning.trim().length.toLocaleString()} characters of reasoning, `
            + 'which you can read to judge which of those two to change.',
            { kind: 'reasoning-overrun' },
        );
    }

    if (!content.length) {
        throw new RecallError('The model returned an empty response.', { kind: 'empty-response' });
    }

    throw new RecallError(
        `The model returned only ${content.length} characters, which is too short to be a summary. `
        + 'Treating it as a generation failure rather than saving a stub.',
        { kind: 'short-response' },
    );
}

/**
 * The main API path, unchanged: the same connection the chat itself uses.
 * @returns {Promise<{content: string, reasoning: string}>}
 */
async function runViaMainApi(buffer, systemPrompt) {
    const settings = getSettings();

    // Your chat's custom stopping strings would otherwise apply to the summary,
    // and `###` or `---` in that list truncates one at its first section break —
    // reported by the provider as a normal finish. See suppressStoppingStrings.
    const restoreStoppingStrings = suppressStoppingStrings();

    let data;
    try {
        data = await generateRawData({
            prompt: buffer,
            systemPrompt,
            responseLength: settings.outputBudget > 0 ? settings.outputBudget : null,
        });
    } finally {
        restoreStoppingStrings();
    }

    const raw = extractMessageFromData(data, main_api);

    let reasoning = '';
    try {
        reasoning = extractReasoningFromData(data, { ignoreShowThoughts: true }) ?? '';
    } catch {
        reasoning = '';
    }

    return {
        content: removeReasoningFromString(String(raw ?? '')).trim(),
        reasoning,
    };
}

/**
 * The connection-profile path. The request service already returns reasoning and
 * content as separate fields, so nothing needs stripping here — but an inline
 * `<think>` block would still arrive inside content, so it is run through the
 * same stripper for consistency.
 *
 * Provider errors are surfaced verbatim: with an overridden model id there is no
 * list to validate against, so the provider's own complaint is the only thing
 * that can tell the user they mistyped it.
 *
 * @returns {Promise<{content: string, reasoning: string}>}
 */
async function runViaProfile(buffer, systemPrompt) {
    try {
        const { content, reasoning } = await generateViaProfile(systemPrompt, buffer, {
            signal: activeRun?.controller?.signal ?? null,
            onProgress: makeProgressHandler(),
        });
        return {
            content: removeReasoningFromString(String(content ?? '')).trim(),
            reasoning: String(reasoning ?? ''),
        };
    } catch (error) {
        // A cancel unwinds as an abort from deep inside fetch, and dressing that up
        // as "the request failed" would blame the provider for something the user
        // just did. The caller turns this into the cancellation message.
        if (wasCancelled()) {
            return { content: '', reasoning: '' };
        }

        const detail = error?.cause?.message || error?.message || String(error);
        throw new RecallError(
            `${describeTarget()}\n\nThe request failed: ${detail}`,
            { kind: 'profile-failed' },
        );
    }
}

/** Whether the run in flight was stopped by the user rather than by the model. */
function wasCancelled() {
    return !!activeRun?.controller?.signal?.aborted;
}

/**
 * Which indices auto-hide is allowed to touch.
 *
 * Message 0 is never hidden — no exceptions, ever. It is the greeting or scenario,
 * it anchors the chat, and losing it is a real problem. The newest `tailPin`
 * messages are also skipped, so the chat does not go blank the moment a summary is
 * generated.
 *
 * @param {number[]} covered Indices that were in the buffer.
 * @returns {number[]}
 */
export function hideableIndices(covered) {
    const settings = getSettings();
    const tailPin = Math.max(0, Number(settings.tailPin) || 0);
    const pinnedTail = new Set(covered.slice(-tailPin));

    return covered.filter(index => index !== 0 && !pinnedTail.has(index));
}

/**
 * Builds exactly what Summarize now would send, without sending it.
 *
 * "Is the character description actually reaching the model?" is otherwise only
 * answerable by reading the network tab, and a setting whose effect you cannot
 * observe is a setting you cannot trust. This assembles through the same code
 * path as the real thing rather than describing it — a preview built separately
 * would drift from the request and reassure about the wrong text.
 *
 * @returns {Promise<{
 *   systemPrompt: string, buffer: string, indices: number[],
 *   included: string[], seededFromLegacy: boolean, target: string,
 *   tokens: { system: number, buffer: number, total: number, available: number },
 * }>}
 */
export async function previewRequest(steeringNote = '') {
    const systemPrompt = substituteParams(assemblePrompt());
    const { buffer, indices, seededFromLegacy } = buildBuffer(steeringNote);
    const { included } = buildContextBlocks();

    const system = await getTokenCountAsync(systemPrompt);
    const body = await getTokenCountAsync(buffer);

    return {
        systemPrompt,
        buffer,
        indices,
        included,
        seededFromLegacy,
        target: describeTarget(),
        tokens: {
            system,
            buffer: body,
            total: system + body,
            available: getPromptBudget() - system - BUDGET_PADDING,
        },
    };
}

/**
 * Summarize now — produce a new summary over the currently visible chat.
 * @returns {Promise<import('./store.js').RecallSummary>}
 */
export async function summarizeNow(steeringNote = '') {
    checkGuards({ nothingNew: true });

    const settings = getSettings();
    const { blocks, setName, isOverride } = resolveBlocks();

    if (!blocks.some(block => block.enabled && block.content.trim())) {
        throw new RecallError('The summary prompt is empty — every block is disabled or blank.', { kind: 'no-prompt' });
    }

    const systemPrompt = substituteParams(assemblePrompt());
    const { buffer, indices, previous, seededFromLegacy } = buildBuffer(steeringNote);

    if (!indices.length) {
        throw new RecallError('Every message is hidden — there is nothing visible to summarize.', { kind: 'empty' });
    }

    await enforceBudget(buffer, systemPrompt, indices);

    // Captured from the buffer as it was built, never from chat.length afterwards:
    // in non-blocking mode the user can send messages while generation runs, and
    // recording those as covered would mark never-read messages as summarised —
    // which, once hidden, loses them silently.
    const coversTo = indices[indices.length - 1];
    const snapshot = captureContext();

    beginRun('summarize');
    if (settings.blocking) {
        deactivateSendButtons();
    }

    try {
        const content = await runGeneration(buffer, systemPrompt);

        if (contextChanged(snapshot)) {
            throw new RecallError('The chat changed while the summary was generating, so the result was discarded.', { kind: 'context-changed' });
        }

        const record = createSummaryRecord({
            name: defaultSummaryName(),
            content,
            coversFrom: 0,
            coversTo,
            newFrom: previous ? Math.min(previous.coversTo + 1, coversTo) : 0,
            anchorHash: getStringHash(chat[coversTo]?.mes ?? ''),
            rangeHash: settings.deepIntegrityCheck ? computeRangeHash(0, coversTo) : null,
            generatedWith: { setName, isOverride },
            seededFromLegacy: !!seededFromLegacy,
            // Recorded so a later regenerate replays this exact set rather than
            // re-deriving it from the coverage range, which would sweep in every
            // message an earlier summary had already hidden.
            sourceIndices: [...indices],
            steeringNote: String(steeringNote ?? '').trim(),
        });

        addSummary(record);

        if (settings.autoHide) {
            record.hiddenIndices = await hideIndices(hideableIndices(indices));
            await persist({ immediate: true });
        }

        return record;
    } finally {
        endRun();
        if (settings.blocking) {
            activateSendButtons();
        }
    }
}

/**
 * Regenerate — redo an existing summary over the same material, as a sibling.
 *
 * Airtight because it touches no state: the buffer is rebuilt from the original's
 * recorded indices regardless of whether those messages are currently hidden, and
 * a new record is written with `regeneratedFrom` set. No hiding, no unhiding,
 * nothing to fall out of sync.
 *
 * @param {string} id
 * @returns {Promise<import('./store.js').RecallSummary>}
 */
/**
 * Works out which messages a redo should replay.
 *
 * A summary generated since this was recorded knows exactly what it read. One
 * generated before it does not, and the only thing left to fall back on is its
 * coverage range — which is not the same set, and is the bug this exists to make
 * visible: the range includes every message an earlier summary had already hidden,
 * none of which were in the original buffer.
 *
 * @param {import('./store.js').RecallSummary} summary
 * @returns {{ indices: number[], exact: boolean, rangeIndices: number[], extra: number }}
 */
export function resolveSourceIndices(summary) {
    const rangeIndices = [];
    for (let i = summary.coversFrom; i <= summary.coversTo && i < chat.length; i++) {
        if (chat[i]) {
            rangeIndices.push(i);
        }
    }

    const recorded = (summary.sourceIndices ?? []).filter(i => chat[i]);

    if (recorded.length) {
        return {
            indices: recorded,
            exact: !summary.sourceIndicesInferred,
            rangeIndices,
            extra: 0,
        };
    }

    return {
        indices: rangeIndices,
        exact: false,
        rangeIndices,
        extra: rangeIndices.length,
    };
}

/**
 * @param {string} id
 * @param {number[]} [indicesOverride] Messages to replay instead, when the user
 *        has told Recall what the original actually covered.
 */
export async function regenerateSummary(id, indicesOverride = null, steeringNote = '') {
    checkGuards();

    const original = getSummaryById(id);
    if (!original) {
        throw new RecallError('That summary no longer exists.', { kind: 'missing' });
    }
    if (original.stale) {
        throw new RecallError('That summary is stale — re-anchor it before regenerating, or the material it names no longer matches the chat.', { kind: 'stale' });
    }

    const settings = getSettings();
    const { blocks, setName, isOverride } = resolveBlocks();

    if (!blocks.some(block => block.enabled && block.content.trim())) {
        throw new RecallError('The summary prompt is empty — every block is disabled or blank.', { kind: 'no-prompt' });
    }

    const systemPrompt = substituteParams(assemblePrompt());

    const indices = indicesOverride?.length
        ? indicesOverride.filter(i => chat[i])
        : resolveSourceIndices(original).indices;

    if (!indices.length) {
        throw new RecallError('The messages this summary covered are no longer in the chat.', { kind: 'missing' });
    }

    // Regeneration rebuilds on whatever the original built on, not on the
    // currently active summary — otherwise the sibling is not comparable.
    const basis = original.regeneratedFrom
        ? getSummaryById(original.regeneratedFrom)
        : previousSummaryOf(original);

    // A first summary that was itself seeded from the built-in must be redone
    // against the same seed, or the sibling is not comparable to the original.
    const basisContent = basis?.content
        ?? (original.seededFromLegacy ? getFallbackSummary() : '');

    // The original's own note is not carried over. A redo with the same note would
    // be indistinguishable from one without, and the point of a sibling is that you
    // chose what changed between them.
    const buffer = buildBufferFrom(indices, basisContent, steeringNote);
    await enforceBudget(buffer, systemPrompt, indices);

    const snapshot = captureContext();

    beginRun('regenerate');
    if (settings.blocking) {
        deactivateSendButtons();
    }

    try {
        const content = await runGeneration(buffer, systemPrompt);

        if (contextChanged(snapshot)) {
            throw new RecallError('The chat changed while the summary was generating, so the result was discarded.', { kind: 'context-changed' });
        }

        const record = createSummaryRecord({
            name: `${original.name || 'Summary'} (redo)`,
            content,
            coversFrom: original.coversFrom,
            coversTo: original.coversTo,
            newFrom: original.newFrom,
            anchorHash: original.anchorHash,
            rangeHash: original.rangeHash,
            generatedWith: { setName, isOverride },
            regeneratedFrom: original.id,
            seededFromLegacy: !!original.seededFromLegacy,
            sourceIndices: [...indices],
            sourceIndicesInferred: !!indicesOverride,
            steeringNote: String(steeringNote ?? '').trim(),
            // Hide ownership stays with the original. One summary owns a hidden
            // range, always.
            hiddenIndices: [],
        });

        // Neither the original nor the sibling becomes active automatically.
        addSummary(record, { makeActive: false });
        return record;
    } finally {
        endRun();
        if (settings.blocking) {
            activateSendButtons();
        }
    }
}

/**
 * The summary a given summary was built on top of: the newest one created before
 * it that is not one of its own siblings.
 * @param {import('./store.js').RecallSummary} summary
 */
function previousSummaryOf(summary) {
    return getSummariesRaw()
        .filter(s => s.id !== summary.id
            && s.regeneratedFrom !== summary.id
            && s.createdAt < summary.createdAt)
        .reduce((newest, s) => (!newest || s.createdAt > newest.createdAt ? s : newest), null);
}

function defaultSummaryName() {
    const stamp = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
}
