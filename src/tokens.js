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

import { main_api, getRequestHeaders } from '../../../../../script.js';
import { getTokenCountAsync } from '../../../../tokenizers.js';
import { power_user } from '../../../../power-user.js';
import { getStringHash } from '../../../../utils.js';
import { createLimiter } from './limit.js';
import { createEstimator } from './sizing.js';
import { getCountingModel } from './connection.js';

/** @type {Map<string, number>} */
const cache = new Map();

/**
 * Counts are only comparable within one tokenizer. Switching API, tokenizer or
 * summarising model makes every cached number wrong, so all three are part of
 * the key rather than something to remember to invalidate.
 */
function cacheKey(text, id = counterId()) {
    return `${id}:${getStringHash(text)}`;
}

/** Which tokenizer a count made now would come from. */
function counterId() {
    const model = getCountingModel();
    return model ? `model=${model}` : `${main_api}:${power_user?.tokenizer ?? '?'}`;
}

/** What estimateTokens goes by: fed by every real count, per tokenizer. */
const estimator = createEstimator();

/**
 * About how many tokens a text is, without asking the tokenizer.
 *
 * For text that is still arriving. Counting a growing string is a cache miss
 * every time, since every chunk makes a new string, and each miss is a request
 * carrying the whole text so far: the live pane asked once a second, for the
 * summary and for the reasoning, for as long as the run lasted. Where the host
 * runs on the same device as the page, that tokenizing was the device's own work,
 * done over and over on text nobody had finished writing.
 *
 * So the size is worked out from the length (createEstimator), and the saved
 * summary gets a real count, like every other.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
    return estimator.estimate(counterId(), String(text ?? ''));
}

/**
 * Counts with the summarising model when it differs from the chat's, else the
 * way ST counts for the chat. See getCountingModel for why.
 *
 * The same endpoint and message shape ST's own counter uses for chat
 * completion, so a figure here matches one ST would give with that model
 * connected. If the server cannot count for it, ST's count stands in: a
 * slightly wrong size beats a missing one.
 *
 * @param {string} text
 * @returns {Promise<number>}
 */
async function countWithModel(text) {
    const model = getCountingModel();
    if (!model) {
        return await getTokenCountAsync(text);
    }

    try {
        const response = await fetch(`/api/tokenizers/openai/count?model=${encodeURIComponent(model)}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify([{ role: 'system', content: text }]),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const count = Number((await response.json())?.token_count);
        if (!Number.isFinite(count)) {
            throw new Error('No token_count in the response');
        }
        // ST's counter starts from -1 and does the same.
        return Math.max(0, count - 1);
    } catch (error) {
        console.warn(`[Recall] Could not count with ${model}; using the chat's tokenizer instead.`, error);
        return await getTokenCountAsync(text);
    }
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

    // Named now, not when the count lands: the connection can change while
    // this waits its turn, and the count belongs to the tokenizer it was asked of.
    const id = counterId();
    const key = cacheKey(value, id);
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

        const count = await countWithModel(value);
        cache.set(key, count);
        estimator.learn(id, value, count);
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
