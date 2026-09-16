/**
 * Recall — the model-written title line.
 *
 * One property matters more than all the others here: **a response without a
 * title must come back untouched.** The summary is the artefact that sits in
 * permanent context, a model is free to ignore the instruction, and a stripper
 * that removes the first line regardless would quietly delete real content — the
 * kind of damage noticed weeks later, if at all.
 *
 * So most of what follows is the negative case: text that must survive.
 *
 * Run:  node test/title.mjs
 */

import { splitTitle, composeName, titleFromReasoning } from '../src/title.js';

const failures = [];

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        failures.push(`${label}: expected ${b}, got ${a}`);
    }
}

// --------------------------------------------------------------------------
// The happy path
// --------------------------------------------------------------------------

{
    const { title, content } = splitTitle('TITLE: The Long Road North\n\n## Continuity\n\nMara and Tev.');
    check('title is taken', title, 'The Long Road North');
    check('content keeps everything else', content, '## Continuity\n\nMara and Tev.');
}

// The decorations a model reaches for even when told not to.
for (const [raw, expected] of [
    ['TITLE: **The Ford**', 'The Ford'],
    ['**TITLE:** The Ford', 'The Ford'],
    ['**TITLE: The Ford**', 'The Ford'],
    ['## TITLE: The Ford', 'The Ford'],
    ['title: the ford', 'the ford'],
    ['TITLE:   The Ford   ', 'The Ford'],
    ['TITLE: "The Ford"', 'The Ford'],
    ['TITLE: “The Ford”', 'The Ford'],
    ['TITLE: `The Ford`', 'The Ford'],
    ['TITLE: The Ford.', 'The Ford'],
    ['TITLE：The Ford', 'The Ford'],
    ['   TITLE: The Ford', 'The Ford'],
]) {
    const { title } = splitTitle(`${raw}\n\nBody text.`);
    check(`decoration handled: ${raw}`, title, expected);
}

// A question mark can be the title; a full stop is a truncated sentence.
check('a question mark survives', splitTitle('TITLE: Whose Writ?\n\nBody.').title, 'Whose Writ?');

// Leading blank lines before the title line.
{
    const { title, content } = splitTitle('\n\nTITLE: The Ford\n\nBody.');
    check('leading blank lines are tolerated', title, 'The Ford');
    check('content after leading blanks', content, 'Body.');
}

// --------------------------------------------------------------------------
// The negative case: text that must survive untouched
// --------------------------------------------------------------------------

for (const untouched of [
    // The ordinary non-compliance: a summary that just starts.
    '## Continuity\n\nMara and Tev are travelling east.',
    // A first line that is real content and merely looks structural.
    'The title of the book Mara carries is unknown.\n\nMore text.',
    // Prose beginning with the word, but not as a marker.
    'Titles and honorifics matter to Tev.\n\nMore text.',
    // The word without the colon.
    'TITLE The Ford\n\nBody.',
    // A colon, but not at the start of the line.
    'Chapter TITLE: The Ford\n\nBody.',
    // The marker further down, where removing it would be an edit mid-summary.
    '## Continuity\n\nTITLE: not a title\n\nMore text.',
    '',
]) {
    const { title, content } = splitTitle(untouched);
    check(`no title claimed: ${JSON.stringify(untouched.slice(0, 34))}`, title, '');
    check(`content untouched: ${JSON.stringify(untouched.slice(0, 34))}`, content, untouched);
}

// --------------------------------------------------------------------------
// Degenerate markers
// --------------------------------------------------------------------------

{
    // A marker with nothing after it is still a marker: the line was meant as a
    // title, so it comes off, but there is no title to show.
    const { title, content } = splitTitle('TITLE:\n\nBody text.');
    check('an empty marker yields no title', title, '');
    check('but the marker line still comes off', content, 'Body text.');
}

{
    // A model answering with a sentence, or with the summary itself, is truncated
    // rather than allowed to fill the archive list.
    const long = 'TITLE: ' + 'word '.repeat(60);
    const { title } = splitTitle(`${long}\n\nBody.`);
    check('an overlong title is truncated', title.length <= 72, true);
    check('and is marked as truncated', title.endsWith('…'), true);
}

{
    // A title spanning lines cannot exist — only the first line is eligible.
    const { title, content } = splitTitle('TITLE: The Ford\nand the road east\n\nBody.');
    check('a title is one line only', title, 'The Ford');
    check('the next line stays in the summary', content, 'and the road east\n\nBody.');
}

// --------------------------------------------------------------------------
// Partial responses, because this runs against a stream
// --------------------------------------------------------------------------

for (const partial of ['T', 'TIT', 'TITLE', 'TITLE:']) {
    const { content } = splitTitle(partial);
    if (partial === 'TITLE:') {
        check('a bare complete marker is consumed', content, '');
    } else {
        check(`a partial marker is left alone: ${partial}`, content, partial);
    }
}

{
    // Mid-title: the line is complete enough to match, and the caller gets the
    // partial title. Harmless — the next chunk replaces it.
    const { title } = splitTitle('TITLE: The Long\n');
    check('a partially written title is readable', title, 'The Long');
}

// --------------------------------------------------------------------------
// The title at the end, which is where the prompt now asks for it
// --------------------------------------------------------------------------

