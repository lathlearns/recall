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
 * The marker anywhere inside a line, for reading reasoning only.
 *
 * Reasoning is prose about the task, not the task's output: a model writes
 * "Let me make sure it fits: TITLE: Smoke and silver on asphalt" and "So: TITLE:
 * …", never a bare line. Requiring the marker at the start of a line — which is
 * right for the response, where a wrong match deletes a line of the summary —
 * finds none of that, and the first version of this reused that rule and
 * therefore never recovered a single title.
 *
 * Looser here because the stakes are not the same. Nothing is removed from
 * anything: the worst a false match can do is put a slightly wrong name on a
 * summary, in a field the user can edit.
 */
const TITLE_IN_TEXT = /\btitle[ \t]*[:：][ \t]*([^\n]*)/gi;

/**
 * The example from the instruction, lowercased.
 *
 * A model reasoning about the format frequently quotes the template back to
 * itself. Recovering *that* would name every summary after the placeholder.
 */
const TEMPLATE_TITLE = 'a short name for this stretch of the story';

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
    const text = String(reasoning ?? '');
    let found = '';

    for (const match of text.matchAll(TITLE_IN_TEXT)) {
        const candidate = cleanTitle(match[1]);

        if (isPlaceholder(candidate)) {
            continue;
        }

        found = candidate;
    }

    return found;
}

/**
 * Whether a recovered string is the model talking about titles rather than
 * naming one.
 *
 * Reasoning is a workspace, and a model planning its output writes the *shape*
 * of the line as often as the line itself: `TITLE: [at most 8 words]`,
 * `TITLE: <name>`, or the instruction's own example quoted back. An early
 * version of this recovered "[at most 8 words]" from a real run and would have
 * named the summary that — worse than leaving it untitled, because a wrong name
 * looks deliberate.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isPlaceholder(candidate) {
    if (!candidate || candidate.toLowerCase() === TEMPLATE_TITLE) {
        return true;
    }

    // Brackets of any kind are a slot, not a name.
    if (/[[\]<>{}]/.test(candidate)) {
        return true;
    }

    // Phrases from the instruction, restated as a reminder to itself.
    if (/\bat most\b|\bwords?\b|\bshort name\b|\bplaceholder\b|\bstretch of the story\b/i.test(candidate)) {
        return true;
    }

    // Weighing options rather than naming one. A model comparing candidates
    // writes them quoted and joined — `"The Omega on the Hood" or "Honda" - hood
    // is American for bonnet…` — which has letters, no brackets, and nothing
    // else to distinguish it from a decision. A real title contains no quotation
    // marks: the instruction says so, and one that does is a sentence about
    // titles.
    if (/["“”]/.test(candidate)) {
        return true;
    }

    // Longer than the instruction allows.
    //
    // Deliberation runs on; a decision does not. Eight words is the stated rule,
    // and a couple of words of slack keeps a hyphenated or subtitled name from
    // being refused while still rejecting prose. This also catches anything the
    // length cap had to truncate, which is by definition too long to be the
    // answer.
    if (candidate.split(/\s+/).filter(Boolean).length > 10 || candidate.endsWith('…')) {
        return true;
    }

    // A name has letters in it.
    return !/\p{L}/u.test(candidate);
}

/**
 * Strips the decoration a model adds around a title it was asked to leave bare.
 * @param {string} raw
 * @returns {string}
 */
export function cleanTitleText(raw) {
    return cleanTitle(raw);
}

function cleanTitle(raw) {
    let title = String(raw ?? '').trim();

    // Newlines cannot survive: this goes in a single-line field.
    title = title.replace(/\s+/g, ' ').trim();

    // Strong emphasis and code ticks, wherever they fall. The response path has
    // already normalised the whole line, but the reasoning path matches
    // mid-sentence and can capture a stray closing `**` with no opener — which
    // the paired stripper below will not touch. Neither can appear in a real
    // title, so removing them outright costs nothing.
    title = title.replace(/\*\*|__|`/g, '').trim();

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
