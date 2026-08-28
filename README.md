# Recall

A memory/summary extension for **SillyTavern 1.18.0**.

Recall keeps one recursive, whole-chat summary in permanent context, resolved through
a `{{recall}}` macro. It replaces the built-in Summarize extension: the summary prompt
becomes a set of individually toggleable blocks, past summaries become a browsable and
editable archive, automatic triggering is replaced by a manual workflow with a nudge,
and the UI moves out of the Extensions panel into a responsive manager.

**Recall summarises everything currently visible in the chat, and nothing else.**
Visibility is the only control surface. You hide messages when you want them out of
future summaries; Recall never computes a range on your behalf, and there is no
"summarise messages 51 to 100."

Recall injects nothing into the prompt. Your preset already contains a block that calls
a macro; Recall's only job on the prompt side is to make that macro resolve.

---

## Install

Extensions → Install extension → paste this repository's URL. Or clone into
`data/<user>/extensions/third-party/recall`.

### Required setup

**1. Disable the built-in Summarize extension.** It registers `{{summary}}` and calls
`setExtensionPrompt` unconditionally on chat load. Left enabled, you risk a duplicated
summary in context and a macro collision whose winner depends on load order. Recall
warns you once on startup if it is still enabled.

Recall never writes to `chat[i].extra.memory`, so an accidentally-enabled Summarize
stays inert — but only while it is paused. If it is generating on its own interval it
will populate that field itself. If you must leave it enabled, tick its **Pause** box.

**2. Change your preset's summary block** from `[Summary: {{summary}}]` to
`[Summary: {{recall}}]`. One-time edit. The wrapper text does not change, only the
macro inside it.

**3. If this chat already has hidden messages, unhide everything before the first
summary.** The default prompt tells the model to read the entire chat when creating a
summary from scratch. On an old chat previously managed with the built-in, that
instruction is given while only the visible tail is shown — producing a confident
summary of recent messages presented as covering the whole story.

---

## Using it

**Summarize now** (drawer, manager, or `/recall`) summarises every currently visible
message, revising the active summary in place. Afterwards, if auto-hide is on, the
covered messages are hidden — except message 0, which is never hidden, and the pinned
tail, which defaults to the newest 5.

**Regenerate** redoes an existing summary over the same material and produces a
*sibling*, never a replacement. Both persist so you can compare and pick; neither
becomes active on its own. Regeneration touches no state at all — it rebuilds the
buffer from the original's recorded indices whether or not those messages are
currently hidden.

**Making a summary active** changes what `{{recall}}` resolves to and nothing else. It
never moves a message. You can browse and diff the whole archive without touching the
chat. When chat visibility and the active summary's coverage disagree, the manager says
so and offers a one-click **Sync chat to this summary** — never automatically, because
a mismatch is usually intentional.

**The nudge** replaces automatic summarization. Recall reads the size of the last prompt
actually sent against your context limit and, once past your threshold, fires a single
toast — not one per message. It stays quiet until a summary brings usage back down.
Narrative structure decides *when* to summarise; the nudge only tells you it's time to
start looking for a stopping point.

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
| Deep integrity check | Also hash the whole covered range, catching edits below a summary's anchor. Off by default — it flags on any edit anywhere in history. |

### The two limits

These are separate settings because one number cannot do both jobs — the built-in uses
one value for both, and it flows two ways at once.

`getMaxPromptTokens(reserve)` returns `getMaxContextTokens() - reserve`, so a high
value **starves the buffer**. Meanwhile `responseLength` becomes the request's
`max_tokens`. A single 15,000 setting would subtract 15,000 tokens of room from every
buffer and cause constant overflow refusals on chats that would summarise fine.

How the output budget interacts with thinking differs by source, enough to change the
right value:

- **OpenAI-compatible** (OpenRouter, NanoGPT, most others): `max_tokens` is a single
  total covering reasoning *and* visible output, and nothing reserves room for the
  response. The budget is a genuine killswitch for a model that thinks without end —
  and nothing guarantees a summary gets written, which is why an empty response is
  reported as a failure rather than saved. ~15,000 suits a ~1,400-token target with
  verbose reasoners; if empty responses appear, raise it before changing anything else.
