/**
 * Recall — sizing text without asking the tokenizer for every piece of it.
 *
 * Free of SillyTavern imports so it can be tested, like stream.js and limit.js.
 * Both things here stand in for tokenizer requests, and a count that is not yet
 * cached is a request carrying the text — to a server that, for someone running
 * the host on their phone, is the same device as the page. What they replace was
 * thousands of requests around a rebuild's first batch, so the arithmetic has to
 * be right without them, and nothing but a test would notice if it were not.
 */

/**
 * How many messages, from the front, fit in a request.
 *
 * Where to cut is estimated from the messages' lengths and then measured, never
 * taken on trust: the answer is always a count whose real size was checked, or 0.
 *
 * The tokens per character are the messages' own — what the request came to,
 * less its fixed part, over the messages' length — not the whole request's. The
 * fixed part (prompt material, the summary carried in) and the chat are often
 * in different languages, and an average over both is wrong for either: applied
 * to a Japanese chat under English reference material it asks for several times
 * too many messages to go, and can ask for all of them.
 *
 * @param {object} options
 * @param {number[]} options.sizes   Each message's length in characters, in order.
 * @param {number} options.used      Tokens the request comes to with every message in.
 * @param {number} options.fixed     Tokens it comes to with none.
 * @param {number} options.available Tokens it may come to.
 * @param {(count: number) => Promise<number>} options.measure  The real size with the first `count` messages.
 * @returns {Promise<number>} How many fit; 0 when not even the first does.
 */
export async function cutToFit({ sizes, used, fixed, available, measure }) {
    // The fixed part alone is too much: no message can be read on top of it.
    if (fixed > available) {
        return 0;
    }

    let count = sizes.length;

    while (count > 0 && used > available) {
        // One left and it is still over: nothing fits. Also what ends the loop,
        // since every other pass measures a smaller count than the last.
        if (count === 1) {
            return 0;
        }

        let chars = 0;
        for (let i = 0; i < count; i++) {
            chars += sizes[i];
        }
        const perChar = Math.max(0, used - fixed) / Math.max(1, chars);

        // Never estimated down to nothing: the first message is always measured
        // before it is given up on.
        let estimate = used;
        do {
            count--;
            estimate -= sizes[count] * perChar;
        } while (count > 1 && estimate > available);

        used = await measure(count);
    }

    return count;
}

/** Below this a count says more about the text than about the tokenizer. */
const LEARN_FROM_CHARS = 200;

/** Characters per token before anything has been counted: about right for English prose. */
const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Estimates token counts from length, at the characters per token each
 * tokenizer has actually come to on text counted for real.
 *
 * Kept per tokenizer, because the figure is only true of the one it was learned
 * from — and of the language it was learned on, which is why it is fed by the
 * counts made before a run: the prompt and the chat's own messages.
 *
 * @returns {{
 *   learn: (id: string, text: string, tokens: number) => void,
 *   estimate: (id: string, text: string) => number,
 * }}
 */
export function createEstimator() {
    /** @type {Map<string, { chars: number, tokens: number }>} */
    const seen = new Map();

    return {
        learn(id, text, tokens) {
            if (text.length < LEARN_FROM_CHARS || !(tokens > 0)) {
                return;
            }
            const entry = seen.get(id) ?? { chars: 0, tokens: 0 };
            entry.chars += text.length;
            entry.tokens += tokens;
            seen.set(id, entry);
        },

        estimate(id, text) {
            if (!text) {
                return 0;
            }
            const entry = seen.get(id);
            const perToken = entry ? entry.chars / entry.tokens : DEFAULT_CHARS_PER_TOKEN;
            return Math.max(1, Math.round(text.length / perToken));
        },
    };
}

/**
 * Resolves after `ms`. For waiting out typing before a count is asked for: every
 * keystroke in a number field is a different text to count, and only the last
 * is wanted.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function settle(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** How long a typed number is left to settle before it is counted. */
export const TYPING_SETTLE_MS = 300;
