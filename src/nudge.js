/**
 * Recall — the context nudge, which replaces automatic summarization entirely.
 *
 * The user's workflow triggers on narrative structure — end of a day, end of a
 * subplot — which no message or word threshold can detect, so a threshold that
 * fires on its own is always wrong. What *is* useful is a signal that it is time
 * to start looking for a stopping point.
 *
 * Recall reads ST's own record of the last prompt actually sent, rather than
 * estimating what the next one might be.
 */

import { getMaxContextTokens } from '../../../../../script.js';
import { itemizedPrompts } from '../../../../itemized-prompts.js';
import { getTokenCountAsync } from '../../../../tokenizers.js';
import { getSettings, AUTO_NUDGE_FRACTION } from './settings.js';

/**
 * Whether the next upward crossing should fire. Cleared on fire and after a
 * successful summary; set again only by a reading below the threshold, which is
 * what gives the re-arm dead zone.
 */
let armed = true;

/** Last computed usage, for the drawer's at-a-glance line. */
let lastUsage = null;

export function resetNudge() {
    armed = true;
    lastUsage = null;
}

/**
 * Called after a successful summary: disarm, and let a below-threshold reading
 * re-arm. If usage is somehow still above the threshold right after summarizing,
 * this is what stops it firing again immediately.
 */
export function disarmNudge() {
    armed = false;
}

export function getLastUsage() {
    return lastUsage;
}

/**
 * The threshold in tokens. A stored 0 means "derive it from the context limit",
 * which keeps the default meaningful across wildly different context sizes.
 * @returns {number}
 */
export function getThresholdTokens() {
    const settings = getSettings();
    const stored = Number(settings.nudgeThreshold);

    if (Number.isFinite(stored) && stored > 0) {
        return stored;
    }

    return Math.round(getMaxContextTokens() * AUTO_NUDGE_FRACTION);
}

/**
 * Reads how many tokens the last prompt for `mesId` actually used.
 *
 * Deliberately not `findItemizedPromptSet()`: that returns an index rather than
 * an entry, mutates the module-level state behind ST's own prompt-itemization
 * viewer, and logs several lines per call — none of which is acceptable on every
 * received message.
 *
 * The entry's own `main_api` decides how to read it. `finalPrompt` is only
 * populated for non-OAI APIs; Chat Completion sources (OpenRouter, NanoGPT,
 * Claude, Google) instead carry pre-summed `oaiTotalTokens`, so on those the
 * count needs no tokenization at all.
 *
 * @param {number} mesId
 * @returns {Promise<number|null>} null when there is nothing to read yet.
 */
export async function readPromptUsage(mesId) {
    if (!Array.isArray(itemizedPrompts) || !itemizedPrompts.length) {
        return null;
    }

    let entry = null;
    for (let i = itemizedPrompts.length - 1; i >= 0; i--) {
        if (itemizedPrompts[i]?.mesId === mesId) {
            entry = itemizedPrompts[i];
            break;
        }
    }

    if (!entry) {
        return null;
    }

    if (entry.main_api === 'openai') {
        const total = Number(entry.oaiTotalTokens);
        return Number.isFinite(total) && total > 0 ? total : null;
    }

    if (!entry.finalPrompt) {
        return null;
    }

    return await getTokenCountAsync(entry.finalPrompt);
}

/**
 * Evaluates the threshold for the newest message.
 *
 * If no itemized entry exists yet — a fresh chat, or a swipe before any
 * generation — the check is skipped rather than falling back to an estimate.
 *
 * @param {number} mesId
 * @returns {Promise<{ usage: number, limit: number, threshold: number, crossed: boolean, fired: boolean }|null>}
 */
export async function evaluateNudge(mesId) {
    const settings = getSettings();

    const usage = await readPromptUsage(mesId);
    if (usage === null) {
        return null;
    }

    const limit = getMaxContextTokens();
    const threshold = getThresholdTokens();
    const crossed = usage >= threshold;

    lastUsage = { usage, limit, threshold, crossed, at: Date.now() };

    if (!crossed) {
        armed = true;
        return { usage, limit, threshold, crossed, fired: false };
    }

    if (!settings.nudgeEnabled || !armed) {
        return { usage, limit, threshold, crossed, fired: false };
    }

    // One toast per crossing, not one per message — otherwise the user gets a
    // toast every turn for the twenty messages spent hunting for a scene break.
    armed = false;
    return { usage, limit, threshold, crossed, fired: true };
}
