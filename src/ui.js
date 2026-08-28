/**
 * Recall — the drawer strip and the manager modal.
 *
 * Two surfaces. The drawer is the at-a-glance view available without opening
 * anything; the modal is everything else. ST's Popup is full-screen on mobile and
 * a large centered dialog on desktop, which is the only thing that behaves sanely
 * in both places without maintaining a second layout.
 *
 * All styling goes through ST's theme tokens. Nothing here hardcodes a colour.
 */

import { chat, getMaxContextTokens } from '../../../../../script.js';
import { renderExtensionTemplateAsync, extension_settings } from '../../../../extensions.js';
import { Popup, POPUP_TYPE } from '../../../../popup.js';

import {
    getSettings,
    saveSettings,
    resolveBlocks,
    saveGlobalBlocks,
    saveOverrideBlocks,
    startOverride,
    endOverride,
    resyncOverride,
    restoreDefaultBlocks,
    makeEmptyBlock,
    isOverriding,
    getAvatarKey,
} from './settings.js';
import {
    getSummaries,
    getSummaryById,
    getActiveSummary,
    setActiveSummary,
    deleteSummary,
    unhideIndices,
    reanchorSummary,
    persist,
} from './store.js';
import { checkCoverage, syncToSummary, transferHideRecord } from './coverage.js';
import { summarizeNow, regenerateSummary, previewRequest, resolveSourceIndices, RecallError, isGenerating } from './generate.js';
import { getLastUsage, getThresholdTokens } from './nudge.js';
import { isLegacyFallbackActive, getLegacyMemory } from './legacy.js';
import { listProfiles, getActiveProfile, describeTarget, isConnectionManagerAvailable } from './connection.js';
import { previewContextBlocks } from './context-blocks.js';
import { escapeHtml, formatTimestamp, formatTokens, clampNumber } from './util.js';

const EXTENSION_PATH = 'third-party/recall';

/** @type {JQuery<HTMLElement>|null} */
let drawerRoot = null;

/** @type {Popup|null} */
let managerPopup = null;
/** @type {HTMLElement|null} */
let managerRoot = null;

/** Manager working state. Reset every time the modal opens. */
let selectedId = null;
let draftContent = null;
let draftName = null;
let draftBlocks = null;

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export async function initDrawer({ onSummarize }) {
    const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'templates/drawer');
    $('#extensions_settings2').append(html);
    drawerRoot = $('#recall_drawer');

    drawerRoot.find('[data-recall="summarize-now"]').on('click', () => onSummarize());
    drawerRoot.find('[data-recall="open-manager"]').on('click', () => openManager({ onSummarize }));

    refreshDrawer();
}

export function refreshDrawer() {
    if (!drawerRoot?.length) {
        return;
    }

    const active = getActiveSummary();
    const onFallback = isLegacyFallbackActive();

    drawerRoot.find('[data-recall="active-name"]')
        .text(active
            ? (active.name || 'Untitled')
            : (onFallback ? 'Built-in summary (stand-in)' : 'None'))
        .toggleClass('recall-dim', !active);

    drawerRoot.find('[data-recall="active-coverage"]')
        .text(active
            ? describeCoverage(active)
            : (onFallback ? 'from the built-in Summarize' : '—'));

    drawerRoot.find('[data-recall="context-usage"]').text(describeUsage());

    const notice = drawerRoot.find('[data-recall="strip-notice"]');
    const usage = getLastUsage();

    if (usage?.crossed) {
        notice
            .text('Context is filling up — a good moment to look for a stopping point.')
            .attr('hidden', null);
    } else {
        notice.attr('hidden', 'hidden');
    }

    drawerRoot.find('[data-recall="summarize-now"]').toggleClass('disabled', isGenerating());
}

function describeCoverage(summary) {
    const range = `Messages ${summary.coversFrom}–${summary.coversTo}`;
    return summary.stale ? `${range} (stale)` : range;
}

function describeUsage() {
    const usage = getLastUsage();
    if (!usage) {
        return '—';
    }
    const percent = usage.limit > 0 ? Math.round((usage.usage / usage.limit) * 100) : 0;
    return `${formatTokens(usage.usage)} / ${formatTokens(usage.limit)} (${percent}%)`;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export async function openManager({ onSummarize } = {}) {
    if (managerPopup) {
        return;
    }

    const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'templates/manager');
    const container = document.createElement('div');
    container.innerHTML = html;
    managerRoot = container.firstElementChild;

    resetDraft();
    selectedId = getActiveSummary()?.id ?? getSummaries()[0]?.id ?? null;

    wireManager({ onSummarize });
    renderAll();

    managerPopup = new Popup(managerRoot, POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: true,
        onClosing: guardUnsaved,
        onClose: () => {
            managerPopup = null;
            managerRoot = null;
            resetDraft();
        },
    });

    await managerPopup.show();
}

function resetDraft() {
    draftContent = null;
    draftName = null;
    draftBlocks = null;
}

/**
 * The unsaved-changes guard. Returning false cancels the close.
 */
