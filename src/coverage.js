/**
 * Recall — coverage/visibility reconciliation.
 *
 * Hide state changes only in response to an explicit command, never as a side
 * effect of selecting or activating a summary. So this file only ever *reports* a
 * mismatch; acting on it is the one-click Sync action, and nothing calls that on
 * the user's behalf. Much of the time a mismatch is intentional — the user
 * activated an older summary specifically to compare output, with no interest in
 * rewinding the chat.
 */

import { chat } from '../../../../../script.js';
import { getSettings } from './settings.js';
import { getSummariesRaw, hideIndices, unhideIndices, persist } from './store.js';

/**
 * The indices a given summary's coverage implies should be hidden.
 *
 * Message 0 and the pinned tail are covered but deliberately not hidden, so a
 * naive coverage-vs-hidden comparison would report a mismatch permanently.
 * Coverage and hiding are not the same set by design.
 *
 * @param {import('./store.js').RecallSummary} summary
 * @returns {number[]}
 */
export function expectedHiddenFor(summary) {
    const tailPin = Math.max(0, Number(getSettings().tailPin) || 0);

    const covered = [];
    for (let i = summary.coversFrom; i <= summary.coversTo && i < chat.length; i++) {
        covered.push(i);
    }

    const pinnedTail = new Set(covered.slice(-tailPin));
    return covered.filter(index => index !== 0 && !pinnedTail.has(index));
}

/**
 * Compares chat visibility against a summary's coverage.
 *
 * @param {import('./store.js').RecallSummary|null} summary
 * @returns {{ mismatch: boolean, toHide: number[], toUnhide: number[] }}
 */
export function checkCoverage(summary) {
    if (!summary) {
        return { mismatch: false, toHide: [], toUnhide: [] };
    }

    // Covered by this summary, but still on screen.
    const toHide = expectedHiddenFor(summary)
        .filter(index => chat[index] && chat[index].is_system !== true);

    // Hidden by some *other* Recall summary, above this one's coverage. Only
    // Recall-owned hides are eligible: a message the user hid by hand is never
    // resurrected, whatever the summary says.
    const ownedElsewhere = new Set();
    for (const other of getSummariesRaw()) {
        if (other.id === summary.id) {
            continue;
        }
        for (const index of other.hiddenIndices ?? []) {
            if (index > summary.coversTo) {
                ownedElsewhere.add(index);
            }
        }
    }

    const toUnhide = [...ownedElsewhere]
        .filter(index => chat[index] && chat[index].is_system === true)
        .sort((a, b) => a - b);

    return {
        mismatch: toHide.length > 0 || toUnhide.length > 0,
        toHide,
        toUnhide,
    };
}

/**
 * Sync chat to this summary. Explicit, never automatic.
 * @param {import('./store.js').RecallSummary} summary
 * @returns {Promise<{ hidden: number[], unhidden: number[] }>}
 */
export async function syncToSummary(summary) {
    const { toHide, toUnhide } = checkCoverage(summary);

    const unhidden = await unhideIndices(toUnhide);
    const hidden = await hideIndices(toHide);

    // Hide ownership follows the messages: whatever this summary now hides is
    // recorded against it, and the summaries that previously owned those indices
    // give them up. One summary owns a hidden range, always.
    if (hidden.length) {
        summary.hiddenIndices = [...new Set([...(summary.hiddenIndices ?? []), ...hidden])]
            .sort((a, b) => a - b);
    }

    if (unhidden.length) {
        const released = new Set(unhidden);
        for (const other of getSummariesRaw()) {
            if (other.id === summary.id) {
                continue;
            }
            other.hiddenIndices = (other.hiddenIndices ?? []).filter(index => !released.has(index));
        }
    }

    if (hidden.length || unhidden.length) {
        await persist({ immediate: true });
    }

    return { hidden, unhidden };
}

/**
 * Transfers a hide record from one summary to another, used when the user deletes
 * an original and keeps its regeneration sibling: the sibling has no hide record
 * of its own, so the choice is transfer or unhide, and transfer is usually what
 * was meant.
 */
export function transferHideRecord(fromSummary, toSummary) {
    toSummary.hiddenIndices = [...(fromSummary.hiddenIndices ?? [])];
    return persist({ immediate: true });
}
