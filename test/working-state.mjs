/**
 * Recall — the generating/working state on action buttons.
 *
 * `paintRunButton` in ui.js rewrites a button in place: it swaps the `<i>` for a
 * spinner and the `<span>` for a counting label, then puts both back when the run
 * ends. That contract is entirely implicit in the markup — there is no error if a
 * button has no icon or no label element, the spinner simply never appears, and
 * the only symptom is the thing the whole feature exists to prevent: a button that
 * looks idle while a request is in flight.
 *
 * So the shape of those buttons is asserted here rather than assumed, along with
 * the one CSS property the state depends on: `.recall-busy` must refuse clicks
 * without dimming, since ST's `.disabled` does both and would hide the spinner.
 *
 * Run:  npx playwright install chromium   (once)
 *       node test/working-state.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(`${ROOT}/style.css`, 'utf8');
const manager = fs.readFileSync(`${ROOT}/templates/manager.html`, 'utf8');
const drawer = fs.readFileSync(`${ROOT}/templates/drawer.html`, 'utf8');
const uiSrc = fs.readFileSync(`${ROOT}/src/ui.js`, 'utf8');
const generateSrc = fs.readFileSync(`${ROOT}/src/generate.js`, 'utf8');

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--SmartThemeBodyColor:#ddd;--SmartThemeEmColor:#999;--SmartThemeQuoteColor:#e18a24;
--SmartThemeUnderlineColor:#bce7cf;--SmartThemeBorderColor:rgba(0,0,0,.5);
--black30a:rgba(0,0,0,.3);--crimson70a:rgba(100,0,0,.7);--mainFontSize:15px;}
.menu_button{display:inline-flex;align-items:center;gap:.4em;padding:.3em .6em;}
.menu_button.disabled,.menu_button[disabled]{opacity:.4;pointer-events:none;}
${css}</style></head><body>${manager}${drawer}</body></html>`;

const browser = await chromium.launch();
const p = await browser.newPage();
await p.setContent(page);

const failures = [];

// The selectors ui.js sweeps, read from the source so the two cannot drift.
// Non-greedy to the closing `\n];` — the selectors themselves contain `]`, so a
// character class stopping at the first one parses nothing.
const selectorBlock = uiSrc.match(/const ACTION_SELECTORS = \[([\s\S]*?)\n\];/);
if (!selectorBlock) {
    failures.push('ACTION_SELECTORS not found in ui.js');
}

const selectors = selectorBlock
    ? [...selectorBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1])
    : [];

if (selectors.length < 2) {
    failures.push(`expected several action selectors, parsed ${selectors.length}`);
}

// 1. Every action button the paint touches must exist, and must carry the icon
//    and label elements the paint reaches for.
for (const selector of selectors) {
    const shape = await p.$$eval(selector, els => els.map(el => ({
        icon: !!el.querySelector('i'),
        label: !!el.querySelector('span'),
        cls: el.className,
    })));

    if (!shape.length) {
        failures.push(`no element in either template matches ${selector}`);
        continue;
    }

    for (const { icon, label, cls } of shape) {
        if (!icon) failures.push(`${selector} has no <i> for the spinner to replace (class="${cls}")`);
        if (!label) failures.push(`${selector} has no <span> for the elapsed label (class="${cls}")`);
        if (!/\bmenu_button\b/.test(cls)) failures.push(`${selector} is not a .menu_button, so .disabled will not stop clicks`);
    }
}

// 2. The running button must refuse clicks.
const busy = await p.evaluate(() => {
    const el = document.querySelector('[data-recall="summarize-now"]');
    el.classList.add('recall-busy');
    const style = getComputedStyle(el);
    return { pointerEvents: style.pointerEvents, opacity: Number(style.opacity) };
});

if (busy.pointerEvents !== 'none') {
    failures.push(`.recall-busy does not block clicks (pointer-events: ${busy.pointerEvents})`);
}

// 3. ...but must NOT be dimmed. This is the whole reason it is not `.disabled`:
//    a spinner at 40% opacity under a greyscale filter is not a working state,
//    it is a button that looks broken.
if (busy.opacity < 0.95) {
    failures.push(`.recall-busy is dimmed to ${busy.opacity}, which would hide the spinner`);
}

// 4. The buttons that are not running still get the ordinary disabled treatment.
const idleDisabled = await p.evaluate(() => {
    const el = document.querySelector('[data-recall="preview"]');
    el.classList.add('disabled');
    return getComputedStyle(el).pointerEvents;
});

if (idleDisabled !== 'none') {
    failures.push(`.disabled does not block clicks on the non-running buttons (got ${idleDisabled})`);
}

// 5. Every kind of run ui.js knows how to label must name a button that exists,
//    or that run would count up on nothing at all.
const runButtons = [...uiSrc.matchAll(/^\s{4}(\w+): '([\w-]+)',$/gm)]
    .filter(m => uiSrc.indexOf('const RUN_BUTTON') < m.index
        && m.index < uiSrc.indexOf('const RUN_LABEL'))
    .map(m => m[2]);

if (!runButtons.length) {
    failures.push('RUN_BUTTON has no entries, so no button would ever show the spinner');
}

for (const name of runButtons) {
    const count = await p.$$eval(`[data-recall="${name}"]`, els => els.length);
    if (!count) failures.push(`RUN_BUTTON names "${name}" but no template has [data-recall="${name}"]`);
}

// 5b. The live pane and Stop exist, and start hidden. Both are driven purely by
//     the `hidden` attribute, so a class that set `display` on either would strand
//     them on screen with no run behind them.
for (const hook of ['live', 'live-label', 'live-size', 'live-body', 'stop']) {
    const found = await p.$$eval(`[data-recall="${hook}"]`, els => els.length);
    if (!found) failures.push(`ui.js paints [data-recall="${hook}"] but no template has one`);
}

const stopPlaces = await p.$$eval('[data-recall="stop"]', els => els.length);
if (stopPlaces < 2) {
    failures.push(`Stop appears in ${stopPlaces} place(s); it belongs in both the drawer and the manager`);
}

const liveHidden = await p.evaluate(() => {
    const el = document.querySelector('[data-recall="live"]');
    return { start: getComputedStyle(el).display, hasAttr: el.hasAttribute('hidden') };
});
if (!liveHidden.hasAttr) failures.push('the live pane is not hidden in the template');
if (liveHidden.start !== 'none') failures.push(`the live pane renders while hidden (display: ${liveHidden.start})`);

// 5c. The live body must scroll its own text rather than grow.
//
//     Without this it gains a line every few hundred milliseconds for a minute,
//     pushing the whole archive down the screen and reflowing the page under the
//     pointer for the entire run.
const liveBody = await p.evaluate(() => {
    const el = document.querySelector('[data-recall="live-body"]');
    el.closest('[data-recall="live"]').removeAttribute('hidden');
    const style = getComputedStyle(el);
    return { maxHeight: style.maxHeight, overflowY: style.overflowY, whiteSpace: style.whiteSpace };
});
if (liveBody.maxHeight === 'none') failures.push('the live body has no max-height, so it grows without bound as text arrives');
if (!['auto', 'scroll'].includes(liveBody.overflowY)) failures.push(`the live body does not scroll (overflow-y: ${liveBody.overflowY})`);
if (!liveBody.whiteSpace.startsWith('pre')) failures.push(`the live body collapses the model's line breaks (white-space: ${liveBody.whiteSpace})`);

// 5d. Streamed text is model output arriving a chunk at a time, so it must be
//     written as text. Half a markdown link is still half a tag.
if (/live-body[\s\S]{0,400}?\.innerHTML\s*=/.test(uiSrc)) {
    failures.push('the live body is written with innerHTML; partial model output must go in as textContent');
}

// 5e. The reasoning region: present, hidden to begin with, scrolling rather than
//     growing, and shorter than the summary window below it — reasoning is long
//     and repetitive and must not bury the thing being waited for.
for (const hook of ['think', 'think-toggle', 'think-summary', 'think-chevron', 'think-body']) {
    const found = await p.$$eval(`[data-recall="${hook}"]`, els => els.length);
    if (!found) failures.push(`ui.js paints [data-recall="${hook}"] but the template has none`);
}

const think = await p.evaluate(() => {
    const region = document.querySelector('[data-recall="think"]');
    const hiddenAtRest = region.hasAttribute('hidden') && getComputedStyle(region).display === 'none';
    region.removeAttribute('hidden');
    region.closest('[data-recall="live"]').removeAttribute('hidden');

    const body = getComputedStyle(document.querySelector('[data-recall="think-body"]'));
    const live = getComputedStyle(document.querySelector('[data-recall="live-body"]'));
    const px = value => parseFloat(value) || Infinity;

    return {
        hiddenAtRest,
        maxHeight: body.maxHeight,
        overflowY: body.overflowY,
        shorterThanSummary: px(body.maxHeight) <= px(live.maxHeight),
        toggleRole: document.querySelector('[data-recall="think-toggle"]').getAttribute('role'),
        toggleTabIndex: document.querySelector('[data-recall="think-toggle"]').getAttribute('tabindex'),
    };
});

if (!think.hiddenAtRest) failures.push('the reasoning region is not hidden before a run produces any');
if (think.maxHeight === 'none') failures.push('the reasoning body has no max-height, so it grows without bound');
if (!['auto', 'scroll'].includes(think.overflowY)) failures.push(`the reasoning body does not scroll (overflow-y: ${think.overflowY})`);
if (!think.shorterThanSummary) failures.push('the reasoning window is taller than the summary window it sits above');

// 5f. The toggle is a div, so the browser gives it no keyboard behaviour of its
//     own. If it claims to be a button it has to act like one.
if (think.toggleRole !== 'button') failures.push(`the reasoning toggle has role="${think.toggleRole}", not "button"`);
if (think.toggleTabIndex === null) failures.push('the reasoning toggle is not reachable by keyboard (no tabindex)');
if (!/think-toggle[\s\S]{0,600}?addEventListener\('keydown'/.test(uiSrc)) {
    failures.push('the reasoning toggle has role="button" but no keydown handler, so Enter and Space do nothing');
}

// 5g. Reasoning is model output too, and goes in as text for the same reason.
if (/think-body[\s\S]{0,400}?\.innerHTML\s*=/.test(uiSrc)) {
    failures.push('the reasoning body is written with innerHTML; partial model output must go in as textContent');
}

// 5h. Reasoning is stored with its summary, and must never reach the prompt.
//
//     An earlier version of this check simply forbade the field on a record. That
//     was the wrong invariant — it banned the storage rather than the leak, and
//     had to go the moment reasoning was kept so it could be read afterwards.
//     What actually matters is narrower and permanent: the macro resolves the
//     summary's `content` and nothing else, so reasoning can be any size in the
//     chat file and still be invisible to the model. These pin that.
const macroSrc = fs.readFileSync(`${ROOT}/src/macro.js`, 'utf8');
if (/\breasoning\b/.test(macroSrc)) {
    failures.push('src/macro.js mentions reasoning; the macro must resolve content and nothing else');
}

// The buffer is the other way text reaches the model. Reasoning must not appear
// in the function that builds it, nor in the reference material it assembles.
const bufferFn = generateSrc.match(/function buildBufferFrom\([\s\S]*?\n\}/)?.[0] ?? '';
if (!bufferFn) {
    failures.push('buildBufferFrom not found in generate.js — this check is not looking at anything');
}
if (/\breasoning\b/.test(bufferFn)) {
    failures.push('buildBufferFrom mentions reasoning; it must never enter the buffer');
}

const contextSrc = fs.readFileSync(`${ROOT}/src/context-blocks.js`, 'utf8');
if (/\breasoning\b/.test(contextSrc)) {
    failures.push('src/context-blocks.js mentions reasoning; reference material must never carry it');
}

// And it must stay out of the field the macro does read: nothing may assign a
// summary's content from a reasoning value.
if (/\bcontent\s*[:=]\s*[\w.?]*\breasoning\b/.test(generateSrc + uiSrc)) {
    failures.push('a summary\'s content is being assigned from reasoning');
}

// 5i. The title instruction goes in the buffer, after the chat — not in the
//     system prompt.
//
//     It shipped in the system prompt first and was ignored by every model tried,
//     because everything in the user message lands after it: the reference
//     material, the previous summary and the entire visible chat sit between a
//     format rule written there and the point of generation. The placement is the
//     feature, so it is pinned rather than left to a comment.
const settingsSrc = fs.readFileSync(`${ROOT}/src/settings.js`, 'utf8');

if (/TITLE_INSTRUCTION/.test(settingsSrc)) {
    failures.push('settings.js references TITLE_INSTRUCTION — the title rule belongs in the buffer, not the system prompt');
}
if (!/\bTITLE_INSTRUCTION\b/.test(bufferFn)) {
    failures.push('buildBufferFrom does not add TITLE_INSTRUCTION, so nothing asks the model for a title');
}

// And before the steering note, so the user's own guidance keeps the last word.
const titleAt = bufferFn.indexOf('TITLE_INSTRUCTION');
const steeringAt = bufferFn.indexOf('BEGIN GUIDANCE FOR THIS PASS');
if (titleAt !== -1 && steeringAt !== -1 && titleAt > steeringAt) {
    failures.push('the title instruction is placed after the steering note, displacing the user\'s guidance from last position');
}

// The marker the extractor looks for has to be the one the prompt asks for, or
// every title is silently dropped.
const promptSrc = fs.readFileSync(`${ROOT}/src/default-prompt.js`, 'utf8');
const titleSrc = fs.readFileSync(`${ROOT}/src/title.js`, 'utf8');
const instruction = promptSrc.match(/export const TITLE_INSTRUCTION = \[([\s\S]*?)\]\.join/)?.[1] ?? '';

if (!instruction) {
    failures.push('TITLE_INSTRUCTION not found in default-prompt.js');
}
if (!/TITLE/.test(instruction) || !/title/i.test(titleSrc)) {
    failures.push('the prompt and the extractor disagree about the marker word');
}
// A brace macro here would be resolved by the host before the model sees it.
if (/\{\{/.test(instruction)) {
    failures.push('TITLE_INSTRUCTION contains a macro, which the host would expand before sending');
}

// Never tell the model its output will be thrown away.
//
// An earlier wording said the title line "is removed before the summary is
// saved", meaning it kindly — it is what makes writing one harmless. A reasoning
// model chose a title, checked it against every rule, and then left it out:
// informed the line would be discarded and was "not part of the summary", it
// treated the summary as the deliverable and dropped the scaffolding. What
// becomes of the line afterwards is Recall's business and must stay out of the
// prompt.
if (/removed before the summary|is removed before|will be discarded|thrown away|deleted before/i.test(instruction)) {
    failures.push('TITLE_INSTRUCTION tells the model its title line will be discarded, which invites it to omit the line');
}

// And it has to be stated as required output, or a model that plans one in its
// reasoning can consider the instruction satisfied without ever writing it.
if (!/must begin|must start|required/i.test(instruction)) {
    failures.push('TITLE_INSTRUCTION does not state that the title line is required');
}
if (!/planning|reasoning/i.test(instruction)) {
    failures.push('TITLE_INSTRUCTION does not say that planning a title is not the same as writing one');
}

// 5j. The title has to survive the trip from the response to the record.
//
//     It did not, for four releases. runGeneration extracted a title and then
//     returned `{ content, reasoning }` without it, so every caller destructured
//     `title` and got undefined, and every summary was named after a timestamp
//     however well the model had complied. Nothing failed, nothing logged, and
//     the symptom was indistinguishable from a model ignoring the instruction —
//     which is what it was mistaken for, three times.
//
//     Every hop is checked, because the break was at the one hop nobody looked
//     at.
const runGenerationFn = generateSrc.match(/async function runGeneration\([\s\S]*?\n\}/)?.[0] ?? '';
if (!runGenerationFn) {
    failures.push('runGeneration not found in generate.js — this check is not looking at anything');
}

const successfulReturn = runGenerationFn.match(/return \{[^}]*\};/g) ?? [];
if (!successfulReturn.length) {
    failures.push('runGeneration has no object return to check');
}
for (const ret of successfulReturn) {
    if (!/\btitle\b/.test(ret)) {
        failures.push(`runGeneration returns ${ret.trim()} without a title — every summary would be named after its timestamp`);
    }
}

// Both callers must take it off the result and put it into the name.
const callSites = (generateSrc.match(/const \{[^}]*\} = await runGeneration\(/g) ?? []);
if (callSites.length < 2) {
    failures.push(`expected both summarize and regenerate to call runGeneration, found ${callSites.length}`);
}
for (const call of callSites) {
    if (!/\btitle\b/.test(call)) {
        failures.push(`a runGeneration caller does not destructure title: ${call.trim()}`);
    }
}

// And composeName must actually receive it, rather than being handed a stamp.
const composeCalls = generateSrc.match(/composeName\([^)]*\)/g) ?? [];
if (!composeCalls.length) {
    failures.push('nothing calls composeName, so no title ever reaches a name');
}
for (const call of composeCalls) {
    if (!/\btitle\b/.test(call)) {
        failures.push(`composeName is called without a title: ${call}`);
    }
}

// 5k. Diagnostics meant for a person must be visible without changing the
//     console's log level. `console.debug` is Verbose in Chrome and hidden by
//     default, so an earlier diagnostic reported nothing to the user it was
//     written for.
for (const line of generateSrc.split('\n')) {
    if (/console\.debug\(/.test(line)) {
        failures.push('generate.js logs a diagnostic with console.debug, which browsers hide by default');
    }
}

// 6. The clock must be cleared from the same place it is set. A run that ends by
//    throwing would otherwise leave an interval repainting a button forever.
if (!/clearInterval\(runTicker\)/.test(uiSrc)) {
    failures.push('ui.js never clears runTicker, so the elapsed clock would outlive the run');
}

// 7. Both generation entry points must report their state, or one of them runs
//    silently and the button sits idle through it.
const begins = (generateSrc.match(/beginRun\(/g) ?? []).length - 1;  // minus the definition
const ends = (generateSrc.match(/endRun\(/g) ?? []).length - 1;

if (begins !== ends) {
    failures.push(`generate.js has ${begins} beginRun calls but ${ends} endRun calls — they must pair`);
}
if (begins < 2) {
    failures.push(`expected both summarize and regenerate to report a run, found ${begins}`);
}

// 8. Every endRun must sit in a finally, so a refusal or a provider error still
//    releases the button.
const finallyEnds = (generateSrc.match(/finally \{\s*\n\s*endRun\([^)]*\);/g) ?? []).length;
if (finallyEnds !== begins) {
    failures.push(`${begins} runs start but only ${finallyEnds} release the button from a finally block`);
}

await browser.close();

if (failures.length) { console.log('FAIL:'); failures.forEach(f => console.log('  -', f)); process.exit(1); }
console.log(`All working-state checks pass (${selectors.length} action selectors, ${begins} run sites).`);