async function guardUnsaved() {
    if (!isDetailDirty() && !areBlocksDirty()) {
        return true;
    }

    const what = [];
    if (isDetailDirty()) {
        what.push('the summary you were editing');
    }
    if (areBlocksDirty()) {
        what.push('the summary prompt');
    }

    // Popup.show.confirm resolves to POPUP_RESULT, so coerce: onClosing treats any
    // falsy return as "cancel the close".
    return !!await Popup.show.confirm(
        'Discard unsaved changes?',
        `You have unsaved changes to ${what.join(' and ')}. Closing now loses them.`,
    );
}

function q(selector) {
    return managerRoot?.querySelector(selector) ?? null;
}

function qa(selector) {
    return managerRoot ? Array.from(managerRoot.querySelectorAll(selector)) : [];
}

function on(selector, event, handler) {
    const element = q(selector);
    element?.addEventListener(event, handler);
}

function wireManager({ onSummarize }) {
    // Tabs
    for (const tab of qa('[data-recall-tab]')) {
        tab.addEventListener('click', () => {
            const name = tab.dataset.recallTab;
            for (const other of qa('[data-recall-tab]')) {
                other.classList.toggle('recall-tab-active', other === tab);
            }
            for (const pane of qa('[data-recall-pane]')) {
                const isActive = pane.dataset.recallPane === name;
                pane.classList.toggle('recall-pane-active', isActive);
                pane.toggleAttribute('hidden', !isActive);
            }
        });
    }

    on('[data-recall="summarize-now"]', 'click', async () => {
        if (onSummarize) {
            await onSummarize();
        }
        renderAll();
    });

    on('[data-recall="preview"]', 'click', showPreview);
    on('[data-recall="view-legacy"]', 'click', showLegacySummary);

    on('[data-recall="error-dismiss"]', 'click', () => hideBanner('error'));
    on('[data-recall="notice-dismiss"]', 'click', () => hideBanner('notice'));

    on('[data-recall="back"]', 'click', () => setView('list'));

    // Detail editing
    on('[data-recall="detail-name"]', 'input', event => {
        draftName = event.target.value;
        renderDirty();
    });
    on('[data-recall="detail-content"]', 'input', event => {
        draftContent = event.target.value;
        renderDirty();
    });
    on('[data-recall="detail-save"]', 'click', saveDetail);
    on('[data-recall="detail-revert"]', 'click', () => {
        resetDraft();
        renderDetail();
    });

    on('[data-recall="make-active"]', 'click', () => {
        if (!selectedId) {
            return;
        }
        setActiveSummary(selectedId);
        refreshDrawer();
        renderAll();
        showBanner('notice', 'That summary is now what {{recall}} resolves to. Message visibility was not changed.');
    });

    on('[data-recall="regenerate"]', 'click', doRegenerate);
    on('[data-recall="delete"]', 'click', doDelete);
    on('[data-recall="delete-stale"]', 'click', doDelete);
    on('[data-recall="reanchor"]', 'click', doReanchor);
    on('[data-recall="sync"]', 'click', doSync);

    // Settings
    wireSettings();
}

function setView(view) {
    managerRoot?.setAttribute('data-recall-view', view);
}

function showBanner(kind, text) {
    const banner = q(`[data-recall="${kind}"]`);
    const label = q(`[data-recall="${kind}-text"]`);
    if (!banner || !label) {
        return;
    }
    label.textContent = text;
    banner.removeAttribute('hidden');
}

function hideBanner(kind) {
    q(`[data-recall="${kind}"]`)?.setAttribute('hidden', 'hidden');
}

function renderAll() {
    renderFallbackBanner();
    renderList();
    renderDetail();
    renderSettings();
}

/**
 * The standing condition: something other than a Recall summary is reaching the
 * prompt. Shown in both tabs, since the setting that governs it lives in one and
 * the consequence shows in the other.
 */
function renderFallbackBanner() {
    q('[data-recall="fallback-banner"]')?.toggleAttribute('hidden', !isLegacyFallbackActive());
}

// --- Master list ------------------------------------------------------------

function renderList() {
    const list = q('[data-recall="list"]');
    const empty = q('[data-recall="empty"]');
    if (!list || !empty) {
        return;
    }

    const summaries = getSummaries();
    const activeId = getActiveSummary()?.id ?? null;

    q('[data-recall="summary-count"]').textContent = summaries.length
        ? `${summaries.length}`
        : '';

    if (!summaries.length) {
        list.innerHTML = '';
        empty.removeAttribute('hidden');
        q('[data-recall="empty-fallback"]')?.toggleAttribute('hidden', !isLegacyFallbackActive());
        return;
    }

    empty.setAttribute('hidden', 'hidden');

    list.innerHTML = summaries.map(summary => {
        const badges = [];
        if (summary.id === activeId) {
            badges.push('<span class="recall-badge recall-badge-active">Active</span>');
        }
        if (summary.regeneratedFrom) {
            badges.push('<span class="recall-badge">Redo</span>');
        }
        if (summary.stale) {
            badges.push('<span class="recall-badge recall-badge-warn">Stale</span>');
        }

        return `
            <div class="recall-row-item ${summary.id === selectedId ? 'recall-row-selected' : ''}" data-recall-id="${escapeHtml(summary.id)}">
                <div class="recall-row-main">
                    <span class="recall-row-name">${escapeHtml(summary.name || 'Untitled')}</span>
                    <span class="recall-row-badges">${badges.join('')}</span>
                </div>
                <div class="recall-row-sub recall-dim">
                    Messages ${summary.coversFrom}–${summary.coversTo}
                    ${summary.newFrom > 0 ? ` · new from ${summary.newFrom}` : ''}
                </div>
            </div>`;
    }).join('');

    for (const row of qa('[data-recall-id]')) {
        row.addEventListener('click', async () => {
            if (isDetailDirty() && !(await confirmDiscardDetail())) {
                return;
            }
            resetDraft();
            selectedId = row.dataset.recallId;
            setView('detail');
            renderList();
            renderDetail();
        });
    }
}

