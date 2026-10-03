/**
 * Recall — rebuilding a chat's summaries in batches.
 *
 * What is checked is everything around the model: where the batches fall, what
 * each one reads, what it builds on, and above all what a rebuild does to the
 * chat when it finishes and when it does not. A rebuild that stops halfway and
 * still rewrites visibility, or one that finishes and leaves old summaries owning
 * hides, does not throw — it just leaves a long chat quietly wrong.
 *
 * The real rebuild, store, coverage and settings modules run; generation is a
 * stand-in that writes a predictable summary, so no request is ever made. Same
 * throwaway-tree approach as reference-material.mjs.
 *
 * Run:  node test/rebuild.mjs
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'recall-rebuild-'));
const scripts = join(root, 'public', 'scripts');
const src = join(scripts, 'extensions', 'third-party', 'recall', 'src');

mkdirSync(src, { recursive: true });
cpSync('src', src, { recursive: true });

const stub = (path, body) => writeFileSync(join(root, path), body);

globalThis.document = { querySelector: () => null };

stub('public/script.js', `
export const chat = [];
export const chat_metadata = {};
export const characters = [];
export const this_chid = 0;
export async function saveChatConditional() {}
export async function saveMetadata() {}
export const saveSettingsDebounced = () => {};
export function getCurrentChatId() { return 'chat-1'; }
`);
stub('public/scripts/extensions.js', `
export const extension_settings = {};
export const saveMetadataDebounced = () => {};
`);
stub('public/scripts/utils.js', `
export function getStringHash(text) {
    let hash = 0;
    for (const ch of String(text)) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    return hash;
}
`);
stub('public/scripts/extensions/third-party/recall/src/tokens.js', `
export async function countTokens(text) { return Math.ceil(String(text ?? '').length / 4); }
`);

// Generation, replaced. Every batch records what it was given, and \`fits\` lets a
// test say how many messages a request can hold.
stub('public/scripts/extensions/third-party/recall/src/generate.js', `
import { chat } from '../../../../../script.js';
import { createSummaryRecord, addSummary } from './store.js';

export class RecallError extends Error {
    constructor(message, { kind = 'error' } = {}) { super(message); this.kind = kind; }
}

export const calls = [];
export const control = { fits: Infinity, failOn: null, locked: false };

export function setRebuildLock(locked) { control.locked = locked; }
export function getActiveRun() { return null; }
export function cancelRun() { return false; }
export async function countMessageTokens(index) { return chat[index] ? 10 : 0; }
export async function measureRequestOverhead() { return { system: 100, reference: 0, available: 10000 }; }
export async function fitBatch(indices) { return Math.min(indices.length, control.fits); }

export async function summarizeBatch({ indices, basis, seed, rebuildId, step, steps, steeringNote }) {
    calls.push({ indices: [...indices], basis: basis?.id ?? null, basisContent: basis?.content ?? seed, step, steps, steeringNote });
    if (control.failOn === step) {
        control.failOn = null;
        throw new RecallError('The model returned an empty response.', { kind: 'empty-response' });
    }
    const coversTo = indices[indices.length - 1];
    const record = createSummaryRecord({
        name: 'Batch ' + step,
        content: 'summary through ' + coversTo,
        coversTo,
        newFrom: indices.find(i => i !== 0) ?? 0,
        builtOn: basis?.id ?? null,
        sourceIndices: [...indices],
        rebuildId,
        rebuildStep: step,
        rebuildSteps: steps,
    });
    addSummary(record, { makeActive: false });
    return record;
}
`);

const load = path => import(pathToFileURL(join(root, 'public/scripts/extensions/third-party/recall/src', path)).href);

const { chat, chat_metadata } = await import(pathToFileURL(join(root, 'public/script.js')).href);
const { getSettings } = await load('settings.js');
const store = await load('store.js');
const gen = await load('generate.js');
const rebuild = await load('rebuild.js');

const failures = [];
const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        failures.push(`${label}: expected ${b}, got ${a}`);
    }
};

const settings = getSettings();
settings.tailPin = 2;

/**
 * A 30-message chat summarised three times by hand, at 9, 19 and 27, with each
 * summary hiding what it covered, as auto-hide does. Message 5 is hidden by
 * the user and owned by nobody.
 */
