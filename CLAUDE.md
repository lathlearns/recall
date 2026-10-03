# Working on Recall

## Branches

Three, and work only ever moves one way: `wip-do-not-install` → `test` → `main`.

| Branch | What it is | Who installs it |
| --- | --- | --- |
| `main` | Released versions. | Everyone. |
| `test` | Features ready for someone else to try. | Testers. |
| `wip-do-not-install` | Where changes are made. May be half-finished or broken at any commit. | Nobody. The name is the warning. |

- **Commit on `wip-do-not-install`.** Never commit directly to `test` or `main`.
- **`test` takes `wip-do-not-install` whole**, as a fast-forward, only when asked. If `test`
  has something wip lacks, stop and ask rather than merging.
- **`main` takes `test`** only with explicit approval, and gets the version bump and
  `CHANGELOG.md` entry as part of that release.
- **Pushing** any branch happens only when asked.
- **Don't delete `test`.** Testers' installs track it.

## Docs that move with the code

- `docs/feature-reference.md` is shared with LumiRecall (`C:\AI\Extensions\LumiRecall`) and
  must stay byte-identical there. A behaviour change updates it in both, and what LumiRecall
  hasn't ported yet goes under "Not yet ported from Recall" in its `docs/host-notes.md`.
- Recall's own host-specific gotchas live in `docs/host-notes.md`.
