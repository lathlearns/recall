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

import { getMaxPromptTokens, main_api } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
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
 * @returns {{id: string, name: string, api: string, model: string}[]}
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
 * @returns {{id: string, name: string, api: string, model: string}|null}
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

    const result = await ConnectionManagerRequestService.sendRequest(
        profile.id,
        messages,
        Math.max(1, Number(settings.outputBudget) || 1024),
        {
            stream: false,
            signal,
            extractData: true,
            // Off by default: a preset tuned for roleplay prose is the wrong sampler
            // set for an editing task, and it can also carry its own max_tokens,
            // which would quietly displace the output budget.
            includePreset: !!settings.profileUsePreset,
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

    return `Summarising through "${profile.name}"${model ? ` with ${model}` : ''}`
        + `${overridden ? ' (model overridden)' : ''}. Your selected profile is not changed.`;
}
