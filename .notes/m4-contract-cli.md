# M4 contract note — unit `cli` (wave 2)

Files: `src/cli/repl-commands.ts`, `src/cli/repl.ts`, `src/cli/repl-render.ts`, `src/cli/repl-journal.ts`,
`src/cli/render.ts`, `src/cli/main.ts`, `src/cli/compact.ts` (new), `src/session/log.ts` (compact only:
`TurnOpenError`, `CompactResult`, `compactSessionLog`, one header comment line). Tests: `test/repl/m4-commands`,
`m4-render`, `m4-journal`, `m4-flows` (.test.ts), `test/cli-m4/compact.test.ts`, `test/cli-m4/fixtures.ts`
(helpers). Nothing was ported (no provenance rows).

## 1. Changes in files I do not own / needed from others

- **Edited outside the listed files (unavoidable, same change as the M3 help line):**
  `test/repl/commands.test.ts:113` expected `/director on` to parse as `later` → now `{name:'director', action:'on'}`
  (plus `/persona` still later); `test/repl/m2-commands.test.ts:92` expected `Later: /director (M4);` in /help → now
  `Later: /memory tree|`. `test/repl/m3-commands.test.ts:151` updated as assigned.
- **integrate** — the CLI reads only these shapes:
  - `msg.dir` = a DirectorRecord that `checkRecord` accepts (`/director show` folds `directorAt(tree, head)`).
  - `trace.calls` rows `{callKey, agent:'director', model:'conn:model', ms, usage?}` on the COMMIT's trace (and on
    `prep.trace`, which recovery copies to the recovered msg). `/usage` counts every non-narrator row of the msg
    trace and of each continue-edit trace on the path. A continue's trace must NOT copy the target's Director rows
    (they would be counted twice).
  - events `director{status, reason?, summary?}`: `failed` carries the fail code in `reason`.
- **engine/api.ts (lead)** — `turn_open` is not a `RefusalCode`; compact prints the refusal line itself. If
  `--stdio` (M6) exposes compact, add `'turn_open'` to `RefusalCode`.
- **docs (lead)** — ARCHITECTURE.md §12.3 (`rp-core compact`, exit 5 `turn_open`/`session_locked`), §12.4 (/director,
  the banner's Director part, /usage rows per agent). `recover.ts:156` already says compact deletes chk lines: true now.

## 2. Deviations from m4-decisions.md / the task text, and why

- **Banner**: `… narrator c:m (tools: x) · director c:m (<profile>) · ctx N` — D-113's form with the profile
  (`director.profile`: auto/full/lite); the task text had no profile. Shown only while `director.enabled`; the binding
  is the config's (`roles.director`, else the narrator's), like the narrator part (also under `--provider`).
- **/director show with the Director off** prints the off line (with how to turn it on) AND the kept state, since the
  plan is frozen, not gone; "The Director has not planned yet." when no record is on the path.
- **What "ripe/OVERDUE" means in show**: a seed is `age N/T OVERDUE` when `age ≥ SURFACE_TURNS[payoffHorizon]` (what
  the planner's prompt calls OVERDUE) and additionally `ripe for payoff` by `MOMENTUM.seedRipe` (age ≥ 30 with ≥ 2
  reinforcements; what enrich turns into callbacks). Hidden arcs show `age N/T` the same way plus the clue count; arcs
  show `stale: N turns without progress` from `MOMENTUM.arcStale` with `lastProgressTurn ?? createdAtTurn` (A.2). Ages
  count from `state.turn`. Finished arcs / paid seeds / surfaced-or-resolved hidden arcs and completed chapters are
  only counted. The directive line uses the record's final directive ("as sent") when the record planned, else the
  state's authored `lastDirective` (a failed turn).
- **/usage format**: unchanged when the path has no other agent's calls. With them: `usage on this path:` then one row
  per agent (`narrator  N generations · in · out · cost`, `director  N calls · …`), a `total` row, and the notes
  per agent. `UsageSummary` keeps the narrator at the top level and adds `agents?` only when non-empty (old
  `toEqual` tests unchanged).
- **compact**:
  - needs no config.toml (the engine opens with the home only: recovery calls no model), so a broken config does
    not block it; takes no `--provider`;
  - "closed turn" = a `turn` row plus a `msg`/`edit` with that turn id or an `end` (recover.ts's rule). chk/prep of a
    turn with no `turn` row, and lines the reader skips (bad_line), stay byte for byte;
  - a torn or invalid LAST line is refused (exit 1, "open it once"), not repaired: the engine open just before
    repairs it, so this only happens when another process wrote in between;
  - nothing to remove → the file is not rewritten (mtime unchanged);
  - text output appends `(N lines removed)` / `(nothing to remove)` to D-114's line; refusals print
    `rp-core: refused (<code>): …`, a hint, then `{"type":"refusal",…}` on stderr like `send`; codes `turn_open`,
    `session_locked`, `session_not_found` (exit 5).
- `describeEvent` now returns the Director line too (`planned — summary`, `reused — summary` or bare `reused`,
  `failed (<reason>)`, `failed (unknown)` without one); the REPL's `sideLine` is unchanged (it still prints
  `skipped`). `send`'s text renderer starts a Director line on a fresh stderr line like a tool line.
- `/director on` with a binding of its own on a connection config.toml lacks (or `connectionProblem` refuses) prints a
  warning; it still switches on (the plans then fail `no_connection`, D-101).
- `rp-core --help` says "milestone M4".

## 3. API (additive)

```ts
// cli/repl-commands.ts
type Command = … | { name: 'director'; action: 'show' | 'on' | 'off' };   // commandClass: show 'read', on/off 'edit'
// cli/repl-journal.ts
interface UsageCounts { calls; inputTokens; outputTokens; noUsage; costUsd: number | null; unpriced }
interface UsageSummary extends UsageCounts { agents?: Record<string, UsageCounts> }
function directorBinding(roles: Roles): { conn: string; model: string; follows: boolean };
// cli/repl-render.ts
function bannerLine(header, narrator, window, style, cap?, tools?, director?: { conn; model; profile } | null): string;
interface DirectorShow { enabled; binding: {conn; model; follows}; profile; style; state: DirectorState; record?: DirectorRecord; from?: string; invalid: number }
function renderDirector(d: DirectorShow, style: Style): string;
function directiveSummary(d: NarratorDirective): string;
// cli/render.ts
function directorLine(ev: Extract<Event, { type: 'director' }>): string | null;
// cli/compact.ts
function cmdCompact(a: { home; sessionId; json; io; engine?: Partial<EngineOptions> }): Promise<number>;
// session/log.ts
class TurnOpenError extends Error { readonly turns: readonly string[] }
interface CompactResult { before: number; after: number; removed: number }
function compactSessionLog(home: string, id: string, opts?: LogOptions): CompactResult;  // SessionLockedError, SessionNotFoundError, SessionCorruptError
```

## 4. Not done / open

- No end-to-end test of `send` or the REPL with the Director ON (the integrate unit wires the turn now): the
  Director's stderr line is tested through `createTextRenderer` with synthetic events, `/director show` and
  `/usage` through journals with hand-written records and trace rows.
- compact keeps `msg.dir` snapshots (risk 11: checkpoint snapshots later); on a long Director session the saving is
  only the `prep` copies plus the chk text.
- Results at the time of writing: my tests 45 pass (m4-commands 4, m4-render 15, m4-journal 5, m4-flows 6,
  compact 15); full `bun test` 4140 pass, 3 skip, 0 fail (194 files, other wave-2 units' tests included); `bunx tsc --noEmit -p .` clean.