/**
 * Parses "96-150" or "96 - 150". Deliberately strict: a silently misread range
 * would send the wrong material with no sign of it.
 * @param {string} value
 * @returns {{from: number, to: number}|null}
 */
function parseRange(value) {
    const match = String(value ?? '').trim().match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (!match) {
        return null;
    }
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
        return null;
    }
    return { from, to };
}

async function confirmDiscardDetail() {
    return await Popup.show.confirm(
        'Discard unsaved changes?',
        'You have unsaved edits to this summary. Switching away loses them.',
    );
}

// --- Detail -----------------------------------------------------------------

function currentSummary() {
    return selectedId ? getSummaryById(selectedId) : null;
}

function isDetailDirty() {
    const summary = currentSummary();
    if (!summary) {
        return false;
    }
    if (draftContent !== null && draftContent !== summary.content) {
        return true;
    }
    if (draftName !== null && draftName !== summary.name) {
        return true;
    }
    return false;
}

function renderDetail() {
    const placeholder = q('[data-recall="detail-placeholder"]');
    const body = q('[data-recall="detail-body"]');
    const summary = currentSummary();

    if (!summary) {
        placeholder?.removeAttribute('hidden');
        body?.setAttribute('hidden', 'hidden');
        return;
    }

    placeholder?.setAttribute('hidden', 'hidden');
    body?.removeAttribute('hidden');

    q('[data-recall="detail-name"]').value = draftName ?? summary.name ?? '';
    q('[data-recall="detail-content"]').value = draftContent ?? summary.content ?? '';

    const isActive = getActiveSummary()?.id === summary.id;
    const badges = [];
    if (isActive) {
        badges.push('<span class="recall-badge recall-badge-active">Active</span>');
    }
    if (summary.regeneratedFrom) {
        badges.push('<span class="recall-badge">Regenerated from another summary</span>');
    }
    if (summary.stale) {
        badges.push('<span class="recall-badge recall-badge-warn">Stale anchor</span>');
    }
    if (summary.seededFromLegacy) {
        badges.push('<span class="recall-badge">Continued the built-in summary</span>');
    }
    q('[data-recall="detail-badges"]').innerHTML = badges.join('');

    q('[data-recall="detail-meta"]').innerHTML = [
        ['Covers', `messages ${summary.coversFrom}–${summary.coversTo}`],
        ['New this time', summary.newFrom > 0 ? `from message ${summary.newFrom}` : 'the whole chat'],
        ['Created', formatTimestamp(summary.createdAt)],
        ['Edited', summary.editedAt ? formatTimestamp(summary.editedAt) : 'never'],
        ['Generated with', `${escapeHtml(summary.generatedWith?.setName || 'unknown')}${summary.generatedWith?.isOverride ? ' (character override)' : ''}`],
        ['Hides', summary.hiddenIndices?.length ? `${summary.hiddenIndices.length} message${summary.hiddenIndices.length === 1 ? '' : 's'}` : 'nothing'],
        ['Read', describeReadSet(summary)],
    ].map(([label, value]) => `
        <div class="recall-meta-row">
            <span class="recall-meta-label">${label}</span>
            <span class="recall-meta-value">${value}</span>
        </div>`).join('');

    q('[data-recall="stale-banner"]').toggleAttribute('hidden', !summary.stale);

    // "Old summaries can be regenerated" — flagged once, quietly, at the point of
    // use. Not blocked.
    const hasLater = getSummaries().some(s => s.createdAt > summary.createdAt && !s.regeneratedFrom);
    q('[data-recall="redo-banner"]').toggleAttribute('hidden', !hasLater);

    renderMismatch(summary, isActive);
    renderDirty();
}

/**
 * What a redo of this summary would actually replay. Coverage is a range; the read
 * set is what was in the buffer, and on any summary after the first those differ.
 */
function describeReadSet(summary) {
    const { exact, indices, extra } = resolveSourceIndices(summary);

    if (exact) {
        return `${indices.length} message${indices.length === 1 ? '' : 's'}, recorded`;
    }
    if (summary.sourceIndicesInferred) {
        return `${indices.length} message${indices.length === 1 ? '' : 's'}, as you specified`;
    }
    return `not recorded — a redo would replay all ${extra} in range`;
}

