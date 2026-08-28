/**
 * Recall — a private SillyTavern memory/summary extension.
 *
 * Recall keeps one recursive, whole-chat summary in permanent context, resolved
 * through the `{{recall}}` macro. It injects nothing: the user's preset owns
 * placement, and Recall's only job on the prompt side is to make that macro
 * resolve.
 *
 * Target: SillyTavern 1.18.0.
 */

import { eventSource, event_types } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

import { getSettings } from './src/settings.js';
import { getStore, runDriftDetection } from './src/store.js';
import { registerMacro, registerSlashCommand } from './src/macro.js';
import { summarizeNow, RecallError } from './src/generate.js';
import { evaluateNudge, resetNudge, disarmNudge } from './src/nudge.js';
import { initDrawer, refreshDrawer, toastNudge } from './src/ui.js';

const MODULE_NAME = 'recall';

/** The built-in Summarize extension's manifest key. */
const BUILTIN_SUMMARIZE = 'memory';

/**
 * Summarize now, wired to the drawer button, the manager button and `/recall`.
 * Refusals are user-facing text and are shown as toasts here; the manager also
 * renders them inline, since the user may not be looking at the screen.
 */
async function handleSummarize(steeringNote = '') {
    try {
        const record = await summarizeNow(steeringNote);

        // The nudge clears and re-arms only once usage has actually dropped back
        // below the threshold — see the dead zone in nudge.js.
        disarmNudge();
        refreshDrawer();

        toastr.success(
            `Summarized messages ${record.coversFrom}–${record.coversTo}.`,
            'Recall',
        );
        return record;
    } catch (error) {
        if (error instanceof RecallError) {
            toastr.warning(error.message, 'Recall', { timeOut: 12000, extendedTimeOut: 6000 });
        } else {
            console.error('[Recall] Summarization failed', error);
            toastr.error(String(error?.message ?? error), 'Recall');
        }
        refreshDrawer();
        return null;
    }
}

/**
 * The built-in Summarize registers `{{summary}}` and calls `setExtensionPrompt`
 * unconditionally on chat load. Left enabled alongside Recall, that risks a
 * duplicated summary in context and a macro collision whose winner depends on
 * load order.
 *
 * Recall never writes to `chat[i].extra.memory`, which keeps Summarize's own
 * injection empty and therefore inert — but that only holds while Summarize is
 * paused. If it is generating on its own interval it will populate that field
 * itself, so the warning stands.
 */
function checkPrerequisites() {
    const disabled = extension_settings.disabledExtensions ?? [];

    if (!disabled.includes(BUILTIN_SUMMARIZE)) {
        console.warn('[Recall] The built-in Summarize extension appears to be enabled.');
        toastr.warning(
            'The built-in Summarize extension is still enabled. Disable it in the Extensions manager, '
            + 'or at minimum tick its Pause box — otherwise it will inject a second summary into context.',
            'Recall',
            { timeOut: 15000, extendedTimeOut: 8000 },
        );
    }
}

function onChatChanged() {
    getSettings();
    getStore();

    const { staled } = runDriftDetection(getSettings().deepIntegrityCheck);

    if (staled.length) {
        toastr.warning(
            `${staled.length} summar${staled.length === 1 ? 'y is' : 'ies are'} anchored to messages that no longer exist. `
            + 'Open the Recall manager to re-anchor or delete them.',
            'Recall',
            { timeOut: 12000 },
        );
    }

    resetNudge();
    refreshDrawer();
}

function onMessageChanged() {
    runDriftDetection(getSettings().deepIntegrityCheck);
    refreshDrawer();
}

/**
 * The nudge reads the size of the last prompt actually sent, so it is only
 * meaningful once a generation has produced an itemized entry. MESSAGE_SENT has
 * no new entry to read yet and would always skip, so only MESSAGE_RECEIVED is
 * wired.
 */
async function onMessageReceived(mesId) {
    try {
        const result = await evaluateNudge(Number(mesId));
        if (result?.fired) {
            toastNudge(result);
        }
        refreshDrawer();
    } catch (error) {
        console.error('[Recall] Nudge evaluation failed', error);
    }
}

jQuery(async () => {
    try {
        getSettings();

        registerMacro();
        registerSlashCommand(handleSummarize);

        await initDrawer({ onSummarize: handleSummarize });

        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.MESSAGE_DELETED, onMessageChanged);
        eventSource.on(event_types.MESSAGE_EDITED, onMessageChanged);

        eventSource.once(event_types.APP_READY, checkPrerequisites);

        console.log(`[${MODULE_NAME}] ready`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] failed to initialise`, error);
    }
});
