# Recall

A summary extension for **SillyTavern 1.18.0+**, replacing the built-in Summarize. Its twin,
[LumiRecall](https://github.com/lathlearns/LumiRecall), does the same for Lumiverse.

> **Before you install:** Recall was written almost entirely by Claude, Anthropic's AI model,
> for one person's private use. It's shared as-is in case it's useful to someone else, but
> it's built and tested around one setup, so your experience may vary, and support is
> best-effort at most.

Recall keeps one running summary of the whole chat in permanent context, resolved through a
`{{recall}}` macro. The summary prompt is a set of toggleable blocks you can edit, every
summary you generate is kept in a browsable archive, and nothing generates on a timer —
you press a button, and a nudge tells you when it's worth pressing.

Two rules shape the rest of it:

**It summarises everything currently visible, and nothing else.** Visibility is the control
surface. Hide what you want left out. There is no range selection.

**It injects nothing.** Your preset already has a block that calls a macro; Recall's only
job on the prompt side is to make that macro resolve.

---

## Install

Extensions → Install extension → paste this repo's URL. Or clone into
`data/<user>/extensions/third-party/recall`.

**No dependencies.** Nothing bundled, nothing downloaded at runtime — it uses SillyTavern's
own modules. The `devDependencies` in `package.json` are for running the tests. Connection
Manager (an ST built-in) is only needed if you want to summarise through a different
connection than your chat uses.

**Chat Completion only.** Text completion backends are untested and unsupported. Two things
are known not to work: the preset's context length can truncate the buffer behind your
back, and preset reference blocks need a prompt manager that text completion doesn't have.
It may work anyway.

### Setup

**1. Disable the built-in Summarize.** It registers `{{summary}}` and injects on every chat
load, so leaving it on risks a duplicated summary in context and a macro collision decided
by load order. Recall warns you once at startup if it's still enabled. If you must keep it,
tick its **Pause** box — Recall never writes to `extra.memory`, so a paused Summarize stays
inert, but one running on its own interval will fill that field itself.

**2. Point your preset at Recall.** Change `[Summary: {{summary}}]` to
`[Summary: {{recall}}]`. The wrapper stays; only the macro changes. With no summary yet the
block renders as `[Summary: ]`, which is deliberate.

Recall can also answer to `{{summary}}` if you'd rather not edit anything — but only while
the built-in is disabled, because whoever registers the name last wins and that's decided
by load order. `{{recall}}` always works and is the name worth putting in a preset.

**Old chats carry over on their own.** If the built-in already summarised a chat,
`{{recall}}` resolves to that old summary until you make your first, and it seeds that
first generation so Recall *revises* it instead of starting over. Turning this off means
unhiding everything before your first summary — otherwise Recall sees only the visible tail
but is told to summarise the whole chat, and writes a confident summary of the last twenty
messages as though it covered everything.

---

## Using it

**Summarize now** (drawer, manager, or `/recall`) summarises everything visible and revises
the active summary in place. Covered messages are then hidden, except message 0 and the
newest few. It won't start while the chat is still generating a reply.

**The nudge** replaces automatic summarization. When the last prompt sent crosses your
threshold, you get one toast — not one per message — and then silence until a summary
brings usage back down. When to summarise is a narrative decision; the nudge only says it's
time to start looking for a stopping point.

**The steering field** at the top of the manager is one-off guidance — *"track all four,
don't let Maddie drop out"*. It applies to the next Summarize or Regenerate you press and
then clears itself. `/recall keep all four present` does the same from the chat bar. It's
recorded on the summary it produced so you can see which note caused what, but it is never
replayed.

**Preview request** shows exactly what *Summarize now* would send — both messages, token
counts, remaining room — without sending it. It's built through the same code as the real
request, so it can't drift from it.

### While it's running

A summary can take a minute or more, so the button counts up — elapsed, never a progress
bar, because nothing can know how long a pass will take.

On a **Chat Completion connection profile**, you watch the summary being written, and the
model's reasoning above it while it thinks. The reasoning folds itself away to one line
(*Thought for 0:31 · 624 tokens*) once the summary proper starts, and is kept with the
finished summary so you can read it later from the archive. It's never sent to the model —
the macro resolves the summary text and nothing else — so it costs space in your chat file
and nothing in context.

When the run ends the pane stays, headed *finished*, *stopped* or *did not finish*, until
the next run, until you hide it, or until you change chat.

Live output needs Chat Completion specifically, and that's deliberate rather than a gap:
SillyTavern strips instruct scaffolding from a text completion response *only* when it
didn't stream it, so streaming one would save a summary still wearing its stop sequences.
Text completion profiles and the main API get the spinner and the clock. The settings panel
says which you're on. If a connection turns out to refuse streaming altogether, Recall
reissues the request without it and you still get your summary.

**Stop** cancels a summary running through a connection profile. Nothing is saved — a
half-written summary isn't a summary.

**Titles.** Recall asks the model to name each summary and puts that name in front of the
timestamp: *The Long Road North — 2026-09-12 14:31*. The title line is removed before the
summary is stored, so it never reaches the model and never accumulates. If the model leaves
it out, Recall takes the title it settled on while thinking, and failing that asks for one
in a small request of its own. Every name stays editable by hand.

---

## The archive

Every summary is kept. One is **active** — the one `{{recall}}` resolves to. Making another
active changes what the macro resolves to and nothing else; it never moves a message. If
chat visibility and the active summary disagree, the manager says so and offers a one-click
sync. It won't do it on its own; a mismatch is usually deliberate.

**Regenerate** produces a *sibling*, never a replacement. Both are kept, neither becomes
active on its own, so you can compare and pick. It re-reads the exact messages the original
read, hidden or not, and rebuilds on the summary the original was built on.

**Deleting** a summary offers to unhide the messages it hid. Recall only ever unhides what it
hid itself.

**Edits and deletions in the chat** are tracked. A summary whose last message moved is
corrected silently; one whose last message was edited or deleted is marked **stale**, with
the choice to re-anchor it to another message or delete it.

**Branching** keeps the archive. If the active summary covers messages the branch doesn't
have, Recall switches to the newest summary that fits and tells you which.

---

## The summary prompt

The prompt is an ordered list of named blocks — *Summary Prompt* and *Quality Check* by
default. Each can be switched off, edited, reordered or deleted, and you can add your own.
New instructions belong above the quality check, so they land inside the instruction rather
than after the model has been told to check its work and submit.

Edits are a working copy: nothing is saved until you press **Save**, and **Discard** throws
them away. Each block shows its size in tokens, and the total for the enabled ones is what
the system prompt actually costs.

The prompt is **global** — the same one serves every character. A character can take its
own copy with **Override for this character**. If you edit the global prompt afterwards, the copy is marked out
of sync, with a button to take the global copy again. Group chats always use the global
prompt.

**Restore defaults** puts the shipped blocks back.

---

## Settings

| Setting | What it does |
| --- | --- |
| Hide covered messages after summarizing | Hide the covered range after a successful summary. |
| Keep the newest N messages visible | Auto-hide skips this many recent messages. Message 0 is always skipped. |
| Block sending while a summary generates | Deactivate send buttons while a summary generates. |
| Have the model name each summary | Ask for a title and use it in the archive name. Removed from the summary before it's stored; never sent to the model. |
| Keep the model's reasoning | Show reasoning while it writes, on a connection that streams, and store it with the summary. Never sent to the model. |
| Connection profile | Summarise through a different connection. Blank = your chat's. |
| Model / Its context size | Override the profile's model; tell Recall that profile's context window. |
| Reference material | What to send alongside the chat — see below. |
| Use its old summary until Recall has one | Stand in the built-in's `extra.memory` until Recall has a summary of its own. |
| Also answer to `{{summary}}` | Only registers while the built-in Summarize is disabled. |
| Warn me when context is filling up / Threshold | The nudge. In tokens, against the last prompt sent. 0 tracks 80% of the context limit. |
| **Kept free for the reply** | Context held back so the answer has room. Keep it at least as large as the next row. |
| **Most the model may write** | The generation limit sent to the API — thinking included, on most sources. |
| Framing prefix/suffix | Wraps the previous summary in the buffer. Match your preset. |
| Minimum summary length | In characters. Shorter responses are treated as failures, not saved as stubs. |
| Deep integrity check | Also hash the covered range, catching edits below a summary's anchor. Off by default — it flags on any edit anywhere. |

### The two limits

The defaults are fine. This section is for when they aren't.

**Kept free for the reply** (the *response reserve*) is what Recall expects a summary to
need, held out of the context window; the chat history gets everything else. Set it high and
Recall starts refusing chats it could have handled.

**Most the model may write** (the *output budget*) is the request's `max_tokens` — a ceiling,
not an expectation. Its job is stopping a model that reasons without end.

The two differ on purpose: a summary runs about 1,400 tokens, so reserving room for a 15,000
ceiling that will almost never be reached would waste buffer on every pass. The gap only
bites when a near-full buffer meets a reply allowed to exceed what was held for it — Claude
and some others reject that combination up front instead of truncating. The panel warns when
you're set that way; if summaries fail on long chats, that's the first thing to raise.

How the ceiling interacts with thinking models decides the right value, and the two failure
modes are opposites:

- **OpenAI-compatible** (OpenRouter, NanoGPT, most others): one budget covers reasoning
  *and* output, with nothing reserved for the response — so a model that thinks without end
  can spend all of it and write nothing. ~15,000 suits a ~1,400-token summary. If you get
  empty responses, raise this first.
- **Claude**: the budget is *split* — thinking takes 10% at `low` up to 95% at `max`. At
  `max`, a 15,000 budget leaves 750 tokens for the summary and everything truncates.
- **Google**: `auto` thinking behaves like the OpenAI-compatible case.

Recall doesn't touch Reasoning Effort. That's yours, set on the connection.

Over budget is a refusal, not a silent trim: Recall tells you how many of the oldest visible
messages to hide to make it fit.

---

## Reference material

Optional context sent alongside the chat, so the summariser isn't guessing who these people
are. Everything here is off by default and competes for the same tokens as the chat history
— each one enabled means less history per pass. The panel shows what each costs.

**From the character card:** description, personality, scenario, user persona, example
dialogue. Group chats use ST's combined cards.

**From your chat's preset:** your main prompt, post-history instructions and any custom
prompts, read from the preset your *chat* is on, in the order your prompt manager shows
them — markers omitted, so it's that list with the gaps closed up. They tell the summariser
the register the chat is written in and what it's allowed to be explicit about, which
nothing else here does.

Your summary block is safe to tick. Recall's macros are stripped from a preset block before
anything is substituted, so `[Summary: {{summary}}]` contributes its wrapper and not a
second copy of the summary the request is already carrying for revision.

These toggles are the only thing that decides what's sent. Whether a prompt is currently
switched on in your prompt manager doesn't come into it: one you've switched off there still
goes if it's ticked here, and one that's on there stays out if it isn't. Otherwise the
setting would change meaning behind your back every time you tweaked the preset.

Preset blocks are sent quoted, under `### Chat instruction:` headings and behind a note
saying they're addressed to someone else. They're commands, and a model handed them
unmarked will follow them — the failure isn't a mediocre summary, it's the model writing
the chat's next reply instead.

All of it goes in the user message inside `--- BEGIN/END REFERENCE MATERIAL ---` fences,
marked as background rather than events, so the card doesn't get summarised as though it
happened.

---

## Where summarization runs

By default, your chat's connection. Pick a Connection Manager profile and **only Recall's
requests** go through it — your selected profile is never changed. Summarising is a
different job from roleplaying and often wants a cheaper, longer-context, less florid
model.

**The profile's preset comes with it.** Its samplers are what the summary is generated
under; edit that preset in ST to change them.

**Set the profile's context size.** Recall budgets the buffer against your *chat's* context
otherwise, which is the wrong number in both directions — refusing work that fits, or
building a buffer the API rejects.

**The model field is free text.** A profile stores one model string, and ST only lists
models for the source you're currently connected to, so there's no dropdown to build. Blank
uses the profile's own. A typo comes back as the provider's error.

**Sizes are counted for the model that writes the summary.** On a Chat Completion profile
running a different model from your chat, token counts use that model's tokenizer. A text
completion profile counts with your chat's tokenizer, which can be off by 10–20% if the
models differ.

**Your custom stopping strings are stripped from Recall's requests, and only Recall's.**
They're a global Advanced Formatting setting, so they'd otherwise apply to summaries too —
and `###` and `---` are exactly what the summary structure is built from. The provider
stops at the first match and reports a normal finish, so a summary cut off after its first
section saves like a complete one, and the next pass revises *that*.

---

## Not in scope

Vectorization, RAG, World Info integration, prompt injection, Extras, per-message
summaries, range selection. Importing from the built-in Summarize, beyond reading its
stored summary once to carry an old chat over.

---

## Development

`npm install`, then `npx playwright install chromium` once, then `npm test`. The tests cover
what static checking can't see: CSS that defeats the `hidden` attribute, Handlebars
templates that expand macros written as prose, the assembled reference-material buffer, and
the pure logic — title parsing, stream handling, branch realignment, redo lineage.

- [docs/feature-reference.md](docs/feature-reference.md) — what Recall does, in full. Shared
  with LumiRecall and kept identical in both repos; a behaviour change updates both.
- [docs/host-notes.md](docs/host-notes.md) — where Recall departs from the reference because
  of SillyTavern, and the SillyTavern behaviour that has bitten it.
- [CHANGELOG.md](CHANGELOG.md) — releases. Semver, tagged `vX.Y.Z`.

MIT licensed. Use it, fork it, change it.