function renderMismatch(summary, isActive) {
    const banner = q('[data-recall="mismatch-banner"]');
    if (!banner) {
        return;
    }

    if (!isActive || summary.stale) {
        banner.setAttribute('hidden', 'hidden');
        return;
    }

    const { mismatch, toHide, toUnhide } = checkCoverage(summary);

    if (!mismatch) {
        banner.setAttribute('hidden', 'hidden');
        return;
    }

    const parts = [];
    if (toHide.length) {
        parts.push(`${toHide.length} message${toHide.length === 1 ? '' : 's'} this summary covers ${toHide.length === 1 ? 'is' : 'are'} still visible`);
    }
    if (toUnhide.length) {
        parts.push(`${toUnhide.length} message${toUnhide.length === 1 ? '' : 's'} past its coverage ${toUnhide.length === 1 ? 'is' : 'are'} hidden by another summary`);
    }

    q('[data-recall="mismatch-text"]').textContent = `Chat visibility does not match this summary: ${parts.join(', ')}.`;
    banner.removeAttribute('hidden');
}

function renderDirty() {
    q('[data-recall="detail-dirty"]')?.toggleAttribute('hidden', !isDetailDirty());
}

function saveDetail() {
    const summary = currentSummary();
    if (!summary) {
        return;
    }

    if (draftContent !== null) {
        summary.content = draftContent;
    }
    if (draftName !== null) {
        summary.name = draftName;
    }
    summary.editedAt = Date.now();

    resetDraft();
    persist({ immediate: true });
    refreshDrawer();
    renderAll();
}

async function doRegenerate() {
    const summary = currentSummary();
    if (!summary) {
        return;
    }

    hideBanner('error');

    let override = null;

    // A summary from before the read set was recorded can only be replayed from
    // its coverage range, which is very likely more than it read. Say so with the
    // real numbers, and let the range be corrected rather than merely confirmed.
    const { exact, rangeIndices } = resolveSourceIndices(summary);

    if (!exact) {
        const first = rangeIndices[0] ?? summary.coversFrom;
        const last = rangeIndices[rangeIndices.length - 1] ?? summary.coversTo;

        const answer = await Popup.show.input(
            'This summary did not record what it read',
            `It covers messages ${summary.coversFrom}–${summary.coversTo}, but only its range was stored, not the list. `
            + `Regenerating will replay all ${rangeIndices.length} messages in that range — including any an earlier `
            + 'summary had already hidden, which the original never saw.\n\n'
            + 'Accept the range below to send all of it, or narrow it to what this summary actually covered.',
            `${first}-${last}`,
        );

        if (answer === null) {
            return;
        }

        const parsed = parseRange(answer);
        if (!parsed) {
            showBanner('error', `"${answer}" is not a range. Use two message numbers separated by a dash, like 96-150.`);
            return;
        }

        override = rangeIndices.filter(i => i >= parsed.from && i <= parsed.to);
        if (!override.length) {
            showBanner('error', `No messages in ${parsed.from}–${parsed.to} are still in this chat.`);
            return;
        }

        // Keep what the user told us, so the next redo of this summary is exact.
        // Flagged as inferred: it is their statement, not a recording.
        summary.sourceIndices = [...override];
        summary.sourceIndicesInferred = true;
        persist({ immediate: true });
    }

    try {
        // Regeneration produces a sibling, never a replacement. Both persist, and
        // neither becomes active on its own — the user compares and picks.
        const sibling = await regenerateSummary(summary.id, override);
        selectedId = sibling.id;
        resetDraft();
        refreshDrawer();
        renderAll();
        showBanner('notice', 'Regenerated as a sibling. Both versions are kept and neither is active yet — read them, then use Make active on the one you want.');
    } catch (error) {
        reportError(error);
    }
}

async function doDelete() {
    const summary = currentSummary();
    if (!summary) {
        return;
    }

    const confirmed = await Popup.show.confirm(
        'Delete this summary?',
        `"${summary.name || 'Untitled'}" will be removed from the archive. This cannot be undone.`,
    );
    if (!confirmed) {
        return;
    }

    // A surviving regeneration sibling with no hide record of its own: offer the
    // transfer rather than unhiding, since one summary owns a hidden range.
    const sibling = getSummaries().find(s =>
        s.id !== summary.id
        && (s.regeneratedFrom === summary.id || s.id === summary.regeneratedFrom)
        && !(s.hiddenIndices?.length));

    let transferred = false;
    if (summary.hiddenIndices?.length && sibling) {
        const doTransfer = await Popup.show.confirm(
            'Transfer the hide record?',
            `"${sibling.name || 'Untitled'}" covers the same messages but owns no hide record. Transfer this summary's record to it instead of unhiding ${summary.hiddenIndices.length} message${summary.hiddenIndices.length === 1 ? '' : 's'}?`,
        );
        if (doTransfer) {
            await transferHideRecord(summary, sibling);
            transferred = true;
        }
    }

    if (!transferred && summary.hiddenIndices?.length) {
        const doUnhide = await Popup.show.confirm(
            'Unhide the messages it hid?',
            `This summary hid ${summary.hiddenIndices.length} message${summary.hiddenIndices.length === 1 ? '' : 's'}. Bring them back into view?`,
        );
        if (doUnhide) {
            await unhideIndices(summary.hiddenIndices);
        }
    }

    const { pointerMoved, newActive } = deleteSummary(summary.id);

    if (selectedId === summary.id) {
        selectedId = getSummaries()[0]?.id ?? null;
        setView('list');
    }
    resetDraft();
    refreshDrawer();
    renderAll();

    if (pointerMoved) {
        showBanner('notice', newActive
            ? `That was the active summary. "${newActive.name || 'Untitled'}" is active now.`
            : 'That was the active summary. There is no active summary now, so {{recall}} resolves to nothing.');
    }
}

