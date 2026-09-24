# Host notes: SillyTavern

What SillyTavern gives Recall, where Recall departs from [the feature
reference](feature-reference.md) because of it, and the SillyTavern behaviour that has bitten.
Written for whoever next changes this code. LumiRecall keeps the same file for Lumiverse.

Checked against SillyTavern **1.18.0** (commit `51ad27f`). § numbers are the feature
reference's.

---

## What SillyTavern provides

How each item in §21 is met.

| §21 requirement | SillyTavern |
|---|---|
| A custom macro resolved at prompt-assembly time | `macros.registry.registerMacro`, plus `MacrosParser.registerMacro` — see [the macro is registered twice](#the-macro-is-registered-twice) |
| The chat as an ordered list with name, text, hidden flag | The global `chat` array: `name`, `mes`, `is_system` |
| Set the hidden flag and persist it | Set `is_system` per index, then `saveChatConditional` |
| Per-chat metadata that travels with the chat file | `chat_metadata.recall`, saved with `saveMetadata` / `saveMetadataDebounced` |
| Global settings storage | `extension_settings.recall`, saved with `saveSettingsDebounced` |
| A two-message completion outside the chat flow | `ConnectionManagerRequestService.sendRequest` for a profile; `generateRawData` for the main API |
| A token counter for the summarising model | `/api/tokenizers/openai/count?model=…` for a Chat Completion profile on another model; `getTokenCountAsync` otherwise |
| The context limit | `getMaxPromptTokens`, or the profile context size the user enters |
| The size of the last prompt sent | `itemizedPrompts` — see [the nudge](#the-nudge-reads-itemizedprompts-itself) |
| Events | `CHAT_CHANGED`, `MESSAGE_RECEIVED`, `MESSAGE_EDITED`, `MESSAGE_DELETED` |
| Card fields, persona, group cards | `characters[this_chid]` with the chat's `scenario` / `mes_example` overrides, `getGroupCharacterCards`, `power_user` |
| The chat preset's prompt blocks in display order | `promptManager.getPromptOrderForCharacter` over `oai_settings.prompts` |
| Reasoning stripping | `removeReasoningFromString`, `extractReasoningFromData` |
| Connection profiles | `extension_settings.connectionManager.profiles` |
| Custom stopping strings, suppressible per request | `power_user.custom_stopping_strings`; `stop: []` in the profile payload, `CHAT_COMPLETION_SETTINGS_READY` on the main API |
| Streaming | `sendRequest(…, { stream: true })` — Chat Completion profiles only, see [below](#streaming-is-chat-completion-only) |
| An abort signal | Honoured by `sendRequest`; `generateRawData` takes none |
| Stored API key ids | `secret_state` |

Other surfaces in use: `Popup` for the manager and its confirms,
`renderExtensionTemplateAsync` for the templates, `SlashCommandParser` for `/recall`.

---

## Where Recall departs from the reference

**Stop is hidden on the main API.** `generateRawData` takes no abort signal, so a summary
running through your chat's own connection cannot be cancelled. The button is hidden there
rather than offered and found to do nothing (§16).

**The title request thinks if the connection does.** The reference asks for no thinking on
the separate title request "where the host can say so". SillyTavern cannot say it once for
every provider: `reasoning_effort: 'auto'` turns Claude's thinking off but lets Gemini decide,
and `min` is a zero thinking budget on Gemini but 1,024 tokens on older Claude models. So the
title request is sent like any other, and a model that spends its 32 tokens thinking leaves
the summary on its timestamp (§7).

**Text completion profiles count with the chat's tokenizer.** Their tokenizer is the
backend's own, reachable only while that backend is the main connection (§16).

**The chat changing mid-run discards the result.** SillyTavern's chat state is global, so a
result that lands after a chat switch could be written into the wrong chat. Recall compares
the chat, character and group it started with and throws the result away if any changed
(§13).

---

## Things that bite

### Templates are Handlebars, and every macro in them is live

ST registers a global `helperMissing` that pipes any unknown expression through
`substituteParams`, so naming a macro in help-text prose *resolves* it — writing the recall
macro in a paragraph expanded it to the entire active summary, in the middle of a settings
panel, twice. Braces in these templates are written as `&#123;` and `&#125;`. Handlebars does
not respect HTML comments either, so a malformed example inside one is a compile error that
takes the whole template with it. `test/templates.mjs` guards both.

### The macro is registered twice

The registry is invisible to the legacy substitution path, which builds replacements from
`MacrosParser.populateEnv`. `experimental_macro_engine` defaults to true in 1.18.0, but it is
a user-facing toggle, and with it off a registry-only macro resolves empty with no error at
all. So `{{recall}}` goes into both.

### Hiding goes one message at a time

`hideChatMessageRange` sets `is_system` across a whole span, which would flip genuine system
messages and break the rule that Recall only ever unhides what it hid. Recall flips indices
individually and saves once.

### The nudge reads itemizedPrompts itself

`findItemizedPromptSet` returns an *index*, not an entry, and it mutates the module-level
state behind ST's own prompt-itemization viewer while logging several lines per call. Calling
it on every received message would corrupt that viewer's target, so Recall does its own
side-effect-free lookup.

`entry.finalPrompt` is only populated for non-OAI APIs. Chat Completion sources carry a
pre-summed `oaiTotalTokens` instead, so a nudge reading `finalPrompt` would never fire on
exactly the configuration it is for. Recall branches on the entry's own stored `main_api`.

Only `MESSAGE_RECEIVED` fires the nudge. `MESSAGE_SENT` would always find no itemized entry,
since nothing has been generated against the new message yet.

### MESSAGE_RECEIVED is awaited, and fires before the message renders

On the non-streaming path `saveReply` emits it and then calls `addOneMessage`, so anything an
extension awaits in that listener sits between the reply arriving and the reply appearing.
Recall's nudge once awaited a tokenizer call on the whole final prompt — a server round-trip
with the entire prompt as its body, and a cache miss every turn. The listener is now sync and
lets the promise settle on its own. **Nothing in a `MESSAGE_RECEIVED` handler should be
awaited unless the message genuinely must not render until it finishes.**

### Branching copies everything, including the wrong pointer

`saveChat` spreads `chat_metadata` into the new chat file, so a branch inherits the archive,
the active pointer and the hide records with no code. The pointer is the problem: it arrives
naming a summary that covers messages the branch does not have, and the macro resolves it
anyway. `realign.js` moves it on chat load (§7).

### Streaming is Chat Completion only

`TextCompletionService.processRequest` strips trailing whitespace, removes partial
`stopping_strings` matches from the tail, and truncates at the instruct preset's stop, input
and output sequences — all behind `if (!requestData.stream)`. `ChatCompletionService` does
none of it. So streaming a Chat Completion profile is byte-identical to waiting for it, while
streaming a text completion profile would save a summary still wearing its instruct
scaffolding, permanently, in the one artefact that stays in context.

### Streamed chunks are cumulative, not deltas

Each yield carries the whole response so far — `text` and `state.reasoning` both. Appending
them, as a stream reader normally would, yields a response containing every prefix of itself,
which looks exactly like a model stuck in a loop. The generator is also returned as a
*factory*: `sendRequest` hands back `async function* streamData()` itself, so it has to be
called before it can be iterated.

### A streamed request's error is thrown away

On failure the streaming path calls `tryParseStreamingError`, which throws
`new Error(data)` — an `Error("[object Object]")` — into a bare `catch {}`, leaving the caller
`Got response status 400` and nothing else. Recall retries without streaming when nothing
had arrived yet, partly because the ordinary path reports what the provider actually said.

### readSecret answers an unknown key id with an empty string

A profile names its API key by id, and rotating or re-entering that key leaves the profile
pointing at an id that no longer exists. The request then goes out with no credentials and
comes back 401 — while the same profile keeps working in the chat, because the ordinary path
passes no id and falls through to whichever key is active. Recall checks the id against
`secret_state` before spending a call.

### Request parameters arrive from places the user is not looking

A profile sent with no preset gets no sampler parameters at all — not ST's defaults, none, so
the provider's apply. And `stop` is filled from the global `power_user.custom_stopping_strings`
whichever profile is in play. Anything read from `oai_settings` or `power_user` at request
time is worth checking against "would the user expect this to govern a summary?"

### Regeneration must not derive its material from the coverage range

Coverage is a range; what a summary read was "whatever was visible", which is that range
minus every hole an earlier summary or the user had hidden. Deriving one from the other fed a
redo every message an earlier summary had hidden: the third summary of a chat was regenerated
against 151 messages when it had read 56. Summaries record their read set; older ones without
it prompt the user rather than guessing. For the same reason each summary records what it
was built on, rather than having it guessed from creation times (§10).

---

## Worth re-checking after an ST update

- `{{recall}}` and `/recall` are still unclaimed — the macro registry spans several files now.
- `itemizedPrompts` entries still carry `main_api`, `oaiTotalTokens` and `finalPrompt`.
- Streamed chunks are still cumulative, and `TextCompletionService` still skips its cleanup on
  streamed responses.
- `/api/tokenizers/openai/count` still takes a raw model name and maps it server-side.
- NanoGPT still tolerates `reasoning_effort: 'auto'` from a preset. ST passes it through
  unmapped for that source, where it is not a standard value.