function reset() {
    chat.length = 0;
    for (let i = 0; i < 30; i++) {
        chat.push({ name: i % 2 ? 'Ada' : 'Val', mes: `message ${i}`, is_system: false });
    }
    delete chat_metadata.recall;
    gen.calls.length = 0;
    gen.control.fits = Infinity;
    gen.control.failOn = null;

    const made = [];
    let previous = null;
    for (const [coversTo, hide] of [[9, [1, 2, 3, 4, 6, 7]], [19, [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]], [27, [18, 19, 20, 21, 22, 23, 24, 25]]]) {
        const record = store.createSummaryRecord({
            name: `By hand to ${coversTo}`,
            content: `old summary through ${coversTo}`,
            coversTo,
            newFrom: previous ? previous.coversTo + 1 : 0,
            builtOn: previous?.id ?? null,
            hiddenIndices: hide,
            createdAt: 1000 + coversTo,
        });
        store.addSummary(record);
        for (const i of hide) chat[i].is_system = true;
        made.push(record);
        previous = record;
    }
    chat[5].is_system = true;
    return made;
}

const base = { end: 'active', breaks: 'existing', batchSize: 50, review: false, oldSummaries: 'keep' };

// 1. Following the existing break points, from the beginning.
{
    reset();
    const plan = rebuild.planRebuild({ ...base, start: { kind: 'beginning' } });
    check('existing breaks: ranges', plan.batches.map(b => [b[0], b[b.length - 1]]), [[1, 9], [10, 19], [20, 27]]);
    check('existing breaks: used', plan.usedExisting, true);
    check('a message hidden by hand is not read', plan.batches[0].includes(5), false);
    check('a message Recall hid is read', plan.batches[0].includes(3), true);
    check('message 0 is read with every batch', plan.includesZero, true);
}

// 2. Fixed batches, to the latest message.
{
    reset();
    const plan = rebuild.planRebuild({ ...base, start: { kind: 'beginning' }, breaks: 'fixed', batchSize: 10, end: 'latest' });
    check('fixed: ranges', plan.batches.map(b => [b[0], b[b.length - 1]]), [[1, 9], [10, 19], [20, 29]]);
}

// 3. After a trusted summary: builds on it and starts right after it.
{
    const [first] = reset();
    const plan = rebuild.planRebuild({ ...base, start: { kind: 'summary', id: first.id } });
    check('after a summary: from', plan.from, 10);
    check('after a summary: basis', plan.basis?.id, first.id);
    check('after a summary: breaks after it only', plan.batches.map(b => b[0]), [10, 20]);
}

// 4. A full unattended run: chain, active pointer, hide ownership, visibility.
{
    reset();
    await rebuild.startRebuild({ ...base, start: { kind: 'beginning' } });

    check('three batches ran', gen.calls.length, 3);
    check('the first builds on nothing', gen.calls[0].basis, null);
    check('each builds on the one before', gen.calls[1].basisContent, 'summary through 9');
    check('message 0 leads every batch', gen.calls.map(c => c.indices[0]), [0, 0, 0]);

    const active = store.getActiveSummary();
    check('the last batch is active', active?.name, 'Batch 3');
    check('every old hide moved to it', store.getSummariesRaw().filter(s => !s.rebuildId).every(s => !s.hiddenIndices.length), true);
    check('the chat is synced to it (tail pinned)', [24, 25, 26, 27].map(i => chat[i].is_system), [true, true, false, false]);
    check('the hand-hidden message stays hidden', chat[5].is_system, true);
    check('old summaries kept', store.getSummariesRaw().length, 6);
    check('the lock is released', gen.control.locked, false);
    check('no rebuild left over', rebuild.getRebuild(), null);
}

