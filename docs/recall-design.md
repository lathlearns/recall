# Recall — Design Document

A private SillyTavern memory/summary extension.

- **Target:** SillyTavern 1.18.0
- **Status:** Revision 2 — open questions resolved, ready for implementation
- **Name:** Recall (confirmed; `{{recall}}` and `/recall` verified as unclaimed)

---

## 1. Summary

Recall is a replacement for SillyTavern's built-in Summarize extension. It keeps
Summarize's core idea — one recursive, whole-chat summary that lives permanently in
context — and rebuilds everything around it: the summary prompt becomes a set of
individually toggleable blocks, past summaries become a browsable and editable archive,
automatic triggering is replaced by a manual workflow with a nudge, and the UI moves out
of the Extensions panel into a proper responsive manager.

It does not inject anything into the prompt itself. The user's preset already contains a
block that calls a macro; Recall's only job on the prompt side is to make that macro
resolve.

**The central rule, from which most of the design follows: Recall summarises everything
currently visible in the chat, and nothing else.** Visibility is the only control surface.
The user hides messages when they want them out of future summaries; Recall never computes
a range on the user's behalf and is never told "summarise messages 51 to 100."

---

## 2. Goals and non-goals

### Goals

- One active summary at a time, resolved through a custom macro, sitting wholesale in
  permanent context.
- Recursive generation: each new summary builds on the active one plus everything visible.
- A summary prompt assembled from named, individually toggleable, reorderable blocks, held
  in a global library with per-character override.
- A summary archive with naming, manual editing, deletion, regeneration, and visible
  coverage ranges.
- Integrated message hiding tied to summary coverage.
- Manual triggering, with a nudge when context approaches full.
- A UI that works properly on both desktop and mobile.

### Non-goals

- **Vectorization / embeddings / RAG.** Out of scope entirely.
- **Lorebook or World Info integration.** Out of scope entirely.
- **Prompt injection.** Recall never calls `setExtensionPrompt`. The user's preset owns
  placement.
- **Extras API and WebLLM summary sources.** Main API only.
- **Classic prompt builder.** Raw only (see §6.2).
- **Per-message summaries.** Recall summarises the visible chat, not individual messages.
- **Range selection.** There is no UI for "summarise from X to Y." Hiding is the mechanism.
- **Importing from the built-in Summarize.** Recall never reads or writes `extra.memory`.

---

## 3. Prerequisites and coexistence

The built-in Summarize extension (module `1_memory`) **must be disabled** in the
Extensions manager. It registers the `{{summary}}` macro and calls `setExtensionPrompt`
unconditionally on chat load; leaving it enabled alongside Recall risks a duplicated
summary in context and a macro name collision whose winner depends on load order.

Because Recall uses its own macro name, the user's preset block must be updated from
`[Summary: {{summary}}]` to `[Summary: {{recall}}]`. This is a one-time edit and is
required regardless. The wrapper text itself does not change — only the macro inside it.

Two defensive measures, so that an accidentally-enabled Summarize stays inert:

1. **Recall never writes to `chat[i].extra.memory`.** That field is Summarize's storage.
   Recall uses `chat_metadata` (§5.2). With nothing in `extra.memory`, Summarize's
   `getLatestMemoryFromChat()` returns an empty string, `formatMemoryValue('')` returns
   an empty string, and its injection is a no-op.
2. If Summarize is left enabled for any reason, its **Pause** checkbox must be ticked,
   otherwise it will generate on its own interval and begin populating `extra.memory`.

Measure 1 is enforced in code. Measure 2 is documentation only.

### 3.1 First-run footgun

The default summary prompt instructs the model to read the entire chat when creating a
summary from scratch. That is correct on a fresh chat, where nothing is hidden. But if
Recall is installed on a chat that **already has hidden messages** — an old chat previously
managed with the built-in — the first Recall summary will be told to read everything while
only being shown the visible tail, and will confidently produce a summary of recent
messages presented as covering the whole story.

Documentation only, no code. The remedy is to unhide everything before the first
summarization.

---

## 4. Macro and slash command

Recall registers a single macro via the **Macros 2.0 registry**, so that it appears in ST's
macro list with a description:

```js
import { macros } from '../../../macros/macro-system.js';

macros.registry.registerMacro('recall', {
    category: 'uncategorized',      // or a custom string
    description: 'The active Recall summary.',
    returns: 'The active summary text, or an empty string if none is active.',
    handler: () => getActiveSummary()?.content ?? '',
});
```

