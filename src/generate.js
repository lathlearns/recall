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
    getMaxPromptTokens,
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

export function isGenerating() {
    return inFlight;
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
function buildBufferFrom(indices, previousSummary) {
    const parts = [frameSummary(previousSummary)];
    for (const index of indices) {
        if (chat[index]) {
            parts.push(formatMessage(index));
        }
    }
    return parts.join('\n\n');
}

/**
 * The buffer for a fresh **Summarize now**: every visible message, plus the active
 * summary as material.
 * @returns {{ buffer: string, indices: number[], previous: import('./store.js').RecallSummary|null }}
 */
export function buildBuffer() {
    const indices = getVisibleIndices();
    const previous = getActiveSummary();

    // With no Recall summary yet, the built-in's stands in if the user enabled the
    // fallback. This is what makes the first summary on a migrated chat a revision
    // rather than a from-scratch rewrite — and it is the real fix for §3.1, since
    // the old summary supplies the history that the already-hidden messages would
    // otherwise have had to.
    const seed = previous?.content ?? getFallbackSummary();

    return {
        buffer: buildBufferFrom(indices, seed),
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
    const settings = getSettings();

    const available = getMaxPromptTokens(settings.responseReserve)
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

    const data = await generateRawData({
        prompt: buffer,
        systemPrompt,
        responseLength: settings.outputBudget > 0 ? settings.outputBudget : null,
    });

    const raw = extractMessageFromData(data, main_api);
    const content = removeReasoningFromString(String(raw ?? '')).trim();

    if (content.length >= settings.minResponseChars) {
        return content;
    }

    let reasoning = '';
    try {
        reasoning = extractReasoningFromData(data, { ignoreShowThoughts: true }) ?? '';
    } catch {
        reasoning = '';
    }

    if (reasoning.trim().length) {
        throw new RecallError(
            'The model spent its entire output budget reasoning and never wrote a summary. '
            + 'Raise the output budget in Advanced, or lower Reasoning Effort for this API.',
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
 * Summarize now — produce a new summary over the currently visible chat.
 * @returns {Promise<import('./store.js').RecallSummary>}
 */
export async function summarizeNow() {
    checkGuards({ nothingNew: true });

    const settings = getSettings();
    const { blocks, setName, isOverride } = resolveBlocks();

    if (!blocks.some(block => block.enabled && block.content.trim())) {
        throw new RecallError('The summary prompt is empty — every block is disabled or blank.', { kind: 'no-prompt' });
    }

    const systemPrompt = substituteParams(assemblePrompt());
    const { buffer, indices, previous, seededFromLegacy } = buildBuffer();

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

    inFlight = true;
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
        });

        addSummary(record);

        if (settings.autoHide) {
            record.hiddenIndices = await hideIndices(hideableIndices(indices));
            await persist({ immediate: true });
        }

        return record;
    } finally {
        inFlight = false;
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
export async function regenerateSummary(id) {
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

    // The same messages the original saw: everything in its covered range that is
    // not a genuine ST system message, hidden or not.
    const indices = [];
    for (let i = original.coversFrom; i <= original.coversTo && i < chat.length; i++) {
        if (chat[i]) {
            indices.push(i);
        }
    }

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

    const buffer = buildBufferFrom(indices, basisContent);
    await enforceBudget(buffer, systemPrompt, indices);

    const snapshot = captureContext();

    inFlight = true;
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
            // Hide ownership stays with the original. One summary owns a hidden
            // range, always.
            hiddenIndices: [],
        });

        // Neither the original nor the sibling becomes active automatically.
        addSummary(record, { makeActive: false });
        return record;
    } finally {
        inFlight = false;
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
