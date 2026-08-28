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
import { extension_settings } from '../../../../extensions.js';
import { getActiveSummary } from './store.js';
import { getFallbackSummary } from './legacy.js';
import { getSettings } from './settings.js';

export const MACRO_NAME = 'recall';

/** The built-in Summarize extension's manifest key. */
const BUILTIN_SUMMARIZE = 'memory';

/** The name the built-in claims. Only taken over while it is disabled. */
const ALIAS_NAME = 'summary';

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
        const active = getActiveSummary();
        if (active) {
            return active.content ?? '';
        }

        // No Recall summary for this chat. Stand in the built-in's, if the user
        // asked for that and one exists, so an old chat is not left with no memory
        // at all until the first Recall summary is generated.
        return getFallbackSummary();
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

    registerAlias();
}

/**
 * Also answer to `{{summary}}`, so a preset that was never updated keeps working.
 *
 * **Only while the built-in Summarize is disabled.** The registry overwrites on a
 * name collision with nothing but a console warning, and Recall's loading_order of
 * 10 puts it after Summarize's 9 — so with both enabled Recall would silently win
 * the name, and which summary reached the prompt would be a function of load
 * order. That is exactly the failure the design document avoided by choosing a
 * fresh macro name, and it is not worth reintroducing for a convenience.
 *
 * The condition is re-evaluated on every page load, so enabling Summarize again
 * hands the name straight back.
 */
function registerAlias() {
    if (!getSettings().summaryAlias) {
        return;
    }

    const summarizeDisabled = (extension_settings.disabledExtensions ?? []).includes(BUILTIN_SUMMARIZE);
    if (!summarizeDisabled) {
        console.info(`[Recall] The built-in Summarize is enabled, so {{${ALIAS_NAME}}} is left to it. Use {{recall}}.`);
        return;
    }

    if (macros.registry.hasMacro(ALIAS_NAME)) {
        console.warn(`[Recall] {{${ALIAS_NAME}}} is already registered by something else; leaving it alone. Use {{recall}}.`);
        return;
    }

    macros.registry.registerMacroAlias(MACRO_NAME, ALIAS_NAME);

    if (!power_user?.experimental_macro_engine) {
        MacrosParser.registerMacro(ALIAS_NAME, resolveRecall, 'The active Recall summary (alias of {{recall}}).');
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