- **Claude**: the budget is *split*. Thinking takes a fraction of `max_tokens` — `low`
  10%, `medium` 25%, `high` 50%, `max` 95% — so at `max` a 15,000 budget leaves 750
  tokens for the summary and every generation truncates. The opposite trap.
- **Google**: `auto` means dynamic thinking, with the same no-reserved-share problem as
  the OpenAI-compatible case.

Recall does not read or change Reasoning Effort. That is a global chat setting and
belongs to you.

---

## The summary prompt

Assembled from named, individually toggleable, reorderable blocks. The shipped
`Standard` set has two:

1. **Summary Prompt** — the instruction body: the empty/non-empty branch, the hierarchy
   of what must stay, the editing loop, the required structure, the behavioural rules.
2. **Quality Check** — the closing self-verification checklist.

The split is deliberate and minimal. The prompt is order-dependent enough that finer
splitting would create ways to break it; the seam that matters is being able to insert
a **new** section above the quality check, so additions land inside the instruction body
rather than after the model has been told to verify and submit. Blocks are an extension
point first and a toggle second.

Prompt configuration is **global by default** — the prompt describes how to summarise a
roleplay, which is universal in practice. A character can override it, taking an owned
copy that stops tracking the global set; if the global set is later edited, the manager
shows a quiet out-of-sync marker. Group chats have no avatar key and always use the
global set — that is the answer, not a fallback.

Editing a set puts it in a modified state in a working copy; the saved set is untouched
until you press Save.

---

## Not in scope

Vectorization / embeddings / RAG. Lorebook or World Info integration. Prompt injection —
Recall never calls `setExtensionPrompt`. Extras API and WebLLM sources. The Classic
prompt builder. Per-message summaries. Range selection. Importing from the built-in
Summarize.

---

## Notes for the next reader

The [design document](docs/recall-design.md) is the specification. Five things in it
turned out not to match SillyTavern 1.18.0 (commit `51ad27f`) and the code deviates
deliberately:

1. **§9 — `findItemizedPromptSet` is not used.** It returns an *index*, not an entry,
   and it mutates the module-level state behind ST's own prompt-itemization viewer
   while logging several lines per call. Calling it on every received message would
   corrupt that viewer's target. Recall does its own side-effect-free lookup.

2. **§9 — `entry.finalPrompt` is only populated for non-OAI APIs.** Chat Completion
   sources (OpenRouter, NanoGPT, Claude, Google) instead carry a pre-summed
   `oaiTotalTokens`. As specified, the nudge would silently never fire on exactly the
   target configuration. Recall branches on the entry's own stored `main_api`.

3. **§4 — the macro is registered twice when the macro engine is off.** The registry is
   invisible to the legacy substitution path, which builds replacements from
   `MacrosParser.populateEnv`. `experimental_macro_engine` defaults to true in 1.18.0,
   but it is a user-facing toggle, and with it off a registry-only macro resolves empty
   with no error at all.

4. **§7 — `hideChatMessageRange` is not used.** It sets `is_system` across a whole span,
   which would flip genuine system messages and defeat §8.1's rule that Recall only ever
   unhides what it actually hid. Recall flips indices individually and saves once.

5. **§12 — branching needs no code.** `saveChat` already spreads `chat_metadata` into
   the new chat file, so a branch inherits the archive, the active pointer and the hide
   records for free. A branch cut below a summary's anchor shows up as a stale badge on
   the next chat load, which is the correct outcome.

One deviation is a judgement call rather than a correction: §12 lists `MESSAGE_SENT` as
a nudge trigger, but no itemized entry exists for a message that has not been generated
against yet, so the check would always skip. Only `MESSAGE_RECEIVED` is wired.

Deferred, per §14: the persistent nudge indicator (the toast and threshold tracking do
ship), multiple named block sets beyond the global-plus-override model, and the desktop
draggable popout.
