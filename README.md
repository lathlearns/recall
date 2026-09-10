# Recall

A memory and summary extension for **SillyTavern 1.18.0**.

Recall keeps one recursive, whole-chat summary in permanent context, resolved through a
`{{recall}}` macro. It replaces the built-in Summarize: the summary prompt becomes a set
of individually toggleable blocks, past summaries become a browsable and editable
archive, automatic triggering is replaced by a manual workflow with a nudge, and the UI
moves out of the Extensions panel into a responsive manager.

Three things are worth knowing before anything else, because everything below follows
from them:

**Recall summarises everything currently visible in the chat, and nothing else.**
Visibility is the only control surface. You hide messages when you want them out of
future summaries; Recall never computes a range on your behalf, and there is no
"summarise messages 51 to 100."

**Recall injects nothing into the prompt.** Your preset already contains a block that
calls a macro. Recall's only job on the prompt side is to make that macro resolve.

**Nothing happens to your chat that you did not press a button for.** Summaries do not
generate themselves, the archive never edits the chat, and a mismatch between the two is
reported rather than repaired.

---

## Install

Extensions → Install extension → paste this repository's URL. Or clone into
`data/<user>/extensions/third-party/recall`.

### What it needs

**SillyTavern 1.18.0 or newer.** The manifest declares that as its
`minimum_client_version`, and ST enforces it.

**Nothing else.** Recall has no runtime dependencies: no bundled libraries, no npm
packages, nothing fetched at load time. It imports SillyTavern's own modules and uses the
jQuery and toastr that ST already loads. The Extras API is not used — the empty `requires`
and `optional` arrays in the manifest are Extras module declarations, and Recall needs
none of them.

**Connection Manager**, ST's own built-in extension, only if you want to summarise through
a profile other than your chat's connection. Disabled or absent, the profile picker greys
out and Recall uses the main API.

**A Chat Completion API.** Text completion backends are not supported: they are not tested,
and two things are known not to work properly there. The preset's context length arrives as
`truncation_length` and can silently truncate the buffer regardless of what you set as the
profile's context size, and reference material read from the chat's preset needs a prompt
manager, which text completion does not have. It may well work anyway. It is not something
to report as broken.

The `devDependencies` in `package.json` — handlebars and playwright — are for running the
tests. They are not needed to use the extension and are not loaded by SillyTavern, which
reads `manifest.json` and nothing else.

### Required setup

**1. Disable the built-in Summarize extension.** It registers `{{summary}}` and calls
`setExtensionPrompt` unconditionally on chat load. Left enabled, you risk a duplicated
summary in context and a macro collision whose winner depends on load order. Recall warns
you once on startup if it is still enabled.

Recall never writes to `chat[i].extra.memory`, so an accidentally-enabled Summarize stays
inert — but only while it is paused. If it is generating on its own interval it will
populate that field itself. If you must leave it enabled, tick its **Pause** box.

**2. Change your preset's summary block** from `[Summary: {{summary}}]` to
`[Summary: {{recall}}]`. One-time edit. The wrapper text does not change, only the macro
inside it.

**3. Old chats carry over automatically.** On a chat the built-in already summarised,
`{{recall}}` resolves to that old summary until you generate your first Recall one, and
that old summary seeds the first generation — so Recall *revises* it rather than writing a
new one from scratch. This is read-only and does not need the built-in enabled; the text
lives in the chat file, not the extension.

It also removes what the design document called the first-run footgun. Without it, an old
chat with messages already hidden would hand Recall an empty `[Summary: ]`, firing the
prompt's "read the entire chat" branch while showing it only the visible tail — a
confident summary of recent messages presented as covering the whole story. With the seed,
the revise branch fires and the old summary supplies the history instead. If you turn the
fallback off, unhide everything before your first summary.

---

## The loop

**Summarize now** (drawer, manager, or `/recall`) summarises every currently visible
message, revising the active summary in place. Afterwards, if auto-hide is on, the covered
messages are hidden — except message 0, which is never hidden, and the pinned tail, which
defaults to the newest 5.

