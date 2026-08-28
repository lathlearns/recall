/**
 * Recall — reading the built-in Summarize extension's stored summary.
 *
 * This is the one place Recall touches `extra.memory`, and it is read-only. The
 * design document lists reading it as a non-goal; that was revised deliberately,
 * because the alternative is worse in a specific and common case.
 *
 * On a chat previously managed by the built-in, the old summary already exists and
 * the messages it covers are already hidden. Without this, Recall's first
 * summarization is handed an empty `[Summary: ]` — which fires the prompt's
 * "create from scratch" branch and instructs the model to read the entire chat,
 * while showing it only the visible tail. The result is a confident summary of
 * recent messages presented as covering the whole story. That is §3.1's first-run
 * footgun, which the document could only offer a manual remedy for ("unhide
 * everything first").
 *
 * Seeding the buffer with the old summary fixes it outright: the revise-in-place
 * branch fires, and the history the hidden messages would have supplied comes from
 * the summary instead.
 *
 * Nothing here requires the built-in to be installed or enabled. `extra.memory`
 * lives on messages in the chat file, so it survives the extension being disabled
 * — which is what makes disabling it permanently, as Recall requires, cost-free.
 */

import { chat } from '../../../../../script.js';
import { getSettings } from './settings.js';
import { getActiveSummary } from './store.js';

/**
 * The most recent summary the built-in Summarize left in this chat.
 *
 * The built-in's own `getLatestMemoryFromChat` skips the newest message before
 * searching, because it reads the field mid-generation and must not pick up a
 * summary attached to the message being generated. Recall reads it as an archive
 * value with no generation in flight, so it takes the newest one outright.
 *
 * @returns {string} The stored summary, or an empty string.
 */
export function getLegacyMemory() {
    if (!Array.isArray(chat) || !chat.length) {
        return '';
    }

    for (let i = chat.length - 1; i >= 0; i--) {
        const memory = chat[i]?.extra?.memory;
        if (typeof memory === 'string' && memory.trim()) {
            return memory;
        }
    }

    return '';
}

/**
 * Whether the built-in's summary is currently standing in for a Recall summary.
 *
 * Surfaced in the UI rather than applied invisibly: silently having no memory in
 * context is the kind of thing that goes unnoticed for several messages, and
 * silently having *someone else's* memory in context is no better.
 *
 * @returns {boolean}
 */
export function isLegacyFallbackActive() {
    return getSettings().legacyFallback
        && !getActiveSummary()
        && !!getLegacyMemory();
}

/**
 * The text that should stand in for a previous summary when Recall has none: the
 * built-in's, if the fallback is on and one exists. Empty otherwise, which is what
 * makes the prompt's create-from-scratch branch fire.
 *
 * @returns {string}
 */
export function getFallbackSummary() {
    if (!getSettings().legacyFallback) {
        return '';
    }
    return getLegacyMemory();
}
