# M5c contract — cli (wave 3: D-206 and the CLI items of the integrate note)

Fresh code (nothing ported), so no provenance note.

Files: `src/cli/{repl,repl-commands,repl-render,runtime,chat,main}.ts`, `src/cli/tui/{agents,agents-pane}.ts`,
`src/engine/api.ts` + `src/engine/session.ts` (only `MemoryStatus.prefetch`, ruling H), `src/config/config.ts`
(one comment of the starter template). Tests: `test/repl-m5c/` (new: `commands` 16, `flows` 9, `kit.ts`),
`test/tui/recall-m5c.test.ts` (6), `test/cli/routeof-m5c.test.ts` (2); older tests that pinned "later" updated
(`test/repl/{commands,m2-commands,m3-commands,m4-commands,repl}.test.ts`, `test/repl-m5a/export.test.ts`,
`test/repl-m5b/commands.test.ts`, `test/tui/e2e.test.ts` smoke rows); `test/repl/kit.ts` got `engine` (lane,
recall seam) and `local` options.

## Engine surface (ruling H)

- `MemoryStatus.prefetch?: {basis, on, state: 'queued'|'running'|'ready', record?: RecallRecord}` (api.ts).
  `session.ts` fills it in `memoryStatus()` and `memoryWait()` from the lane's public surface only
  (`lane.mode`, `lane.prefetchFor(basis)`): auto lane, `recallSetup` + `wantsPrefetch`, a live typed entry;
  `on` = the head answer (the greeting too), or the answer a player's message at the head replies to.
  `ready` (a record held, a failed one too) / `running` (begun; it may still wait for a place: the lane's
  `PreRun.waiting` is private) / `queued` (owed, not begun; only while an answer is the head). Absent
  otherwise. Under the preload (lexical) it is always absent, so M5b status comparisons do not change.

## Commands (repl-commands.ts)

- `/memory recall [--turn <#n|id>]` (also a bare `5`, `#5`, id) → `{action:'recall', at?}`; read.
- `/memory profile` → read; `/memory mode` (show, read) / `/memory mode <auto|sync|prefetch|lexical|off>`
  (any case; edit: refused mid-turn). `RECALL_MODES` exported. `MEMORY_LATER = {}`; SUBCOMMANDS lists the
  three; /help has their lines, mentions the prefetch under /memory status and recall under /trace; the
  `Later:` line is gone (LATER keeps persona/impersonate, which help never listed).

## What prints (repl-render.ts; repl.ts wires it)

- `/memory recall`: `recall for #3: sync · recalled 2 · full · script:default · tagged`, then the picks in
  recall's order (`1. C3 "Арсений Кеттер" — reason`), `read:` (non-zero unknown/repeated/over the limit/by
  name/salvaged, omitted), and `1 call · 0.4s · 200 in / 8 out tokens` (a prefetch: `… in the background,
  before the player's message`; a reuse: `0 calls: the picks of #n`). Failed/skipped: the code's reason and
  "the selector picked alone (lexical)". No record: lexical / off / no Compendium input, from the answer's
  `trace.compendium.source`; a player's message and a greeting are refused/explained. The target defaults
  to the last non-greeting answer on the path; record = `effectiveRecall` (a continue's newest).
- `/trace`: `  recall: sync · 2 picked: C3 "…", C2 "…" · 1 call 0.4s` before the compendium line; adopted
  prefetch `prefetch after #1 · … · 0 calls in this turn (the prefetch: 1 call 2.5s)`; `reused from #n · …
  · 0 calls`; `failed [timeout] → lexical`; `missed [prefetch_missed] → lexical`; no record: `lexical (no
  recall call; …)` / `off (no recall call)`. A swiped-away answer reads `<id> (another version of #n)`.
- Lane lines (between turns, like `⋯ memory:`): `⋯ recall: prefetched after #1 → 1: C3 "Арсений Кеттер"`,
  `→ nothing picked`, `the prefetch after #1 failed [timeout]`, `… gave way to a turn; it runs again at the
  next pause`, a coded skip; nothing for queued/started/superseded. The event names neither the answer nor
  the picks, so the REPL reads `memoryStatus().prefetch` when a final recall event arrives (listen()).
- `/memory status`: the prefetch counts with running/queued and has its own line (`recall: the prefetch
  after #1 runs` / `is queued …` / `prefetched after #1, ready for the next reply: 1 picked: …` / `… failed
  [code]: the next reply falls back`). `/memory wait`: waits for a queued or running prefetch too (below);
  out of time: `still working after 0.2 s: the recall prefetch after #1 runs (/memory status)`.
- `/memory profile`: one header (auto: lite below 24576; or "set" for all) and rows block / recall /
  filing / historian: profile, the window that decides it, `conn:model`, how the binding follows (D-85),
  recall's `up to N picks, reading the last M messages`, and `not running: …` (filing off, interval 0, mode
  lexical/off). Block window = the banner's (last answer's trace, else the connection's, within preset and
  session limits); others = `ReplDeps.routeOf` (else windowOf/caps), within the session's limit.
