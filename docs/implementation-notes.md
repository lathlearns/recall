# Implementation notes

Where the code deliberately departs from [the design document](recall-design.md), and why.
Checked against SillyTavern 1.18.0, commit `51ad27f`. This lived in the README until it
outgrew its welcome there; it is written for whoever next has to change this code, not for
someone deciding whether to install it.

## Deviations from the spec

**§9 — `findItemizedPromptSet` is not used.** It returns an *index*, not an entry, and it
mutates the module-level state behind ST's own prompt-itemization viewer while logging
several lines per call. Calling it on every received message would corrupt that viewer's
target. Recall does its own side-effect-free lookup.

**§9 — `entry.finalPrompt` is only populated for non-OAI APIs.** Chat Completion sources
(OpenRouter, NanoGPT, Claude, Google) instead carry a pre-summed `oaiTotalTokens`. As
specified, the nudge would silently never fire on exactly the target configuration. Recall
branches on the entry's own stored `main_api`.

**§4 — the macro is registered twice when the macro engine is off.** The registry is
invisible to the legacy substitution path, which builds replacements from
`MacrosParser.populateEnv`. `experimental_macro_engine` defaults to true in 1.18.0, but it
is a user-facing toggle, and with it off a registry-only macro resolves empty with no error
at all.

**§7 — `hideChatMessageRange` is not used.** It sets `is_system` across a whole span, which
would flip genuine system messages and defeat §8.1's rule that Recall only ever unhides what
it actually hid. Recall flips indices individually and saves once.

**§12 — branching needs no code.** `saveChat` already spreads `chat_metadata` into the new
chat file, so a branch inherits the archive, the active pointer and the hide records for
free. A branch cut below a summary's anchor shows up as a stale badge on the next chat load,
which is the correct outcome.

**§12 — `MESSAGE_SENT` is not wired as a nudge trigger.** A judgement call rather than a
correction: no itemized entry exists for a message that has not been generated against yet,
so the check would always skip. Only `MESSAGE_RECEIVED` fires the nudge.

## Things that bite

**Templates are Handlebars, and every macro in them is live.** ST registers a global
`helperMissing` that pipes any unknown expression through `substituteParams`, so naming a
macro in help-text prose *resolves* it — writing the recall macro in a paragraph expanded it
to the entire active summary, in the middle of a settings panel, twice. Braces in these
templates are written as `&#123;` and `&#125;`. Handlebars does not respect HTML comments
either, so a malformed example inside one is a compile error that takes the whole template
with it. `test/templates.mjs` guards both.

**Regeneration must not derive its material from the coverage range.** Coverage is a range;
what a summary actually read was "whatever was visible", which is that range minus arbitrary
holes wherever an earlier summary or the user had already hidden something. The two coincide
only for the first summary in a chat. Deriving one from the other — which Recall did until
this was caught — feeds a redo every message an earlier summary hid: on a chat with three
summaries, the third was regenerated against 151 messages when it had read 56. Summaries
record their read set at generation time; older ones without that record prompt the user
rather than guessing.

**Request parameters arrive from places the user is not looking.** Two found so far, both
fixed in 1.1.x: a connection profile sent with no preset gets no sampler parameters at all
(not ST's defaults — none, so the provider's apply), and `stop` is filled from the global
`power_user.custom_stopping_strings` regardless of which profile is in play. Anything read
out of `oai_settings` or `power_user` at request time is worth checking against "would the
user expect this to govern a summary?"

## Deferred

Per §14: the persistent nudge indicator (the toast and threshold tracking do ship), multiple
named block sets beyond the global-plus-override model, and the desktop draggable popout.
