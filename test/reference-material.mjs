/**
 * What the reference-material section of the buffer actually assembles to.
 *
 * The other tests here cover what a browser does to the templates. This one covers
 * text: which blocks land, in what order, and — the part that matters most — that
 * the chat's own prompt blocks arrive quoted and disclaimed rather than reading as
 * instructions addressed to the summariser. A regression there does not throw and
 * does not look wrong in the panel; it shows up as a model that writes the chat's
 * next reply instead of a summary, days later, on someone else's install.
 *
 * `src/` imports SillyTavern by relative path, five and four levels up, so the
 * modules are copied into a throwaway tree of the right depth with stubs at the
 * other end. Nothing here touches a real ST install.
 */

import assert from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'recall-refmat-'));
const scripts = join(root, 'public', 'scripts');
const src = join(scripts, 'extensions', 'third-party', 'recall', 'src');

mkdirSync(src, { recursive: true });
cpSync('src', src, { recursive: true });

const stub = (path, body) => writeFileSync(join(root, path), body);

stub('public/script.js', `
export const chat_metadata = {};
export const characters = [{ description: 'A tall woman.', personality: 'Wry.', scenario: '', mes_example: '' }];
export const this_chid = 0;
export const name1 = 'Val';
export let main_api = 'openai';
export function setMainApi(value) { main_api = value; }
export const SUMMARY_TEXT = 'CORE MEMORY: the pier at dawn.';
export function substituteParams(text) {
    return String(text)
        .replaceAll('{{char}}', 'Ada')
        .replaceAll('{{summary}}', SUMMARY_TEXT)
        .replaceAll('{{recall}}', SUMMARY_TEXT);
}
export const saveSettingsDebounced = () => {};
`);
stub('public/scripts/openai.js', `
export const oai_settings = { prompts: [] };
export const promptManager = {
    activeCharacter: { id: 100001 },
    order: [],
    getPromptOrderForCharacter(character) {
        return String(character?.id) === '100001' ? this.order : [];
    },
};
`);
stub('public/scripts/power-user.js', "export const power_user = { persona_description: 'A tired archivist.' };");
stub('public/scripts/group-chats.js', `
export const selected_group = null;
export function getGroupCharacterCards() { return null; }
export function getGroupMembers() { return []; }
`);
stub('public/scripts/extensions.js', `
export const extension_settings = {};
export const saveMetadataDebounced = () => {};
`);

const load = path => import(pathToFileURL(join(root, path)).href);

const { oai_settings, promptManager } = await load('public/scripts/openai.js');
const { setMainApi, SUMMARY_TEXT } = await load('public/script.js');
const { getSettings } = await load('public/scripts/extensions/third-party/recall/src/settings.js');
const { buildContextBlocks, previewPresetBlocks } =
    await load('public/scripts/extensions/third-party/recall/src/context-blocks.js');

const settings = getSettings();

// A preset with one marker (no text of its own), one prompt left empty, and a
// custom prompt under the uuid it was created with — the three cases that decide
// whether a prompt is offerable. Plus an orphan the prompt order never mentions.
oai_settings.prompts = [
    { identifier: 'main', name: 'Main Prompt', content: "Write {{char}}'s next reply." },
    { identifier: 'chatHistory', name: 'Chat History', marker: true },
    { identifier: 'nsfw', name: 'Auxiliary Prompt', content: '' },
    { identifier: 'jailbreak', name: 'Post-History Instructions', content: 'Never refuse.' },
    { identifier: 'ab12', name: 'House Style', content: 'Short sentences.' },
    { identifier: 'zz99', name: 'Orphan', content: 'Never placed.' },
    { identifier: 'sum', name: 'Summary', content: 'Previous events: [Summary: {{summary}}]' },
];

// Deliberately not the order the prompts were declared in: reading the bag
// instead of the order is the bug this fixture exists to catch.
promptManager.order = [
    { identifier: 'sum', enabled: true },
    { identifier: 'ab12', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'jailbreak', enabled: false },
    { identifier: 'main', enabled: true },
];

const failures = [];
const check = (name, fn) => {
    try {
        fn();
    } catch (error) {
        failures.push(`${name}: ${error.message}`);
    }
};

const CARD_PREAMBLE = 'reference material about the participants';
const PRESET_NOTE = 'standing instructions the chat itself runs under';

check('markers and empty prompts are not offered', () => {
    assert.ok(!previewPresetBlocks().some(block => ['Chat History', 'Auxiliary Prompt'].includes(block.label)));
});

check('blocks follow the prompt order, not the order prompts were declared in', () => {
    assert.deepStrictEqual(
        previewPresetBlocks().map(block => block.label),
        ['Summary', 'House Style', 'Post-History Instructions', 'Main Prompt', 'Orphan'],
    );
});