`MacrosParser.registerMacro(key, value, description)` — the API the original draft named —
still exists and still works, but is **deprecated as of 1.18.0** and logs a deprecation
warning on every call. Internally it forwards to the registry above with
`category: 'legacy'`. Use the registry directly.

The handler receives a `MacroExecutionContext` and Recall ignores it entirely: the macro
takes no arguments, so `unnamedArgs` defaults to 0 and `strictArgs` defaults to true, which
means `{{recall}}` is the only accepted form. That is the desired behaviour.

- Name: `recall`, used as `{{recall}}`.
- Resolves to the **active summary's `content` field and nothing else**.
- Returns an empty string when there is no active summary.
- No other field on a summary record — name, coverage range, timestamps, block set — has
  any code path to the prompt. The coverage numbers are for the user only; the LLM cannot
  see them.

**Empty resolution is deliberate and requires no special handling.** With no active
summary, the user's preset renders `[Summary: ]` — a labelled empty block. This matches
what the summary prompt itself expects to receive on a first run (§6.2), so both sides stay
consistent, and the roleplay context simply carries an empty labelled block until the first
summary exists.

A `/recall` slash command triggers generation, equivalent to the **Summarize now** button.
Included for convenience; not load-bearing.

---

## 5. Data model

### 5.1 Scoping

| Data | Scope | Storage |
| --- | --- | --- |
| Block library, block sets, global defaults | Global | `extension_settings[MODULE].library` |
| Per-character override (a set reference, or an owned copy) | Per character | `extension_settings[MODULE].characters[avatarKey]` |
| Summaries, active pointer, hide records | Per chat | `chat_metadata` |

Summaries belong to `chat_metadata` because they are chat-specific, travel with the chat
file on export, and would bloat `settings.json` if stored globally.

**Prompt configuration is global by default.** The summary prompt describes *how to
summarise a roleplay*, and in practice is universal — the same prompt serves every
character. Storing it per character would mean N copies of a ~2,500-token prompt, edited N
times by hand, silently drifting apart. Instead:

- The library holds one or more **named block sets** (default: `Standard`).
- Every character uses the global active set unless it explicitly overrides.
- A character that overrides gets its own copy of the blocks and stops tracking the global.
- If the global set is edited while a character is overriding, the manager shows a quiet
  out-of-sync marker on that character's settings. No prompting, no automatic merging.

**Group chats** have no avatar key and therefore always use the global set. This is a real
answer rather than a fallback, and means group chats work with no special handling.

**Avatar key fragility.** Per-character config is keyed on avatar filename, so changing a
character's image orphans its override. Under this model an orphaned character falls back
to the global set, which is almost always the right prompt anyway. Documented, not
engineered around.

### 5.2 Summary record

Stored as an ordered array in `chat_metadata`.

```js
{
  id: string,              // uuid, stable
  name: string,            // user-facing label, never sent to the LLM
  content: string,         // the summary text; the only field the macro reads
  coversFrom: number,      // always 0 in practice — message 0 is never hidden (§7.2)
  coversTo: number,        // last message covered — also the anchor
  newFrom: number,         // first message not covered by the previous summary; display only
  anchorHash: string,      // getStringHash(chat[coversTo].mes) at time of creation
  createdAt: number,
  editedAt: number | null,
  generatedWith: {         // which prompt configuration produced this
    setName: string,
    isOverride: boolean
  },
  regeneratedFrom: string | null, // id of the summary this is a sibling of; see §6.5
  hiddenIndices: number[], // indices this summary hid; see §8
  stale: boolean           // set by drift detection; see §5.4
}
```

`coversTo` doubles as the anchor index — there is no separate field.

`newFrom` exists purely so the UI can distinguish consecutive summaries at a glance. Every
summary covers from 0, so a coverage label alone would be identical across the archive.

### 5.3 Active pointer

A single `activeSummaryId` in `chat_metadata`. Defaults to the most recently created
summary. The user may override it manually, and the override persists until changed or
until a new summary is generated.

Changing the active summary changes what the macro resolves to and **nothing else**. It
does not touch message visibility (§8).

**If the active summary is deleted**, the pointer falls back to the newest remaining
summary, and the manager shows a brief notice saying so. If none remain, the pointer is
cleared and the macro resolves empty. Silently having no memory in context is the kind of
thing that goes unnoticed for several messages, so the notice is not optional.

