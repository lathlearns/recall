/**
 * Recall — which summary should be active for the chat actually loaded.
 *
 * Free of SillyTavern imports so it can be tested, like the other pieces whose
 * mistakes are quiet. Getting this wrong does not throw: it leaves the model
 * remembering a future that was abandoned, or silently drops a summary that was
 * perfectly good.
 *
 * The case it exists for is branching. Branching copies the whole of
 * `chat_metadata` and truncates the chat to the branch point, so the new chat
 * inherits every summary and the pointer — which now names one describing events
 * that only happened in the branch you left.
 */

/**
 * @typedef {object} SummaryLike
 * @property {string} id
 * @property {number} coversTo
 * @property {number} createdAt
 * @property {boolean} [stale]
 */

/**
 * @param {SummaryLike[]} summaries  In any order.
 * @param {string|null} activeId
 * @param {number} chatLength        Messages in the chat as loaded.
 * @returns {{ moved: boolean, id: string|null }}
 *          `moved` is false when the pointer is already right. A null `id` with
 *          `moved` true means nothing fits and the pointer should be cleared.
 */
export function chooseActiveSummary(summaries, activeId, chatLength) {
    const all = Array.isArray(summaries) ? summaries : [];
    const active = all.find(summary => summary?.id === activeId) ?? null;

    // Nothing active, or nothing to measure against. An empty chat is not
    // evidence that a summary is wrong — it is a chat that has not loaded.
    if (!active || !chatLength) {
        return { moved: false, id: activeId ?? null };
    }

    // The test, and the only one: does its coverage run past the end of this
    // chat? A summary whose anchor was merely *edited* is stale but still
    // describes this chat, and its remedy is re-anchoring — deciding that for the
    // user would take away a summary they may well want.
    if (active.coversTo < chatLength) {
        return { moved: false, id: activeId };
    }

    // The newest summary that still describes this chat. Stale ones are excluded:
    // their anchor is gone or changed, so their coverage no longer means what it
    // says, and promoting one would trade a wrong summary for an untrustworthy one.
    const candidate = all
        .filter(summary => summary
            && !summary.stale
            && Number.isFinite(summary.coversTo)
            && summary.coversTo < chatLength)
        .reduce((newest, summary) =>
            (!newest || summary.createdAt > newest.createdAt ? summary : newest), null);

    return { moved: true, id: candidate?.id ?? null };
}
