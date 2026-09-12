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
const finallyEnds = (generateSrc.match(/finally \{\s*\n\s*endRun\(\);/g) ?? []).length;
if (finallyEnds !== begins) {
    failures.push(`${begins} runs start but only ${finallyEnds} release the button from a finally block`);
}

await browser.close();

if (failures.length) { console.log('FAIL:'); failures.forEach(f => console.log('  -', f)); process.exit(1); }
console.log(`All working-state checks pass (${selectors.length} action selectors, ${begins} run sites).`);