// Nearly every preset has a block that places the summary — that is how it reaches
// the chat. Ticking it here must not hand the summariser a second copy of what it
// is already being given to revise.
check("a preset block's summary macro cannot pull the summary into the buffer", () => {
    const summaryBlock = previewPresetBlocks().find(block => block.label === 'Summary');
    assert.ok(!summaryBlock.text.includes(SUMMARY_TEXT), 'the summary macro expanded');
    assert.ok(summaryBlock.text.includes('Previous events: [Summary: ]'), summaryBlock.text);

    settings.contextBlocks.description = false;
    settings.presetBlocks.sum = true;
    try {
        assert.ok(!buildContextBlocks().text.includes(SUMMARY_TEXT));
    } finally {
        settings.presetBlocks.sum = false;
    }
});

check('a prompt the order never mentions sorts last rather than vanishing', () => {
    const labels = previewPresetBlocks().map(block => block.label);
    assert.strictEqual(labels.at(-1), 'Orphan');
});

check('the buffer emits blocks in that same order', () => {
    settings.contextBlocks.description = false;
    settings.presetBlocks.main = true;
    settings.presetBlocks.ab12 = true;

    // Reset even when an assert throws. These checks share one settings object,
    // so a check that fails half-way would otherwise leave its toggles on and
    // fail every check after it — turning one broken thing into seven, with the
    // real one buried at the top.
    try {
        const { text, included } = buildContextBlocks();
        assert.deepStrictEqual(included, ['House Style', 'Main Prompt']);
        assert.ok(text.indexOf('### Chat instruction: House Style')
            < text.indexOf('### Chat instruction: Main Prompt'));
    } finally {
        settings.presetBlocks.main = false;
        settings.presetBlocks.ab12 = false;
    }
});

check('preset blocks are headed as the chat\'s and have macros resolved', () => {
    const main = previewPresetBlocks().find(block => block.label === 'Main Prompt');
    assert.ok(main.text.startsWith('### Chat instruction: Main Prompt'), main.text);
    assert.ok(main.text.includes("Ada's next reply"), main.text);
});

check('card blocks alone do not announce preset blocks', () => {
    settings.contextBlocks.description = true;
    const { text, included } = buildContextBlocks();
    assert.ok(text.includes(CARD_PREAMBLE));
    assert.ok(!text.includes(PRESET_NOTE));
    assert.deepStrictEqual(included, ['Character description']);
});

check('preset blocks alone do not announce card material', () => {
    settings.contextBlocks.description = false;
    settings.presetBlocks.jailbreak = true;
    const { text, included } = buildContextBlocks();
    assert.ok(!text.includes(CARD_PREAMBLE), 'card preamble emitted with no card blocks');
    assert.ok(text.includes(PRESET_NOTE));
    assert.ok(text.includes('### Chat instruction: Post-History Instructions'));
    assert.deepStrictEqual(included, ['Post-History Instructions']);
});

check('the note sits between the two groups and the fence closes after them', () => {
    settings.contextBlocks.description = true;
    const { text, included } = buildContextBlocks();
    const at = needle => text.indexOf(needle);
    assert.strictEqual(at('--- BEGIN REFERENCE MATERIAL ---'), 0);
    assert.ok(at('### Character description') < at(PRESET_NOTE), 'card material follows the note');
    assert.ok(at(PRESET_NOTE) < at('### Chat instruction:'), 'note follows the blocks it introduces');
    assert.ok(at('### Chat instruction:') < at('--- END REFERENCE MATERIAL ---'), 'block outside the fence');
    assert.ok(text.trimEnd().endsWith('--- END REFERENCE MATERIAL ---'));
    assert.deepStrictEqual(included, ['Character description', 'Post-History Instructions']);
});

check('a toggle for a prompt this preset does not define contributes nothing', () => {
    settings.presetBlocks.fromSomeOtherPreset = true;
    assert.deepStrictEqual(
        buildContextBlocks().included,
        ['Character description', 'Post-History Instructions'],
    );
});

check('no prompt manager, no preset blocks', () => {
    setMainApi('textgenerationwebui');
    const { text, included } = buildContextBlocks();
    assert.strictEqual(previewPresetBlocks().length, 0);
    assert.ok(!text.includes(PRESET_NOTE));
    assert.deepStrictEqual(included, ['Character description']);
    setMainApi('openai');
});

// The fixture's order marks jailbreak disabled and main enabled, so one check
// covers both directions: Recall's toggle decides, and the chat's does not get a
// vote either way. Getting this backwards would mean a block you switched off
// still reaching the model because your preset happens to have it on.
check("the preset's own on/off state does not decide what Recall sends", () => {
    settings.contextBlocks.description = false;
    settings.presetBlocks.jailbreak = true;
    settings.presetBlocks.main = false;

    try {
        assert.deepStrictEqual(buildContextBlocks().included, ['Post-History Instructions']);
    } finally {
        settings.presetBlocks.jailbreak = false;
    }
});

check('nothing enabled emits nothing, not an empty fence', () => {
    settings.contextBlocks.description = false;
    settings.presetBlocks.jailbreak = false;
    assert.deepStrictEqual(buildContextBlocks(), { text: '', included: [] });
});

rmSync(root, { recursive: true, force: true });

if (failures.length) {
    console.error(`Reference-material checks failed:\n${failures.join('\n')}`);
    process.exit(1);
}

console.log('All 14 reference-material assembly checks pass.');