### 5.4 Anchor drift detection

ST message IDs are array indices, not stable identifiers. Deleting a message shifts the
index of everything above it. Stored indices can therefore become wrong, which would
mislabel summaries in the UI and misdirect the unhide record.

In practice the workflow makes this rare — messages at or below the anchor are hidden and
frozen, so edits and deletions almost always land above the anchor, where they cannot move
it. The check is cheap insurance, not load-bearing machinery.

On `CHAT_CHANGED`, for each summary, compare `getStringHash(chat[coversTo].mes)` against
the stored `anchorHash`:

- **Match** → no drift. Continue.
- **Mismatch, and `anchorHash` is found at another index** → the anchor message still
  exists and simply moved. Silently update `coversTo` to the new index, shift `newFrom` by
  the same delta, **and shift every entry in `hiddenIndices` by the same delta.** No user
  involvement.
- **Mismatch, and `anchorHash` is found nowhere** → the anchor message was edited or
  deleted. Unrecoverable. Set `stale: true` and surface a badge in the manager, offering
  two actions: **Re-anchor to a message I pick** (the user selects the message the summary
  now ends at; `coversTo` and `anchorHash` are recomputed from it) and **Delete**. Nothing
  more elaborate.

`hiddenIndices` shifting alongside the coverage fields is required, not optional. It is
also a raw index list, and if it is left uncorrected the two disagree — so a later delete
would unhide the wrong messages, leaving some stranded and popping others back into view
mid-range.

**Deep integrity check (optional, default off).** The above does not detect edits to
messages *below* the anchor — content the summary covered but is not anchored to. A second
hash over the entire covered range would catch this, but would flag on any edit anywhere in
history, producing a lot of noise in normal use. Ships as an off-by-default setting; worth
revisiting after real use.

### 5.5 Prompt blocks

An ordered array, held per block set:

```js
{
  id: string,
  name: string,     // user-facing
  content: string,  // the actual prompt text
  enabled: boolean
}
```

Assembly filters on `enabled` and joins in array order. Reordering is index manipulation
(move up / move down, and drag on desktop).

**Editing semantics.** Loading a set and then changing a block puts the set into a modified
state — the change lives in a working copy, and the saved set is untouched until the user
explicitly saves back. The set name shows a modified marker, with **Save** and **Discard**.
This is the behaviour that never surprises; the alternative saves a click and lets a set
silently drift from what the user believes it contains.

### 5.6 Default blocks

The `Standard` set ships with two blocks, in this order:

1. **`Summary Prompt`** — the body of the summary instruction: the branch on whether
   `[Summary:…]` is empty, the hierarchy of what must stay, the editing loop, the required
   structure, and the final behavioural rules.
2. **`Quality Check`** — the closing self-verification checklist.

The split is deliberate and minimal. The prompt is order-dependent enough that finer
splitting would create ways to break it; the one seam that matters is the ability to insert
a **new** section above the quality check, so that additions land inside the instruction
body rather than after the model has been told to verify and submit. Blocks are an
extension point first and a toggle second.

---

## 6. Generation

### 6.1 Trigger

Manual only. There is no message-count or word-count interval. See §9 for the nudge that
replaces it.

Two distinct actions, deliberately separate:

- **Summarize now** — summarise the current visible chat, producing a new summary.
- **Regenerate** — redo an existing summary over the same material (§6.5).

They are never the same button. Mispressing is recoverable by deleting the newest record.

### 6.2 Prompt construction

Raw only — Recall does not implement the Classic builder. The assembled prompt blocks
become the `systemPrompt`; the buffer becomes the `prompt`; sent via `generateRaw()`.

Buffer construction:

1. **Collect every message where `is_system !== true`.** In chat order. That is the entire
   selection rule. There is no start index, no anchor arithmetic, and no range. Messages
   already covered by a previous summary are hidden, and are therefore excluded by the same
   rule that excludes everything else hidden.
2. Format each message as `${name}:\n${mes}`, joined by blank lines.
3. Prepend the active summary wrapped in the framing strings (§6.3), so generation is
   recursive — the model receives the previous summary as material and is instructed to
   revise it in place.
4. Enforce the token budget (§6.4). Refuse rather than truncate.
5. Strip reasoning blocks from the response via `removeReasoningFromString()`.

Message 0 is never hidden (§7.2) and is therefore always in the buffer. Recent messages the
user has chosen not to hide are also in the buffer, which means consecutive summaries
overlap slightly at the tail. This is harmless and arguably good — it means the newest
material is seen twice, once as raw text and once as summary.

