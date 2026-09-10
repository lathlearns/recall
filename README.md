# Recall

A summary extension for **SillyTavern 1.18.0+**, replacing the built-in Summarize.

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
own modules. The `devDependencies` in `package.json` are for running the tests and are not
needed to use it. Connection Manager (an ST built-in) is only needed if you want to
summarise through a different connection than your chat uses.

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
`[Summary: {{recall}}]`. The wrapper stays; only the macro changes.

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
newest few.

**The nudge** replaces automatic summarization. When the last prompt sent crosses your
threshold, you get one toast — not one per message — and then silence until a summary
brings usage back down. When to summarise is a narrative decision; the nudge only says it's
time to start looking for a stopping point.

**Regenerate** produces a *sibling*, never a replacement. Both are kept, neither becomes
active on its own, so you can compare and pick. It re-reads the exact messages the original
read, hidden or not.

**Making a summary active** changes what `{{recall}}` resolves to and nothing else — it
never moves a message. If chat visibility and the active summary disagree, the manager says
so and offers a one-click sync. It won't do it on its own; a mismatch is usually deliberate.

**The steering field** at the top of the manager is one-off guidance — *"track all four,
don't let Maddie drop out"*. It applies to the next action you press and then clears itself.
`/recall keep all four present` does the same from the chat bar. It's recorded on the
summary it produced so you can see which note caused what, but it is never replayed.

**Preview request** shows exactly what *Summarize now* would send — both messages, token
counts, remaining room — without sending it. It's built through the same code as the real
request, so it can't drift from it.

---

## Settings

| Setting | What it does |
| --- | --- |
| Hide covered messages | Hide the covered range after a successful summary. |
| Keep newest N visible | Auto-hide skips this many recent messages. Message 0 is always skipped. |
| Block sending | Deactivate send buttons while a summary generates. |
| Nudge threshold | In tokens, against the last prompt sent. 0 tracks 80% of the context limit. |
| **Response reserve** | Context room held back when budgeting the buffer. |
| **Output budget** | The generation limit sent to the API. |
| Framing prefix/suffix | Wraps the previous summary in the buffer. Match your preset. |
| Minimum summary length | Shorter responses are treated as failures, not saved as stubs. |
| Connection profile | Summarise through a different connection. Blank = your chat's. |
| Model / Its context size | Override the profile's model; tell Recall that profile's context window. |
| Reference material | What to send alongside the chat — see below. |
| Use the built-in's old summary | Stand in `extra.memory` until Recall has one of its own. |
| Also answer to `{{summary}}` | Only registers while the built-in Summarize is disabled. |
| Deep integrity check | Also hash the covered range, catching edits below a summary's anchor. Off by default — it flags on any edit anywhere. |

### The two limits are not one limit

**Response reserve** is subtracted from your context to decide how much chat fits in a
buffer. Set it high and you starve the buffer, and long chats start refusing to summarise.

**Output budget** is the `max_tokens` of the request. How it interacts with thinking models
decides the right value, and the two failure modes are opposites:

- **OpenAI-compatible** (OpenRouter, NanoGPT, most others): one budget covers reasoning
  *and* output, with nothing reserved for the response — so a model that thinks without end
  can spend all of it and write nothing. ~15,000 suits a ~1,400-token summary. If you get
  empty responses, raise this first.
- **Claude**: the budget is *split* — thinking takes 10% at `low` up to 95% at `max`. At
  `max`, a 15,000 budget leaves 750 tokens for the summary and everything truncates.
- **Google**: `auto` thinking behaves like the OpenAI-compatible case.

Recall doesn't touch Reasoning Effort. That's yours.

---

## Reference material

Optional context sent alongside the chat, so the summariser isn't guessing who these people
are. Everything here is off by default and competes for the same tokens as the chat history
— each one enabled means less history per pass. The panel shows what each costs.

**From the character card:** description, personality, scenario, user persona, example
dialogue. Group chats use ST's combined cards.

**From your chat's preset:** your main prompt, post-history instructions and any custom
prompts, read from the preset your *chat* is on. They tell the summariser the register the
chat is written in and what it's allowed to be explicit about, which nothing else here
does.

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
templates that expand macros written as prose, and the assembled reference-material buffer.

[docs/recall-design.md](docs/recall-design.md) is the design document.
[docs/implementation-notes.md](docs/implementation-notes.md) records where the code
deliberately departs from it, and why. [CHANGELOG.md](CHANGELOG.md) tracks releases —
semver, tagged `vX.Y.Z`.

MIT licensed. Use it, fork it, change it.
