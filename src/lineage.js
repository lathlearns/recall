/**
 * Recall — which summary a given summary was built on.
 *
 * Free of SillyTavern imports so it can be tested. A redo has to rebuild on what
 * its original was built on, or the sibling is not comparable; getting the basis
 * wrong does not throw, it just hands the model different history and makes the
 * two versions differ for a reason nobody chose.
 *
 * New summaries record `builtOn` when they are written. Older ones did not, so
 * their basis is derived from creation times, which is right for a plain chain
 * and a guess for anything else — the reason the field exists.
 */

/**
 * @typedef {object} SummaryLike
 * @property {string} id
 * @property {number} createdAt
 * @property {string|null} [regeneratedFrom]
 * @property {string|null} [builtOn]  Absent on records written before 1.6.0.
 */

/**
 * @param {SummaryLike} summary
 * @param {SummaryLike[]} summaries The whole archive, `summary` included.
 * @returns {SummaryLike|null}
 */
export function basisOf(summary, summaries) {
    const byId = id => summaries.find(s => s.id === id) ?? null;

    if (summary.builtOn !== undefined) {
        if (!summary.builtOn) {
            return null;
        }
        // The basis may have been deleted since. The usual reason is that it was
        // redone and the user kept the redo, so the redo is what it would have
        // been built on had the user chosen first. Nothing surviving means the
        // basis really is gone, and the older derivation is the best left.
        return byId(summary.builtOn)
            ?? newest(summaries.filter(s => s.regeneratedFrom === summary.builtOn))
            ?? derivedBasis(summary, summaries);
    }

    return derivedBasis(summary, summaries);
}

/**
 * For records without `builtOn`: the newest summary created before this one's
 * family began, not counting the family itself. A redo of a redo walks back to
 * the summary the chain started from, because every sibling shares its basis.
 * @param {SummaryLike} summary
 * @param {SummaryLike[]} summaries
 */
function derivedBasis(summary, summaries) {
    const family = familyOf(summary, summaries);
    const start = summaries.find(s => s.id === family) ?? summary;
    return newest(summaries.filter(s => familyOf(s, summaries) !== family
        && s.createdAt < start.createdAt));
}

/**
 * The id a redo chain started from. When a link in the chain was deleted, the
 * missing id still names the family, so its surviving siblings stay together.
 * @param {SummaryLike} summary
 * @param {SummaryLike[]} summaries
 */
function familyOf(summary, summaries) {
    let current = summary;
    const seen = new Set();
    while (current.regeneratedFrom && !seen.has(current.id)) {
        seen.add(current.id);
        const next = summaries.find(s => s.id === current.regeneratedFrom);
        if (!next) {
            return current.regeneratedFrom;
        }
        current = next;
    }
    return current.id;
}

/** @param {SummaryLike[]} list */
function newest(list) {
    return list.reduce((best, s) => (!best || s.createdAt > best.createdAt ? s : best), null);
}
