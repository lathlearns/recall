/**
 * Recall — global settings, block library, per-character overrides.
 *
 * Everything in this file lives in `extension_settings[MODULE]`, which is global
 * and shared across every chat. Per-chat data (summaries, the active pointer,
 * hide records) lives in `chat_metadata` and belongs to store.js.
 *
 * Prompt configuration is global by default: the summary prompt describes *how to
 * summarise a roleplay*, which is universal in practice. A character may override
 * it, and doing so takes an owned copy of the blocks and stops tracking the
 * global set.
 */

import { extension_settings, saveMetadataDebounced } from '../../../../extensions.js';
import { characters, this_chid, saveSettingsDebounced } from '../../../../../script.js';
import { DEFAULT_BLOCKS, DEFAULT_SET_NAME } from './default-prompt.js';
import { uuid } from './util.js';

export const MODULE = 'recall';

/**
 * The fraction of the context limit used as the nudge threshold when the user
 * has not set one explicitly. Stored thresholds of 0 mean "derive it".
 */
export const AUTO_NUDGE_FRACTION = 0.8;

/**
 * @typedef {object} RecallBlock
 * @property {string} id
 * @property {string} name        User-facing label.
 * @property {string} content     The actual prompt text.
 * @property {boolean} enabled
 */

/**
 * @typedef {object} RecallBlockSet
 * @property {string} name
 * @property {RecallBlock[]} blocks
 * @property {number} updatedAt   Bumped on every save; overrides compare against it.
 */

/**
 * @typedef {object} RecallCharacterConfig
 * @property {'global'|'override'} mode
 * @property {RecallBlock[]} blocks       Owned copy. Only meaningful when overriding.
 * @property {string} basedOnSet          Which set the copy was taken from.
 * @property {number} basedOnUpdatedAt    That set's updatedAt at copy time.
 */

function freshDefaultSet() {
    return {
        name: DEFAULT_SET_NAME,
        blocks: structuredClone(DEFAULT_BLOCKS),
        updatedAt: Date.now(),
    };
}

const DEFAULT_SETTINGS = {
    /** Bumped when the stored shape changes, so migrations have something to read. */
    schemaVersion: 1,

    library: {
        activeSetName: DEFAULT_SET_NAME,
        /** @type {Record<string, RecallBlockSet>} */
        sets: {},
    },

    /** @type {Record<string, RecallCharacterConfig>} */
    characters: {},

    // --- Generation ---

    /**
     * Context room held back when budgeting the buffer. Passed to
     * getMaxPromptTokens(). This is NOT the generation limit — see outputBudget.
     */
    responseReserve: 2000,

    /**
     * The generation limit sent to the API, via generateRawData({ responseLength }).
     * On OpenAI-compatible sources this covers reasoning *and* visible output, so it
     * doubles as the killswitch for a model that thinks without end.
     */
    outputBudget: 15000,

    /** Deactivate send buttons while a summary generates. */
    blocking: true,

    /**
     * Show the model's reasoning while it works, and keep it with the summary.
     *
     * On by default, and it costs nothing when there is none: a model that does
     * not reason streams no reasoning, and the region stays hidden. On one that
     * does, this is usually the only thing happening for the first half of the
     * run — the alternative is an empty pane and a clock.
     *
     * One setting for both showing and keeping, because they are one decision:
     * someone who does not want to watch the model think has no use for a copy of
     * it in their chat file either.
     *
     * Kept, but never sent. The macro resolves a summary's `content` and nothing
     * else, so this field is invisible to the model at any size — it costs space
     * in the chat file and nothing in context. Turning it off stops recording it;
     * summaries that already carry it keep it until they are deleted.
     */
    showReasoning: true,

    /** Framing around the previous summary in the buffer. Must survive being empty. */
    framingPrefix: '[Summary: ',
    framingSuffix: ']',

    /** Responses shorter than this after reasoning is stripped are a failure, not a summary. */
    minResponseChars: 200,

    // --- Where summarization runs ---

    /**
     * Connection Manager profile id to summarise through. Empty means the main
     * API, which is the default and the fallback. Choosing one never changes the
     * user's selected profile.
     */
    profileId: '',

    /**
     * Model id overriding the profile's own. A connection profile stores a single
     * model string and ST enumerates models only for the source it is currently
     * connected to, so there is no list to validate this against.
     */
    modelOverride: '',

    /**
     * Context size of the profile, in tokens. 0 means "use the main API's", which
     * is wrong whenever the profile's window differs — see connection.js.
     */
    profileContextSize: 0,


    // --- Reference material sent alongside the chat ---

    /**
     * Which parts of the character card and persona to include in the buffer.
     * All off by default: they cost tokens from the same budget the chat history
     * competes for.
     */
    contextBlocks: {
        description: false,
        personality: false,
        scenario: false,
        persona: false,
        examples: false,
    },

    /**
     * Which of the chat preset's own prompt blocks to include, keyed by the
     * preset's identifier for each — `main`, `nsfw`, `jailbreak`, or the uuid a
     * custom prompt was created with.
     *
     * An open map rather than a fixed set of keys, because the list belongs to the
     * preset: a preset with eight custom prompts has eight togglable blocks, and
     * naming them here would mean shipping a new version whenever someone writes a
     * new prompt. Everything absent is off, so the empty default is "none of them"
     * and stays correct for presets that do not exist yet.
     */
    presetBlocks: {},

    // --- Hiding ---

    /** Hide the covered range after a successful summary. */
    autoHide: true,

    /** How many of the newest messages auto-hide always skips. Message 0 is always skipped. */
    tailPin: 5,

    // --- Nudge ---

    nudgeEnabled: true,

    /** In tokens. 0 means "derive from the context limit" — see AUTO_NUDGE_FRACTION. */
    nudgeThreshold: 0,

    // --- Migration from the built-in Summarize ---

    /**
     * On a chat where Recall has no summary yet, stand in the built-in's stored
     * summary: `{{recall}}` resolves to it, and it seeds the first summarization
     * so Recall continues that summary rather than restarting from scratch.
     * Read-only, and does not require the built-in to be enabled.
     */
    legacyFallback: true,

    /**
     * Also answer to `{{summary}}`, so presets that were never updated keep
     * working. Registered only while the built-in Summarize is disabled — see
     * macro.js for why that condition is not optional.
     */
    summaryAlias: true,

    // --- Advanced ---

    /**
     * Also hash the whole covered range, catching edits below the anchor. Off by
     * default: it flags on any edit anywhere in history, which is noisy in normal use.
     */
    deepIntegrityCheck: false,
};

