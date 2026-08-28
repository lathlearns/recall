/**
 * Recall — the `{{recall}}` macro and the `/recall` slash command.
 *
 * Recall injects nothing. It never calls `setExtensionPrompt`; the user's preset
 * owns placement, and this macro's only job is to make the preset's block resolve.
 */

import { macros, MacroCategory } from '../../../../macros/macro-system.js';
import { MacrosParser } from '../../../../macros.js';
import { power_user } from '../../../../power-user.js';
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../slash-commands/SlashCommand.js';
import { getActiveSummary } from './store.js';

export const MACRO_NAME = 'recall';

/**
 * Resolves to the active summary's `content` field and nothing else. No other
 * field on a summary record — name, coverage range, timestamps, block set — has
 * any code path to the prompt; the coverage numbers are for the user, and the LLM
 * cannot see them.
 *
 * Empty resolution is deliberate and needs no special handling: with no active
 * summary the user's preset renders `[Summary: ]`, a labelled empty block, which
 * is exactly what the summary prompt expects to receive on a first run.
 *
 * @returns {string}
 */
function resolveRecall() {
    try {
        return getActiveSummary()?.content ?? '';
    } catch (error) {
        console.error('[Recall] Macro resolution failed', error);
        return '';
    }
}

export function registerMacro() {
    macros.registry.registerMacro(MACRO_NAME, {
        // MISC rather than UNCATEGORIZED: the registry treats the latter as "the
        // author forgot to pick one", and says so in its own source comment.
        category: MacroCategory?.MISC ?? 'misc',
        description: 'The active Recall summary.',
        returns: 'The active summary text, or an empty string if none is active.',
        handler: resolveRecall,
    });

    // The registry is invisible to the legacy substitution path: `evaluateMacros`
    // builds its replacements from `MacrosParser.populateEnv`, not from the
    // registry. `experimental_macro_engine` defaults to true in 1.18.0, but it is
    // a user-facing toggle, and with it off a registry-only macro would resolve
    // empty with no error at all. Registering the legacy form as well closes that
    // hole; the legacy bridge into the new engine no-ops while the flag is off, so
    // this never double-registers.
    if (!power_user?.experimental_macro_engine) {
        console.warn('[Recall] The experimental macro engine is disabled; registering {{recall}} through the legacy macro parser as well.');
        MacrosParser.registerMacro(MACRO_NAME, resolveRecall, 'The active Recall summary.');
    }
}

/**
 * `/recall` — a convenience trigger equivalent to Summarize now. Not load-bearing.
 * @param {() => Promise<void>} onTrigger
 */
export function registerSlashCommand(onTrigger) {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: MACRO_NAME,
        callback: async () => {
            await onTrigger();
            return '';
        },
        helpString: 'Generates a new Recall summary of the currently visible chat. Equivalent to the Summarize now button.',
    }));
}
