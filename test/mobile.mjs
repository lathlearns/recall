/**
 * Recall — phone-width layout regression tests.
 *
 * Recall's own stylesheet is only half the layout. The other half comes from
 * SillyTavern's, and two of its rules actively fight a narrow screen:
 *
 *     .menu_button { width: min-content; }
 *     .text_pole   { width: 100%; }
 *
 * `width: min-content` sizes a button to its longest *word* rather than to its
 * label, so "Take the global copy again" renders as a five-line column of single
 * words at any screen size — ST hit this itself and patched it for its own popup
 * controls. On a phone, where the banner holding that button is 300px wide, the
 * result is unreadable. Separately, a flex column that forgets `min-width: 0`
 * cannot shrink below its longest summary name, so the summary list pushed its
 * own right edge — badges, selection border and all — off the side of the popup.
 *
 * Neither is visible from reading the CSS, and neither shows at desktop width,
 * so both need a real engine at a real phone size.
 *
 * The ST rules Recall is layered on are reproduced below rather than read out of
 * an install: the point is to pin the *contract* Recall is written against, so
 * that if ST changes it this fails here rather than on someone's phone.
 *
 * Run:  npx playwright install chromium   (once)
 *       node test/mobile.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(`${ROOT}/style.css`, 'utf8');
const manager = fs.readFileSync(`${ROOT}/templates/manager.html`, 'utf8');

/** The SillyTavern rules Recall's layout actually depends on. */
const stContract = `
*, *::before, *::after { box-sizing: border-box; }
body { font-family: var(--mainFontFamily); font-size: var(--mainFontSize); color: var(--SmartThemeBodyColor); }
.menu_button {
    color: var(--SmartThemeBodyColor);
    background-color: var(--SmartThemeBlurTintColor);
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 5px;
    padding: 3px 5px;
    width: min-content;
    cursor: pointer;
    margin: 5px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
}
.menu_button_icon { display: flex; align-items: center; width: fit-content; gap: 5px; }
.menu_button_icon span { font-size: calc(var(--mainFontSize) * 0.9); }
.text_pole {
    background-color: var(--black30a);
    color: var(--SmartThemeBodyColor);
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 5px;
    padding: 3px 5px;
    width: 100%;
    margin: 5px 0;
    height: fit-content;
}
.checkbox_label { display: flex; flex-direction: row; column-gap: 5px; align-items: baseline; }
/* Font Awesome cannot load here; give its icons the box they would occupy. */
.fa-solid { display: inline-block; width: 1.25em; height: 1.25em; }
/* popup.css and style.css, for a Popup opened with { large: true, wide: true }. */
.popup {
    width: 500px; padding: 4px 14px; border: 1px solid var(--SmartThemeBorderColor);
    display: flex; flex-direction: column;
    max-height: calc(100dvh - 2em); max-width: calc(100dvw - 2em); min-height: fit-content;
}
.large_dialogue_popup { height: 90dvh !important; max-width: 90dvw !important; }
.wide_dialogue_popup { min-width: var(--sheldWidth); }
.popup .popup-body { display: flex; flex-direction: column; overflow: hidden; width: min(100%, 100vw); height: 100%; padding: 1px; max-height: 95dvh; }
.popup .popup-content { margin-top: 10px; padding: 0 8px; overflow: hidden; flex-grow: 1; }
.popup.vertical_scrolling_dialogue_popup .popup-content { overflow-y: auto; }
`;