async function doReanchor() {
    const summary = currentSummary();
    if (!summary) {
        return;
    }

    const answer = await Popup.show.input(
        'Re-anchor this summary',
        `Which message does this summary now end at? The chat currently has ${chat.length} message${chat.length === 1 ? '' : 's'} (0–${Math.max(0, chat.length - 1)}).`,
        String(Math.min(summary.coversTo, Math.max(0, chat.length - 1))),
    );

    if (answer === null || answer === undefined || answer === '') {
        return;
    }

    const index = Number(answer);
    if (!Number.isInteger(index) || index < 0 || index >= chat.length) {
        showBanner('error', `"${answer}" is not a message index in this chat.`);
        return;
    }

    reanchorSummary(summary.id, index);
    refreshDrawer();
    renderAll();
    showBanner('notice', `Re-anchored to message ${index}.`);
}

async function doSync() {
    const summary = currentSummary();
    if (!summary) {
        return;
    }

    const { hidden, unhidden } = await syncToSummary(summary);
    renderAll();
    refreshDrawer();

    const parts = [];
    if (hidden.length) {
        parts.push(`hid ${hidden.length}`);
    }
    if (unhidden.length) {
        parts.push(`unhid ${unhidden.length}`);
    }
    showBanner('notice', parts.length
        ? `Synced: ${parts.join(', ')} message${hidden.length + unhidden.length === 1 ? '' : 's'}.`
        : 'Nothing to sync.');
}

/**
 * Shows the built-in's summary, read-only.
 *
 * It was visible before only by accident — the macro in the help text was
 * expanding into it. Being able to read the text that is currently reaching the
 * prompt is genuinely useful, so it is a deliberate action now. Read-only, because
 * Recall does not write to `extra.memory` and an editable box would imply it does.
 */
async function showLegacySummary() {
    const text = getLegacyMemory();
    if (!text) {
        showBanner('notice', 'There is no built-in summary in this chat.');
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'recall-preview';
    wrapper.innerHTML = `
        <p class="recall-dim">
            Left by the built-in Summarize, stored in this chat's file. Recall reads it and
            never writes to it, so this is not editable here.
        </p>
        <div class="recall-editor-head">
            <span class="recall-editor-label">Currently standing in for a Recall summary</span>
            <i class="editor_maximize fa-solid fa-maximize right_menu_button"
                data-for="recall_legacy_view" title="Expand the editor"></i>
        </div>
        <textarea id="recall_legacy_view" class="text_pole textarea_compact recall-preview-text"
            rows="20" readonly></textarea>`;

    wrapper.querySelector('#recall_legacy_view').value = text;

    await new Popup(wrapper, POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: true,
    }).show();
}

/**
 * Shows the exact request Summarize now would send.
 *
 * The two messages are shown separately and labelled, because which half a piece
 * of text lands in is the thing being checked: reference material belongs in the
 * user message alongside the chat, not in the system prompt with the instruction.
 */
async function showPreview() {
    hideBanner('error');

    let preview;
    try {
        preview = await previewRequest();
    } catch (error) {
        reportError(error);
        return;
    }

    const { tokens, included, indices, seededFromLegacy, target } = preview;
    const overBudget = tokens.buffer > tokens.available;

    const summaryLine = [
        `${indices.length} visible message${indices.length === 1 ? '' : 's'}`,
        included.length ? `reference material: ${included.join(', ')}` : 'no reference material',
        seededFromLegacy ? 'seeded from the built-in summary' : null,
    ].filter(Boolean).join(' · ');

    const wrapper = document.createElement('div');
    wrapper.className = 'recall-preview';
    wrapper.innerHTML = `
        <p class="recall-dim">${escapeHtml(target)}</p>
        <p class="recall-dim">${escapeHtml(summaryLine)}</p>
        <p class="${overBudget ? 'recall-preview-over' : 'recall-dim'}">
            System prompt ${tokens.system.toLocaleString()} tokens ·
            Chat and material ${tokens.buffer.toLocaleString()} ·
            Total ${tokens.total.toLocaleString()} ·
            Room for the buffer ${Math.max(0, tokens.available).toLocaleString()}
            ${overBudget ? '— over budget, this would be refused' : ''}
        </p>

        <div class="recall-editor-head">
            <span class="recall-editor-label">System message — the assembled prompt blocks</span>
            <i class="editor_maximize fa-solid fa-maximize right_menu_button"
                data-for="recall_preview_system" title="Expand the editor"></i>
        </div>
        <textarea id="recall_preview_system" class="text_pole textarea_compact monospace recall-preview-text"
            rows="8" readonly></textarea>

        <div class="recall-editor-head">
            <span class="recall-editor-label">User message — reference material, previous summary, then the chat</span>
            <i class="editor_maximize fa-solid fa-maximize right_menu_button"
                data-for="recall_preview_buffer" title="Expand the editor"></i>
        </div>
        <textarea id="recall_preview_buffer" class="text_pole textarea_compact monospace recall-preview-text"
            rows="16" readonly></textarea>`;

    // Assigned rather than interpolated: the buffer contains the whole chat, and
    // building it into an HTML string is how a stray sequence in someone's
    // roleplay becomes markup.
    wrapper.querySelector('#recall_preview_system').value = preview.systemPrompt;
    wrapper.querySelector('#recall_preview_buffer').value = preview.buffer;

    await new Popup(wrapper, POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: true,
    }).show();
}

