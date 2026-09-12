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

**`eventSource.emit` is awaited, and `MESSAGE_RECEIVED` fires *before* the message renders.**
On the non-streaming path `saveReply` emits it and then calls `addOneMessage`, so anything an
extension awaits in that listener sits between the reply arriving and the reply appearing.
Recall's nudge was awaiting a tokenizer call on the whole final prompt — a server round-trip
with the entire prompt as its body, and a cache miss every turn, since every turn's prompt is
a new string. Chat Completion sources were never affected: they read the pre-summed
`oaiTotalTokens` off the itemized entry and tokenize nothing, which is also why it went
unnoticed. The listener is now sync and lets the promise settle on its own. **Nothing in a
`MESSAGE_RECEIVED` handler should be awaited unless the message genuinely must not render
until it finishes.**

**Streaming and non-streaming responses are not post-processed alike, and only one of them is
cleaned up.** `TextCompletionService.processRequest` strips trailing whitespace, walks
`stopping_strings` removing partial matches from the tail, and truncates at the instruct
preset's `stop_sequence`, `input_sequence`, `output_sequence` and `last_output_sequence` —
all of it behind `if (!requestData.stream)`. `ChatCompletionService.processRequest` does none
of it and returns what the provider sent. So streaming a Chat Completion profile is
byte-identical to waiting for it, while streaming a text completion profile would save a
summary still wearing its instruct scaffolding — permanently, in the one artefact that stays
in context. That asymmetry, not preference, is why Recall's live view is Chat Completion only.

**ST's streaming chunks are cumulative, not deltas.** Each yield from the generator
`sendRequest` returns carries the whole response so far — `text` and `state.reasoning` both.
Appending them, which is what a stream reader normally does, yields a response containing
every prefix of itself: it does not throw, and it looks exactly like a model stuck in a
repetition loop. Also note the generator is returned as a *factory*: `sendRequest` hands back
`async function* streamData()` itself, so it must be called before it can be iterated.

**A streamed request's error body is read and then discarded.** On failure the streaming path
calls `tryParseStreamingError`, which throws `new Error(data)` — an `Error("[object Object]")`
— into a bare `catch {}` that swallows it, leaving the caller `Got response status 400` and
nothing else. The provider's actual complaint is unrecoverable on that path. Recall's
fallback to a non-streamed request exists partly for this: the ordinary path reports what the
provider said.

**`readSecret` answers an unknown secret id with an empty string, not an error.** A connection
profile records which stored key to use by id, and rotating or re-entering that key leaves the
profile pointing at an id that no longer exists. The request then goes out with no credentials
and comes back 401 — while the same profile keeps working in the chat, because the ordinary
generation path passes no id and `readSecret` falls through to whichever key is `active`. The
result is a profile that is healthy everywhere except the one feature that names its key
explicitly, which reads as a bug in that feature. Recall checks the id against the client's own
`secret_state` (ids and masked values, no request) before spending a call.

**Request parameters arrive from places the user is not looking.** Two found so far, both
fixed in 1.1.x: a connection profile sent with no preset gets no sampler parameters at all
(not ST's defaults — none, so the provider's apply), and `stop` is filled from the global
`power_user.custom_stopping_strings` regardless of which profile is in play. Anything read
out of `oai_settings` or `power_user` at request time is worth checking against "would the
user expect this to govern a summary?"

## Deferred

Per §14: the persistent nudge indicator (the toast and threshold tracking do ship), multiple
named block sets beyond the global-plus-override model, and the desktop draggable popout.