const theme = `:root{
--SmartThemeBodyColor:#ddd;--SmartThemeEmColor:#999;--SmartThemeQuoteColor:#e18a24;
--SmartThemeUnderlineColor:#bce7cf;--SmartThemeBorderColor:rgba(255,255,255,.22);
--SmartThemeBlurTintColor:rgba(23,23,26,.97);
--black30a:rgba(0,0,0,.3);--crimson70a:rgba(100,0,0,.7);
--mainFontSize:15px;--mainFontFamily:sans-serif;
/* A phone user almost always runs the chat at full width, which is what makes
   the popup's min-width the whole screen. */
--sheldWidth:100vw;}
html,body{margin:0;padding:0;}`;

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${stContract}</style><style>${theme}</style><style>${css}</style></head><body>
<dialog class="popup wide_dialogue_popup large_dialogue_popup vertical_scrolling_dialogue_popup left_aligned_dialogue_popup">
<div class="popup-body"><div class="popup-content">${manager}</div></div></dialog>
</body></html>`;

const failures = [];
const browser = await chromium.launch();

/** Fills the manager with content of the shape and length real use produces. */
function populate() {
    const q = s => document.querySelector(s);
    document.querySelector('dialog').showModal();

    const names = ['Chapter 3 — the long road north to Ashfall', 'Chapter 2', 'Opening'];
    q('[data-recall="list"]').innerHTML = names.map((name, i) => `
        <div class="recall-row-item ${i === 0 ? 'recall-row-selected' : ''}" data-recall-id="s${i}">
            <div class="recall-row-main">
                <span class="recall-row-name">${name}</span>
                <span class="recall-row-badges">${i === 0 ? '<span class="recall-badge recall-badge-active">Active</span>' : ''}</span>
            </div>
            <div class="recall-row-sub recall-dim">Messages 0–184 · new from 120 · 1,204 tokens</div>
        </div>`).join('');
    q('[data-recall="empty"]').setAttribute('hidden', 'hidden');

    q('[data-recall="detail-placeholder"]').setAttribute('hidden', 'hidden');
    q('[data-recall="detail-body"]').removeAttribute('hidden');
    q('[data-recall="detail-name"]').value = names[0];
    for (const key of ['error', 'fallback-banner', 'stale-banner', 'mismatch-banner', 'redo-banner', 'detail-dirty', 'oos-banner']) {
        q(`[data-recall="${key}"]`).removeAttribute('hidden');
    }
    q('[data-recall="mismatch-text"]').textContent =
        '42 messages this summary covers are still visible in the chat, so they are being sent twice.';
    q('[data-recall="error-text"]').textContent =
        'The summariser returned nothing usable. The connection profile may be pointing at a model that no longer exists.';

    // A summary being written, which is the widest the topbar ever gets: the
    // running button carries a clock and Stop appears beside it.
    const run = q('[data-recall="summarize-now"]');
    run.classList.add('recall-busy');
    run.querySelector('span').textContent = 'Summarizing… 1:07';
    q('[data-recall="preview"]').classList.add('disabled');
    q('[data-recall="stop"]').removeAttribute('hidden');

    const thinking = 'The user wants continuity, relationships and open threads. Let me work '
        + 'through what actually changed in this stretch. Messages 96-120 cover the ford argument '
        + 'and the road east, and the writ Mara took at 102 is still an open thread.';

    q('[data-recall="live"]').removeAttribute('hidden');
    q('[data-recall="live-label"]').textContent = 'Writing the summary…';
    q('[data-recall="live-size"]').textContent = '412 tokens';
    q('[data-recall="live-body"]').textContent =
        '## Continuity\n\nMara and Tev are still travelling east along the Vensk road, four days '
        + 'out from Halloway. Mara is carrying the sealed writ she took from the courier.';
    q('[data-recall="think"]').removeAttribute('hidden');
    q('[data-recall="think-summary"]').textContent = 'Thought for 0:31 · 624 tokens';
    q('[data-recall="think-body"]').textContent = thinking;

    // And the same reasoning kept on a finished summary, expanded.
    q('[data-recall="detail-think"]').removeAttribute('hidden');
    q('[data-detail-think-size]').textContent = '624 tokens';
    const storedThink = q('[data-recall="detail-think-body"]');
    storedThink.removeAttribute('hidden');
    storedThink.textContent = thinking;

    q('[data-recall="toggle-override"]').textContent = 'Stop using a character-specific prompt';
    q('[data-recall="restore-defaults"]').textContent = 'Restore defaults';
    q('[data-recall="blocks"]').innerHTML = `
        <div class="recall-block"><div class="recall-block-head">
            <label class="checkbox_label recall-block-enable"><input type="checkbox" checked></label>
            <input class="text_pole recall-block-name" value="Continuity and consistency">
            <div class="recall-block-buttons">${'<div class="menu_button menu_button_icon"><i class="fa-solid"></i></div>'.repeat(5)}</div>
        </div></div>`;
}

const setPane = (page, name) => page.evaluate(wanted => {
    for (const pane of document.querySelectorAll('[data-recall-pane]')) {
        const active = pane.dataset.recallPane === wanted;
        pane.classList.toggle('recall-pane-active', active);
        pane.toggleAttribute('hidden', !active);
    }
}, name);

const setView = (page, view) => page.evaluate(v =>
    document.querySelector('.recall-manager').setAttribute('data-recall-view', v), view);

/** Anything rendering past the right edge of the pane that holds it. */
const escapees = (page, pane) => page.evaluate(name => {
    const host = document.querySelector(`[data-recall-pane="${name}"]`).getBoundingClientRect();
    const out = [];
    for (const el of document.querySelectorAll(`[data-recall-pane="${name}"] *`)) {
        const box = el.getBoundingClientRect();
        if (!box.width && !box.height) continue;
        if (box.right > host.right + 1) {
            out.push(`${el.getAttribute('data-recall') || el.className}: right=${Math.round(box.right)}, pane ends at ${Math.round(host.right)}`);
        }
    }
    return out;
}, pane);

/**
 * Buttons taller than one line of their own text. Such a button overflows
 * nothing and reports no error — it has simply become a column of one-word
 * lines, which is what `width: min-content` does to a label with a space in it.
 */
const wordStacked = page => page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.recall-manager .menu_button')) {
        const box = el.getBoundingClientRect();
        if (!box.height) continue;
        const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
        if (box.height > line * 1.8) {
            out.push(`${el.getAttribute('data-recall') || el.textContent.trim()} (${Math.round(box.width)}x${Math.round(box.height)})`);
        }
    }
    return out;
});

// --------------------------------------------------------------------------
// Phone
// --------------------------------------------------------------------------

const phone = await browser.newPage({ viewport: { width: 375, height: 812 } });
await phone.setContent(html);
await phone.evaluate(populate);

// 1. Nothing may render outside the pane holding it. The summary list did, by
//    fifteen pixels, taking the active badge and the selection border with it.
for (const [pane, view] of [['archive', 'list'], ['archive', 'detail'], ['settings', 'detail']]) {
    await setPane(phone, pane);
    await setView(phone, view);
    for (const escaped of await escapees(phone, pane)) {
        failures.push(`at 375px, ${pane}/${view} overflows its pane — ${escaped}`);
    }
}

// 1b. The same rule for everything outside the panes.
//
//     The topbar, the guidance field and the pinned fallback banner are siblings
//     of the panes, not children, so the per-pane check above never looked at
//     them — and the topbar is the row most likely to burst: it holds three
//     buttons at once while a summary is running, one of them carrying a clock.
for (const view of ['list', 'detail']) {
    await setView(phone, view);
    for (const escaped of await phone.evaluate(() => {
        const root = document.querySelector('.recall-manager').getBoundingClientRect();
        const out = [];
        for (const el of document.querySelectorAll('.recall-manager *')) {
            const box = el.getBoundingClientRect();
            if (!box.width && !box.height) continue;
            if (box.right > root.right + 1) {
                out.push(`${el.getAttribute('data-recall') || el.className}: right=${Math.round(box.right)}, manager ends at ${Math.round(root.right)}`);
            }
        }
        return out;
    })) {
        failures.push(`at 375px, ${view} overflows the manager — ${escaped}`);
    }
}

// 2. No button may be taller than a single line of its own text.
await setPane(phone, 'settings');
for (const button of await wordStacked(phone)) {
    failures.push(`at 375px a button label broke into a column of words — ${button}`);
}

// 3. The prompt block's name field lost its width to five fixed-size icon
//    buttons — 43px at 320px wide, narrower than the word it was holding.
const nameWidth = await phone.evaluate(() =>
    Math.round(document.querySelector('.recall-block-name').getBoundingClientRect().width));
if (nameWidth < 120) {
    failures.push(`the prompt block name field is only ${nameWidth}px wide at 375px`);
}

// 4. A number field and the words naming its unit stay on one line together.
//    Broken apart, the row read as "Keep the newest / 12 / messages visible".
const splitUnits = await phone.evaluate(() => {
    const out = [];
    for (const unit of document.querySelectorAll('.recall-field-unit')) {
        const box = unit.getBoundingClientRect();
        const field = unit.querySelector('input').getBoundingClientRect();
        if (box.height > field.height * 1.6) {
            out.push(`${unit.querySelector('input').id} (${Math.round(box.width)}x${Math.round(box.height)})`);
        }
    }
    return out;
});
for (const unit of splitUnits) {
    failures.push(`a number field wrapped away from its unit at 375px — ${unit}`);
}

// 5. Touch targets. ST builds for a mouse; the collapsed layout has to be
//    usable with a thumb, and the back control was 19px tall.
await setPane(phone, 'archive');
const small = await phone.evaluate(() => {
    const out = [];
    const seen = new Set();
    const targets = [
        ['.recall-back', 'back control'],
        ['.recall-manager .menu_button', 'button'],
        ['.recall-manager .checkbox_label:not(.recall-block-enable)', 'checkbox row'],
        ['.recall-tab', 'tab'],
        // Both reasoning folds. They are divs with role="button", so nothing
        // gives them a usable height unless Recall's own stylesheet does.
        ['.recall-think-toggle', 'reasoning fold'],
    ];
    for (const [selector, label] of targets) {
        for (const el of document.querySelectorAll(selector)) {
            const box = el.getBoundingClientRect();
            if (!box.height || seen.has(el)) continue;
            seen.add(el);
            if (box.height < 34) {
                out.push(`${label} ${el.getAttribute('data-recall') || el.textContent.trim().slice(0, 24)}: ${Math.round(box.height)}px tall`);
            }
        }
    }
    return out;
});
for (const target of small) {
    failures.push(`touch target below 34px at 375px — ${target}`);
}

// 6. The nav-stack collapse has to swap the panes, not show both or neither.
const swap = await phone.evaluate(() => {
    const root = document.querySelector('.recall-manager');
    const shown = () => [
        getComputedStyle(document.querySelector('.recall-master')).display !== 'none',
        getComputedStyle(document.querySelector('.recall-detail')).display !== 'none',
    ].join();
    root.setAttribute('data-recall-view', 'list');
    const list = shown();
    root.setAttribute('data-recall-view', 'detail');
    return { list, detail: shown() };
});
if (swap.list !== 'true,false') failures.push(`list view shows master/detail as ${swap.list}`);
if (swap.detail !== 'false,true') failures.push(`detail view shows master/detail as ${swap.detail}`);

// 7. The dismissable banners live inside a pane and scroll away with it; the
//    fallback banner is deliberately the exception and stays pinned. Pinned
//    above everything, two banners took the settings reading window from 553px
//    to 332px and held it there for as long as they were showing.
const placement = await phone.evaluate(() => {
    const stack = document.querySelector('[data-recall="banners"]');
    const fallback = document.querySelector('[data-recall="fallback-banner"]');
    return {
        stackInPane: !!stack?.closest('[data-recall-pane]'),
        fallbackInPane: !!fallback?.closest('[data-recall-pane]'),
        stackHolds: ['error', 'notice'].every(n => !!stack?.querySelector(`[data-recall="${n}"]`)),
    };
});
if (!placement.stackInPane) failures.push('the banner stack is not inside a pane');
if (!placement.stackHolds) failures.push('the banner stack does not hold both dismissable banners');
if (placement.fallbackInPane) failures.push('the fallback banner was moved into a pane — it is meant to stay pinned');

await setPane(phone, 'settings');
const scrollBehaviour = await phone.evaluate(() => {
    const pane = document.querySelector('.recall-pane-active');
    // The banner stack starts life in the archive pane; the tab handler moves it.
    pane.prepend(document.querySelector('[data-recall="banners"]'));
    const top = s => Math.round(document.querySelector(s).getBoundingClientRect().top);
    const before = { error: top('[data-recall="error"]'), fallback: top('[data-recall="fallback-banner"]') };
    pane.scrollTop = 200;
    const after = { error: top('[data-recall="error"]'), fallback: top('[data-recall="fallback-banner"]') };
    return {
        // A real scroller, not merely content that overflows visibly.
        scrollable: ['auto', 'scroll'].includes(getComputedStyle(pane).overflowY)
            && pane.scrollHeight > pane.clientHeight,
        errorMoved: before.error - after.error,
        fallbackMoved: before.fallback - after.fallback,
    };
});
if (!scrollBehaviour.scrollable) {
    failures.push('the active pane is not a scroll container at 375px');
}
if (scrollBehaviour.errorMoved < 150) {
    failures.push(`the error banner did not scroll with the pane (moved ${scrollBehaviour.errorMoved}px of 200)`);
}
if (scrollBehaviour.fallbackMoved !== 0) {
    failures.push(`the fallback banner scrolled away (moved ${scrollBehaviour.fallbackMoved}px) — it is meant to stay pinned`);
}

// 8. The move is done by ui.js on every tab switch. A stack that never follows
//    the pane would sit in whichever one the template happened to put it in.
const uiSrc = fs.readFileSync(`${ROOT}/src/ui.js`, 'utf8');
if (!/function moveBannersInto\b/.test(uiSrc)) {
    failures.push('ui.js no longer defines moveBannersInto');
}
if (!/data-recall-tab[\s\S]{0,1600}?moveBannersInto\(/.test(uiSrc)) {
    failures.push('the tab handler in ui.js does not move the banner stack into the new pane');
}

// --------------------------------------------------------------------------
// Desktop — none of the above may have been bought at its expense.
// --------------------------------------------------------------------------

const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await desktop.setContent(html.replace('--sheldWidth:100vw', '--sheldWidth:50vw'));
await desktop.evaluate(populate);

await setPane(desktop, 'settings');
for (const button of await wordStacked(desktop)) {
    failures.push(`at 1440px a button label broke into a column of words — ${button}`);
}

await setPane(desktop, 'archive');
await setView(desktop, 'detail');
const split = await desktop.evaluate(() => {
    const shown = s => getComputedStyle(document.querySelector(s)).display !== 'none';
    return { master: shown('.recall-master'), detail: shown('.recall-detail'), back: shown('.recall-back') };
});
if (!split.master || !split.detail) {
    failures.push('the desktop split view no longer shows both panes at once');
}
if (split.back) {
    failures.push('the mobile-only back control is showing at desktop width');
}

// Summary rows stay two lines — a name and its coverage line, neither wrapped.
const rowHeight = await desktop.evaluate(() =>
    Math.round(document.querySelector('.recall-row-item').getBoundingClientRect().height));
if (rowHeight > 60) {
    failures.push(`summary rows grew to ${rowHeight}px — the coverage line is wrapping`);
}

// Above the breakpoint the pane is not the scroller: the master list and the
// detail keep their own scroll areas, which is what makes the split work.
const desktopScrollers = await desktop.evaluate(() => {
    const overflow = s => getComputedStyle(document.querySelector(s)).overflowY;
    return {
        pane: overflow('.recall-pane-active'),
        list: overflow('.recall-list'),
        detail: overflow('.recall-detail'),
    };
});
if (desktopScrollers.pane === 'auto' || desktopScrollers.pane === 'scroll') {
    failures.push('the pane became the scroll container at desktop width, which breaks the split');
}
for (const [name, value] of [['list', desktopScrollers.list], ['detail', desktopScrollers.detail]]) {
    if (value !== 'auto' && value !== 'scroll') {
        failures.push(`the ${name} lost its own scroll area at desktop width (overflow-y: ${value})`);
    }
}

await browser.close();

if (failures.length) { console.log('FAIL:'); failures.forEach(f => console.log('  -', f)); process.exit(1); }
console.log('All phone-width layout checks pass.');