A **blocking / non-blocking** toggle controls whether send buttons are deactivated during
generation, as in the built-in.

### 6.3 Framing strings

The summary prompt branches on whether the provided `[Summary:…]` block is empty: if it
contains text, revise in place; if empty, create from scratch. That branch only works if
the block is **present even when empty**. Omitting the summary section entirely when there
is no active summary would remove the very thing the model was told to check.

Recall therefore always emits the wrapper:

- No active summary → buffer opens with `[Summary: ]`
- Active summary → `[Summary: <content>]`

Prefix defaults to `[Summary: ` and suffix to `]`, matching the user's preset exactly. Both
are editable in Advanced settings, so the framing can be adjusted if a model responds
better to different wording, or blanked out entirely.

This is a format setting, not a prompt block. It is not optional and it is not part of the
instruction — it is the shape of the material.

### 6.4 Token budget and the two limits

Two separate settings, because one number cannot do both jobs:

| Setting | Purpose | Passed to | Default |
| --- | --- | --- | --- |
| **Response reserve** | How much context room to hold back when budgeting the buffer. | `getMaxPromptTokens(reserve)` | ~2,000 tokens |
| **Output budget** | The generation limit sent to the API. | `generateRaw({ responseLength })` | ~15,000 tokens |

The built-in uses one value for both. Verified against 1.18.0 source, that value flows two
ways at once:

- `getMaxPromptTokens(overrideResponseLength)` returns
  `getMaxContextTokens() - overrideResponseLength`. A high value here starves the buffer.
- `generateRaw({ responseLength })` temporarily overwrites `oai_settings.openai_max_tokens`
  via `TempResponseLength`, and that becomes the request's `max_tokens`.

So a single 15,000 setting would subtract 15,000 tokens of room from every buffer and cause
constant overflow refusals on chats that would summarise fine. The two must be separate.
They should sit adjacent in Advanced, since neither is comprehensible without the other.

**How the output budget interacts with thinking.** This differs by source, and the
difference is large enough to change the right value.

**OpenAI-compatible sources (OpenRouter, NanoGPT, and most others) — the target setup.**
`max_tokens` is a single total covering reasoning *and* visible output. ST reserves nothing
for the response. With Reasoning Effort on `auto`, OpenRouter omits `reasoning_effort` from
the request entirely and NanoGPT passes the raw string through, so in both cases the model
thinks according to its own defaults, unbounded except by `max_tokens`.

Two consequences:

1. **The output budget is a genuine killswitch.** A model that thinks pathologically long
   is stopped by it, and nothing else stops it. This is the setting's real job here.
2. **Nothing guarantees room for the summary.** If reasoning consumes the budget, the
   response comes back with no summary in it. §6.6 is the only safeguard, which is why it
   is a requirement rather than a refinement.

Sizing: ~15,000 is a reasonable default for a ~1,400-token target with verbose reasoners.
If empty responses appear, raise it before changing anything else.

**Claude sources** split the budget instead. `calculateClaudeBudgetTokens` derives a
thinking allowance as a fraction of `max_tokens` — `low` 10%, `medium` 25%, `high` 50%,
`max` 95%, floored at 1,024 and clamped to 21,333 when not streaming — and `auto` returns
`null`, which attaches no `thinking` block at all and so disables extended thinking. The
trap here is the opposite one: at `max`, a 15,000 budget leaves only 750 tokens for the
summary and every generation truncates. Attaching a thinking budget also causes ST to strip
`temperature`, `top_p`, and `top_k`, since the API rejects them alongside it.

**Google sources** use `auto` to mean dynamic thinking (`thinkingBudget: -1`), letting the
model choose per turn, with the same no-reserved-share problem as the OpenAI-compatible
case.

Recall does not read or change Reasoning Effort — it is a global chat setting and belongs
to the user. The doc records the mapping only so the output budget default can be chosen
sensibly.

**Budget calculation.** Available room is `getMaxPromptTokens(responseReserve)` minus:

- the assembled system prompt (the block content — ~2,500 tokens for the default set, and
  omitted from the subtraction in the original draft, which would have put every
  summarization over budget by that much),
- a padding constant (the built-in uses 64).

