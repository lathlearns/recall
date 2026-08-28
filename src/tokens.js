/**
 * Recall — token counts in the UI.
 *
 * Counting is asynchronous (some tokenizers are a server round-trip) while every
 * render here is synchronous, so counts are painted into their element after the
 * fact. ST caches results internally, keyed by tokenizer and model, so a repeat
 * count is nearly free — but the *first* one is not, and a panel that flashed an
 * ellipsis on every re-render would be worse than no number at all. Hence the
 * small local cache: a value already known is painted immediately, in the same
 * frame, and only a genuinely new string ever shows a placeholder.
 */

import { main_api } from '../../../../../script.js';
import { getTokenCountAsync } from '../../../../tokenizers.js';
import { power_user } from '../../../../power-user.js';
import { getStringHash } from '../../../../utils.js';

/** @type {Map<string, number>} */
const cache = new Map();

/**
 * Counts are only comparable within one tokenizer. Switching API or tokenizer
 * makes every cached number wrong, so it is part of the key rather than something
 * to remember to invalidate.
 */
function cacheKey(text) {
    return `${main_api}:${power_user?.tokenizer ?? '?'}:${getStringHash(text)}`;
}

/**
 * @param {string} text
 * @returns {number|null} The count if already known, else null.
 */
export function peekTokens(text) {
    const value = String(text ?? '');
    if (!value) {
        return 0;
    }
    return cache.get(cacheKey(value)) ?? null;
}

/**
 * @param {string} text
 * @returns {Promise<number>}
 */
export async function countTokens(text) {
    const value = String(text ?? '');
    if (!value) {
        return 0;
    }

    const key = cacheKey(value);
    const known = cache.get(key);
    if (known !== undefined) {
        return known;
    }

    const count = await getTokenCountAsync(value);
    cache.set(key, count);
    return count;
}

/**
 * Renders a token count into an element.
 *
 * The element is stamped with the key it is currently displaying, and a resolved
 * count is only written if that stamp still matches. Without it, a slow count
 * started before a re-render would land in an element that now describes a
 * different summary — quietly attributing one item's size to another.
 *
 * @param {Element|null} element
 * @param {string} text
 * @param {{ suffix?: string, empty?: string }} options
 */
export async function paintTokens(element, text, { suffix = 'tokens', empty = 'empty' } = {}) {
    if (!element) {
        return;
    }

    const value = String(text ?? '');

    if (!value.trim()) {
        element.dataset.tokenKey = '';
        element.textContent = empty;
        return;
    }

    const key = cacheKey(value);
    element.dataset.tokenKey = key;

    const known = cache.get(key);
    if (known !== undefined) {
        element.textContent = format(known, suffix);
        return;
    }

    element.textContent = '…';

    try {
        const count = await countTokens(value);
        if (element.isConnected && element.dataset.tokenKey === key) {
            element.textContent = format(count, suffix);
        }
    } catch (error) {
        console.warn('[Recall] Token count failed', error);
        if (element.isConnected && element.dataset.tokenKey === key) {
            element.textContent = '';
        }
    }
}

function format(count, suffix) {
    return `${count.toLocaleString()}${suffix ? ` ${suffix}` : ''}`;
}
