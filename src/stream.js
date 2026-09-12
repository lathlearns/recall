/**
 * Recall — draining a streamed response.
 *
 * Deliberately free of SillyTavern imports. Everything else in `src/` reaches
 * into `script.js` and friends, which makes it unloadable outside a running ST
 * and therefore untestable; this is the one piece whose logic can be got wrong
 * silently, so it lives where a test can reach it.
 *
 * The thing to get wrong: **ST's chunks are cumulative, not deltas.** Each yield
 * carries the whole response so far — `text` is everything written, `state.reasoning`
 * is everything thought. Appending them, which is what a stream normally wants,
 * produces a response containing every prefix of itself concatenated: n chunks
 * yield roughly n²/2 characters of duplicated summary. It does not throw, it does
 * not warn, and it looks exactly like a model stuck in a repetition loop.
 */

/**
 * Whether a failed streamed request may be retried without streaming.
 *
 * Two conditions, and getting either wrong costs the user money rather than
 * pixels, which is why this is a named rule with a test rather than an inline
 * `&&` inside a catch block.
 *
 * `aborted` — the user pressed Stop. Retrying would ignore them and issue the
 * request they just cancelled.
 *
 * `started` — text had already arrived. Those tokens are generated and billed;
 * asking again pays for them twice and produces a summary from the second reply
 * while the first is discarded. A stream that never yielded anything has cost
 * nothing, and only that one is free to try the other way.
 *
 * @param {{ aborted: boolean, started: boolean }} state
 * @returns {boolean}
 */
export function shouldRetryWithoutStreaming({ aborted, started }) {
    return !aborted && !started;
}

/**
 * @typedef {object} StreamChunk
 * @property {string} [text]                     The whole response so far.
 * @property {{ reasoning?: string }} [state]    Accumulated reasoning, if any.
 */

/**
 * @param {() => AsyncIterable<StreamChunk>} factory
 *        ST returns `async function* streamData()` itself rather than the
 *        generator, so this is called, not iterated directly.
 * @param {(progress: {content: string, reasoning: string}) => void} [onProgress]
 * @returns {Promise<{ content: string, reasoning: string, chunks: number }>}
 */
export async function consumeStream(factory, onProgress = null) {
    if (typeof factory !== 'function') {
        throw new Error('The connection returned no stream to read.');
    }

    let content = '';
    let reasoning = '';
    let chunks = 0;

    for await (const chunk of factory()) {
        chunks++;

        // Assigned, never appended — see the note above. `??` rather than `||` so
        // a chunk that legitimately carries an empty string does not silently
        // resurrect the previous one, while a chunk missing the field entirely
        // leaves what we already have alone.
        content = String(chunk?.text ?? content);
        reasoning = String(chunk?.state?.reasoning ?? reasoning);

        if (onProgress) {
            try {
                onProgress({ content, reasoning });
            } catch (error) {
                // A failing progress display must not abandon a request that is
                // already half paid for. Report it once and keep reading.
                console.error('[Recall] Progress handler failed', error);
            }
        }
    }

    return { content, reasoning, chunks };
}
