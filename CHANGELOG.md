# Changelog

Semantic versioning: the patch digit is a fix, the minor digit adds or changes a setting,
and the major digit would break a chat's stored data or your preset. `manifest.json`
carries the version ST reads; `package.json` matches it.

## 1.1.4

**Ticking your preset's summary block no longer sends the summary twice.** Nearly every
preset has a block like `[Summary: {{summary}}]` — it is how the summary reaches the chat at
all, since Recall injects nothing — and offering that block as reference material meant its
macro resolved like any other. The summariser was handed the whole previous summary twice:
once as reference material it is told not to act on, and once in the framed slot it is
supposed to be revising. Double the tokens, and the two copies disagreeing about their own
purpose.

Recall's macros are now removed from a preset block before anything is substituted, so what
is left is the wrapper — `[Summary: ]`, a labelled empty block, a handful of tokens. The
block is still offered rather than hidden, since blocks that mix a summary macro into
otherwise useful instructions exist.

## 1.1.3

**Preset blocks follow the preset's own order**, in the panel and in what is sent. They were
read from `oai_settings.prompts`, which is a bag in roughly the order prompts were created;
the sequence the prompt manager shows, and the one ST assembles from, is a separate
`prompt_order` list. The result looked plausible enough to miss until you put the two panels
side by side, and it meant the summariser read the chat's instructions in an order the chat
never uses. Markers are still omitted, so the list is that order with the gaps closed up.

## 1.1.2

**The preset blocks line up with the blocks above them again.** They were indented behind a
coloured left rule, which pushed their checkbox column out of line with the character-card
list and read as a layout bug before it read as grouping. The divider and the heading were
already separating the two groups; the rule was doing nothing the heading did not say.

## 1.1.1

**Your chat's custom stopping strings no longer apply to summaries.** They live in Advanced
Formatting, not in a preset or a profile, so they rode along on every summarization request
— and `###` and `---`, two of the commonest entries, are what the required summary
structure is built out of. The provider stops at the first match and reports an ordinary
finish, so the truncated summary saved like a complete one and the next pass revised
*that*, losing the cut sections for good.

Both paths are covered: the profile path clears `stop` in Recall's own payload, and the
main API path removes it through `CHAT_COMPLETION_SETTINGS_READY`, the hook ST uses for
this itself. Neither fires unless you actually have stopping strings set, so a user who has
none sends exactly the request they sent before. Your chat is unaffected either way.

Text completion is unchanged and still unsupported: its stopping strings arrive in a
different field.

## 1.1.0

**The profile's generation preset is no longer optional.** Picking a connection profile now
summarises under that profile's preset — its temperature, top P and the rest. The checkbox
that used to control this is gone, and the stored setting is deleted from saved settings on
first load.

The old default was off, and off was not neutral: with no preset, ST sends no sampler
parameters at all, so the request ran on whatever the provider defaults to — a third
sampler set nobody chose and nobody could see. Recall's own payload is still applied over
the preset's, so the output budget and any model override continue to win. The status line
under the profile picker now names the preset in play.

**Your chat preset's own prompt blocks can be sent as reference material.** Main prompt,
post-history instructions, auxiliary prompt and any custom prompts you wrote, read from the
Chat Completion preset the *chat* is running on, listed under their own heading in the
Reference material section. All off by default, like every other block there.

They are sent quoted, under `### Chat instruction:` headings and behind a note saying whose
instructions they are — a main prompt handed to a summariser unmarked is an instruction it
will follow, and the failure is not a poor summary but the model writing the chat's next
reply instead. Chat Completion only; the panel says so on other APIs rather than showing an
empty list.

**Text completion backends are documented as unsupported.** They were never tested, and two
things are now known not to work properly: the preset's context length arrives as
`truncation_length` and can truncate the buffer behind the profile's context size, and the
new preset blocks need a prompt manager, which text completion does not have. Nothing was
removed — they may still work — but they are out of scope rather than quietly assumed.

## 1.0.0

First release.