/**
 * Ensures `extension_settings[MODULE]` exists and has every key we expect.
 * Safe to call repeatedly.
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = {};
    }

    const settings = extension_settings[MODULE];

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(value);
        }
    }

    // Nested defaults that structuredClone above would not repair on a partial object.
    if (!settings.library || typeof settings.library !== 'object') {
        settings.library = structuredClone(DEFAULT_SETTINGS.library);
    }
    if (!settings.library.sets || typeof settings.library.sets !== 'object') {
        settings.library.sets = {};
    }
    if (!settings.characters || typeof settings.characters !== 'object') {
        settings.characters = {};
    }
    if (!settings.contextBlocks || typeof settings.contextBlocks !== 'object') {
        settings.contextBlocks = structuredClone(DEFAULT_SETTINGS.contextBlocks);
    } else {
        // A block added in a later version must default to off rather than
        // undefined, or it reads as enabled nowhere and disabled nowhere.
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS.contextBlocks)) {
            if (typeof settings.contextBlocks[key] !== 'boolean') {
                settings.contextBlocks[key] = value;
            }
        }
    }

    if (!settings.presetBlocks || typeof settings.presetBlocks !== 'object') {
        settings.presetBlocks = {};
    }

    // Dropped in 1.1.0, when the profile's preset stopped being optional. Left
    // behind it would be a stored answer to a question nothing asks any more, and
    // the next reader of the saved settings would have to work out which.
    delete settings.profileUsePreset;

    // Seed the default set on first run.
    if (!Object.keys(settings.library.sets).length) {
        settings.library.sets[DEFAULT_SET_NAME] = freshDefaultSet();
        settings.library.activeSetName = DEFAULT_SET_NAME;
    }

    // A missing or dangling active pointer falls back to whatever set exists.
    if (!settings.library.sets[settings.library.activeSetName]) {
        settings.library.activeSetName = Object.keys(settings.library.sets)[0];
    }

    return settings;
}

export function saveSettings() {
    saveSettingsDebounced();
}

/**
 * The avatar filename of the current character, or null in a group chat / no chat.
 * Per-character config is keyed on this, so changing a character's image orphans
 * its override — the character then falls back to the global set, which is almost
 * always the right prompt anyway.
 * @returns {string|null}
 */
