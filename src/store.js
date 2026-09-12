/**
 * Recall — per-chat storage: the summary archive, the active pointer, and hide
 * records.
 *
 * All of this lives in `chat_metadata`, which is chat-specific, travels with the
 * chat file on export, and — usefully — is copied wholesale into a branch by
 * `saveChat({ withMetadata })`, so branching inherits its memory with no code here.
 *
 * Recall never touches `chat[i].extra.memory`. That field belongs to the built-in
 * Summarize extension; leaving it empty is what keeps an accidentally-enabled
 * Summarize inert, since its `formatMemoryValue('')` injection becomes a no-op.
 */

import { chat, chat_metadata, saveChatConditional, saveMetadata } from '../../../../../script.js';
import { saveMetadataDebounced } from '../../../../extensions.js';
import { getStringHash } from '../../../../utils.js';
import { uuid } from './util.js';

export const STORE_KEY = 'recall';

/**
 * @typedef {object} RecallSummary
 * @property {string} id
 * @property {string} name              User-facing label. Never sent to the LLM.
 * @property {string} content           The summary text. The only field the macro reads.
 * @property {number} coversFrom        Always 0 in practice — message 0 is never hidden.
 * @property {number} coversTo          Last message covered. Doubles as the anchor index.
 * @property {number} newFrom           First message not covered by the previous summary. Display only.
 * @property {number} anchorHash        Hash of chat[coversTo].mes at creation.
 * @property {number|null} rangeHash    Hash of the whole covered range. Only set when the deep check is on.
 * @property {number} createdAt
 * @property {number|null} editedAt
 * @property {{setName: string, isOverride: boolean}} generatedWith
 * @property {string|null} regeneratedFrom  Id of the summary this is a sibling of.
 * @property {number[]} sourceIndices   The messages actually in the buffer. Empty on records written before this was captured.
 * @property {boolean} sourceIndicesInferred  True when the read set was supplied by the user rather than recorded at generation.
 * @property {number[]} hiddenIndices   Indices this summary actually flipped to hidden.
 * @property {boolean} stale            Set by drift detection when the anchor is gone.
 * @property {boolean} seededFromLegacy Built on the built-in Summarize's stored summary rather than from scratch.
 * @property {string} steeringNote      One-off guidance sent with this pass. Kept as a record of what produced this result; never replayed.
 * @property {string} reasoning         What the model was thinking while it wrote this. Display only — see below.
 */

function emptyStore() {
    return {
        schemaVersion: 1,
        /** @type {RecallSummary[]} */
        summaries: [],
        /** @type {string|null} */
        activeSummaryId: null,
    };
}

/**
 * The Recall block of the current chat's metadata, created on demand.
 */
export function getStore() {
    if (!chat_metadata[STORE_KEY] || typeof chat_metadata[STORE_KEY] !== 'object') {
        chat_metadata[STORE_KEY] = emptyStore();
    }

    const store = chat_metadata[STORE_KEY];

    if (!Array.isArray(store.summaries)) {
        store.summaries = [];
    }
    if (store.activeSummaryId === undefined) {
        store.activeSummaryId = null;
    }

    return store;
}

export function persist({ immediate = false } = {}) {
    if (immediate) {
        return saveMetadata();
    }
    saveMetadataDebounced();
    return Promise.resolve();
}

/** @returns {RecallSummary[]} Newest first. */
export function getSummaries() {
    return getStore().summaries.slice().sort((a, b) => b.createdAt - a.createdAt);
}

/** @returns {RecallSummary[]} In creation order, as stored. */
export function getSummariesRaw() {
    return getStore().summaries;
}

/** @returns {RecallSummary|null} */
export function getSummaryById(id) {
    return getStore().summaries.find(s => s.id === id) ?? null;
}

/**
 * The summary the `{{recall}}` macro resolves to.
 * @returns {RecallSummary|null}
 */
export function getActiveSummary() {
    const store = getStore();
    if (!store.activeSummaryId) {
        return null;
    }
    return store.summaries.find(s => s.id === store.activeSummaryId) ?? null;
}

/**
 * Changes what the macro resolves to and nothing else. Never touches message
 * visibility — that is §7.3, and it is the rule that lets the user browse and
 * compare the whole archive without moving a single message.
 */
export function setActiveSummary(id) {
    const store = getStore();
    store.activeSummaryId = id;
    persist();
}

/**
 * The newest summary by creation time, used as the fallback active pointer.
 * @returns {RecallSummary|null}
 */
export function getNewestSummary() {
    const summaries = getStore().summaries;
    if (!summaries.length) {
        return null;
    }
    return summaries.reduce((newest, s) => (s.createdAt > newest.createdAt ? s : newest));
}

/**
 * @param {Partial<RecallSummary>} fields
 * @returns {RecallSummary}
 */
