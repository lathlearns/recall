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
import { createLimiter } from './limit.js';

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
 * How many uncached counts may be in flight at once.
 *
 * Opening the manager paints a token count into every summary row, and on most
 * tokenizers each uncached count is a POST carrying the whole summary. Twenty
 * summaries meant twenty simultaneous requests the moment the popup appeared —
 * a burst that only ever arrives all at once, because the rows are rendered in
 * one loop.
 *
 * A cap rather than a serial queue: the counts are independent and a few in
 * parallel finish sooner than one at a time, while still arriving as a queue
 * rather than a stampede. Every repeat is free afterwards — the cache below and
 * ST's own both hold the answer — so this only has to survive the first open.
 */
const limit = createLimiter(4);

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

    return await limit(async () => {
        // Re-checked after queueing: an identical string waiting behind this one
        // is the normal case when a list repaints, and by now the count it was
        // queued for may already have landed.
        const cached = cache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const count = await getTokenCountAsync(value);
        cache.set(key, count);
        return count;
    });
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

/**
 * A token count for text that is still arriving.
 *
 * Counting a growing string is a cache miss every single time — the cache is
 * keyed by hash, and every chunk makes a new string — and on a Chat Completion
 * source each miss is a POST to the tokenizer endpoint. The live pane updates
 * around eight times a second, so counting on every repaint would mean eight
 * round-trips a second of ever-larger bodies, for a number nobody reads that
 * fast.
 *
 * So it counts on its own schedule and the display lags slightly behind the
 * text. The previous number stays on screen while the next is in flight rather
 * than blanking or showing a placeholder: a figure that is a second stale reads
 * as a counter, whereas one that flickers between a number and an ellipsis reads
 * as broken.
 *
 * @param {{ minIntervalMs?: number }} options
 */
export function createStreamingCount({ minIntervalMs = 1000 } = {}) {
    let value = null;
    let busy = false;
    let lastStartedAt = 0;

    return {
        /** The most recent count, or null before the first one lands. */
        get current() {
            return value;
        },

        /** Called when a new run starts, so one run's figure never labels another's. */
        reset() {
            value = null;
            busy = false;
            lastStartedAt = 0;
        },

        /**
         * Starts a count if one is due. Never awaited by the caller — read
         * `current` on the next repaint.
         * @param {string} text
         */
        refresh(text) {
            const now = Date.now();

            if (busy || !text || now - lastStartedAt < minIntervalMs) {
                return;
            }

            busy = true;
            lastStartedAt = now;

            countTokens(text)
                .then(count => { value = count; })
                .catch(error => console.warn('[Recall] Live token count failed', error))
                .finally(() => { busy = false; });
        },
    };
}