**Overflow behaviour: refuse, with an actionable message.** Recall cannot silently trim,
because trimmed messages would be recorded as covered without having been read. It also
cannot ask the user to narrow a range, because ranges are not a thing the user controls. So
it walks backward from the oldest visible message, counting, until the remainder would fit,
and reports:

> Too much to summarize. The visible messages come to ~19,200 tokens; the budget is 16,000.
> Hiding the oldest 14 visible messages would bring it under.

The remedy is already in the user's hands. With the nudge threshold set sensibly this
should never appear.

### 6.5 Guards

Refuse to start if: currently streaming, `is_send_press` is true, a group is generating, or
a Recall generation is already in flight.

**Nothing-new check.** Refuse **Summarize now** if the newest visible message is unchanged
since the active summary was created — compare against `anchorHash`. With a visible tail
the buffer is never empty, so emptiness cannot be the signal. The refusal reads *"nothing
new since the last summary"* and points at Regenerate.

After generation, compare chatId / groupId / characterId against the values captured at the
start and discard the result if they changed.

**Range capture.** `coversTo` is recorded from the buffer as it was built, **not** from
`chat.length - 1` after the response returns. In non-blocking mode the user can send
messages while generation runs; reading the length afterwards would record those messages
as covered when they were never in the buffer, and — because they would then be treated as
already-summarised and possibly hidden — they would be silently lost. Low-probability in
this workflow, trivial to prevent, catastrophic and near-invisible if it happens.

### 6.6 Response validation

After stripping reasoning via `removeReasoningFromString()`, a response that is empty or
implausibly short is treated as a **generation failure**, not a summary. With thinking
models this is the signature of the reasoning consuming the output budget before any
summary was written. Surfacing it as an error is the only way the user finds out, since a
saved stub inside a long archive is easy to miss.

**Use `generateRawData()` rather than `generateRaw()`.** Both are exported from `script.js`
and take the same `GenerateRawParams`; `generateRawData` returns the raw API response
object and exists, per its own comment, so that extensions can reach data such as the
reasoning message. That lets Recall distinguish two cases that look identical after
stripping:

- reasoning present, summary absent → *"the model spent its entire output budget reasoning.
  Raise the output budget or lower Reasoning Effort."* Actionable, and points at the right
  setting (§6.4).
- nothing at all → a plain generation failure.

`generateRaw` additionally runs `cleanUpMessage()` with name trimming, which Recall does
not need.

### 6.7 On success

1. Create a new summary record covering `[0, lastVisibleIndex]`, with `newFrom` set from
   the previous summary's `coversTo + 1`.
2. Set `anchorHash` from the last covered message.
3. Record `generatedWith` from the active set name and override status.
4. Make it active.
5. If auto-hide is enabled, hide the covered range subject to the pinning rules (§7.2).
6. Clear the context-fullness state and re-arm the nudge (§9).

### 6.8 Regeneration

**Regenerate** produces a **sibling**, never a replacement. Both summaries persist so the
user can compare and choose; the rejected one is deleted by hand.

Regeneration is airtight because **it touches no state**. It rebuilds the buffer from the
original's recorded indices — the same messages, regardless of whether they are currently
hidden — and writes a new record with `regeneratedFrom` set to the original's id. No
hiding, no unhiding, nothing to fall out of sync.

- **Hide ownership stays with the original.** The sibling gets an empty `hiddenIndices`.
  One summary owns a hidden range, always. If the user deletes the original and keeps the
  sibling, Recall offers to transfer the hide record rather than unhiding.
- **Neither is automatically active.** The user picks.
- **Old summaries can be regenerated.** Every later summary was built on top of the one
  being redone, so replacing it does not retroactively improve them. The manager says so
  once, quietly, at the point of use. Not blocked; just flagged.

---

## 7. Message hiding

### 7.1 Mechanism

ST's hide is `is_system = true` on the message object. The message stays in the chat array
at its original index; nothing renumbers, nothing shifts, and the chat file retains every
message. Hiding message 51 in a 100-message chat leaves 51 as 51 and 52 as 52. This is
purely a visibility flag.

`is_system` is shared with genuine system messages, which constrains unhide logic (§8.2).

### 7.2 Pinning rules

**Message 0 is never hidden. No exceptions, ever.** It is the greeting or scenario, it
anchors the chat, and losing it is a real problem. Auto-hide skips it unconditionally, and
the rule is not configurable.

Message 0 remaining visible does **not** exclude it from summarization. It is in the buffer
like any other visible message; it simply also stays on screen.

