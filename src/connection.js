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
import { CONNECT_API_MAP } from '../../../../slash-commands.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { getSettings } from './settings.js';
import { consumeStream, shouldRetryWithoutStreaming } from './stream.js';

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
 * Whether Recall will stream this profile's response rather than wait for it.
 *
 * **Chat Completion only, and this is a correctness boundary, not a preference.**
 *
 * `ChatCompletionService.processRequest` returns what the provider sent and does
 * nothing else to it, so streaming a Chat Completion profile produces byte-for-byte
 * what waiting for it would have produced.
 *
 * `TextCompletionService.processRequest` does not. After the request it strips
 * trailing whitespace, walks `stopping_strings` removing any partial match from
 * the tail, truncates at the instruct preset's `stop_sequence` and `input_sequence`,
 * and deletes every line of its `output_sequence` and `last_output_sequence` — and
 * all of that sits behind `if (!requestData.stream)`. Streaming a text completion
 * profile would therefore save a summary still wearing its instruct scaffolding.
 *
 * Recall passes `includeInstruct: true`, so those sequences are always set for a
 * profile that has an instruct preset. Reproducing forty lines of ST's internals
 * here to undo them is not a trade worth making for a progress display: the
 * summary is the artefact that lives in context forever, and it would be silently
 * wrong the first time the two copies drift. So text completion profiles keep the
 * non-streaming path, and the UI says why.
 *
 * @param {{api: string}|null} [profile]
 * @returns {boolean}
 */
export function canStreamProfile(profile = getActiveProfile()) {
    return !!profile
        && CONNECT_API_MAP[profile.api]?.selected === 'openai'
        && !streamingBroken.has(profile.id);
}

/**
 * Profiles whose streaming attempt failed but whose non-streaming attempt then
 * worked, for this session only.
 *
 * "Chat Completion" is not one protocol. Plenty of OpenAI-compatible endpoints
 * accept the exact payload Recall sends and reject it the moment `stream` is
 * true — a model that has no streaming variant, a gateway that does not proxy
 * SSE, a provider wanting `stream_options` it was not given. There is no way to
 * ask in advance, so the answer is learned from the one request that can tell us
 * and then remembered, instead of paying for a doomed streamed request every
 * time.
 *
 * Cleared by a reload, which is also what changing the model override amounts to
 * in practice — the entry is keyed by profile, and a profile pointed at a
 * different model is worth one more attempt.
 *
 * @type {Map<string, string>} profile id -> what went wrong
 */
const streamingBroken = new Map();

/**
 * Why the live view is or is not available, for the settings panel.
 * @returns {string}
 */
export function describeStreaming() {
    const profile = getActiveProfile();

    if (!profile) {
        return 'The summary appears when it is finished. Live output needs a Chat Completion '
            + 'connection profile — the main API\'s raw-generation path does not stream.';
    }

    if (streamingBroken.has(profile.id)) {
        return `"${profile.name}" refused the streamed request, so Recall is using the ordinary `
            + 'one for the rest of this session — summaries still work, they just appear all at '
            + 'once. Not every OpenAI-compatible endpoint streams. Reload SillyTavern to try again.';
    }

    if (!canStreamProfile(profile)) {
        return `"${profile.name}" is a Text Completion profile, so the summary appears when it is `
            + 'finished. SillyTavern only strips instruct sequences from a response it did not '
            + 'stream, and a summary keeping them would be wrong for as long as it stays active.';
    }

    return `Streaming live from "${profile.name}". The summary is written into the manager as it arrives.`;
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
 * @param {object} [options]
 * @param {AbortSignal|null} [options.signal]
 * @param {((progress: {content: string, reasoning: string}) => void)|null} [options.onProgress]
 *        Called with the cumulative text as it arrives. Supplying it is what asks
 *        for streaming; it is still ignored on a profile that cannot stream, so a
 *        caller never has to check first.
 * @returns {Promise<{ content: string, reasoning: string, streamed: boolean }>}
 */
export async function generateViaProfile(systemPrompt, buffer, { signal = null, onProgress = null } = {}) {
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

    const wantsStream = !!onProgress && canStreamProfile(profile);

    if (!wantsStream) {
        const result = await send(false);
        return {
            content: String(result?.content ?? ''),
            reasoning: String(result?.reasoning ?? ''),
            streamed: false,
        };
    }

    // Whether anything actually arrived before the failure. A stream that broke
    // halfway is a real failure and must not be retried: the tokens are spent,
    // and asking again would charge for them twice. A stream that never started
    // has cost nothing, so the same request can be tried the other way.
    let started = false;
    const watch = progress => {
        started = started || !!progress.content || !!progress.reasoning;
        onProgress(progress);
    };

    try {
        // On the streaming branch `extractData` is ignored and what comes back is
        // a *factory*, not the generator — ST returns `async function* streamData()`
        // itself, so it has to be called before it can be iterated.
        //
        // `state.reasoning` arrives populated because ST builds that generator with
        // `overrideShowThoughts: true`, so reasoning is separated out whether or not
        // the user has ST's own thought display switched on. Recall only uses it to
        // tell "spent its whole budget thinking" apart from "returned nothing"; it
        // never reaches the summary.
        const { content, reasoning } = await consumeStream(await send(true), watch);
        return { content, reasoning, streamed: true };
    } catch (error) {
        if (!shouldRetryWithoutStreaming({ aborted: !!signal?.aborted, started })) {
            throw error;
        }

        // Retried without streaming rather than surfaced, because streaming is a
        // display feature and must never be why a summary fails. It also recovers
        // the error message: ST's streaming path reads the provider's response
        // body, throws `new Error(data)` from tryParseStreamingError — which is an
        // Error("[object Object]") — and then swallows it in a bare catch, leaving
        // the caller nothing but "Got response status 400". The ordinary path
        // reports what the provider actually said.
        console.warn('[Recall] The streamed request failed; retrying without streaming.', error);

        const result = await send(false);

        // Only now is streaming specifically the problem. Had this failed too it
        // would be the provider, the key or the network, none of which is a reason
        // to give up the live view for the session.
        streamingBroken.set(profile.id, error?.message || String(error));

        return {
            content: String(result?.content ?? ''),
            reasoning: String(result?.reasoning ?? ''),
            streamed: false,
            streamFailed: true,
        };
    }

    /** @param {boolean} stream */
    function send(stream) {
        return ConnectionManagerRequestService.sendRequest(
            profile.id,
            messages,
            Math.max(1, Number(settings.outputBudget) || 1024),
            {
                stream,
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
    }
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