- `/memory mode`: `recall mode: auto (the default | this session's compendium.recall.mode | RP_CORE_RECALL |
  set for this session, from the next reply)` + what it does here (auto by locality: prefetch with grace and
  onMiss, or sync beside the Director; unknown locality: both said). Same mode again: "already …; nothing
  changed" (compared with the session's raw mode, so setting the default explicitly still writes a row).
- `/model`: an unset recall shows `recorder (follows)`; the starter config.toml comment says so.
- TUI agents pane: `isLaneEvent` takes agent{recall} without a turn and retries of `p_…` call keys; a
  prefetch's usage is NOT counted live (it counts once adopted, through the record, as /usage). Recall
  blocks from the lane carry `lane: true` and source `prefetch`; `done` shows as `Recall · prefetched (n)`;
  idle{background:0} clears a lane recall block still queued/started, never a turn's. `withLane` reads
  `MemoryStatus.prefetch`. Sync recall was already shown (`recalled (n) · sync · 0.4s`).
- `rp-core chat --help`: recall and `RP_CORE_RECALL=lexical|off` next to `RP_CORE_LANE`.

## ReplDeps additions

- `routeOf?(conn, model) → {window, local} | null` — `runtime.ts routeOf`: the connection (the --provider
  override serves every binding), `contextWindow({caps, local: conn.local})`, and `connectionLocality` over
  the same connections the engine gets. `chatDeps` passes it (the TUI reuses chatDeps).
- `recallDefault?: 'auto'|'lexical'|'off'` — what replaced the engine's default; absent: process.env
  `RP_CORE_RECALL` as Engine.open reads it (not `ReplOptions.env`, which hosts and tests replace).

## Choices (say if any should change)

1. `/memory wait` waits for the prefetch in the REPL: after `memoryWait` says idle while
   `prefetch.state` is queued/running, it waits for the next final recall lane event (via the bus), then
   `memoryWait()` again (auto lane: passive), under one deadline for `sec` (a REPL timer). `lane.wait` does
   not wait for `pre` (lane.ts not mine); if it starts to, this loop just never runs.
2. `/memory recall` accepts a bare `#n`/id besides `--turn` (demo G14).
3. The picks a lane line names come from the status read at the event's arrival; when it no longer
   matches (count differs), the line only counts.
4. `/memory profile`'s windows are the CLI's computation (no engine call): exact in `rp-core chat|tui`
   (routeOf), approximate in a host without routeOf ("full or lite: … window is not known yet").

## Open questions

- Q1 Should `lane.wait` (memoryWait) wait for a due/running prefetch itself (idle{background} counts it)?
  The demo's `/memory wait` lines rely on it; the REPL covers it today.
- Q2 `MemoryStatus.prefetch` cannot say "begun but waiting for a place" without the lane exposing
  `PreRun.waiting`; and an `on` on the lane's agent{recall} events would make the REPL's snapshot needless.
- Q3 Not built: `/memory recall test <text>` (demo G9; not in D-206), start offsets on `Trace.calls` (G10).

## Tests

`TMPDIR=… bun test test/repl test/repl-m5a test/repl-m5b test/repl-m5c test/tui test/cli test/demo-m5b`:
859 pass, 0 fail. `bunx tsc --noEmit -p .` clean. Not run (rule): `test/lane-m5b`, `test/recall-engine-m5c`
(session.ts's memoryStatus/memoryWait now add `prefetch`; absent under the preload's lexical default, and
the recall-engine tests do not read the status), `test/demo-*` other than m5b.

## After the review (fix-cli, the lead's ruling K)