**Tail pinning.** A configurable count of the most recent messages is also skipped by
auto-hide, defaulting to **5**. This keeps the chat from going blank the moment a summary
is generated, and leaves the model some verbatim recent context. The user may hide these
manually at any point once the story has settled.

### 7.3 Governing principle

**Hide state changes only in response to an explicit command, never as a side effect of
selecting or activating a summary.**

- Clicking a summary in the manager opens it for reading and comparison. No chat mutation.
- Making a summary active changes macro resolution. No chat mutation.
- Regenerating changes nothing at all (§6.8).
- The user can browse and diff every summary in the archive without moving a single
  message.

---

## 8. Hide records

### 8.1 Tracked hiding

When Recall hides a range, it records in `hiddenIndices` **only the indices it actually
flipped** — messages already hidden by the user are excluded. Unhiding only ever touches
that list. A message the user hid manually weeks ago for their own reasons will not be
resurrected by Recall deleting a summary.

### 8.2 Coverage sync

If the currently hidden range does not match the active summary's coverage, the manager
shows a quiet mismatch indicator and a one-click **Sync chat to this summary** action. It
is never automatic. Much of the time a mismatch is intentional — the user activated an
older summary specifically to compare output, with no interest in rewinding the chat.

**The mismatch check must account for pinning.** Message 0 and the pinned tail are covered
but not hidden by design, so a naive comparison would report a mismatch permanently.
Coverage and hiding are deliberately not the same set.

### 8.3 Deletion

Deleting a summary offers to unhide its `hiddenIndices`, so that scrapping a bad summary
genuinely reverts chat state rather than leaving orphaned hidden messages to dig out by
hand. Offered, not forced.

For regeneration siblings, see §6.8 — the offer becomes a transfer when the surviving
sibling has no hide record of its own.

---

## 9. Context nudge

Replaces automatic summarization entirely.

The user's workflow triggers on narrative structure — end of a day, end of a subplot —
which no message or word threshold can detect. A threshold that fires on its own is
therefore always wrong. What is useful is a signal that it is *time to start looking* for
a stopping point.

Recall reads ST's own context usage: the size of the last prompt actually sent, against the
context limit. Both are available without recomputing anything.

- **Limit:** `getMaxContextTokens()`, exported from `script.js`.
- **Usage:** `itemizedPrompts` (also exported) holds a record per generated message, with
  the assembled `finalPrompt` on it. `findItemizedPromptSet(itemizedPrompts, mesId)`
  locates the entry for the newest message; `getTokenCountAsync(entry.finalPrompt)` gives
  its token count.

This measures what was really sent rather than estimating what might be, and costs one
token count on `MESSAGE_RECEIVED`. If no itemized entry exists yet — a fresh chat, or a
swipe before any generation — skip the check rather than falling back to an estimate.

When usage crosses a user-set threshold:

1. **One toast**, fired once per crossing. Not on every subsequent message — otherwise the
   user gets a toast every turn for the twenty messages spent hunting for a scene break.
2. **A persistent indicator** that stays lit until a summary is generated, because toasts
   are transient and trivially missed while reading. **Deferred — see §14.**
3. On successful generation, the state clears and the trigger re-arms.

**Re-arm dead zone.** If usage is somehow still above the threshold immediately after
summarizing, do not re-fire. Wait until usage has dropped below the threshold and crossed
it again.

The threshold is entered in tokens and displayed as a percentage alongside, so it is
meaningful at a glance.

---

## 10. UI

### 10.1 Surfaces

- **Drawer** (Extensions panel): a thin status strip and launcher. Shows the active
  summary's name, its coverage range, context-fullness state, a **Summarize now** button,
  and an **Open manager** button. It earns its space by being the at-a-glance view
  available without opening anything.
- **Modal** (ST's `Popup` class): everything else. Full-screen on mobile, large centered
  dialog on desktop — responsive by default, and the only surface that behaves sanely in
  both places without maintaining a second layout.

A draggable popout is explicitly **not** the primary surface. ST's movingUI is effectively
desktop-only, and dragging a floating window around a phone is not a real interaction. See
§14.

### 10.2 Layout

**Master-detail**, with settings behind a gear.

- **Master:** scrollable list of summaries, newest first. Each row shows name, coverage
  ("Messages 0–150"), an active marker, a sibling marker where `regeneratedFrom` is set,
  and a stale badge where applicable. Rows stay compact — a long chat with regeneration
  siblings will accumulate entries, and the list must remain usable at forty.
- **Detail:** the selected summary's editable content, with metadata (created, edited, new
  this time, generated with) and per-summary actions including **Regenerate**.
