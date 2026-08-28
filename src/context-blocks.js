/**
 * Recall — optional reference material prepended to the summarization buffer.
 *
 * The chat alone is ambiguous to a summariser: names without roles, relationships
 * without history, a setting it has to infer. The character card and persona
 * disambiguate all of that, so including them makes the model better at judging
 * what matters — which is the whole job.
 *
 * Every block is optional and off by default. They cost tokens out of the same
 * budget the chat competes for, and the budget check counts them, so turning them
 * all on shrinks how much history fits in one pass.
 *
 * None of this is instruction. It is material, so it goes in the buffer alongside
 * the chat rather than into the system prompt, under a header that tells the model
 * not to summarise it.
 */

import { chat_metadata, characters, this_chid, substituteParams, name1 } from '../../../../../script.js';
import { selected_group, getGroupCharacterCards, getGroupMembers } from '../../../../group-chats.js';
import { power_user } from '../../../../power-user.js';
import { getSettings } from './settings.js';

/**
 * The header that separates reference material from the chat. Without it the
 * model will happily fold the character card into the summary as though it were
 * something that happened.
 */
const PREAMBLE = 'The following is reference material about the participants and setting. '
    + 'It is background for understanding the chat, not events to be summarised.';

/**
 * Explicit fences around the reference material.
 *
 * A blank line is not a boundary, it is a paragraph break — and a character card
 * is prose in the same register as the chat it precedes, so the model has nothing
 * but the preamble to tell it where background stops and material to be summarised
 * begins. One sentence is doing structural work that punctuation should do.
 *
 * Named rather than bare rules on purpose. A `---` alone would be ambiguous here:
 * this user's own summary format uses `---` between its sections, and character
 * cards are frequently markdown containing rules of their own, so an unlabelled
 * one is just another horizontal line among several. These two lines cannot be
 * mistaken for card content, and the closing one marks the end unambiguously even
 * if a description ends mid-list.
 */
const FENCE_OPEN = '--- BEGIN REFERENCE MATERIAL ---';
const FENCE_CLOSE = '--- END REFERENCE MATERIAL ---';

/**
 * @typedef {object} ContextBlockDef
 * @property {string} key      Settings key under `contextBlocks`.
 * @property {string} label    Shown in settings and as the block heading.
 * @property {() => string} read
 */

/** @type {ContextBlockDef[]} */
export const CONTEXT_BLOCKS = [
    {
        key: 'description',
        label: 'Character description',
        read: () => readCard('description'),
    },
    {
        key: 'personality',
        label: 'Character personality',
        read: () => readCard('personality'),
    },
    {
        key: 'scenario',
        label: 'Scenario',
        read: () => readCard('scenario'),
    },
    {
        key: 'persona',
        label: 'User persona',
        read: () => readPersona(),
    },
    {
        key: 'examples',
        label: 'Example dialogue',
        read: () => readCard('mesExamples'),
    },
];

/**
 * Reads one card field, handling solo and group chats.
 *
 * Group chats have no single character card. ST's own `getGroupCharacterCards`
 * combines every member's fields and honours the chat-level scenario and example
 * overrides, so it is used where available — it returns null when the group's
 * generation mode is not an append mode, and the members are walked directly in
 * that case rather than silently returning nothing.
 *
 * @param {'description'|'personality'|'scenario'|'mesExamples'} field
 * @returns {string}
 */
function readCard(field) {
    if (selected_group) {
        const combined = safely(() => getGroupCharacterCards(selected_group, Number(this_chid)));
        if (combined && typeof combined[field] === 'string' && combined[field].trim()) {
            return combined[field];
        }
        return readGroupFallback(field);
    }

    const character = characters[this_chid];
    if (!character) {
        return '';
    }

    // The chat-level overrides win for the two fields that have them, matching
    // what the roleplay prompt itself would use.
    if (field === 'scenario' && String(chat_metadata.scenario ?? '').trim()) {
        return String(chat_metadata.scenario);
    }
    if (field === 'mesExamples' && String(chat_metadata.mes_example ?? '').trim()) {
        return String(chat_metadata.mes_example);
    }

    const solo = {
        description: character.description,
        personality: character.personality,
        scenario: character.scenario,
        mesExamples: character.mes_example,
    };

    return String(solo[field] ?? '');
}

/**
 * Walks the group's members directly, labelling each contribution by name so the
 * model can tell whose description is whose.
 * @param {'description'|'personality'|'scenario'|'mesExamples'} field
 * @returns {string}
 */
function readGroupFallback(field) {
    const perCharacter = {
        description: c => c.description,
        personality: c => c.personality,
        scenario: c => c.scenario,
        mesExamples: c => c.mes_example,
    }[field];

    const members = safely(() => getGroupMembers(selected_group)) ?? [];

    return members
        .filter(Boolean)
        .map(member => {
            const value = String(perCharacter(member) ?? '').trim();
            return value ? `${member.name}: ${value}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
}

function readPersona() {
    const description = String(power_user?.persona_description ?? '').trim();
    if (!description) {
        return '';
    }
    return `${name1}: ${description}`;
}

function safely(fn) {
    try {
        return fn();
    } catch (error) {
        console.warn('[Recall] Could not read context block', error);
        return null;
    }
}

/**
 * Assembles the enabled blocks that actually have content.
 *
 * A block that is enabled but empty contributes nothing — no heading, no blank
 * section — so an unused character field does not teach the model that empty
 * sections are normal.
 *
 * @returns {{ text: string, included: string[] }}
 */
export function buildContextBlocks() {
    const enabled = getSettings().contextBlocks ?? {};
    const sections = [];
    const included = [];

    for (const block of CONTEXT_BLOCKS) {
        if (!enabled[block.key]) {
            continue;
        }

        const raw = safely(block.read) ?? '';
        const value = substituteParams(String(raw)).trim();
        if (!value) {
            continue;
        }

        sections.push(`### ${block.label}\n${value}`);
        included.push(block.label);
    }

    if (!sections.length) {
        return { text: '', included: [] };
    }

    return {
        text: [
            FENCE_OPEN,
            PREAMBLE,
            ...sections,
            FENCE_CLOSE,
        ].join('\n\n'),
        included,
    };
}

/**
 * A preview of what each block currently resolves to, for the settings panel —
 * so the user can see that a block they enabled is actually empty for this
 * character rather than wondering why nothing changed.
 * @returns {{ key: string, label: string, chars: number }[]}
 */
export function previewContextBlocks() {
    return CONTEXT_BLOCKS.map(block => ({
        key: block.key,
        label: block.label,
        chars: substituteParams(String(safely(block.read) ?? '')).trim().length,
    }));
}
