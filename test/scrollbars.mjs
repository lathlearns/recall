/**
 * Recall — scrollbar gutter tests.
 *
 * The panes have to leave room for a scrollbar, and how much room depends on a
 * platform decision the stylesheet cannot see. A *classic* bar takes its width
 * out of the box, so `scrollbar-gutter: stable` reserves it and the pane only
 * adds a few pixels of gap. An *overlay* bar has no width at all and paints on
 * top of the content; `scrollbar-gutter` is specified to ignore those, so the
 * only thing between the bar and the pane's right-hand column of token counts
 * and action buttons is padding the pane puts there itself.
 *
 * The overlay case is the one that shipped broken, and it is the one this file
 * is really for. Conveniently it is also the one headless Chromium can speak to:
 * it lays out no scrollbar at all, so it *is* an overlay platform rather than a
 * simulation of one, and the pane can be measured against a bar that would be
 * drawn over it.
 *
 * The classic case cannot be exercised here. Headless Chromium reports a
 * zero-width scrollbar under every configuration — `overflow-y: scroll`,
 * `scrollbar-width: auto`, an explicit `::-webkit-scrollbar { width: 15px }` —
 * and a headed browser will not launch in the environment these tests run in. So
 * the measurement's classic answer is not asserted; only the mapping from that
 * answer to a gutter is, by handing `applyScrollbarGutter` the answer directly.
 * That gap is why the function takes the measurement as a parameter at all.
 *
 * Run:  npx playwright install chromium   (once)
 *       node test/scrollbars.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(`${ROOT}/style.css`, 'utf8');
const source = fs.readFileSync(`${ROOT}/src/scrollbars.js`, 'utf8');

/**
 * The widest a Firefox overlay bar gets on Windows: it rests at about 10px and
 * fattens to about this under the pointer. Content closer than this to the
 * pane's edge is content the user watches disappear when they reach for the
 * scrollbar, which is the complaint that prompted all of this.
 */
const HOVERED_OVERLAY_WIDTH = 17;

const theme = `:root{
--SmartThemeBodyColor:#ddd;--SmartThemeEmColor:#999;--SmartThemeQuoteColor:#e18a24;
--SmartThemeBorderColor:rgba(255,255,255,.22);--black30a:rgba(0,0,0,.3);
--mainFontSize:15px;--mainFontFamily:sans-serif;}
html,body{margin:0;padding:0;}
*,*::before,*::after{box-sizing:border-box;}
/* A pane of a fixed height holding more than fits, i.e. one that scrolls. The
   filler is flex-locked because the pane is a flex column, where a plain tall
   child would simply be squashed to fit and nothing would overflow. */
.recall-settings{height:300px;}
.filler{flex:0 0 900px;}`;

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${theme}</style><style>${css}</style></head><body>
<div class="recall-manager"><div class="recall-pane recall-pane-active">
<div class="recall-settings">
    <div class="recall-section"><div class="recall-section-head">
        <h4 class="recall-section-title">Summary prompt</h4>
        <span class="recall-badge">Global</span>
    </div></div>
    <div class="filler"></div>