- **Gear:** settings — block sets and blocks, nudge threshold, auto-hide toggle, tail pin
  count, blocking mode. Advanced: response reserve, hard cap, framing strings, deep
  integrity check.

### 10.3 Responsive behaviour

Standard navigation-stack collapse at one breakpoint:

- **Wide:** list and detail side by side; selecting a row updates the right pane.
- **Narrow:** list fills the screen; tapping a row slides the detail over it; a back button
  returns.

Same components, same state. This is a requirement, not a nice-to-have — "mobile
technically renders" is not the bar.

### 10.4 Visual and interaction requirements

- **Theme tokens.** All styling goes through ST's CSS custom properties. No hardcoded
  colours. The extension must inherit the user's theme and keep matching when it changes.
  The complete set defined in 1.18.0's `public/style.css`:

  | Token | Typical use |
  | --- | --- |
  | `--SmartThemeBodyColor` | Primary text |
  | `--SmartThemeEmColor` | De-emphasised text — metadata, coverage ranges |
  | `--SmartThemeQuoteColor` | Accent — active markers, primary actions |
  | `--SmartThemeUnderlineColor` | Links |
  | `--SmartThemeBorderColor` | Dividers, row separators, input borders |
  | `--SmartThemeShadowColor` | Elevation |
  | `--SmartThemeBlurTintColor` | Panel background |
  | `--SmartThemeChatTintColor` | Chat-area background |
  | `--SmartThemeUserMesBlurTintColor` / `--SmartThemeBotMesBlurTintColor` | Message backgrounds |
  | `--SmartThemeFastUIBGColor` | Background when blur is disabled |
  | `--SmartThemeBlurStrength` | Backdrop blur amount |
  | `--SmartThemeCheckboxBgColorR` / `G` / `B` | Checkbox background channels |
  | `--SmartThemeCheckboxTickColor` / `--SmartThemeCheckboxTickColorValue` | Checkbox tick |

  There is no dedicated destructive/danger token. Destructive actions should reuse ST's
  existing button classes rather than inventing a red.
- **Progressive disclosure.** Every control is kept. Controls touched every session are
  visible by default; set-once controls live behind an Advanced toggle. Nothing removed,
  hierarchy clarified.
- **Action hierarchy.** Primary (Summarize now), secondary (Save, Sync, Regenerate), and
  destructive (Delete) actions are visually distinct. Destructive actions get a confirm
  step or an undo window.
- **Dirty state.** Manual edits to summary content and to block sets both show an
  unsaved-changes indicator with Save and Revert. Without this, an edit will eventually be
  lost by clicking away.
- **Empty state.** Defined copy for a chat with zero summaries.
- **Error state.** Generation failures — including overflow refusal (§6.4), nothing-new
  refusal (§6.5), and empty-response failure (§6.6) — surface as persistent inline errors
  in the panel, not only as toasts, since the user may not be looking at the screen.
- **Density.** More breathing room and clearer grouping than the built-in, which loses
  legibility by cramming a manager, an editor, and a settings block into one narrow
  accordion column.

---

## 11. File layout

```
data/<user>/extensions/third-party/recall/
├── manifest.json
├── index.js
├── style.css
└── templates/
    ├── drawer.html
    └── manager.html
```

Rendered via `renderExtensionTemplateAsync`.

---

## 12. Events

| Event | Action |
| --- | --- |
| `CHAT_CHANGED` | Load summaries from `chat_metadata`, run drift detection, refresh drawer |
| `MESSAGE_RECEIVED` / `MESSAGE_SENT` | Re-evaluate context threshold for the nudge |
| `MESSAGE_DELETED` / `MESSAGE_EDITED` | Run drift detection |

**Branching.** Branching or checkpointing a chat creates a new chat file. Recall copies the
summary archive, active pointer, and hide records into the branch, so a branch inherits its
memory rather than starting blank.

---

## 13. Resolved questions

Recorded for the implementer, since the original draft left these open:

1. **Naming.** Extension `Recall`, folder `recall`, macro `{{recall}}`, command `/recall`,
   preset block `[Summary: {{recall}}]`. Verified as unclaimed in the target install.
2. **Group chat scoping.** Group chats use the global block set. Resolved by the
   global-library model (§5.1).