Files: `src/cli/{repl,repl-render,repl-journal,chat,main,provider}.ts`; tests `test/repl-m5c/{commands,flows,kit}`,
`test/repl/kit.ts`, `test/cli/{kit,replay-m5c,script-recall-m5c}`; two assertions outside (below).

- **cli#3** `ReplDeps.lane?: 'auto'|'manual'` (default RP_CORE_LANE as Engine.open reads it; chatDeps passes
  `a.engine.lane` when a caller set it; test/repl/kit.ts passes `engine.lane`, test/repl-m5c/kit.ts its
  `lane`). `RecallModeFacts.lane`; `recallRunsAs(facts)` (exported) mirrors turn.ts decideRecall: a manual
  lane never prefetches, auto on a local server and prefetch act as on_miss. `/memory mode` then says
  `here: no prefetch: the lane is manual (RP_CORE_LANE), so compendium.recall.on_miss decides each reply:
  <lexical|sync words>` (unknown locality: both halves); `/memory profile`'s recall row says `not running:
  recall mode auto, but the lane is manual (RP_CORE_LANE): no prefetch, and on_miss gives lexical` when it
  comes to lexical. `chat --help`: "with RP_CORE_LANE=manual it never prefetches (auto on a local server and
  prefetch act as on_miss)". One-shot commands print no recall-mode text (nothing to change).
- **cli#6** `lanePrefetchLine(ev, pre, words, now?)`: for `preempted`, `now = {again, answer}` read when the
  line is shown (REPL `prefetchStanding`: the lane's current prefetch has the same basis; the answer it
  followed is the last answer on the path / earlier on it / off it). Same basis: the old line ("runs again
  at the next pause"); else `… gave way to a turn and was dropped: that answer was replaced (a swipe, a regen
  or a rewind)` / `the story went on past that answer` / `that answer changed (a continue or an edit), so a
  prefetch after it starts over`. Without `now` (other callers) the old line.
- **cli#9** The card: `1 call in the background, without the player's message` (true whether the prefetch
  ended before the message or the reply waited for it; RecallRecord has no "waited" field). The lane's
  `done` line for a prefetch the last answer on the path adopted (its record: source prefetch, basis = the
  line's `on`) is not printed after that answer (`adoptedByLastAnswer`); the turn already said `⋯ recall:
  adopted (n)`. A `done` that arrives before the message prints as before.
- **cli#10** `/memory status` of a held `skipped` prefetch: `recall: the prefetch after #1 skipped [code]:
  <the code's words>; the next reply goes without recall (lexical)` (the turn adopts a skipped record and
  reads no on_miss). `failed` keeps `… the next reply falls back (compendium.recall.on_miss)`.
- **breaker#5** `/trace`'s recall line reads `traceRecall(j, id)` (repl-journal.ts): the record of the entry
  whose trace `latestTrace` shows (its newest continue with a trace, else the message); none → the trace's
  compendium source (`lexical (no recall call; …)` / `off`). `/memory recall` keeps `effectiveRecall` (the
  answer-wide newest record).
- **sched#4 (CLI part)** `ReplDeps.override.recallDefault?: 'lexical'|'off'` (chat.ts overrideOf:
  engine.ts `scriptRecallDefault(conn)`); `RecallModeFacts.from` gains `'script'`: `recall mode: lexical
  (the --provider script tags no line "agent": "recall")`. Order as the engine's: ReplDeps.recallDefault
  (its 'auto' = nothing replaces) › RP_CORE_RECALL › the script. PROVIDER_HELP: "a script with no line
  {"agent": "recall", ...} makes no recall calls (lexical) unless a recall mode is set".
- **sched#2** `replayConnection`'s provider has a `localOrigin` getter: `connectionLocality` over config.toml's
  connections at the recorded connection's origin (the first recorded call whose connection config.toml
  has), undefined without one (remote, as before). routeOf and the scheduler agree with the recording.
- Outside my dirs, by the lead's word: `test/demo-m5a/lantern.test.ts` and `test/demo-m5b/lantern.test.ts`
  spawn every CLI with RP_CORE_RECALL removed (`test/cli/kit.ts` spawnCli drops a variable set to
  undefined); `test/demo-m5c/lantern.test.ts` 3b's card assertion takes the cli#9 wording.
- Docs not touched (not my files): docs/M5C-DEMO.md lines 38 and 427 still quote `in the background, before
  the player's message`; M5A/M5B-DEMO.md need no RP_CORE_RECALL now.
