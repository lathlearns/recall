/**
 * Recall — small shared helpers.
 */

/**
 * RFC4122-ish v4 id. `crypto.randomUUID` is available in every browser ST
 * supports, but it is only exposed on secure origins; ST is commonly served over
 * plain HTTP on a LAN address, where it is undefined. The fallback keeps ids
 * working there.
 * @returns {string}
 */
export function uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    return `recall-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Formats a timestamp for the manager's metadata lines.
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatTimestamp(ms) {
    if (!ms) {
        return '—';
    }
    try {
        return new Date(ms).toLocaleString();
    } catch {
        return String(ms);
    }
}

/**
 * Escapes text for insertion into HTML.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Renders a token count as a compact string: 19200 -> "19.2k".
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokens(tokens) {
    const n = Number(tokens);
    if (!Number.isFinite(n)) {
        return '—';
    }
    if (Math.abs(n) < 1000) {
        return String(Math.round(n));
    }
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

/**
 * Clamps a number into a range, falling back to `fallback` for junk input.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, n));
}

/**
 * The most the model may write in one request: the hard cutoff, or whatever the
 * window has left once the request is in it, whichever is less.
 *
 * Some APIs (Claude's among them) refuse a request whose input plus its
 * `max_tokens` exceeds the context window, rather than letting the reply run
 * into the end. The buffer is sized against the reserve, not the cutoff, so on a
 * near-full one the cutoff can ask for more room than exists. Fitting the
 * request — never the setting — keeps it under, and the room left is never less
 * than the reserve, because the buffer was refused if it would have taken any of
 * that.
 *
 * @param {number} cutoff The hard cutoff; 0 means none is sent.
 * @param {number} room Tokens the window has left after the request.
 * @returns {{ limit: number, lowered: boolean }}
 */
export function fitOutputLimit(cutoff, room) {
    const ceiling = Math.max(0, Number(cutoff) || 0);
    if (!ceiling) {
        return { limit: 0, lowered: false };
    }
    const limit = Math.max(1, Math.min(ceiling, Math.floor(Number(room) || 0)));
    return { limit, lowered: limit < ceiling };
}

/**
 * Why a run's limit was fitted below the hard cutoff, and what gives it more
 * room — which depends on what set the room.
 *
 * Summarize now reads everything since the last summary, so smaller requests
 * are the way out. A redo reads a fixed set of messages, and the reserve cancels
 * out of the room it leaves, so only a bigger window helps. A rebuild batch is
 * cut to fit wherever it would take any of the reserve, so raising the reserve
 * cuts batches smaller and leaves each one more room. Raising the hard cutoff helps
 * none of them: it was not the limit.
 *
 * Said by the run as it starts (ui.js) and by a run that then thinks its whole
 * room away (generate.js), so the two always agree.
 *
 * @param {'summarize'|'regenerate'|'rebuild'} kind
 * @returns {{ why: string, fix: string }} Both clauses, without a full stop; `fix` starts lower-case.
 */
export function roomRemedy(kind) {
    if (kind === 'rebuild') {
        return {
            why: 'This batch leaves less room for the summary than your hard cutoff allows',
            fix: 'raise "Reserved for the summary" in Advanced so batches are cut smaller and leave more room, '
                + 'or lower Reasoning Effort for this API',
        };
    }
    if (kind === 'regenerate') {
        return {
            why: 'The messages this summary read leave less room for the summary than your hard cutoff allows',
            fix: 'raise the context size if your model can take more, or lower Reasoning Effort for this API',
        };
    }
    return {
        why: 'This chat is long, so there is less room for the summary than your hard cutoff allows',
        fix: 'summarize it in batches with the Rebuild button in the manager to give each request more room, '
            + 'or lower Reasoning Effort for this API',
    };
}