3. **Nudge indicator placement.** Deferred (§14).
4. **Empty macro handling.** No special handling. The preset renders `[Summary: ]`, which
   is both harmless in the roleplay context and consistent with what the summary prompt
   expects on a first run (§4, §6.3).
5. **Deep integrity check default.** Off. Revisit after real use.
6. **Slash commands.** `/recall` ships as a trigger equivalent to Summarize now.

---

## 14. Deferred

Not part of the first implementation. Ordered by likely value.

1. **Persistent nudge indicator.** The toast and the threshold tracking ship — they are
   just "read a number, compare it, fire once." Only the persistent lit element is
   deferred, because it needs a home in the live 1.18.0 DOM that is visible while the
   drawer is collapsed and the modal is closed, and that should be chosen against the
   actual install rather than guessed at. Consequence: the first version can be missed if
   the user is not looking. Tolerable, since ST shows context usage independently.
2. **Block sets beyond the basic model.** The global set plus per-character override ships.
   Multiple named sets, switching between them, and the modified/save/discard cycle are
   specified (§5.1, §5.5) but can land later — with one universal prompt in use, the
   machinery has nothing to do yet.
3. **Desktop draggable popout.** A convenience on top of the modal, never a replacement.

---

## 15. Verified API surface

Read from the pinned **1.18.0** tag (commit `51ad27f`, released 3 May 2026). Everything the
original draft flagged as unverified is resolved below.

### Confirmed

**Macro registration** — `macros.registry.registerMacro(name, options)` from
`public/scripts/macros/macro-system.js`. `MacrosParser.registerMacro` is deprecated (§4).

**Popup** — `public/scripts/popup.js`:

```js
new Popup(content, POPUP_TYPE, inputValue = '', options)
await popup.show()   // resolves to POPUP_RESULT | number | string | null
```

`POPUP_TYPE`: `TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5`.
`POPUP_RESULT`: `AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1–9: 1001–1009`.

Relevant options for the manager: `large` (90% of screen — the right default here), `wide` /
`wider`, `allowVerticalScrolling`, `leftAlign`, `customButtons` (array of
`{ text, icon, result, classes, action, appendAtEnd }`; **a button with no `result` does not
close the popup**, which is what Summarize now / Regenerate / Save need), `onClosing`
(return `false` to cancel — this is where the unsaved-changes guard goes), `onClose`,
`onOpen`, `allowEscapeClose`.

`Popup.show.confirm(header, text, options)` covers destructive confirms without building a
popup by hand. `callGenericPopup()` is the one-shot convenience wrapper.

**Generation** — `public/script.js`:

```js
generateRaw({ prompt, api, instructOverride, quietToLoud, systemPrompt,
              responseLength, trimNames, prefill, jsonSchema })
generateRawData({ ...same, minus trimNames })   // returns the raw response object
```

`prompt` accepts a string or an array of `{ role, content }`. Recall uses `systemPrompt`
for the assembled blocks and `prompt` for the buffer. Positional arguments still work but
log a stack trace — use the object form.

**Token budgeting** — `getMaxPromptTokens(overrideResponseLength)`,
`getMaxContextTokens()`, `getMaxResponseTokens()`, `getTokenCountAsync(text, padding)`.
See §6.4 for how these interact with the two settings.

**Context usage** — `itemizedPrompts`, `findItemizedPromptSet()`, both exported from
`script.js`. See §9.

**Theme tokens** — full list in §10.4.

### Still to check against the live install

- **`{{recall}}` and `/recall` collision.** Verified as free by the user in their own
  install; re-check after any ST update, since the macro registry now spans several
  definition files.
- **Whether the user's setup has `power_user.experimental_macro_engine` enabled.** It
  changes nothing for registration — `registerMacro` writes to the new engine either way —
  but Macros 2.0 changes evaluation order and nesting behaviour in presets generally.
- **Reasoning Effort setting.** §6.4's sizing guidance depends on it and on the source.
  Read it once during setup; warn only in the cases that actually misbehave (Claude at
  `max` with a low budget).
- **Whether NanoGPT tolerates `reasoning_effort: 'auto'`.** ST does not map the value for
  that source and passes the raw string to an OpenAI-compatible endpoint, where `auto` is
  not a standard value. It appears to be ignored in practice, but if summarization fails
  there with a validation error while OpenRouter works, this is the first thing to check.
- **The nudge indicator's DOM home** (§14), deferred by design.
