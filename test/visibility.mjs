/**
 * Recall — visibility and layout regression tests.
 *
 * These exist because of a bug static checking could never have caught: every
 * class here that sets `display` silently defeated the `hidden` attribute, whose
 * UA rule has the lowest possible priority. The result was every banner, every
 * dirty-state bar and the entire detail pane rendering at once, empty and
 * undismissable — in a chat with no summaries at all.
 *
 * Recall toggles visibility exclusively through the `hidden` attribute, so that
 * contract is worth a test that runs in a real browser engine rather than a
 * reasoned argument about specificity.
 *
 * Run:  npx playwright install chromium   (once)
 *       node test/visibility.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(`${ROOT}/style.css`, 'utf8');
const manager = fs.readFileSync(`${ROOT}/templates/manager.html`, 'utf8');
const drawer = fs.readFileSync(`${ROOT}/templates/drawer.html`, 'utf8');

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--SmartThemeBodyColor:#ddd;--SmartThemeEmColor:#999;--SmartThemeQuoteColor:#e18a24;
--SmartThemeUnderlineColor:#bce7cf;--SmartThemeBorderColor:rgba(0,0,0,.5);
--black30a:rgba(0,0,0,.3);--crimson70a:rgba(100,0,0,.7);--mainFontSize:15px;}
${css}</style></head><body>${manager}${drawer}</body></html>`;

const browser = await chromium.launch();
const p = await browser.newPage();
await p.setContent(page);

const failures = [];

// 1. Everything marked hidden must actually be invisible.
const visibleHidden = await p.$$eval('[hidden]', els =>
    els.filter(el => getComputedStyle(el).display !== 'none')
       .map(el => el.getAttribute('data-recall') || el.className || el.tagName));
if (visibleHidden.length) failures.push(`[hidden] still displayed: ${visibleHidden.join(', ')}`);

// 2. Removing hidden must restore the intended layout, not leave it invisible.
const restored = await p.evaluate(() => {
    const el = document.querySelector('[data-recall="error"]');
    el.removeAttribute('hidden');
    return getComputedStyle(el).display;
});
if (restored !== 'flex') failures.push(`banner did not return to flex on show (got ${restored})`);

// 3. Re-hiding must work (the dismiss path).
const rehidden = await p.evaluate(() => {
    const el = document.querySelector('[data-recall="error"]');
    el.setAttribute('hidden', 'hidden');
    return getComputedStyle(el).display;
});
if (rehidden !== 'none') failures.push(`banner did not re-hide on dismiss (got ${rehidden})`);

// 4. Every element the JS toggles must start hidden in the template.
const shouldStartHidden = ['error','notice','empty','detail-body','stale-banner',
                           'mismatch-banner','redo-banner','detail-dirty','blocks-dirty',
                           'oos-banner','advanced','strip-notice','empty-fallback',
                           'profile-extras','profile-context-row','profile-preset-row','fallback-banner'];
for (const hook of shouldStartHidden) {
    const state = await p.$eval(`[data-recall="${hook}"]`, el =>
        ({ hidden: el.hasAttribute('hidden'), display: getComputedStyle(el).display }))
        .catch(() => null);
    if (!state) { failures.push(`missing element: ${hook}`); continue; }
    if (!state.hidden) failures.push(`${hook} does not start hidden`);
    if (state.display !== 'none') failures.push(`${hook} starts visible (display:${state.display})`);
}

// 5. The archive pane shows and the settings pane does not, on open.
const panes = await p.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('[data-recall-pane]')]
        .map(el => [el.dataset.recallPane, getComputedStyle(el).display])));
if (panes.archive === 'none') failures.push('archive pane hidden on open');
if (panes.settings !== 'none') failures.push(`settings pane visible on open (${panes.settings})`);

// 6. Narrow viewport: detail must collapse away in list view.
await p.setViewportSize({ width: 420, height: 900 });
const narrow = await p.evaluate(() => {
    const root = document.querySelector('.recall-manager');
    root.setAttribute('data-recall-view', 'list');
    const detail = getComputedStyle(document.querySelector('[data-recall="detail"]')).display;
    root.setAttribute('data-recall-view', 'detail');
    const master = getComputedStyle(document.querySelector('.recall-master')).display;
    const back = getComputedStyle(document.querySelector('[data-recall="back"]')).display;
    return { detail, master, back };
});
if (narrow.detail !== 'none') failures.push(`narrow list view still shows detail (${narrow.detail})`);
if (narrow.master !== 'none') failures.push(`narrow detail view still shows master (${narrow.master})`);
if (narrow.back === 'none') failures.push('back button missing on narrow screens');

// 7. Wide viewport: both panes side by side, no back button.
await p.setViewportSize({ width: 1400, height: 900 });
const wide = await p.evaluate(() => ({
    detail: getComputedStyle(document.querySelector('[data-recall="detail"]')).display,
    master: getComputedStyle(document.querySelector('.recall-master')).display,
    back: getComputedStyle(document.querySelector('[data-recall="back"]')).display,
}));
if (wide.detail === 'none' || wide.master === 'none') failures.push('wide view is not side-by-side');
if (wide.back !== 'none') failures.push('back button showing on wide screens');

// 8. Every expand-editor button must name an element that exists. ST's handler
//    only console.errors when data-for misses, so a typo is silent in the UI.
const danglingInTemplate = await p.$$eval('.editor_maximize[data-for]', els =>
    els.map(el => el.getAttribute('data-for'))
       .filter(id => !document.getElementById(id)));
if (danglingInTemplate.length) {
    failures.push(`expand button points at missing id(s): ${danglingInTemplate.join(', ')}`);
}

// 9. The block editor's markup is generated in ui.js rather than the template,
//    so its data-for/id pairing is checked at the source instead.
const uiSource = fs.readFileSync(`${ROOT}/src/ui.js`, 'utf8');
const dataFors = [...uiSource.matchAll(/data-for="([^"]+)"/g)].map(m => m[1]);
const ids = new Set([...uiSource.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
for (const target of dataFors) {
    if (!ids.has(target)) {
        failures.push(`ui.js expand button data-for="${target}" has no matching id="${target}"`);
    }
}
if (!dataFors.length) failures.push('ui.js has no expand button at all');

// 10. The empty state must sit at the top of the column, not be pushed to the
//     bottom by an empty list that still claims all the free space.
await p.setViewportSize({ width: 1400, height: 900 });
const emptyPlacement = await p.evaluate(() => {
    const master = document.querySelector('.recall-master');
    const list = document.querySelector('[data-recall="list"]');
    const empty = document.querySelector('[data-recall="empty"]');
    master.style.height = '700px';
    list.innerHTML = '';
    empty.removeAttribute('hidden');
    const head = document.querySelector('.recall-master-head').getBoundingClientRect();
    const box = empty.getBoundingClientRect();
    const masterBox = master.getBoundingClientRect();
    return { gapBelowHeader: box.top - head.bottom, columnHeight: masterBox.height };
});
if (emptyPlacement.gapBelowHeader > 40) {
    failures.push(`empty state is ${Math.round(emptyPlacement.gapBelowHeader)}px below the header `
        + `in a ${Math.round(emptyPlacement.columnHeight)}px column — it is being pushed down`);
}

// 11. Metadata values must have room to read.
//
//     `auto-fit` COLLAPSES EMPTY TRACKS, so the column count follows the number of
//     items: a three-row sample proves nothing about an eight-row panel. The real
//     bug produced five 175px columns with 63px values wrapping to 13 lines, and
//     only appears with the full row set — so the full row set is used here.
await p.setViewportSize({ width: 1250, height: 1000 });
const metrics = await p.evaluate(() => {
    const rows = [
        ['Covers', 'messages 0-107'],
        ['New this time', 'the whole chat'],
        ['Created', '28/08/2026, 10:07:09 am'],
        ['Edited', 'never'],
        ['Generated with', 'Standard'],
        ['Hides', '43 messages'],
        ['Read', '49 messages, recorded'],
    ];
    document.querySelector('[data-recall="detail-body"]').removeAttribute('hidden');
    const meta = document.querySelector('[data-recall="detail-meta"]');
    meta.innerHTML = rows.map(([l, v]) =>
        '<div class="recall-meta-row"><span class="recall-meta-label">' + l + '</span>' +
        '<span class="recall-meta-value">' + v + '</span></div>').join('');
    return [...meta.querySelectorAll('.recall-meta-row')].map(row => {
        const value = row.querySelector('.recall-meta-value');
        const box = value.getBoundingClientRect();
        // line-height computes to "normal" here and parseFloat("normal") is NaN,
        // which made an earlier version of this check silently never fire.
        const style = getComputedStyle(value);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
        return {
            label: row.querySelector('.recall-meta-label').textContent,
            width: Math.round(box.width),
            lines: Math.round(box.height / lineHeight),
        };
    });
});
for (const m of metrics) {
    if (m.width < 120) failures.push(`meta value for "${m.label}" is only ${m.width}px wide`);
    if (m.lines > 1) failures.push(`meta value for "${m.label}" wraps to ${m.lines} lines`);
}

// 12. Long freeform guidance gets its own full-width block, not a metadata cell.
const guidanceWidth = await p.evaluate(() => {
    const block = document.querySelector('[data-recall="detail-guidance"]');
    block.removeAttribute('hidden');
    const text = document.querySelector('[data-recall="detail-guidance-text"]');
    text.textContent = "don't modify existing core memories; don't make new core "
        + 'memories out of the sex between Sylvia and Vasilica';
    return Math.round(text.getBoundingClientRect().width);
});
if (guidanceWidth < 400) {
    failures.push(`guidance block is only ${guidanceWidth}px wide - it needs the full pane`);
}

// 13. Token counts are painted into elements found by selector. A hook emitted
//     under one name and queried under another paints nothing, silently — there
//     is no error, just a blank where a number should be.
const uiSrc = fs.readFileSync(`${ROOT}/src/ui.js`, 'utf8');
const templateSrc = fs.readFileSync(`${ROOT}/templates/manager.html`, 'utf8');

// Attributes ui.js emits into generated markup, e.g. data-summary-size="..."
// Matches both data-x-size="v" and the valueless data-x-size form.
// Matches data-x-size="v" and the valueless data-x-size, but NOT the same
// name inside a selector like [data-x-size=...] — counting those made the
// two sets identical by construction and the check vacuous.
const emitted = new Set([...uiSrc.matchAll(/(?<!\[)\bdata-([a-z-]+-size)(?=[="\s>])/g)].map(m => m[1]));
// Attributes ui.js then queries, e.g. [data-summary-size="..."]
const queried = new Set([...uiSrc.matchAll(/\[data-([a-z-]+-size)[\]=]/g)].map(m => m[1]));

for (const name of queried) {
    if (!emitted.has(name)) failures.push(`ui.js queries [data-${name}] but never emits it`);
}
for (const name of emitted) {
    if (!queried.has(name)) failures.push(`ui.js emits data-${name} but never paints into it`);
}
if (!emitted.size) failures.push('no token-count hooks found in ui.js at all');

// The blocks total lives in the template rather than generated markup.
if (uiSrc.includes('data-recall="blocks-total"') && !templateSrc.includes('data-recall="blocks-total"')) {
    failures.push('ui.js paints [data-recall="blocks-total"] but the template has no such element');
}

await browser.close();

if (failures.length) { console.log('FAIL:'); failures.forEach(f => console.log('  -', f)); process.exit(1); }
console.log('All 13 visibility, layout and editor-wiring checks pass.');
