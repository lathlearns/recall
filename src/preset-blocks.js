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
import { oai_settings } from '../../../../openai.js';
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
 * The offerable prompts of the chat's active preset, in preset order.
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

    return prompts.filter(isOfferable).map(prompt => ({
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
