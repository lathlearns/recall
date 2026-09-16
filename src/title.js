/**
 * Recall — the model-written title line.
 *
 * The summary prompt asks for a marked title on the first line; this takes it
 * back off before the summary is stored, so the title lives in the archive's
 * name field and never in the text the macro resolves.
 *
 * Free of SillyTavern imports so it can be tested, because the thing that can go
 * wrong here is quiet and permanent.
 *
 * **The rule: strip only on a confident match.** A model that ignores the
 * instruction writes a summary whose first line is real content, and a
 * "remove the first line" that fires anyway deletes it — from the one artefact
 * that stays in context indefinitely, where it would be noticed weeks later if
 * at all. So non-compliance has to degrade to *no title*, never to lost text,
 * and that means the marker has to be unmistakable rather than positional.
 */

/**
 * The marker, allowing for the decorations a model reaches for unprompted: a
 * heading hash, bold asterisks, a full-width colon from a CJK keyboard layout.
 * What it does *not* allow is a bare first line — the literal word must be there.
 */
const TITLE_LINE = /^title[ \t]*[:：][ \t]*(.*)$/i;

/**
 * Reduces a candidate line to the form the matcher expects.
 *
 * Models decorate this line in more ways than a single pattern can carry, and
 * the emphasis lands in every position: `**TITLE:** X`, `**TITLE: X**`,
 * `TITLE: **X**`, `## TITLE: X`. Normalising first and matching second is far
 * easier to reason about than one expression trying to allow all of them.
 *
 * Strong emphasis and code ticks are removed outright — they cannot legitimately
 * appear in a title, so nothing is lost. Single `*` and `_` are left to the
 * paired stripper below, which only removes them when they actually wrap.
 */
function normaliseLine(line) {
    return String(line ?? '')
        .replace(/^[ \t]*#{1,6}[ \t]*/, '')
        .replace(/\*\*|__|`/g, '')
        .trim();
}

/**
 * Long enough for a real chapter name, short enough that a model answering with
 * a sentence — or with the summary itself — is truncated rather than allowed to
 * fill the archive list.
 */
const MAX_TITLE_LENGTH = 72;

/**
 * Splits a model response into its title and the summary proper.
 *
 * Safe to call on a partial response: while the line is still arriving it simply
 * does not match yet, and the caller gets the text unchanged.
 *
 * @param {string} response
 * @returns {{ title: string, content: string }} `title` is '' when there is none,
 *          and `content` is then the response untouched.
 */
export function splitTitle(response) {
    const text = String(response ?? '');
    const lines = text.split('\n');

    // The two ends, and only the two ends.
    //
    // The prompt asks for the line last, because a model revising a document with
    // a required first heading reliably normalises a *leading* extra line away —
    // it drops it while writing the answer even after deciding on one. Appending
    // after the document is finished does not compete with that.
    //
    // The first line is still accepted, because some models put it there anyway
    // and earlier versions asked them to. A marker anywhere *between* the two is
    // ignored: it is either part of the summary or a second attempt, and cutting
    // from the middle of the text is precisely the silent edit this file exists
    // to avoid.
    const firstIndex = lines.findIndex(line => line.trim());
    if (firstIndex === -1) {
        return { title: '', content: text };
    }

    let lastIndex = lines.length - 1;
    while (lastIndex > firstIndex && !lines[lastIndex].trim()) {
        lastIndex--;
    }

    for (const index of firstIndex === lastIndex ? [firstIndex] : [firstIndex, lastIndex]) {
        const found = normaliseLine(lines[index]).match(TITLE_LINE);
        if (!found) {
            continue;
        }

        const remaining = lines.slice();
        remaining.splice(index, 1);

        // A marker with nothing usable after it is still a marker: the line was
        // meant as a title, so it comes off, but there is no title to show.
        return {
            title: cleanTitle(found[1]),
            content: remaining.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
        };
    }

    return { title: '', content: text };
}

/**
 * The title a model settled on while thinking, for when it never wrote one.
 *
 * A last resort, and only ever used for the archive's name — reasoning has no
 * path to the summary text or the prompt, and this does not give it one.
 *
 * It exists because of a failure that two rounds of prompt wording did not fix:
 * a reasoning model drafts the whole answer in its thinking, picks a title,
 * verifies it against every rule, and then writes a final response without it.
 * The decision is right there and discarding it to preserve a principle about
 * where titles come from would leave the user with a timestamp for no reason.
 *
 * The *last* match wins, because thinking is a draft: a model that reconsiders
 * has its final answer at the end.
 *
 * @param {string} reasoning
 * @returns {string} '' when the reasoning names no title.
 */
export function titleFromReasoning(reasoning) {
    const lines = String(reasoning ?? '').split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
        const found = normaliseLine(lines[i]).match(TITLE_LINE);
        if (found) {
            return cleanTitle(found[1]);
        }
    }

    return '';
}

/**
 * Strips the decoration a model adds around a title it was asked to leave bare.
 * @param {string} raw
 * @returns {string}
 */
function cleanTitle(raw) {
    let title = String(raw ?? '').trim();

    // Newlines cannot survive: this goes in a single-line field.
    title = title.replace(/\s+/g, ' ').trim();

    // Wrappers and trailing punctuation strip in the same loop, because either
    // can hide the other. A model writing `"The Ford".` puts the full stop
    // outside the quotes, so stripping quotes first finds no closing quote and
    // gives up; stripping punctuation first would miss `"The Ford."`, where it
    // is inside. Alternating until nothing changes handles both, and **"A
    // Title"** — several layers at once — falls out for free.
    for (let i = 0; i < 4; i++) {
        const before = title;
        title = title
            // Trailing sentence punctuation reads as a truncated sentence in a
            // list of names. A question or exclamation mark can *be* the title,
            // so those stay.
            .replace(/[.,;:]+$/, '')
            .trim()
            .replace(/^\*\*([\s\S]*)\*\*$/, '$1')
            .replace(/^__([\s\S]*)__$/, '$1')
            .replace(/^\*([\s\S]*)\*$/, '$1')
            .replace(/^_([\s\S]*)_$/, '$1')
            .replace(/^`([\s\S]*)`$/, '$1')
            .replace(/^"([\s\S]*)"$/, '$1')
            .replace(/^'([\s\S]*)'$/, '$1')
            .replace(/^[“”]([\s\S]*)[“”]$/, '$1')
            .trim();
        if (title === before) {
            break;
        }
    }

    if (title.length > MAX_TITLE_LENGTH) {
        title = `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
    }

    return title;
}

/**
 * Builds the archive name from a title and a timestamp.
 *
 * The timestamp always survives. Two summaries a model titles identically are
 * otherwise indistinguishable in the list, and the date is the one thing that
 * orders them — so the title is a prefix, not a replacement.
 *
 * @param {string} title
 * @param {string} stamp
 * @returns {string}
 */
export function composeName(title, stamp) {
    const clean = String(title ?? '').trim();
    return clean ? `${clean} — ${stamp}` : stamp;
}
