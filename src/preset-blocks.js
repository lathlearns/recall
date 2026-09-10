/**
 * Recall — the chat's own prompt blocks, offered as reference material.
 *
 * A summariser reads the chat cold. The card and persona tell it who is speaking;
 * what they do not tell it is the register the chat is written in, what it is
 * allowed to say about it, or the conventions its author set up — all of which
 * live in the preset, not in the chat. A summary that sanitises what the chat was
 * explicit about, or that adopts a voice the roleplay never used, is usually a
 * summariser that was never shown any of this.
 *
 * These are read from the *chat's* active preset, not from whichever profile
 * Recall summarises through. The other reference blocks all come from the chat —
 * card, persona, scenario — and these are the same kind of thing: a description
 * of the roleplay being summarised, not of the connection doing the summarising.
 *
 * Chat Completion only. The prompt manager is a Chat Completion feature; a text
 * completion chat has a system prompt and an instruct template instead, which are
 * a different shape and are not read here. On any other API this returns nothing
 * and the settings panel says why.
 */

import { main_api, substituteParams } from '../../../../../script.js';
import { oai_settings, promptManager } from '../../../../openai.js';
import { getSettings } from './settings.js';

/**
 * Prompts whose content Recall will never offer, whatever the preset calls them.
 *
 * Markers are placeholders the prompt manager fills at generation time — chat
 * history, world info, the character description — so they carry no text of their
 * own, and the three that do resolve to something are already offered as their own
 * reference blocks, read from the card directly. Including them here would let the
 * same description be sent twice under two different headings.
 */
function isOfferable(prompt) {
    return !!prompt
        && !prompt.marker
        && typeof prompt.identifier === 'string'
        && String(prompt.content ?? '').trim().length > 0;
}

/**
 * True when a prompt manager is actually in play for this chat.
 *
 * `oai_settings.prompts` survives a switch to a text completion API — it is the
 * last Chat Completion preset that was loaded, not the thing generating replies —
 * so the API has to be checked rather than the array's contents.
 * @returns {boolean}
 */
export function isPresetAvailable() {
    return main_api === 'openai';
}

/**
 * The order the prompt manager displays, as identifier → position.
 *
 * `oai_settings.prompts` is a bag, near enough to creation order; the sequence
 * you actually see and the sequence ST assembles from both come from
 * `prompt_order`, which is a separate list of references. Reading the bag gets a
 * plausible-looking order that is not the preset's, and the difference is
 * invisible until you compare the two panels side by side.
 *
 * `activeCharacter` is the right key under either ordering strategy: with the
 * global strategy — the only one 1.18.0 configures — ST sets it to the dummy id
 * that holds the shared order, and with a per-character one it is the character.
 * Same call ST's own renderer makes.
 *
 * @returns {Map<string, number>}
 */
function readPromptOrder() {
    try {
        const order = promptManager?.getPromptOrderForCharacter(promptManager.activeCharacter) ?? [];
        return new Map(order.map((entry, index) => [String(entry?.identifier), index]));
    } catch (error) {
        console.warn('[Recall] Could not read the prompt order', error);
        return new Map();
    }
}

/**
 * The offerable prompts of the chat's active preset, in the order the prompt
 * manager shows them — markers removed, so it is that sequence with the gaps
 * closed up.
 *
 * Keyed by the preset's own identifier: `main`, `nsfw` and `jailbreak` are stable
 * across every preset, but a custom prompt's identifier is a uuid minted when it
 * was created, so a toggle set on one preset's custom prompt means nothing in
 * another. That is the honest behaviour — the two prompts are unrelated — and it
 * is why the list is rebuilt from the preset every time the panel renders rather
 * than stored.
 *
 * @returns {{ key: string, label: string, content: string }[]}
 */
export function listPresetBlocks() {
    if (!isPresetAvailable()) {
        return [];
    }

    const prompts = Array.isArray(oai_settings?.prompts) ? oai_settings.prompts : [];
    const order = readPromptOrder();

    // A prompt the order does not mention sorts last rather than disappearing.
    // ST would not draw it at all — its manager renders from the order — but it
    // has content and an identifier, and dropping something that exists is worse
    // than showing it after everything that was placed deliberately. Ties keep
    // their `prompts` order, sort being stable, which is what an unordered preset
    // falls back to in full.
    const rank = prompt => order.get(String(prompt.identifier)) ?? Number.MAX_SAFE_INTEGER;

    return prompts
        .filter(isOfferable)
        .sort((a, b) => rank(a) - rank(b))
        .map(prompt => ({
            key: String(prompt.identifier),
            label: String(prompt.name ?? prompt.identifier),
            content: String(prompt.content ?? ''),
        }));
}

/**
 * The heading a block appears under in the buffer.
 *
 * Named as an instruction *belonging to the chat* rather than by the preset's own
 * label alone. "Post-History Instructions" at the top of a section reads like a
 * heading addressed to the reader; "Chat instruction: Post-History Instructions"
 * cannot.
 *
 * @param {string} label
 * @returns {string}
 */
export function presetBlockHeading(label) {
    return `### Chat instruction: ${label}`;
}

/**
 * @param {{ key: string, label: string, content: string }} block
 * @returns {string} The section exactly as it would appear in the buffer.
 */
export function renderPresetBlock(block) {
    const value = substituteParams(String(block.content ?? '')).trim();
    return value ? `${presetBlockHeading(block.label)}\n${value}` : '';
}

/**
 * The enabled blocks, rendered.
 *
 * Enabled *here*. The prompt order carries the chat's own on/off state for each
 * prompt and it is deliberately not consulted: these toggles say what Recall
 * sends, and nothing about the preset's current state overrides them in either
 * direction. A prompt switched off in the prompt manager still goes if it is
 * ticked here — you may well want the summariser to see a block the chat is not
 * currently running — and one switched on there stays out if it is not.
 *
 * The alternative would make a setting that changes meaning behind your back:
 * you tick a block, someone toggles it in the preset for an unrelated reason, and
 * summaries quietly start or stop including it with nothing in this panel saying
 * so. `readPromptOrder` therefore keeps only the positions and drops `enabled`.
 *
 * @returns {{ sections: string[], included: string[] }}
 */
export function buildPresetBlocks() {
    const enabled = getSettings().presetBlocks ?? {};
    const sections = [];
    const included = [];

    for (const block of listPresetBlocks()) {
        if (!enabled[block.key]) {
            continue;
        }

        const section = renderPresetBlock(block);
        if (!section) {
            continue;
        }

        sections.push(section);
        included.push(block.label);
    }

    return { sections, included };
}
