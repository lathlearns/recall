/**
 * Recall — running summarization through a connection profile of its own.
 *
 * Summarising is a different job from roleplaying, and often wants a different
 * model: cheaper, longer-context, less florid. `ConnectionManagerRequestService`
 * makes that possible without disturbing anything — it takes a profile id and
 * issues the request against that profile's API, model, secret and proxy, leaving
 * the user's selected profile exactly where it was.
 *
 * When no profile is chosen, Recall uses the main API through `generateRawData`
 * as before. That path stays the default and the fallback.
 */

import { getMaxPromptTokens, main_api, eventSource, event_types } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { getCustomStoppingStrings } from '../../../../power-user.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { getSettings } from './settings.js';

/** Connection Manager's own manifest key. Without it, profiles do not exist. */
const CONNECTION_MANAGER = 'connection-manager';

/**
 * Whether profile-based generation can be used at all.
 * @returns {boolean}
 */
export function isConnectionManagerAvailable() {
    return !(extension_settings.disabledExtensions ?? []).includes(CONNECTION_MANAGER)
        && Array.isArray(extension_settings.connectionManager?.profiles);
}

/**
 * The profiles Recall can target. Connection Manager itself filters to Chat
 * Completion and Text Completion, which are the only two the request service
 * knows how to drive.
 * @returns {{id: string, name: string, api: string, model: string, preset: string}[]}
 */
export function listProfiles() {
    if (!isConnectionManagerAvailable()) {
        return [];
    }

    try {
        return ConnectionManagerRequestService.getSupportedProfiles().map(profile => ({
            id: profile.id,
            name: profile.name ?? '(unnamed)',
            api: profile.api ?? '',
            model: profile.model ?? '',
            // Recall never loads this itself — ST resolves the name when the
            // request is sent — but the panel names it, so it is carried along.
            preset: profile.preset ?? '',
        }));
    } catch (error) {
        console.warn('[Recall] Could not list connection profiles', error);
        return [];
    }
}

/**
 * The profile Recall is configured to summarise with, or null for the main API.
 * A profile that has since been deleted resolves to null rather than erroring, so
 * a stale setting degrades to "use the main API" instead of breaking generation.
 * @returns {{id: string, name: string, api: string, model: string, preset: string}|null}
 */
export function getActiveProfile() {
    const id = getSettings().profileId;
    if (!id || !isConnectionManagerAvailable()) {
        return null;
    }
    return listProfiles().find(profile => profile.id === id) ?? null;
}

/**
 * The model that will actually be used, after any override.
 * @returns {string}
 */
export function getEffectiveModel() {
    const override = String(getSettings().modelOverride ?? '').trim();
    if (override) {
        return override;
    }
    return getActiveProfile()?.model ?? '';
}

/**
 * The prompt budget to size the buffer against.
 *
 * `getMaxPromptTokens()` describes the *active* connection, which is the wrong
 * number the moment summarization runs somewhere else: summarising through a
 * 200k-context profile while roleplaying on 32k would refuse work that would fit,
 * and the reverse would build a buffer the API rejects. Neither failure is
 * obviously about the profile when you hit it, so the override exists.
 *
 * @returns {number}
 */
export function getPromptBudget() {
    const settings = getSettings();

    if (getActiveProfile() && Number(settings.profileContextSize) > 0) {
        return Number(settings.profileContextSize) - Math.max(0, Number(settings.responseReserve) || 0);
    }

    return getMaxPromptTokens(settings.responseReserve);
}

/**
 * Whether the user has any custom stopping strings at all.
 *
 * Read rather than assumed so that a user who has none sends exactly the payload
 * they sent before: the guard is what keeps this from being a change to everyone's
 * requests in service of the subset it protects.
 * @returns {boolean}
 */
function hasCustomStoppingStrings() {
    try {
        return getCustomStoppingStrings().length > 0;
    } catch (error) {
        console.warn('[Recall] Could not read custom stopping strings', error);
        return false;
    }
}

/**
 * The same protection for the main API path, where there is no payload to
 * override — `generateRawData` takes no stopping-string option.
 *
 * ST emits `CHAT_COMPLETION_SETTINGS_READY` with the assembled payload and sends
 * whatever the listeners leave behind, which is the documented seam for exactly
 * this; ST's own temporary-response-length machinery uses the same `once` hook.
 *
 * The listener is removed in the caller's `finally` whether or not it fired. A
 * `once` listener that never fires is not inert — it waits, and the next thing to
 * fire it would be the user's own roleplay generation, silently stripped of the
 * stopping strings they set. That is a worse bug than the one being fixed, so the
 * cleanup is not optional and this returns the function that performs it.
 *
 * @returns {() => void} Removes the hook. Always call it.
 */