{
    const { title, content } = splitTitle('## Continuity\n\nMara and Tev.\n\nTITLE: The Long Road North');
    check('a trailing title is taken', title, 'The Long Road North');
    check('the summary above it survives', content, '## Continuity\n\nMara and Tev.');
}

{
    // Trailing blank lines after it, which streamed responses often carry.
    const { title, content } = splitTitle('Body text.\n\nTITLE: The Ford\n\n\n');
    check('trailing blanks do not hide the line', title, 'The Ford');
    check('content after a trailing title', content, 'Body text.');
}

{
    // Both ends marked: the first wins, and only one line is removed.
    const { title, content } = splitTitle('TITLE: First\n\nBody.\n\nTITLE: Second');
    check('the leading marker wins', title, 'First');
    check('the trailing one is left in the text', content, 'Body.\n\nTITLE: Second');
}

{
    // A single line that is only a marker must not be counted twice.
    const { title, content } = splitTitle('TITLE: Only Line');
    check('a lone title line', title, 'Only Line');
    check('leaves no content', content, '');
}

// Still nothing may be cut from the middle, now that both ends are eligible.
{
    const text = '## Continuity\n\nTITLE: not a title\n\nMore text.';
    const { title, content } = splitTitle(text);
    check('a mid-text marker is still ignored', title, '');
    check('and the text is still untouched', content, text);
}

// --------------------------------------------------------------------------
// The reasoning fallback
// --------------------------------------------------------------------------

check('a title is found in reasoning',
    titleFromReasoning('Let me think.\n\nTITLE: Omega on the Ridge\n\nNow the summary.'),
    'Omega on the Ridge');

// The shape reasoning actually takes. A model talks its way to the answer, so
// the marker sits mid-sentence — requiring it at the start of a line, which is
// correct for the response, recovers nothing at all from real thinking.
check('a marker mid-line is found',
    titleFromReasoning('Let me make sure it fits: TITLE: Smoke and silver on asphalt'),
    'Smoke and silver on asphalt');

check('a marker after a short prefix is found',
    titleFromReasoning('Possible titles:\n- one\n- two\n\nSo: TITLE: Smoke and silver on asphalt\n\nYes.'),
    'Smoke and silver on asphalt');

// Prose about the rules must not be mistaken for a decision.
check('"the TITLE line" is not a title',
    titleFromReasoning('Finally the TITLE line. Needs to be at most 8 words.'),
    '');
check('"Possible titles:" is not a title',
    titleFromReasoning('Possible titles:\n- The Mask and the True Name'),
    '');
check('the rule restated is not a title',
    titleFromReasoning('- Must begin with literal word TITLE followed by a colon.'),
    '');

// Weighing options is not deciding. Taken from a real run, where this would
// otherwise have become the summary's name.
check('comparing candidates is not a decision',
    titleFromReasoning('TITLE: "The Omega on the Hood" or "Honda" - hood is American for bonnet, but the scene reads better'),
    '');
check('a quoted single candidate is still refused',
    titleFromReasoning('So maybe TITLE: "The Ford" works'),
    '');

// Longer than the rule allows is prose about the title, not the title.
check('an over-long candidate is refused',
    titleFromReasoning('TITLE: this is a very long run on sentence that clearly is not a chapter name at all'),
    '');
check('but a normal-length name survives',
    titleFromReasoning('TITLE: The Omega on the Hood'),
    'The Omega on the Hood');
check('and eight words is still allowed',
    titleFromReasoning('TITLE: Smoke and silver on the long road north'),
    'Smoke and silver on the long road north');

// The instruction's own example, quoted back while reasoning about the format.
check('the template placeholder is refused',
    titleFromReasoning('The format is TITLE: a short name for this stretch of the story'),
    '');
check('and does not mask a real decision made earlier',
    titleFromReasoning('TITLE: The Real One\n\nThe format is TITLE: a short name for this stretch of the story'),
    'The Real One');

// Thinking is a draft, so a model that reconsiders has its answer at the end.
check('the last decision wins',
    titleFromReasoning('TITLE: First Idea\nhmm, no.\nTITLE: Better Idea'),
    'Better Idea');

check('reasoning without a title yields nothing', titleFromReasoning('No title here at all.'), '');
check('empty reasoning yields nothing', titleFromReasoning(''), '');
check('null reasoning yields nothing', titleFromReasoning(null), '');

// The same decoration handling as the response path, since it is the same line.
check('decoration in reasoning is cleaned',
    titleFromReasoning('**TITLE:** "The Ford".'),
    'The Ford');

// --------------------------------------------------------------------------
// Names
// --------------------------------------------------------------------------

check('a name carries both parts', composeName('The Ford', '2026-09-12 14:31'), 'The Ford — 2026-09-12 14:31');
check('no title leaves the timestamp alone', composeName('', '2026-09-12 14:31'), '2026-09-12 14:31');
check('a whitespace title is no title', composeName('   ', '2026-09-12 14:31'), '2026-09-12 14:31');
check('a null title is no title', composeName(null, '2026-09-12 14:31'), '2026-09-12 14:31');

if (failures.length) { console.log('FAIL:'); failures.forEach(f => console.log('  -', f)); process.exit(1); }
console.log('All title checks pass.');