function reportError(error) {
    if (error instanceof RecallError) {
        showBanner('error', error.message);
        return;
    }
    console.error('[Recall]', error);
    showBanner('error', `Something went wrong: ${error?.message ?? error}`);
}

// --- Settings ---------------------------------------------------------------

function workingBlocks() {
    if (draftBlocks === null) {
        draftBlocks = structuredClone(resolveBlocks().blocks);
    }
    return draftBlocks;
}

function areBlocksDirty() {
    if (draftBlocks === null) {
        return false;
    }
    return JSON.stringify(draftBlocks) !== JSON.stringify(resolveBlocks().blocks);
}

function wireSettings() {
    const settings = getSettings();

    bindCheckbox('auto-hide', 'autoHide');
    bindCheckbox('blocking', 'blocking');
    bindCheckbox('nudge-enabled', 'nudgeEnabled');
    bindCheckbox('deep-integrity', 'deepIntegrityCheck');
    bindCheckbox('legacy-fallback', 'legacyFallback', () => { renderAll(); refreshDrawer(); });
    bindCheckbox('summary-alias', 'summaryAlias', renderAliasStatus);

    bindNumber('tail-pin', 'tailPin', 0, 200);
    bindNumber('nudge-threshold', 'nudgeThreshold', 0, 10_000_000, renderNudgeHint);
    bindNumber('response-reserve', 'responseReserve', 0, 1_000_000);
    bindNumber('output-budget', 'outputBudget', 0, 1_000_000);
    bindNumber('min-response', 'minResponseChars', 0, 100_000);

    bindText('framing-prefix', 'framingPrefix');
    bindText('framing-suffix', 'framingSuffix');

    bindText('model-override', 'modelOverride', renderProfile);
    bindNumber('profile-context', 'profileContextSize', 0, 10_000_000);
    bindCheckbox('profile-preset', 'profileUsePreset');

    on('[data-recall="profile"]', 'change', event => {
        getSettings().profileId = event.target.value;
        saveSettings();
        renderProfile();
    });

    on('[data-recall="advanced-toggle"]', 'click', () => {
        const advanced = q('[data-recall="advanced"]');
        const hidden = advanced.hasAttribute('hidden');
        advanced.toggleAttribute('hidden', !hidden);
        q('[data-recall="advanced-toggle"]').classList.toggle('recall-open', hidden);
    });

    on('[data-recall="add-block"]', 'click', () => {
        workingBlocks().push(makeEmptyBlock());
        renderBlocks();
    });

    on('[data-recall="restore-defaults"]', 'click', async () => {
        const confirmed = await Popup.show.confirm(
            'Restore the default prompt?',
            'This replaces the current blocks with the ones Recall ships with.',
        );
        if (!confirmed) {
            return;
        }
        restoreDefaultBlocks();
        draftBlocks = null;
        renderSettings();
    });

    on('[data-recall="blocks-save"]', 'click', () => {
        if (isOverriding()) {
            saveOverrideBlocks(workingBlocks());
        } else {
            saveGlobalBlocks(workingBlocks());
        }
        draftBlocks = null;
        renderSettings();
    });

    on('[data-recall="blocks-discard"]', 'click', () => {
        draftBlocks = null;
        renderSettings();
    });

    on('[data-recall="toggle-override"]', 'click', async () => {
        if (isOverriding()) {
            const confirmed = await Popup.show.confirm(
                'Drop this character\'s override?',
                'Its own copy of the prompt is discarded and the character goes back to the global set.',
            );
            if (!confirmed) {
                return;
            }
            endOverride();
        } else {
            if (!startOverride()) {
                showBanner('error', 'Group chats have no character to attach an override to — they always use the global prompt.');
                return;
            }
        }
        draftBlocks = null;
        renderSettings();
    });

    on('[data-recall="resync-override"]', 'click', () => {
        resyncOverride();
        draftBlocks = null;
        renderSettings();
    });

    void settings;
}

function bindCheckbox(hook, key, after) {
    on(`[data-recall="${hook}"]`, 'change', event => {
        getSettings()[key] = !!event.target.checked;
        saveSettings();
        refreshDrawer();
        after?.();
    });
}

/**
 * The alias is conditional, and the condition is invisible from the checkbox
 * alone, so the panel says which state it is actually in rather than implying the
 * setting took effect.
 */
function renderAliasStatus() {
    const status = q('[data-recall="alias-status"]');
    if (!status) {
        return;
    }

    if (!getSettings().summaryAlias) {
        status.textContent = 'Only {{recall}} resolves. Your preset must name it directly.';
        return;
    }

    if (!isSummarizeDisabled()) {
        status.textContent = 'Not active: the built-in Summarize is enabled, so {{summary}} is left to it. '
            + 'Disable Summarize and reload for this to take effect — until then, use {{recall}}.';
        return;
    }

    status.textContent = 'Active: {{summary}} resolves to the Recall summary, so an unedited preset keeps working. '
        + 'Re-enabling the built-in Summarize hands the name straight back on the next reload.';
}