**The nudge** replaces automatic summarization. Recall reads the size of the last prompt
actually sent against your context limit and, once past your threshold, fires a single
toast — not one per message. It stays quiet until a summary brings usage back down.
Narrative structure decides *when* to summarise; the nudge only tells you it is time to
start looking for a stopping point.

**Regenerate** redoes an existing summary over the same material and produces a *sibling*,
never a replacement. Both persist so you can compare and pick; neither becomes active on
its own. It rebuilds the buffer from the exact list of messages the original read, whether
or not they are currently hidden — a summary hides its own material immediately after
generating, so ignoring hidden state is what makes a redo possible at all.

That list is *not* the coverage range. Coverage is a range; the buffer was "whatever was
visible", which is a range minus arbitrary holes wherever an earlier summary or you had
already hidden something. The two coincide only for the first summary in a chat. Deriving
the material from the range instead — which Recall did until this was caught — feeds a
redo every message an earlier summary hid: on a chat with three summaries, the third was
regenerated against 151 messages when it had read 56.

Summaries record their read set at generation time. Older ones have no such record, so
regenerating them opens a prompt showing what the range would actually send and letting
you narrow it; what you enter is kept, so the next redo of that summary is exact. The
detail pane's **Read** row says which state a summary is in.

**Making a summary active** changes what `{{recall}}` resolves to and nothing else. It
never moves a message. You can browse and diff the whole archive without touching the
chat. When chat visibility and the active summary's coverage disagree, the manager says so
and offers a one-click **Sync chat to this summary** — never automatically, because a
mismatch is usually intentional.

---

## What actually gets sent

A summarization request is two messages, and which half a piece of text lands in is the
thing most worth checking.

**The system message** is the summary prompt: your enabled prompt blocks, joined.
Instruction, and nothing else.

**The user message** is the buffer, in this order:

1. Reference material, fenced — the character card and persona blocks you enabled, then
   your chat preset's own prompt blocks if you enabled any.
2. The previous summary, inside your framing prefix and suffix.
3. Every message being summarised.
4. Your steering note for this pass, if you typed one, fenced and marked as applying to
   this pass only.

**Preview request** in the manager assembles exactly what *Summarize now* would send and
shows it without sending it: both messages, token counts for each, and how much room is
left. It builds through the same code path as the real request rather than describing it,
so it cannot drift from what is sent and reassure you about the wrong text.

### Steering one pass

The field at the top of the manager is one-off guidance — *"track all four, don't let
Maddie drop out"*. It applies to whichever action you press next, **Summarize now** or
**Regenerate**, and clears itself when that runs. `/recall keep all four present` does the
same from the chat bar.

It is deliberately **not** remembered. An emphasis that silently persisted would make later
summaries drift for a reason invisible at the moment you press the button, and a
regenerated sibling carrying the original's note would be indistinguishable from one
without it — which defeats the point of keeping both. If you want it again, type it again.

It *is* recorded on the resulting summary and shown in the detail pane as its own
full-width block, so you can see which note produced which result. That record is
bookkeeping only; nothing replays it.

The note goes last, after the chat. Recency is the point: it is a correction to emphasis
competing with a long instruction and a longer history. It is not appended to the system
prompt, because the Quality Check block deliberately ends the instruction by telling the
model to verify and submit, and nothing useful goes after that.

### Token counts

Shown in three places, all in the tokenizer your current API uses:

- **Each summary**, in the archive list and its detail pane. A summary sits in permanent
  context, so this is the standing cost of keeping it.
- **Each reference-material block**, counting the section as it would appear in the buffer
  — heading included — so the number is the marginal cost of ticking that box. The
  preamble and fences are shared overhead, paid once whichever blocks are on.
- **Each prompt block**, plus a total for the enabled ones joined exactly as generation
  joins them, which is the system prompt's real cost rather than the sum of its parts.

Counting is asynchronous and some tokenizers are a server round-trip, so counts are painted
in after render. ST caches results internally by tokenizer and model, and Recall keeps a
small local cache besides, so a known value appears in the same frame and only a genuinely
new string ever shows a placeholder. Each element is stamped with the string it is
displaying; a count that resolves after a re-render is discarded rather than written into
an element that now describes something else.

---

## Reference material