// 5. Replace: the old summaries in range go, the chain stays.
{
    reset();
    await rebuild.startRebuild({ ...base, start: { kind: 'beginning' }, oldSummaries: 'replace' });
    check('replace: only the rebuild remains', store.getSummariesRaw().map(s => s.name), ['Batch 1', 'Batch 2', 'Batch 3']);
    check('replace: last batch still active', store.getActiveSummary()?.name, 'Batch 3');
}

// 6. Replace starting after a summary keeps that summary.
{
    const [first] = reset();
    await rebuild.startRebuild({ ...base, start: { kind: 'summary', id: first.id }, oldSummaries: 'replace' });
    check('replace after a summary keeps the basis', store.getSummariesRaw().map(s => s.name), ['By hand to 9', 'Batch 1', 'Batch 2']);
}

// 7. A batch too big is split, not refused, and nothing is skipped.
{
    reset();
    gen.control.fits = 5; // message 0 plus four
    await rebuild.startRebuild({ ...base, start: { kind: 'beginning' }, breaks: 'fixed', batchSize: 50, end: 'latest' });
    const read = gen.calls.flatMap(c => c.indices.filter(i => i !== 0));
    const expected = [];
    for (let i = 1; i < 30; i++) if (i !== 5) expected.push(i);
    check('split batches read every readable message once', read, expected);
    check('every split batch fits', gen.calls.every(c => c.indices.length <= 5), true);
}

// 8. Review mode pauses; redo replaces; stop keeps what was done and changes nothing else.
{
    const made = reset();
    const hiddenBefore = chat.map(m => m.is_system);
    await rebuild.startRebuild({ ...base, start: { kind: 'beginning' }, review: true });
    check('review: paused after one', rebuild.getRebuild()?.status, 'review');
    check('review: locked while paused', gen.control.locked, true);

    await rebuild.redoRebuildBatch('more about the pier');
    check('redo: same messages again', gen.calls[1].indices, gen.calls[0].indices);
    check('redo: with the note', gen.calls[1].steeringNote, 'more about the pier');
    check('redo: the first attempt is gone', store.getSummariesRaw().filter(s => s.rebuildId).length, 1);

    await rebuild.continueRebuild();
    check('continue: second batch builds on the redo', gen.calls[2].basisContent, 'summary through 9');

    await rebuild.stopRebuild();
    check('stop: two batches kept', store.getSummariesRaw().filter(s => s.rebuildId).length, 2);
    check('stop: active unchanged', store.getActiveSummary()?.id, made[2].id);
    check('stop: visibility unchanged', chat.map(m => m.is_system), hiddenBefore);
    check('stop: lock released', gen.control.locked, false);
}

// 8b. Guidance: the dialog's holds for every batch; one typed in a pause is for
// the next batch only; both go together, labelled.
{
    reset();
    await rebuild.startRebuild({ ...base, start: { kind: 'beginning' }, review: true, note: 'track the pier' });
    check('note: first batch gets the whole-rebuild note', gen.calls[0].steeringNote, 'track the pier');

    await rebuild.redoRebuildBatch('shorter');
    check('note: a redo sends both', gen.calls[1].steeringNote,
        'For the whole rebuild: track the pier\n\nFor this batch: shorter');

    await rebuild.continueRebuild('name the boat');
    check('note: keep going sends its own with the whole one', gen.calls[2].steeringNote,
        'For the whole rebuild: track the pier\n\nFor this batch: name the boat');

    await rebuild.continueRebuild();
    check('note: a batch note does not carry over', gen.calls[3]?.steeringNote ?? 'track the pier', 'track the pier');

    await rebuild.stopRebuild();
}

