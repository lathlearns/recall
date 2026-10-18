/**
 * Recall — streaming the main API's Chat Completion request.
 *
 * ST's `generateRawData` never streams, so Recall builds the request itself from
 * ST's own pieces. What can go wrong does so quietly: a payload that is not the
 * one the main API would have sent, a budget written into the live settings the
 * user's own generations read, an event other extensions never see, or a failure
 * reported without saying whether text had already arrived — which decides
 * whether asking again is free or pays twice.
 *
 * connection.js and stream.js run for real; the ST modules under them are stand-ins.
 * Same throwaway-tree approach as rebuild.mjs.
 *
 * Run:  node test/main-api-stream.mjs
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'recall-main-stream-'));
const scripts = join(root, 'public', 'scripts');
const src = join(scripts, 'extensions', 'third-party', 'recall', 'src');

mkdirSync(src, { recursive: true });
cpSync('src', src, { recursive: true });

const stub = (path, body) => writeFileSync(join(root, path), body);

stub('public/script.js', `
export let main_api = 'openai';
export function setMainApi(api) { main_api = api; }
export function getMaxPromptTokens() { return 10000; }
const listeners = new Map();
export const event_types = {
    CHAT_COMPLETION_PROMPT_READY: 'prompt_ready',
    CHAT_COMPLETION_SETTINGS_READY: 'settings_ready',
    GENERATION_STOPPED: 'generation_stopped',
};
export const emitted = [];
export const eventSource = {
    on(type, fn) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn); },
    once(type, fn) { const wrap = (...a) => { this.removeListener(type, wrap); return fn(...a); }; wrap.inner = fn; this.on(type, wrap); },
    removeListener(type, fn) { for (const f of listeners.get(type) ?? []) if (f === fn || f.inner === fn) listeners.get(type).delete(f); },
    async emit(type, ...args) { emitted.push(type); for (const f of [...(listeners.get(type) ?? [])]) await f(...args); },
    count(type) { return listeners.get(type)?.size ?? 0; },
};
export function createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill) {
    return [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }];
}
`);
stub('public/scripts/extensions.js', 'export const extension_settings = {};');
stub('public/scripts/power-user.js', 'export function getCustomStoppingStrings() { return []; }');
stub('public/scripts/secrets.js', 'export const secret_state = {};');
stub('public/scripts/slash-commands.js', 'export const CONNECT_API_MAP = {};');
stub('public/scripts/openai.js', `
export const oai_settings = { openai_max_tokens: 300, chat_completion_source: 'custom', openai_model: 'm' };
export function getChatCompletionModel(settings) { return settings.openai_model; }
export const built = [];
export async function createGenerationParameters(settings, model, type, messages) {
    built.push({ type, maxTokens: settings.openai_max_tokens });
    return {
        generate_data: { messages, model, type, stream: false, max_tokens: settings.openai_max_tokens, chat_completion_source: settings.chat_completion_source, stop: ['###'] },
        stream: false,
    };
}
`);
stub('public/scripts/custom-request.js', `
export const control = { sent: [], behaviour: 'ok' };
export class ChatCompletionService {
    static async sendRequest(data, extractData, signal) {
        control.sent.push(structuredClone(data));
        if (control.behaviour === 'refuse') throw new Error('Got response status 400');
        const behaviour = control.behaviour;
        return async function* () {
            yield { text: 'The', state: { reasoning: 'hm' } };
            if (behaviour === 'break') throw new Error('connection reset');
            if (behaviour === 'hang') {
                await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted'))));
            }
            yield { text: 'The ford', state: { reasoning: 'hm' } };
        };
    }
}
`);
stub('public/scripts/extensions/shared.js', 'export const ConnectionManagerRequestService = {};');
stub('public/scripts/extensions/third-party/recall/src/settings.js', `
export function getSettings() { return { profileId: '', outputBudget: 0, modelOverride: '' }; }
`);

const load = path => import(pathToFileURL(join(src, path)).href);
const st = await import(pathToFileURL(join(root, 'public/script.js')).href);
const openai = await import(pathToFileURL(join(scripts, 'openai.js')).href);
const request = await import(pathToFileURL(join(scripts, 'custom-request.js')).href);
const connection = await load('connection.js');

const failures = [];
const check = (label, actual, expected) => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        failures.push(`${label}: expected ${b}, got ${a}`);
    }
};
const failureOf = async promise => promise.then(() => null, error => error);

// 1. The request is the main API's quiet one, streamed, with the budget applied to a copy.
{
    const progress = [];
    const result = await connection.streamViaMainApi('SYS', 'BUFFER', { maxTokens: 900, onProgress: p => progress.push(p.content) });
    const sent = request.control.sent[0];
    check('result', result, { content: 'The ford', reasoning: 'hm' });
    check('progress is cumulative', progress, ['The', 'The ford']);
    check('streamed', sent.stream, true);
    check('quiet request type', sent.type, 'quiet');
    check('messages from createRawPrompt', sent.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'BUFFER' }]);
    check('budget sent', sent.max_tokens, 900);
    check('live settings untouched', openai.oai_settings.openai_max_tokens, 300);
    check('events in ST order', st.emitted, ['prompt_ready', 'settings_ready']);
    check('stop hook removed', st.eventSource.count('generation_stopped'), 0);
}

// 2. No budget: the chat's own response length.
{
    request.control.sent.length = 0;
    await connection.streamViaMainApi('SYS', 'BUFFER');
    check('no budget: the chat\'s own', request.control.sent[0].max_tokens, 300);
}

// 3. The settings event reaches listeners before sending, so suppression works.
{
    request.control.sent.length = 0;
    st.eventSource.once(st.event_types.CHAT_COMPLETION_SETTINGS_READY, data => { delete data.stop; });
    await connection.streamViaMainApi('SYS', 'BUFFER');
    check('a settings listener edits what is sent', 'stop' in request.control.sent[0], false);
}

// 4. Refused before anything arrived: free to ask again the other way.
{
    request.control.behaviour = 'refuse';
    const error = await failureOf(connection.streamViaMainApi('SYS', 'BUFFER'));
    check('refused: not started, not aborted', [error?.started, error?.aborted], [false, false]);
}

// 5. Broke after text arrived: not free to ask again.
{
    request.control.behaviour = 'break';
    const error = await failureOf(connection.streamViaMainApi('SYS', 'BUFFER'));
    check('broke midway: started', error?.started, true);
}

// 6. Recall's Stop and ST's own stop both abort it, and say so.
{
    request.control.behaviour = 'hang';
    const controller = new AbortController();
    const pending = failureOf(connection.streamViaMainApi('SYS', 'BUFFER', { signal: controller.signal }));
    await new Promise(r => setTimeout(r, 10));
    controller.abort();
    check('Recall stop: aborted', (await pending)?.aborted, true);

    const pendingSt = failureOf(connection.streamViaMainApi('SYS', 'BUFFER'));
    await new Promise(r => setTimeout(r, 10));
    await st.eventSource.emit(st.event_types.GENERATION_STOPPED);
    check('ST stop: aborted', (await pendingSt)?.aborted, true);
    check('stop hook removed after a stop', st.eventSource.count('generation_stopped'), 0);
}

// 7. Which main APIs stream, and the session's memory of one that would not.
{
    check('chat completion streams', connection.canStreamMainApi(), true);
    st.setMainApi('textgenerationwebui');
    check('text completion does not', connection.canStreamMainApi(), false);
    st.setMainApi('openai');
    connection.markMainApiStreamingBroken(new Error('400'));
    check('refused once: not again this session', connection.canStreamMainApi(), false);
}

rmSync(root, { recursive: true, force: true });

if (failures.length) {
    console.error(`${failures.length} main-API streaming check(s) failed:`);
    for (const failure of failures) {
        console.error(`  ${failure}`);
    }
    process.exit(1);
}
console.log('All main-API streaming checks pass.');