function isSummarizeDisabled() {
    return (extension_settings.disabledExtensions ?? []).includes('memory');
}

function bindNumber(hook, key, min, max, after) {
    on(`[data-recall="${hook}"]`, 'input', event => {
        const settings = getSettings();
        settings[key] = clampNumber(event.target.value, min, max, settings[key]);
        saveSettings();
        after?.();
    });
}

function bindText(hook, key, after) {
    on(`[data-recall="${hook}"]`, 'input', event => {
        getSettings()[key] = event.target.value;
        saveSettings();
        after?.();
    });
}

/**
 * The profile picker, the model override, and a plain sentence saying where
 * summarization will actually run — because "which model summarised this" is not
 * something the user should have to infer from a dropdown plus a text field.
 */
function renderProfile() {
    const select = q('[data-recall="profile"]');
    const settings = getSettings();

    if (select) {
        const profiles = listProfiles();
        const available = isConnectionManagerAvailable();

        select.innerHTML = [
            `<option value="">Main API — same connection as the chat</option>`,
            ...profiles.map(profile =>
                `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}${profile.model ? ` — ${escapeHtml(profile.model)}` : ''}</option>`),
        ].join('');

        select.value = settings.profileId ?? '';
        select.disabled = !available;
    }

    setValue('model-override', settings.modelOverride ?? '');
    setValue('profile-context', settings.profileContextSize ?? 0);
    setChecked('profile-preset', settings.profileUsePreset);

    // The model, context-size and preset controls only mean anything once a
    // profile is chosen, so they are not shown until one is.
    const usingProfile = !!getActiveProfile();
    for (const hook of ['profile-extras', 'profile-context-row', 'profile-preset-row']) {
        q(`[data-recall="${hook}"]`)?.toggleAttribute('hidden', !usingProfile);
    }

    const status = q('[data-recall="profile-status"]');
    if (status) {
        status.textContent = describeTarget();
    }
}

/**
 * The reference-material toggles, each showing how much it would actually
 * contribute — an enabled block that is empty for this character otherwise looks
 * identical to one that is working.
 */
function renderContextBlocks() {
    const container = q('[data-recall="context-blocks"]');
    if (!container) {
        return;
    }

    const enabled = getSettings().contextBlocks ?? {};
    const preview = previewContextBlocks();

    container.innerHTML = preview.map(block => `
        <label class="checkbox_label recall-row recall-context-row">
            <input type="checkbox" data-context-block="${escapeHtml(block.key)}" ${enabled[block.key] ? 'checked' : ''}>
            <span class="recall-context-name">${escapeHtml(block.label)}</span>
            <span class="recall-dim recall-context-size">${block.chars ? `${block.chars.toLocaleString()} chars` : 'empty here'}</span>
        </label>`).join('');

    for (const input of Array.from(container.querySelectorAll('[data-context-block]'))) {
        input.addEventListener('change', event => {
            getSettings().contextBlocks[input.dataset.contextBlock] = !!event.target.checked;
            saveSettings();
        });
    }
}

function renderSettings() {
    const settings = getSettings();

    setChecked('auto-hide', settings.autoHide);
    setChecked('blocking', settings.blocking);
    setChecked('nudge-enabled', settings.nudgeEnabled);
    setChecked('deep-integrity', settings.deepIntegrityCheck);
    setChecked('legacy-fallback', settings.legacyFallback);
    setChecked('summary-alias', settings.summaryAlias);

    setValue('tail-pin', settings.tailPin);
    setValue('nudge-threshold', settings.nudgeThreshold);
    setValue('response-reserve', settings.responseReserve);
    setValue('output-budget', settings.outputBudget);
    setValue('min-response', settings.minResponseChars);
    setValue('framing-prefix', settings.framingPrefix);
    setValue('framing-suffix', settings.framingSuffix);

    renderNudgeHint();
    renderAliasStatus();
    renderProfile();
    renderContextBlocks();
    renderScope();
    renderBlocks();
}

function setChecked(hook, value) {
    const element = q(`[data-recall="${hook}"]`);
    if (element) {
        element.checked = !!value;
    }
}

function setValue(hook, value) {
    const element = q(`[data-recall="${hook}"]`);
    if (element) {
        element.value = value;
    }
}

function renderNudgeHint() {
    const hint = q('[data-recall="nudge-threshold-hint"]');
    if (!hint) {
        return;
    }

    const threshold = getThresholdTokens();
    const limit = getMaxContextTokens();
    const percent = limit > 0 ? Math.round((threshold / limit) * 100) : 0;
    const auto = !(Number(getSettings().nudgeThreshold) > 0);

    hint.textContent = `tokens — ${auto ? 'auto: ' : ''}${threshold.toLocaleString()} of ${limit.toLocaleString()} (${percent}%)`;
}