The chat alone is ambiguous to a summariser: names without roles, relationships without
history, a setting it has to infer. Everything here is optional, off by default, and comes
out of the same token budget the chat history competes for — each one enabled means less
history fits in a single pass. The settings panel shows what each would contribute for the
current character and preset, so a block that is empty is visibly empty rather than
silently doing nothing.

### From the character card

- Character description
- Character personality
- Scenario
- User persona
- Example dialogue

Group chats use ST's own combined group cards, falling back to walking the members and
labelling each contribution by name.

### From your chat's preset

Your main prompt, post-history instructions, auxiliary prompt and any custom prompts you
wrote, read from the Chat Completion preset your **chat** is running on — not from the
profile Recall summarises through. The other blocks all describe the roleplay; so do these.
The list is whatever the preset defines, so it changes when you switch preset, and markers
(chat history, world info, the character description) are excluded — they carry no text of
their own, and the three that resolve to something are already offered above, read from the
card directly.

What they add is the thing nothing else here supplies: the register the chat is written in,
and what it is allowed to be explicit about. A summariser that has never seen them will
sanitise what the chat was blunt about and adopt a voice the roleplay never used.

They are sent **quoted, not passed through**. Every other block is description; these are
commands — a main prompt tells a model how to write, a post-history block tells it what it
may not refuse — and a model handed them mid-buffer has no way to know they were addressed
to someone else. Left unmarked, the likeliest failure is not a poor summary but no summary
at all: the model writes the chat's next reply, because the text it just read told it to.
So they go under `### Chat instruction:` headings, after a note naming whose instructions
they are and telling the summariser it is not their audience.

Chat Completion only. The prompt manager is a Chat Completion feature; a text completion
chat has a system prompt and an instruct template instead, which are a different shape and
are not read. The panel says so rather than showing an empty list.

### How it is fenced

Reference material is prepended to the buffer inside explicit
`--- BEGIN/END REFERENCE MATERIAL ---` fences, with a line marking it as background rather
than events, so the model does not fold the character card into the summary as though it
happened. The fences are named rather than bare rules because a lone `---` is ambiguous
here: the summary format uses `---` between its own sections and character cards are often
markdown with rules of their own, so an unlabelled one is just another horizontal line
among several.

---

## Where summarization runs

By default Recall uses the main API — the same connection as your chat. Picking a
Connection Manager profile sends **only Recall's requests** through it, via
`ConnectionManagerRequestService`; your selected profile is never changed. Summarising is a
different job from roleplaying and often wants a different model: cheaper, longer-context,
less florid.

**The profile's generation preset comes with it.** Temperature, top P and the rest of its
samplers are what the summary is generated under; edit that preset in ST to change them. On
the main API nothing is substituted — the request goes out the way your chat's would.

This was a checkbox until 1.1.0, off by default, and the off state was not neutral. With no
preset, ST sends no sampler parameters at all: temperature and the rest are undefined and
stripped from the payload, so the request ran on whatever the provider defaults to — a
third sampler set nobody chose and nobody could see. A profile picked for summarising comes
with a preset picked for summarising, and that one is editable.

Recall's own payload is applied over the preset's, so the output budget and any model
override still win. (On a text completion profile the preset's context length also arrives
as `truncation_length`, which Recall does not override — one of the reasons those backends
are unsupported.)

**The model field is free text, and that is not laziness.** A connection profile stores a
single `model` string, captured from whatever was selected when the profile was made. ST's
model dropdowns are populated only for the source you are *currently connected to* — there
is no per-profile enumeration to read, so a real dropdown cannot be built for a profile you
are not connected to. Leave the field blank to use the profile's own model, or type an id
to override it. A typo surfaces as the provider's error, reported verbatim.

**Set the context size when you pick a profile.** `getMaxPromptTokens()` describes the
*active* connection. Summarising through a 200k profile while roleplaying on 32k would
refuse work that fits; the reverse would build a buffer the API rejects. Neither failure
looks like it is about the profile when you hit it.

---

## The summary prompt

Assembled from named, individually toggleable, reorderable blocks. The shipped `Standard`
set has two:

1. **Summary Prompt** — the instruction body: the empty/non-empty branch, the hierarchy of
   what must stay, the editing loop, the required structure, the behavioural rules.
2. **Quality Check** — the closing self-verification checklist.

The split is deliberate and minimal. The prompt is order-dependent enough that finer
splitting would create ways to break it; the seam that matters is being able to insert a
**new** section above the quality check, so additions land inside the instruction body
rather than after the model has been told to verify and submit. Blocks are an extension
point first and a toggle second.

Prompt configuration is **global by default** — the prompt describes how to summarise a
roleplay, which is universal in practice. A character can override it, taking an owned copy
that stops tracking the global set; if the global set is later edited, the manager shows a
quiet out-of-sync marker. Group chats have no avatar key and always use the global set —
that is the answer, not a fallback.

Editing a set puts it in a modified state in a working copy; the saved set is untouched
until you press Save.

---

## Settings

| Setting | What it does |
| --- | --- |
| Hide covered messages | Hide the covered range after a successful summary. |
| Keep newest N visible | Auto-hide skips this many recent messages. Message 0 is always skipped regardless. |
| Block sending | Deactivate send buttons while a summary generates. |
| Nudge threshold | In tokens, against the last prompt sent. 0 tracks 80% of the context limit. |
| **Response reserve** | Context room held back when budgeting the buffer. |
| **Output budget** | The generation limit sent to the API. |
| Framing prefix/suffix | Wraps the previous summary in the buffer. Match your preset. |
| Minimum summary length | Shorter responses are treated as generation failures, not saved as stubs. |
| Connection profile | Summarise through a different profile than the chat uses. Blank = main API. |
| Model | Overrides the profile's stored model. Free text — see above. |
| Its context size | The profile's context window, so the buffer is budgeted against the right number. |
| Reference material | Which parts of the character card and persona to send alongside the chat. |
| From your chat's preset | Which of the active preset's own prompt blocks to send, quoted, as reference material. |
| Use the built-in's old summary | Stand in `extra.memory` until Recall has a summary of its own, and seed the first generation with it. |
| Also answer to `{{summary}}` | Register `{{summary}}` as a second name for the Recall summary — only while the built-in Summarize is disabled. |
| Deep integrity check | Also hash the whole covered range, catching edits below a summary's anchor. Off by default — it flags on any edit anywhere in history. |

### The two limits

Response reserve and output budget are separate settings because one number cannot do both
jobs — the built-in uses one value for both, and it flows two ways at once.

`getMaxPromptTokens(reserve)` returns `getMaxContextTokens() - reserve`, so a high value
**starves the buffer**. Meanwhile `responseLength` becomes the request's `max_tokens`. A
single 15,000 setting would subtract 15,000 tokens of room from every buffer and cause
constant overflow refusals on chats that would summarise fine.

How the output budget interacts with thinking differs by source, enough to change the right
value:

- **OpenAI-compatible** (OpenRouter, NanoGPT, most others): `max_tokens` is a single total
  covering reasoning *and* visible output, and nothing reserves room for the response. The
  budget is a genuine killswitch for a model that thinks without end — and nothing
  guarantees a summary gets written, which is why an empty response is reported as a
  failure rather than saved. ~15,000 suits a ~1,400-token target with verbose reasoners; if
  empty responses appear, raise it before changing anything else.
- **Claude**: the budget is *split*. Thinking takes a fraction of `max_tokens` — `low` 10%,
  `medium` 25%, `high` 50%, `max` 95% — so at `max` a 15,000 budget leaves 750 tokens for
  the summary and every generation truncates. The opposite trap.
- **Google**: `auto` means dynamic thinking, with the same no-reserved-share problem as the
  OpenAI-compatible case.

Recall does not read or change Reasoning Effort. That is a global chat setting and belongs
to you.

### The `{{summary}}` alias

Recall can also answer to `{{summary}}`, so a preset that was never updated keeps working.
It is registered **only while the built-in Summarize is disabled**, and that condition is
not a formality: the macro registry overwrites on a name collision with nothing but a
console warning, and Recall's `loading_order` of 10 puts it after Summarize's 9. With both
enabled, Recall would silently win the name and which summary reached your prompt would be
a function of load order. The condition is re-evaluated every page load, so re-enabling
Summarize hands the name straight back.