</div></div></div>
</body></html>`;

const failures = [];
const browser = await chromium.launch();

/**
 * Loads the page and reports what the settings pane ended up with. `overlay`
 * is passed straight through to `applyScrollbarGutter`; leave it undefined to
 * let the module measure the platform for itself.
 */
async function measure(overlay) {
    const page = await browser.newPage({ viewport: { width: 1244, height: 1034 } });
    await page.setContent(html);

    // The module is ES, side-effect free and imports nothing, so it runs here as
    // written rather than through a copy that could drift from it.
    await page.addScriptTag({
        type: 'module',
        content: `${source}
            window.__recall = { detected: usesOverlayScrollbars() };
            ${overlay === undefined ? 'applyScrollbarGutter();' : `applyScrollbarGutter(${overlay});`}`,
    });

    const result = await page.evaluate(width => {
        const pane = document.querySelector('.recall-settings');
        const style = getComputedStyle(pane);
        const box = pane.getBoundingClientRect();
        const paddingBoxRight = box.left + pane.clientWidth;
        const barStartsAt = paddingBoxRight - width;

        const intruders = [];
        for (const el of pane.querySelectorAll('*')) {
            const b = el.getBoundingClientRect();
            if (!b.width && !b.height) continue;
            if (b.right > barStartsAt + 0.5) {
                intruders.push(`${el.className || el.tagName} ends at ${Math.round(b.right)}, bar starts at ${Math.round(barStartsAt)}`);
            }
        }

        return {
            detected: window.__recall.detected,
            paddingRight: parseFloat(style.paddingRight),
            gutterProperty: style.scrollbarGutter,
            scrolls: pane.scrollHeight > pane.clientHeight,
            intruders,
        };
    }, HOVERED_OVERLAY_WIDTH);

    await page.close();
    return result;
}

// 1. The harness has to actually scroll, or everything below measures nothing.
const measured = await measure(undefined);

if (!measured.scrolls) {
    failures.push('the settings pane did not overflow, so no scrollbar case was exercised');
}

// 2. This engine lays out no scrollbar, so the probe must say so. If this ever
//    starts failing, headless Chromium has grown classic bars and the overlay
//    assertions below are no longer testing what they claim to.
if (!measured.detected) {
    failures.push('headless Chromium reported a scrollbar with layout width — the overlay checks below are now vacuous');
}

// 3. Overlay platforms. The bar costs no layout width and paints over the pane,
//    so the padding is the only thing keeping content out from under it.
const overlay = await measure(true);

if (overlay.paddingRight < HOVERED_OVERLAY_WIDTH) {
    failures.push(
        `an overlay bar gets ${overlay.paddingRight}px of clearance, less than the ${HOVERED_OVERLAY_WIDTH}px `
        + 'it occupies when hovered — it will cover the pane\'s right-hand column',
    );
}
if (overlay.intruders.length) {
    failures.push(`content sits where an overlay bar would be drawn — ${overlay.intruders.join('; ')}`);
}
if (overlay.gutterProperty !== 'auto') {
    failures.push(
        `an overlay pane asked for scrollbar-gutter: ${overlay.gutterProperty} on top of padding already sized `
        + 'for the bar — a browser that honoured it would leave two gutters of dead space',
    );
}

// 4. Classic platforms take the narrow gutter and let scrollbar-gutter reserve
//    the bar's own width. Only the mapping is checked; see the header.
const classic = await measure(false);

if (!(classic.paddingRight > 0)) {
    failures.push(`a classic pane got ${classic.paddingRight}px of gap, so its content sits against the bar`);
}
if (!(classic.paddingRight < overlay.paddingRight)) {
    failures.push(
        `a classic pane reserved ${classic.paddingRight}px, no less than the overlay case — the bar's own `
        + 'width is being paid for twice',
    );
}
if (classic.gutterProperty !== 'stable') {
    failures.push(`a classic pane did not ask for a stable gutter (got ${classic.gutterProperty}), so it will reflow when its content passes the fold`);
}

// 5. The stylesheet has to stand on its own if the measurement never runs — if
//    init throws before reaching it, the panes still need a gutter.
const page = await browser.newPage({ viewport: { width: 1244, height: 1034 } });
await page.setContent(html);
const unmeasured = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.recall-settings'));
    return { padding: parseFloat(style.paddingRight), gutter: style.scrollbarGutter };
});
await page.close();

if (!(unmeasured.padding > 0)) {
    failures.push(`without the measurement the pane falls back to ${unmeasured.padding}px of gutter, i.e. none`);
}
if (unmeasured.gutter !== 'stable') {
    failures.push(`without the measurement the pane falls back to scrollbar-gutter: ${unmeasured.gutter}`);
}

await browser.close();

if (failures.length) {
    console.error('Scrollbar gutter checks failed:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}

console.log('All scrollbar gutter checks pass (overlay measured, classic mapped).');