export function createSummaryRecord(fields) {
    return {
        id: uuid(),
        name: '',
        content: '',
        coversFrom: 0,
        coversTo: 0,
        newFrom: 0,
        anchorHash: 0,
        rangeHash: null,
        createdAt: Date.now(),
        editedAt: null,
        generatedWith: { setName: '', isOverride: false },
        regeneratedFrom: null,
        // What the buffer actually contained. Coverage is a *range*; the buffer was
        // "whatever was visible", which is a range minus arbitrary holes wherever an
        // earlier summary or the user had already hidden something. Those two are
        // only the same set for the very first summary in a chat, so re-deriving
        // the material from the range fabricates messages the summary never read.
        sourceIndices: [],
        sourceIndicesInferred: false,
        hiddenIndices: [],
        stale: false,
        seededFromLegacy: false,
        // Bookkeeping only. Deliberately never re-applied: a note is a correction
        // for one pass, and silently repeating it would make later summaries drift
        // for a reason invisible at the point of pressing the button.
        steeringNote: '',
        // What the model was thinking while it wrote `content`.
        //
        // Kept because "why did it say that" is a question asked after reading
        // what it said, and a reasoning trace that evaporates the moment the
        // summary lands can only be read by someone who happened to be watching.
        //
        // It is *not* part of the summary and has no path to the prompt. The
        // macro resolves `content` and nothing else — see resolveRecall — so this
        // field is invisible to the model no matter how large it gets. It costs
        // space in the chat file and nothing in context.
        reasoning: '',
        ...fields,
    };
}

/**
 * Appends a summary.
 *
 * `makeActive` is false for regeneration siblings: a redo produces a sibling, not
 * a replacement, and neither version becomes active on its own — the user picks
 * after comparing them.
 *
 * @param {RecallSummary} record
 * @param {{ makeActive?: boolean }} options
 */
export function addSummary(record, { makeActive = true } = {}) {
    const store = getStore();
    store.summaries.push(record);
    if (makeActive) {
        store.activeSummaryId = record.id;
    }
    persist({ immediate: true });
}

/**
 * Removes a summary.
 *
 * Returns whether the active pointer moved, so the caller can show the notice
 * §5.3 requires — silently having no memory in context is the kind of thing that
 * goes unnoticed for several messages.
 *
 * @param {string} id
 * @returns {{ deleted: RecallSummary|null, pointerMoved: boolean, newActive: RecallSummary|null }}
 */
export function deleteSummary(id) {
    const store = getStore();
    const index = store.summaries.findIndex(s => s.id === id);

    if (index === -1) {
        return { deleted: null, pointerMoved: false, newActive: getActiveSummary() };
    }

    const [deleted] = store.summaries.splice(index, 1);
    const wasActive = store.activeSummaryId === id;

    let pointerMoved = false;
    if (wasActive) {
        const fallback = getNewestSummary();
        store.activeSummaryId = fallback?.id ?? null;
        pointerMoved = true;
    }

    persist({ immediate: true });
    return { deleted, pointerMoved, newActive: getActiveSummary() };
}

// --- Message visibility -----------------------------------------------------

/**
 * Hides the given indices, recording only the ones actually flipped.
 *
 * Deliberately not `hideChatMessageRange()`: that sets `is_system` across a whole
 * span, which would flip genuine system messages too and defeat the rule that a
 * message the user hid weeks ago for their own reasons is never resurrected by
 * Recall. One `saveChatConditional()` covers the whole batch.
 *
 * @param {number[]} indices
 * @returns {Promise<number[]>} The indices Recall actually changed.
 */
export async function hideIndices(indices) {
    const flipped = [];

    for (const index of indices) {
        const message = chat[index];
        if (!message) {
            continue;
        }
        if (message.is_system === true) {
            continue; // Already hidden — by the user, or by an earlier summary.
        }

        message.is_system = true;
        flipped.push(index);
        applyVisibilityToDom(index, true);
    }

    if (flipped.length) {
        await saveChatConditional();
    }

    return flipped;
}

/**
 * Unhides exactly the given indices. Only ever called with a summary's own
 * `hiddenIndices`, so nothing the user hid by hand comes back.
 * @param {number[]} indices
 * @returns {Promise<number[]>}
 */
export async function unhideIndices(indices) {
    const flipped = [];

    for (const index of indices) {
        const message = chat[index];
        if (!message) {
            continue;
        }
        if (message.is_system !== true) {
            continue;
        }

        message.is_system = false;
        flipped.push(index);
        applyVisibilityToDom(index, false);
    }

    if (flipped.length) {
        await saveChatConditional();
    }

    return flipped;
}

function applyVisibilityToDom(index, hidden) {
    const block = document.querySelector(`.mes[mesid="${index}"]`);
    if (block) {
        block.setAttribute('is_system', String(hidden));
    }
}

/** @returns {number[]} Indices of every currently hidden message. */
export function getHiddenIndices() {
    const hidden = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.is_system === true) {
            hidden.push(i);
        }
    }
    return hidden;
}