export function getAvatarKey() {
    if (this_chid === undefined || this_chid === null) {
        return null;
    }
    return characters[this_chid]?.avatar ?? null;
}

/**
 * @returns {RecallBlockSet} The globally active block set.
 */
export function getActiveSet() {
    const settings = getSettings();
    return settings.library.sets[settings.library.activeSetName];
}

/**
 * @returns {RecallCharacterConfig|null} The current character's config, if any.
 */
export function getCharacterConfig() {
    const key = getAvatarKey();
    if (!key) {
        return null;
    }
    return getSettings().characters[key] ?? null;
}

/**
 * Whether the current character overrides the global set.
 * Group chats have no avatar key and therefore always use the global set — that is
 * the answer, not a fallback.
 */
export function isOverriding() {
    return getCharacterConfig()?.mode === 'override';
}

/**
 * The blocks that will actually be assembled for the current chat, plus enough
 * context for the UI and for a summary's `generatedWith` record.
 * @returns {{ blocks: RecallBlock[], setName: string, isOverride: boolean, outOfSync: boolean }}
 */
export function resolveBlocks() {
    const config = getCharacterConfig();
    const activeSet = getActiveSet();

    if (config?.mode === 'override') {
        const source = getSettings().library.sets[config.basedOnSet];
        return {
            blocks: config.blocks ?? [],
            setName: config.basedOnSet,
            isOverride: true,
            // Quiet marker only. Never prompts, never merges.
            outOfSync: !!source && source.updatedAt !== config.basedOnUpdatedAt,
        };
    }

    return {
        blocks: activeSet?.blocks ?? [],
        setName: activeSet?.name ?? '',
        isOverride: false,
        outOfSync: false,
    };
}

/**
 * Joins the enabled blocks in order. This becomes the `systemPrompt` for generation.
 * @returns {string}
 */
export function assemblePrompt() {
    return resolveBlocks().blocks
        .filter(block => block.enabled)
        .map(block => block.content)
        .join('\n\n');
}

/**
 * Saves edited blocks back to the global set, bumping updatedAt so that any
 * character overriding this set starts showing an out-of-sync marker.
 * @param {RecallBlock[]} blocks
 */
export function saveGlobalBlocks(blocks) {
    const set = getActiveSet();
    set.blocks = structuredClone(blocks);
    set.updatedAt = Date.now();
    saveSettings();
}

/**
 * Turns the current character into an overrider, taking an owned copy of the
 * blocks it is currently resolving to.
 */
export function startOverride() {
    const key = getAvatarKey();
    if (!key) {
        return false;
    }

    const set = getActiveSet();
    getSettings().characters[key] = {
        mode: 'override',
        blocks: structuredClone(set.blocks),
        basedOnSet: set.name,
        basedOnUpdatedAt: set.updatedAt,
    };
    saveSettings();
    return true;
}

/**
 * Drops the current character's override. The owned copy is discarded, so this is
 * destructive and belongs behind a confirm.
 */
export function endOverride() {
    const key = getAvatarKey();
    if (!key) {
        return false;
    }
    delete getSettings().characters[key];
    saveSettings();
    return true;
}

/**
 * Saves edited blocks to the current character's override.
 * @param {RecallBlock[]} blocks
 */
export function saveOverrideBlocks(blocks) {
    const key = getAvatarKey();
    const config = key ? getSettings().characters[key] : null;
    if (!config || config.mode !== 'override') {
        return false;
    }
    config.blocks = structuredClone(blocks);
    saveSettings();
    return true;
}

/**
 * Re-copies the global set over this character's override, clearing the
 * out-of-sync marker and discarding the character's own edits.
 */
export function resyncOverride() {
    const key = getAvatarKey();
    const config = key ? getSettings().characters[key] : null;
    if (!config || config.mode !== 'override') {
        return false;
    }
    const set = getActiveSet();
    config.blocks = structuredClone(set.blocks);
    config.basedOnSet = set.name;
    config.basedOnUpdatedAt = set.updatedAt;
    saveSettings();
    return true;
}

/**
 * Restores the shipped default blocks into the global set.
 */
export function restoreDefaultBlocks() {
    const set = getActiveSet();
    set.blocks = structuredClone(DEFAULT_BLOCKS);
    set.updatedAt = Date.now();
    saveSettings();
}

/** @returns {RecallBlock} A blank block, ready to be inserted and edited. */
export function makeEmptyBlock() {
    return {
        id: uuid(),
        name: 'New block',
        content: '',
        enabled: true,
    };
}

export { saveMetadataDebounced };