// 9. A failed batch waits to be retried, and retrying carries on.
{
    reset();
    gen.control.failOn = 2;
    await rebuild.startRebuild({ ...base, start: { kind: 'beginning' } });
    check('fail: paused as failed', rebuild.getRebuild()?.status, 'failed');
    await rebuild.continueRebuild();
    check('retry: finished', rebuild.getRebuild(), null);
    check('retry: three batches saved', store.getSummariesRaw().filter(s => s.rebuildId).length, 3);
}

// 10. Carrying on after a batch of an earlier rebuild continues that rebuild.
{
    reset();
    await rebuild.startRebuild({ ...base, start: { kind: 'beginning' }, review: true });
    const firstBatch = rebuild.getRebuild().done[0];
    await rebuild.stopRebuild();
    await rebuild.startRebuild({ ...base, start: { kind: 'summary', id: firstBatch.id } });
    const ids = new Set(store.getSummariesRaw().filter(s => s.rebuildId).map(s => s.rebuildId));
    check('one rebuild group, not two', ids.size, 1);
}

// 11. Hides that are not Recall's: counted, skipped by default, read on request,
//     and ST's own interface messages never read either way.
{
    reset();
    chat[6].is_system = false; // so 5 is the only foreign hide among 1–9 ... plus the ones below
    chat[12].extra = { type: 'comment' };              // a /comment note, hidden
    chat[12].is_system = true;
    store.getSummariesRaw()[1].hiddenIndices = store.getSummariesRaw()[1].hiddenIndices.filter(i => i !== 12 && i !== 13);
    chat[13].extra = { type: 'narrator' };             // a /sys narrator line someone hid
    const off = rebuild.planRebuild({ ...base, start: { kind: 'beginning' } });
    check('foreign: counted, comment excluded', off.foreign, 2);
    check('foreign: skipped by default', off.batches.flat().includes(5) || off.batches.flat().includes(13), false);

    const on = rebuild.planRebuild({ ...base, start: { kind: 'beginning' }, includeForeign: true });
    check('foreign: read when asked', [5, 13].every(i => on.batches.flat().includes(i)), true);
    check('foreign: an ST comment is never read', on.batches.flat().includes(12), false);
}

// 12. A chat with no Recall summaries, everything hidden by hand: the old
//     built-in Summarize case. Empty batches are counted, not silently dropped.
{
    reset();
    chat_metadata.recall.summaries.length = 0;
    chat_metadata.recall.activeSummaryId = null;
    for (let i = 1; i < 20; i++) chat[i].is_system = true;
    for (let i = 20; i < 30; i++) chat[i].is_system = false;

    const off = rebuild.planRebuild({ ...base, start: { kind: 'beginning' }, breaks: 'fixed', batchSize: 10, end: 'latest' });
    check('no summaries: two batches skipped', off.skipped, 2);
    check('no summaries: one left', off.batches.length, 1);
    check('no summaries: hides offered', off.foreign, 19);
    check('no summaries: the dialog defaults to reading them', rebuild.hasOwnSummaries(), false);

    const on = rebuild.planRebuild({ ...base, start: { kind: 'beginning' }, breaks: 'fixed', batchSize: 10, end: 'latest', includeForeign: true });
    check('no summaries: all three when read', on.batches.length, 3);
    check('no summaries: nothing skipped', on.skipped, 0);

    for (let i = 20; i < 30; i++) chat[i].is_system = true;
    const none = rebuild.planRebuild({ ...base, start: { kind: 'message', index: 5 }, end: 'latest' });
    check('all hidden: empty, not thrown', none.empty, true);
    let refused = false;
    try {
        await rebuild.startRebuild({ ...base, start: { kind: 'message', index: 5 }, end: 'latest' });
    } catch {
        refused = true;
    }
    check('all hidden: starting is refused', refused, true);
}

rmSync(root, { recursive: true, force: true });

if (failures.length) {
    console.error(`${failures.length} rebuild check(s) failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('All rebuild checks pass.');