function renderScope() {
    const scope = q('[data-recall="prompt-scope"]');
    const toggle = q('[data-recall="toggle-override"]');
    const help = q('[data-recall="override-help"]');
    const oos = q('[data-recall="oos-banner"]');
    const resolved = resolveBlocks();
    const hasCharacter = !!getAvatarKey();

    if (scope) {
        scope.textContent = resolved.isOverride ? 'This character only' : 'Global';
        scope.classList.toggle('recall-badge-warn', resolved.outOfSync);
    }

    oos?.toggleAttribute('hidden', !resolved.outOfSync);

    if (toggle) {
        toggle.textContent = resolved.isOverride ? 'Use the global prompt' : 'Override for this character';
        toggle.classList.toggle('disabled', !hasCharacter);
    }

    if (help) {
        help.textContent = hasCharacter
            ? (resolved.isOverride
                ? 'This character keeps its own copy and no longer tracks the global set.'
                : 'The same prompt serves every character. Override only if this one genuinely needs different instructions.')
            : 'Group chats have no character key, so they always use the global prompt.';
    }
}

function renderBlocks() {
    const container = q('[data-recall="blocks"]');
    if (!container) {
        return;
    }

    const blocks = workingBlocks();

    container.innerHTML = blocks.map((block, index) => `
        <div class="recall-block ${block.enabled ? '' : 'recall-block-off'}" data-block-index="${index}">
            <div class="recall-block-head">
                <label class="checkbox_label recall-block-enable">
                    <input type="checkbox" data-block-enabled ${block.enabled ? 'checked' : ''}>
                </label>
                <input class="text_pole recall-block-name" data-block-name value="${escapeHtml(block.name)}" placeholder="Block name">
                <div class="recall-block-buttons">
                    <div class="menu_button menu_button_icon" data-block-up title="Move up" ${index === 0 ? 'disabled' : ''}>
                        <i class="fa-solid fa-chevron-up"></i>
                    </div>
                    <div class="menu_button menu_button_icon" data-block-down title="Move down" ${index === blocks.length - 1 ? 'disabled' : ''}>
                        <i class="fa-solid fa-chevron-down"></i>
                    </div>
                    <div class="menu_button menu_button_icon" data-block-expand title="Show or hide the text">
                        <i class="fa-solid fa-pen"></i>
                    </div>
                    <!--
                        ST's native expand control. Its handler is delegated from document
                        and keyed on data-for, so each block's textarea needs a unique id.
                    -->
                    <div class="menu_button menu_button_icon editor_maximize"
                        data-for="recall_block_${index}" title="Expand the editor">
                        <i class="fa-solid fa-maximize"></i>
                    </div>
                    <div class="menu_button menu_button_icon recall-action-destructive" data-block-delete title="Delete block">
                        <i class="fa-solid fa-trash-can"></i>
                    </div>
                </div>
            </div>
            <div class="recall-block-summary recall-dim">${escapeHtml(blockPreview(block))}</div>
            <textarea id="recall_block_${index}" class="text_pole textarea_compact recall-block-content monospace" data-block-content rows="12" hidden>${escapeHtml(block.content)}</textarea>
        </div>`).join('');

    for (const element of Array.from(container.querySelectorAll('[data-block-index]'))) {
        const index = Number(element.dataset.blockIndex);

        element.querySelector('[data-block-enabled]').addEventListener('change', event => {
            blocks[index].enabled = !!event.target.checked;
            renderBlocks();
            renderBlocksDirty();
        });

        element.querySelector('[data-block-name]').addEventListener('input', event => {
            blocks[index].name = event.target.value;
            renderBlocksDirty();
        });

        element.querySelector('[data-block-content]').addEventListener('input', event => {
            blocks[index].content = event.target.value;
            renderBlocksDirty();
        });

        element.querySelector('[data-block-expand]').addEventListener('click', () => {
            const textarea = element.querySelector('[data-block-content]');
            const preview = element.querySelector('.recall-block-summary');
            const hidden = textarea.hasAttribute('hidden');
            textarea.toggleAttribute('hidden', !hidden);
            preview.toggleAttribute('hidden', hidden);
        });

        element.querySelector('[data-block-up]').addEventListener('click', () => {
            if (index === 0) {
                return;
            }
            [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]];
            renderBlocks();
            renderBlocksDirty();
        });

        element.querySelector('[data-block-down]').addEventListener('click', () => {
            if (index === blocks.length - 1) {
                return;
            }
            [blocks[index + 1], blocks[index]] = [blocks[index], blocks[index + 1]];
            renderBlocks();
            renderBlocksDirty();
        });

        element.querySelector('[data-block-delete]').addEventListener('click', async () => {
            const confirmed = await Popup.show.confirm(
                'Delete this block?',
                `"${blocks[index].name || 'Untitled'}" will be removed from the working copy. Nothing is saved until you press Save.`,
            );
            if (!confirmed) {
                return;
            }
            blocks.splice(index, 1);
            renderBlocks();
            renderBlocksDirty();
        });
    }

    renderBlocksDirty();
}

function blockPreview(block) {
    const text = (block.content ?? '').trim().replace(/\s+/g, ' ');
    if (!text) {
        return 'Empty';
    }
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function renderBlocksDirty() {
    q('[data-recall="blocks-dirty"]')?.toggleAttribute('hidden', !areBlocksDirty());
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toastNudge({ usage, limit, threshold }) {
    const percent = limit > 0 ? Math.round((usage / limit) * 100) : 0;
    toastr.info(
        `Context is at ${formatTokens(usage)} of ${formatTokens(limit)} (${percent}%), past your ${formatTokens(threshold)} mark. A good moment to start looking for a stopping point.`,
        'Recall',
        { timeOut: 10000, extendedTimeOut: 5000 },
    );
}