`{{recall}}` always works regardless, and remains the name worth putting in a preset.

---

## Not in scope

Vectorization / embeddings / RAG. Lorebook or World Info integration. Prompt injection —
Recall never calls `setExtensionPrompt`. Extras API and WebLLM sources. The Classic prompt
builder. Per-message summaries. Range selection. Importing from the built-in Summarize —
except reading its stored summary once, to carry an old chat over (see setup step 3).
Recall never *writes* to `extra.memory`.

---

## Versions

Recall follows semantic versioning: the patch digit is a fix, the minor digit adds or
changes a setting, and the major digit would break a chat's stored data or your preset.
`manifest.json` carries the version ST reads, `package.json` matches it, releases are
tagged `vX.Y.Z`, and [CHANGELOG.md](CHANGELOG.md) says what changed and why.

`auto_update` is on, so ST pulls updates on its own. Settings that disappear are removed
from your saved settings on the next load rather than left behind as a stored answer to a
question nothing asks any more.

---

## Notes for the next reader

The [design document](docs/recall-design.md) is the specification. Several things in it
turned out not to match SillyTavern 1.18.0 (commit `51ad27f`) and the code deviates
deliberately:

1. **§9 — `findItemizedPromptSet` is not used.** It returns an *index*, not an entry, and
   it mutates the module-level state behind ST's own prompt-itemization viewer while
   logging several lines per call. Calling it on every received message would corrupt that
   viewer's target. Recall does its own side-effect-free lookup.

2. **§9 — `entry.finalPrompt` is only populated for non-OAI APIs.** Chat Completion sources
   (OpenRouter, NanoGPT, Claude, Google) instead carry a pre-summed `oaiTotalTokens`. As
   specified, the nudge would silently never fire on exactly the target configuration.
   Recall branches on the entry's own stored `main_api`.

3. **§4 — the macro is registered twice when the macro engine is off.** The registry is
   invisible to the legacy substitution path, which builds replacements from
   `MacrosParser.populateEnv`. `experimental_macro_engine` defaults to true in 1.18.0, but
   it is a user-facing toggle, and with it off a registry-only macro resolves empty with no
   error at all.

4. **§7 — `hideChatMessageRange` is not used.** It sets `is_system` across a whole span,
   which would flip genuine system messages and defeat §8.1's rule that Recall only ever
   unhides what it actually hid. Recall flips indices individually and saves once.

5. **§12 — branching needs no code.** `saveChat` already spreads `chat_metadata` into the
   new chat file, so a branch inherits the archive, the active pointer and the hide records
   for free. A branch cut below a summary's anchor shows up as a stale badge on the next
   chat load, which is the correct outcome.

6. **Templates are Handlebars, and every macro in them is live.** ST registers a global
   `helperMissing` that pipes any unknown expression through `substituteParams`, so naming
   a macro in help-text prose *resolves* it — writing the recall macro in a paragraph
   expanded it to the entire active summary, in the middle of a settings panel, twice.
   Braces in these templates are written as `&#123;` and `&#125;`. Handlebars does not
   respect HTML comments either, so a malformed example inside one is a compile error that
   takes the whole template with it. `test/templates.mjs` guards both.

One deviation is a judgement call rather than a correction: §12 lists `MESSAGE_SENT` as a
nudge trigger, but no itemized entry exists for a message that has not been generated
against yet, so the check would always skip. Only `MESSAGE_RECEIVED` is wired.

Tests live in `test/` and run with `npm test` (needs `npm install` first, plus
`npx playwright install chromium` once). They cover the three classes of bug that static
checking cannot see: CSS that defeats the `hidden` attribute, templates that expand macros
written as prose, and a reference-material buffer that assembles into the wrong order or
loses the fencing around the chat's own prompt blocks. The last runs `src/` against stubbed
SillyTavern modules in a throwaway tree, so it needs no install to test against.

Deferred, per §14: the persistent nudge indicator (the toast and threshold tracking do
ship), multiple named block sets beyond the global-plus-override model, and the desktop
draggable popout.
