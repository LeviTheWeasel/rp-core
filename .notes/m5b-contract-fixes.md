# M5b contract — fixes (rulings G and H left over from waves 1–2)

Builder: fixes. Decisions: the lead's rulings G (after wave 1) and H (after wave 2) in
`.notes/m5b-decisions.md`. No API added or removed; behaviour only.

## Files

| file | change |
|---|---|
| `src/agents/compendium/filing.ts` | `{}` reads as nothing to file (`itemsOf`); header/doc lines |
| `src/agents/compendium/historian.ts` | `{}` reads as nothing to summarise; significance `critical` → `pivotal`; «1200 characters»; the digest leaves out resolved, failed and abandoned plots |
| `src/engine/lane.ts` | the reader wrapper (`isEmptyObject`) removed: `read` is `filingReader(...)` / `readHistorianAnswer(raw, profile)` as they are; `forkMoment` (ruling H) |
| `src/engine/session.ts` | `sentChanged`: the {{recap}} slot has its own reason |
| `test/filing-m5b/{read,prompt}.test.ts` | `{}` is nothing (text, fenced, decoded, the structuredCall reader); snapshot and roster drop failed/abandoned plots |
| `test/historian-m5b/{answer,prompt}.test.ts` | `{}`; `critical`; «1200» (and no grouped number in the lite text); digest drops failed/abandoned |
| `test/lane-m5b/lane.test.ts` | the fork test follows ruling H; a new fork test |
| `test/engine-m5a/preview-turn.test.ts` | two slot tests |

## Behaviour

- **`{}`** (an object with no keys) is a valid empty answer in both readers: filing `{ok: true, items: [],
  skipped: []}`, historian an empty `HistorianAnswer`. Text answers too (`'{}'`, a fenced `{ }`). Any
  other object with no envelope and no item shape (`{"notes": "none"}`, `{"filings": 3}`) stays
  unreadable (the corrective pass runs), as Bunraku. The lane's own handling of `{}` is gone.
- **Significance**: the historian's field coercion has a per-field synonym table; only
  `summary.significance: critical → pivotal` (folded first, so `Critical` works). Another word outside
  the enum is still skipped with `must be one of …`.
- **Prompt numbers**: the lite historian line is «Keep each overview under 1200 characters.». No other
  prompt text had a grouped number (the filing prompts interpolate plain numbers).
- **Closed plots**: the historian digest drops statuses `resolved`, `failed`, `abandoned` (trimmed,
  lower-cased), as the filing snapshot and roster already did (`RESOLVED_PLOT`; now pinned by a test).
- **Fork moment (ruling H)**: `enableMoment` on a fork = `forkMoment(tree, fork.at)`: the fork-point
  message's seq − 1 when it is an answer (an assistant message with a user message before it on its
  path), so that answer counts; its own seq otherwise (a user message, the greeting). Every earlier path
  message has a lower seq on the fork (planFork copies in journal order), so earlier answers stay the
  source's (copied rows cover what it filed; the rest is not back-filled). The historian's floor follows
  the same moment: positions before the fork-point answer count as covered.
- **/preview --turn**: `sentChanged` names `the {{recap}} slot` when the slot changed: its `recap`
  message came or went, its row's tokens moved while the rows line up, or `trace.recap` holds other
  ids or arc revisions (read with `readRecapTrace`; a trace without one reads as empty; the boundary is
  not compared). A `recap` row is no longer a system block. Not named when the Compendium changed
  (`inputs.compendium`, as the Compendium block). A row that merges the slot with a block: the slot when
  `trace.recap` already says it changed, else the block.

## Open questions

1. With `filing.wait ≥ 2`, answers before the fork point that the source had not yet accepted are still
   not filed on the fork (ruling H moves the moment only before the fork-point answer). Say if the moment
   should sit before the oldest answer not accepted at the fork instead.
2. A slot held inside a preset block (`{{recap}}` in the preset) that changed may be named both as the
   slot (trace.recap) and as "the text of the system blocks" (the block's tokens moved).
3. docs (ARCHITECTURE rev 17, COMPENDIUM-DEVIATIONS) still need: `{}` as nothing (deviation from
   Bunraku), `critical` → `pivotal`, «1200», the digest's closed plots, the fork moment.