/** @returns {number[]} Indices of every currently visible message, in chat order. */
export function getVisibleIndices() {
    const visible = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i] && chat[i].is_system !== true) {
            visible.push(i);
        }
    }
    return visible;
}

// --- Drift detection --------------------------------------------------------

/**
 * ST message ids are array indices, not stable identifiers, so deleting a message
 * shifts everything above it. In practice the workflow makes this rare — messages
 * at or below the anchor are hidden and frozen, so edits almost always land above
 * it. This is cheap insurance, not load-bearing machinery.
 *
 * @param {boolean} deepCheck Also verify the covered range, catching edits below the anchor.
 * @returns {{ shifted: RecallSummary[], staled: RecallSummary[], drifted: RecallSummary[] }}
 */
export function runDriftDetection(deepCheck = false) {
    const store = getStore();
    const shifted = [];
    const staled = [];
    const drifted = [];

    if (!store.summaries.length || !chat.length) {
        return { shifted, staled, drifted };
    }

    /** @type {Map<number, number[]>} hash -> indices */
    const hashIndex = new Map();
    for (let i = 0; i < chat.length; i++) {
        const hash = getStringHash(chat[i]?.mes ?? '');
        const bucket = hashIndex.get(hash);
        if (bucket) {
            bucket.push(i);
        } else {
            hashIndex.set(hash, [i]);
        }
    }

    for (const summary of store.summaries) {
        const anchor = chat[summary.coversTo];

        if (anchor && getStringHash(anchor.mes ?? '') === summary.anchorHash) {
            // No drift. Clear a stale flag if the user re-anchored or undid a delete.
            if (summary.stale) {
                summary.stale = false;
                shifted.push(summary);
            }
            if (deepCheck) {
                checkRange(summary, drifted);
            }
            continue;
        }

        const candidates = hashIndex.get(summary.anchorHash);

        if (candidates?.length) {
            // The anchor still exists and simply moved. Pick the nearest match:
            // identical messages hash identically, so nearest-to-original is the
            // only sane tiebreak.
            const newIndex = candidates.reduce((best, i) =>
                Math.abs(i - summary.coversTo) < Math.abs(best - summary.coversTo) ? i : best);
            const delta = newIndex - summary.coversTo;

            summary.coversTo = newIndex;
            summary.newFrom = Math.max(0, summary.newFrom + delta);
            // Shifting hiddenIndices alongside the coverage fields is required, not
            // optional: leave it uncorrected and a later delete unhides the wrong
            // messages, stranding some and popping others back mid-range.
            summary.hiddenIndices = summary.hiddenIndices
                .map(i => i + delta)
                .filter(i => i >= 0 && i < chat.length);
            // The read set is a raw index list too, and drifts for the same reason.
            // Left uncorrected it would replay the wrong messages on a regenerate.
            summary.sourceIndices = (summary.sourceIndices ?? [])
                .map(i => i + delta)
                .filter(i => i >= 0 && i < chat.length);
            summary.stale = false;
            shifted.push(summary);

            if (deepCheck) {
                checkRange(summary, drifted);
            }
            continue;
        }

        // The anchor was edited or deleted. Unrecoverable without the user.
        if (!summary.stale) {
            summary.stale = true;
            staled.push(summary);
        }
    }

    if (shifted.length || staled.length) {
        persist();
    }

    return { shifted, staled, drifted };
}

/**
 * The deep check: hash the whole covered range, catching edits *below* the anchor
 * that the anchor hash cannot see. Off by default because it flags on any edit
 * anywhere in history.
 */
function checkRange(summary, drifted) {
    if (summary.rangeHash === null || summary.rangeHash === undefined) {
        // Recorded before the setting was turned on. Adopt the current state as
        // the baseline rather than reporting a drift we cannot substantiate.
        summary.rangeHash = computeRangeHash(summary.coversFrom, summary.coversTo);
        return;
    }

    if (computeRangeHash(summary.coversFrom, summary.coversTo) !== summary.rangeHash) {
        drifted.push(summary);
    }
}

/**
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
export function computeRangeHash(from, to) {
    const parts = [];
    for (let i = from; i <= to && i < chat.length; i++) {
        parts.push(chat[i]?.mes ?? '');
    }
    // Explicit NUL separator: it cannot occur in message text, so two different
    // splits of the same characters cannot collide into one hash.
    return getStringHash(parts.join('\u0000'));
}

/**
 * Re-anchors a stale summary to a message the user picked.
 * @param {string} id
 * @param {number} index
 */
export function reanchorSummary(id, index) {
    const summary = getSummaryById(id);
    if (!summary || !chat[index]) {
        return false;
    }

    summary.coversTo = index;
    summary.anchorHash = getStringHash(chat[index].mes ?? '');
    summary.newFrom = Math.min(summary.newFrom, index);
    summary.stale = false;
    persist({ immediate: true });
    return true;
}