export function suppressStoppingStrings() {
    if (main_api !== 'openai' || !hasCustomStoppingStrings()) {
        return () => {};
    }

    const hook = generateData => {
        if (generateData && typeof generateData === 'object') {
            delete generateData.stop;
        }
    };

    eventSource.once(event_types.CHAT_COMPLETION_SETTINGS_READY, hook);

    return () => eventSource.removeListener(event_types.CHAT_COMPLETION_SETTINGS_READY, hook);
}

/**
 * Sends the summarization request through the configured profile.
 *
 * @param {string} systemPrompt
 * @param {string} buffer
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ content: string, reasoning: string }>}
 */
export async function generateViaProfile(systemPrompt, buffer, signal = null) {
    const settings = getSettings();
    const profile = getActiveProfile();

    if (!profile) {
        throw new Error('No connection profile is configured for Recall.');
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buffer },
    ];

    /** @type {Record<string, any>} */
    const overridePayload = {};

    // An explicit model id wins over the profile's stored one. There is no list to
    // validate it against — a connection profile records a single model string and
    // ST only enumerates models for the source it is currently connected to — so a
    // typo surfaces as the provider's own error, which is reported verbatim.
    const override = String(settings.modelOverride ?? '').trim();
    if (override) {
        overridePayload.model = override;
    }

    // Your chat's stopping strings do not belong in a summarization request.
    //
    // ST fills `stop` from `power_user.custom_stopping_strings` — a global setting
    // in Advanced Formatting, not part of any preset or profile — so it rides along
    // whichever profile is picked. The strings people put there are the ones that
    // end a roleplay turn, and two of the commonest, `###` and `---`, are exactly
    // what the required summary structure is built out of. With macro substitution
    // on, `{{user}}:` is worse: a summary names the persona in its first paragraph.
    //
    // The provider stops at the first match and reports `finish_reason: "stop"`,
    // which is indistinguishable from finishing. A summary cut off after its first
    // section is long enough to save, and the next pass revises *that*, so the lost
    // sections never come back.
    //
    // Sent only when there is something to clear. An empty array is valid for every
    // source ST supports, but a payload that is byte-identical to before whenever
    // the user has no stopping strings cannot regress anyone who was never at risk.
    if (hasCustomStoppingStrings()) {
        overridePayload.stop = [];
    }

    const result = await ConnectionManagerRequestService.sendRequest(
        profile.id,
        messages,
        Math.max(1, Number(settings.outputBudget) || 1024),
        {
            stream: false,
            signal,
            extractData: true,
            // Always the profile's own preset. Without it ST sends no sampler
            // parameters at all — temperature and the rest are undefined and get
            // stripped from the payload — so the request would run on whatever
            // the provider defaults to, which is a third sampler set nobody chose
            // and cannot see. A profile picked for summarising comes with a preset
            // picked for summarising; that is the one the user can actually edit.
            //
            // ST re-applies this payload over the preset's, so the output budget
            // and any model override still win. The preset's context length lands
            // as truncation_length on a text completion profile, which is why its
            // context size is configured separately above.
            includePreset: true,
            includeInstruct: true,
        },
        overridePayload,
    );

    // extractData: true and stream: false means an ExtractedData object, which
    // already separates reasoning from content — no stripping needed on this path.
    return {
        content: String(result?.content ?? ''),
        reasoning: String(result?.reasoning ?? ''),
    };
}

/**
 * A one-line description of where summarization will run, for the settings panel.
 * @returns {string}
 */
export function describeTarget() {
    if (!isConnectionManagerAvailable()) {
        return 'Connection Manager is disabled, so Recall uses the main API.';
    }

    const settings = getSettings();
    const profile = getActiveProfile();

    if (!profile) {
        if (settings.profileId) {
            return 'That profile no longer exists. Recall is using the main API until you pick another.';
        }
        return `Using the main API (${main_api}), the same connection as your chat.`;
    }

    const model = getEffectiveModel();
    const overridden = !!String(settings.modelOverride ?? '').trim();

    // The preset is named because it is the one thing here the user did not pick
    // in this panel: it arrives with the profile, and its samplers are what the
    // summary is actually generated under.
    const preset = String(profile.preset ?? '').trim();

    return `Summarising through "${profile.name}"${model ? ` with ${model}` : ''}`
        + `${overridden ? ' (model overridden)' : ''}`
        + `${preset ? `, under its "${preset}" preset` : ''}. Your selected profile is not changed.`;
}
