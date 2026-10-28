# M5b decisions (the lead's design note; authoritative for the M5b build)

M5b = "Compendium agents": the filing agent, the historian and the `{{recap}}` slot, the background lane
and the scheduler, `/memory undo|refile|retry` (ARCHITECTURE.md §15 M5b, §7.4.3, §7.4.4, §7.4.6, §7.4.7,
§7.4.9, §19.7; D-37, D-58, D-68, D-74…D-89; M5a's D-140…D-169 and `.notes/m5a-decisions.md`). The spec is
the base; where it is silent, contradicts itself or was overtaken by M5a, THIS note decides. Every D-1xx
here becomes a numbered decision in ARCHITECTURE.md rev 17 (question 25: confirm as a batch).
Research (read the parts your task names): `<session scratchpad>/m5b/understand/` (the lead gives the
absolute path): `design.md` (spec digest; gaps G-1…G-28, contradictions C-1…C-13), `bunraku.md` (+
`bunraku-rendered.txt`: Bunraku's prompts rendered, the golden texts), `rolecall.md` (+ `rc-vectors.ts`),
`rpcore.md` (insertion points), `demo.md` (+ `demo-draft/story.json`).

Sources: Bunraku `~/Documents/AI/Bunraku` @ `702d8120` (Coneja-Chibi); RoleCall `~/ST/VAUDEVILLE/apps/rc`
@ `fb8dc623e` (authors per rolecall.md §1; the 660a7d67a caveat where it says so). Headers as in M4/M5a.
Public repo: no e-mail addresses, the author is named only as Levi, no absolute home or scratchpad paths.
Agents: run only your own tests (`TMPDIR=~/.cache`), never the full suite; remove every temp dir you make;
no file over 5 MB.

## A. Scope

**D-170 Scope and module map.** M5b ships the tasks `file` and `hist`; `prerecall` and waiting for a
prefetch in flight come with recall in M5c (C-10). New: `engine/lane.ts` (the session's background lane),
`agents/compendium/filing.ts` (prompt, snapshot/roster, lenient read, staging), `agents/compendium/
historian.ts` (triggers, watermark, window, prompt, read, apply), `agents/compendium/recap.ts` (the slot).
Changed: `engine/sched.ts` (priorities, preemption, local-origin rule, idle gate), `engine/abort.ts`,
`engine/narrate.ts` and `agents/structured.ts` (priority, preemption reported), `agents/compendium/apply.ts`
(G-1, TaskState), `library.ts` (library arcs), `session/tree.ts` (job rows), `engine/session.ts`,
`request.ts`, `prompt/assemble.ts` (slot), CLI and TUI, config. Ollama runner-option mirroring,
`ollama_options_mismatch`, `lmstudio_autoevict`, `id_slot` and `history_crowded` are M5c (G-22).

## B. Lane and scheduler

**D-171 The lane.** One lane per open session, in process; one task at a time, background priority. The
work is DERIVED, never a cursor: after every commit, head move, edit, hide, config change, verb and at
open, the lane recomputes the debt from the path and the fold (`view.compendium.tasks` + coverage).
- *Accepted answer* (G-3): an assistant message on the active path, not hidden, not the opening greeting
  (path position 1 before any user message — card material, not filed; listed deviation from Bunraku),
  with ≥ `filing.wait` visible user messages after it on the path (`wait = 0`: committed).
- *Enable moment* (C-11, G-26): only answers whose `msg` seq is after the moment the Compendium became
  enabled count: the header if it was created enabled, else the newest `config` entry that turned
  `compendium.enabled` on. A fork's moment is the fork's own creation (its copied rows cover what the source
  filed; the rest is not back-filled). `enabled: false` → no lane at all.
- *Coverage*: an answer is covered by a non-stale filing row whose `range` contains it, or by a reverted
  key whose reverted row is not stale (D-74: staleness re-writes even after undo).
- *Grouping* (`everyN`, G-4): uncovered accepted answers in path order; consecutive ones group by N; a
  covered or hidden answer between them ends the group (the part before is its own task). A group with
  fewer than N answers waits. Key `file:<last answer id>`, `on` = that answer, `range` = [the first user
  message of the group (else the first answer), the last answer].
- *Order*: file tasks oldest first, then one historian check (D-175). A starved task (D-172) goes first.
- *Job rows*: `job{begin, attempt}` before the call; then the `mem` row, or `job{failed, code}`.
  Preemption writes nothing more (the begin stays; recovery re-queues it) and is not an attempt: the next
  begin has the same attempt number. Job id `j_<8 hex>` from the engine's random; callKey
  `<jobId>:filing:0` / `<jobId>:historian:0`. `--keep-requests` covers lane requests too.
- *Parking*: `maxAttempts` (3) `job{failed}` rows for a key since its newest `mem` row or `job{retry}`
  row → parked until `/memory retry`. `JobEntry.state` gains `'retry'` (G-8; written by the verb).
- *Recovery at open*: rule 1 = a `job{begin}` with no `mem` row of the same key AFTER it and no later
  `failed` → re-queued with the same attempt (C-6); rule 2 = the derived debt; rule 3 = parked stays parked.
- *Close*: `close()` aborts a running lane call with `shutdown` (writes nothing; the begin re-runs at the
  next open). A piped or one-shot CLI does not wait for the lane (G-7): `/memory wait` does.
- *Events*: `agent{agent:'filing'|'historian', job, status: queued|started|preempted|done|failed|parked,
  count?, skipped?, code?}`; one `memory{change, ref: key, kind, name, by:'filing'|'historian'}` per entry
  the row really changed (effects of the row, minus no-op merges); `idle{background: n}` whenever the
  number of queued + running tasks changes (n = that number).
- *Notices* (session bus; the REPL prints them, G-20): `memory_backlog` when uncovered accepted answers
  exceed `everyN + 3` (C-1), once per session; `memory_starved` (D-172) once per session;
  `filing_classic_conflict` once per name per session; `slots_shared` once per session when two
  connections the session uses resolve to one origin (G-21).
- *Mode* (tests and demos): `EngineOptions.lane?: 'auto' | 'manual'` (default `auto`). `manual` never
  starts a task by itself; `SessionHandle.memoryWait({timeoutMs?})` runs/awaits the lane until it is idle
  (in `auto` it only waits). The CLI reads `RP_CORE_LANE=auto|manual` (default auto); `test/preload.ts`
  sets `manual`, so pre-M5b scripted tests and spawned CLIs see no filing calls; M5b tests opt in.

**D-172 The scheduler (D-37, D-84).** `acquire(priority: 'interactive' | 'background', signal, opts)`.
- Interactive = narrator, Director, recall-sync, `draft`; background = filing, historian (prerecall M5c).
- Preemption: when all places of an origin are busy and one is held by background, an interactive request
  aborts the most recent background holder with `preempted`. On a LOCAL origin (`isLocalOrigin`,
  providers/http.ts) an interactive request preempts background even with a free place, and background
  starts only when the origin has no interactive request in flight or queued AND the origin's idle gate
  is open. Remote origins run background alongside while places are free.
- Idle gate (G-5): per origin, in the scheduler (shared by sessions on that server); `touch(origin)` on
  turn end, head move, edit, hide, continue, swipe and session open; background waits until
  `idleDelaySec` (the requesting session's) has passed since the last touch. `idleDelaySec = 0` → no wait.
- Starvation: preemptions counted per task key; 3 in a row → the task goes first at the next pause and
  `memory_starved` once per session; a completed attempt (done or failed) resets the count.
- `streamCall`/`structuredCall` take `priority`; a preempted call ends with code `preempted` (distinct
  from `timeout`/`aborted`). New abort reasons `budget:filing` and `budget:historian` (C-12, G-27).
- The scripted provider (`script:`) is a remote origin.

## C. Filing

**D-173 Filing prompts (D-88 parity).** Full = Bunraku `filingMessages` verbatim with the spec's three edits
plus two consequences of edit 1 (C-8), all listed in COMPENDIUM-DEVIATIONS: (1) the books list → «You
write into this story's Compendium. Entries marked (library) can be added to; your additions apply to this
story only.»; (2) RoleCall's nested forms of `character.relationships|memories|current_state` (NESTED) in
the field list, memory example `{"what_happened":"…","changed_belief":"…"}`; (3) the snapshot also shows
readable books' typed entries marked `(library)`; (4) the ANSWER FORMAT example drops `"book"`; (5) the
guidance header drops "change the books you may use". Golden test: the rendered full prompt equals
`bunraku-rendered.txt`'s except exactly these lines (render both with the same `allow` list).
Lite = a new text (D-79): the rule paragraphs verbatim (UPSERT, NO-WRITE DEFAULT, DEDUP with its line
shape changed to the roster's `Name (aka: …) [type]` (C-7), WRITE ONLY WHAT MATTERS, RELATIONSHIPS,
guidance, language), `LITE_FIELDS` with NESTED forms and enum values plus «Other fields of the type are
kept if you send them.», «At most 6 items.». The repair is structuredCall's corrective pass for every
agent (one mechanism; listed deviation from Bunraku's `repairMessages`, C-3).

**D-174 Snapshot, roster, user text, budgets.**
- Full snapshot: one line per live typed entry `Name (aka: a, b) - tagline [N chars - add to it, do not
  rewrite]`, grouped `### This story` then `### <book name> (library)` per readable book, then by type
  label; summaries and resolved/failed/abandoned plots left out; capped at min(30 000, 30 % of the agent
  window) tokens, overflow `(+N more entries not shown)`.
- Lite roster (G-13): ≤ 60 lines `Name (aka: …) [type]` (+ ` (library)`): first the entries mentioned in
  the exchange texts (mention.ts), then those named in `castNames`, then by larger `prov.lastSeq`
  (library: higher `order`); plus up to 4 mentioned entries as brief JSON (identity field, the LITE_FIELDS
  it has, the last 3 memories).
- User text: N = 1 is Bunraku's exactly («The narrator just wrote this reply:\n\n<reply>», «\n\nThe reply
  answers:\n<player messages>», «\n\nFile anything that meets the rules above.»). N > 1: «The narrator just
  wrote these replies, oldest first:» + `[k] <reply>` blocks, then «They answer:» + `[k] <player text>`,
  then the same last line. Hidden messages are left out. Cuts head+tail: a reply ≤ 8 000 / 6 000 chars, a
  player message ≤ 4 000 (listed deviation: Bunraku cuts the head only); with N > 1 the texts share what
  the budget leaves, newest first, a reply ≥ 1 000.
- Budget: full = the whole request ≤ agent window − 4 096 (the answer), else the call runs lite (as the
  Director's D-121); lite ≤ 45 % of the window. A group that still does not fit splits by halves (each part
  keyed by its last answer).
- Profile by the RECORDER's window (`compendiumProfile(cfg.profile, recorderWindow)`).
- temperature 0.3; maxTokens 4 096 / 1 500; `filing.timeoutSec` from the grant (300 local / 120 remote).

**D-175 Lenient read and staging (D-82, D-87).** As §7.4.3 and D-82: envelopes, item forms, ru/en type
synonyms, camelCase → snake_case, kind coercions, enums lower-cased with spaces/hyphens → `_`, `event` →
`what_happened`; a wrong field goes to `skipped` and the item stays; a memory with neither non-blank
`changed_belief` nor `changed_behavior` and a relationship without `with` are dropped (that element only,
with a `skipped` line); model-sent service fields (`writer_source`, `source_turn`, `source_job_id`,
`turn_range`, `messages_covered`) are stripped. Items past 12 / 6 → `skipped` (`over_limit`); an item over
6 000 / 3 000 chars JSON or deeper than 6 → rejected with the reason; ops past 24 000 chars per row → the
tail goes to `skipped`. Staging against the fold at the group's last answer: findMatch → classic name →
`skipped: classic_conflict` (+ notice) → merge into a working copy (two items about one entity become one
delta) → required fields after the merge → a merge that changes nothing is dropped. The row holds the
verified deltas (agent rows have no `target`). An empty result is still written (`ops: []`).

## D. Historian and the slot

**D-176 Historian.** Checked after each accepted answer's filing (or alone when filing is off); never reads
past the last accepted answer. `historian.interval = 0` turns the historian off (C-2; BR and the migration
rule agree); otherwise either trigger fires:
- ≥ `interval` player turns on the path after the watermark;
- ≥ `recapAfter` path messages after the watermark that the newest committed answer's trace trimmed.
Watermark = the end of the covered PREFIX of the path: positions covered by non-stale historian rows'
ranges (reverted included) from the start; a hole left by staleness is the next window (G-4 historian).
Window = from the watermark + 1 (new) back `overlap` messages (10 full / 6 lite), forward until min(12 000,
35 % of the recorder window) tokens; the overlap takes at most a third of that cap and at least one new
message is always included (fixes Bunraku's Q1). Visible messages only; each line `[<path position>]
<role>: <text>` with D-58's 1-based positions (listed deviation from Bunraku's 0-based live index, C-4).
Full prompt = Bunraku `historianMessages` verbatim with those numbers; lite = the same text with «At most 6
filings.» and «Keep each overview under 1 200 characters.» (new text, listed). Digest: every non-resolved
plot (full) / the 6 most recently active (lite). Apply as §7.4.4: types summary and plot; a summary needs
`parent_plot` (else that item is skipped); `range`/`messages_covered` set by code; a missing plot is created;
an arc only for plots this run's summaries name; summary text cut to 1 500 chars and overviews to 6 000 /
1 200 with '…' (listed). Row `mem{key:'hist:<newFromId>-<toId>', on: toId, by:'historian', range:[newFromId,
toId], ops}`; temperature 0.3; maxTokens 4 096 / 1 500; timeout = `filing.timeoutSec`.

**D-177 Library `[Arc]` entries (G-9, C-9).** An enabled library entry with `meta.arc` in a `'read'` book is
seeded as an arc CEntry (origin library, key `lib:<book>:<id>`, `arc` = its plot name, `content` = its text)
and routed out of the lore engine; in the slot it is always eligible (inside the arc half, after session
arcs). Books set `'off'` or the Compendium off: plain lore as before. Lore entries with `position:'recap'`
stay where M2 put them (before the chat area) in M5b (G-10).

**D-178 The `{{recap}}` slot (D-83).** Only when it has content; otherwise nothing is reserved and requests
stay byte-identical (G-12). Budget ≤ 10 % of the window, taken from the history share. Content, in order:
1. arc overviews: session arcs whose plot has a summary touching the trimmed part, newest activity
   (`prov.lastSeq`) first, then library arcs; together ≤ half the slot; lite: ≤ 2 overviews of ≤ 1 200 chars;
   text `[Arc] <plot>\n<overview>`;
2. summaries whose range touches or precedes the trim boundary (the trimmed span `trace.trimmed`), oldest to
   newest, `[Summary: <title>]\n<summary>`; the oldest drop first when over.
One system message, `src: 'recap'`, at the trim point of `{{history}}` (after the greeting when nothing is
trimmed); no macro expansion. Stability: the previous request's `trace.recap` comes from the nearest
ancestor reply (as freshness, D-152); while `boundary` (the first visible message id) is unchanged, the same
ids and the same arc revisions render (rev = `prov.lastSeq`; an older revision's text is read back from the
op of the row with that seq), minus ids no longer live. Keys in the slot are the block's `inPrompt`.
`/preview --turn` rebuilds it. Compendium off → no slot.

## E. Fold, verbs, UI

**D-179 Human ops wait for their entry (G-1).** In the fold, a key-addressed human op (`edit`, `retire`,
`restore`) whose key does not exist yet is held and applied right after the entry with that key is created
(in seq order among held ops); one that never meets its entry stays a `not_found` issue. So a refile or a
re-write after staleness, which re-creates an agent entry at a later seq, keeps the person's edits.
`TaskState` gains `stale?: true` for a reverted key whose reverted row is stale and `range` of the row the
status is about (G-2). `TreeIndex.jobs` indexes job rows by key.

**D-180 Verbs.** `memoryUndo({messageId, task?})` writes `revert` for the filing and historian rows whose
`on` is the message (or whose range holds it, filing first), unless `task` picks one; `memoryRefile(
{messageId, task?})` queues the same key again (a never-filed accepted message queues its normal task);
`memoryRetry({messageId?})` writes `job{state:'retry'}` for the parked key(s) and queues them;
`memoryWait({timeoutMs?})`; `memoryStatus()` → `{queued, running?, parked: {key, on, failures}[],
backlog}`. Refusals as D-159 (session_busy during a turn, dry run, changed:false). `memory{change:
'reverted'}` per entry the reverted row had changed.

**D-181 UI.** REPL: `/memory undo <ref|#n> [file|hist]`, `/memory refile …`, `/memory retry [#n]`,
`/memory wait [sec]`, `/memory status`; lane events print as dim lines between turns (`⋯ memory: filing #7
→ +2: C12 "Фрол", C3 "Серый маяк"`), notices as `! …`. `/memory show` gives agent provenance ("filed by
filing from #7"). TUI: the agents pane already folds `agent`/`memory` events; filing and historian get their
blocks (D-128). `rp-core sessions` is unchanged.

**D-182 Config.** All keys are parsed already (D-158); M5b reads `filing.*`, `historian.*` (`interval 0` =
off), `maxAttempts`, `idleDelaySec`, `guidance`, `language`, `profile`. The seed tool
(`tools/fixtures/seed-innkeeper.ts`) gains `--compendium off|on` (default off) so a seeded 199-message chat
does not open with 99 filing tasks.

## F. Build plan

Wave 1 (parallel): infra (sched, abort, narrate/structured priority + preempted), filing (pure), historian +
recap (pure), fold (apply.ts D-179, TaskState, library arcs, tree job index, JobEntry 'retry' guard).
Wave 2: lane + engine wiring (lane.ts, session.ts recovery/verbs/events/notices, request/assemble slot,
trace.recap, preview --turn, EngineOptions.lane, test preload `RP_CORE_LANE`). Wave 3: CLI/TUI, seed tool,
the deterministic demo (test/demo-m5b, docs/M5B-DEMO.md). Then the live run, review, fixes, verification,
docs (ARCHITECTURE rev 17, README, COMPENDIUM-DEVIATIONS rows), commit.

## G. Rulings after wave 1 (the lead)

- `{}` (an object with no known envelope and no item shape) reads as "nothing to file" (D-82 spirit), not
  as unreadable. structuredCall accepts an array root for the `tag: null` agents (filing, historian): the
  reader decides.
- The historian reader maps summary significance `critical` → `pivotal` (RoleCall's word).
- The historian starts at the enable moment too (D-171): positions before it count as covered, so turning
  the Compendium on in a long chat does not summarise the past. A session created enabled covers all.
- Prompt numbers are written without separators: «1200 characters».
- The digest and the filing snapshot leave out plots whose status is resolved, failed or abandoned.
- A session arc and a library arc of the same plot (normalizeName): the slot shows the session arc only.
  `search_lore` labels a library arc `arc, <book>`.
- Memory events compare each touched entry before and after the row (a refile's effects say `created`
  for entries that existed): one `memory` event per entry whose data, name or state really changed.
- The scheduler: the idle gate is local-only; the end of every interactive request on a local origin is a
  touch; locality comes from `isLocalOrigin`; the starvation count lives in the lane (sched exports
  `STARVED_AFTER = 3`). `engine.ts` passes the engine's timers to `createScheduler`.
- `EngineOptions.lane` defaults to `'manual'` when `process.env.RP_CORE_LANE === 'manual'` (read once in
  `createEngine`), else `'auto'`; `test/preload.ts` sets it, spawned CLIs inherit it.
- Filing's `create_plot` in historian summaries (RoleCall) is honoured: a listed deviation from Bunraku.

## H. Rulings after wave 2 (the lead)

- A fork's enable moment sits just before its fork-point answer: an answer not yet accepted when the fork
  was made is filed once it is accepted on the fork.
- One-shot commands (`rp-core send` and the like) open the engine with lane `manual`: they never start a
  task they cannot finish.
- An empty slot records an empty `trace.recap` and does not pin: new slot content appears at the next
  request even when the cut has not moved (one cache break, accepted for simplicity).
- `/preview --turn` names a changed slot "the {{recap}} slot".
- Refile is not journaled (it lasts while the session is open); refiling a parked key is refused —
  `/memory retry` queues it. A task that can never fit (`no_room`) writes begin + failed and parks.
- The lane stages a refile against the fold at its message WITHOUT the key's own rows (else its items
  would read as no-ops).
- Switching a book from `'off'` to `'read'` mid-session does not move a pinned slot (its arcs wait for the
  cut to move): accepted.

## I. Rulings after the review and the live run (the lead)

**D-183 Language line.** When `compendium.language` is blank, filing and historian end with «Write every
field value in the language the story is written in.» (the live run's 12B historian wrote English summaries
of a Russian story; Bunraku adds nothing when blank — listed deviation, like the Director's D-120).

**D-184 The fold applies rows in story order (review lane#2).** Each row gets an anchor: an agent row →
the path position of its `on`; a human row → the path position of the newest path message whose seq is
below the row's (0 when none). Rows apply by (anchor, seq). So a re-write of an old answer (staleness,
refile, a recovered begin) lands where its answer is in the story, never after later answers, and a
person's edit still lands after the passes of the messages before it. Checkpoints resume on the sorted
order's prefix. Filtering (path, staleness, newest action per key) is unchanged.

**Fold cost (review breaker#2).** A 300-message chat with real filing rows must fold from scratch in
≤ 300 ms and incrementally in ≤ 30 ms; every send/turn/open must not refold from scratch. Profile it; fix
what costs (the near-duplicate collapse may compare only the new or reworded strings against the list).

**The lane.**
- A task asked for by name (refile, retry, recovered) runs only while its agent is on; with the agent off
  it is held, never begun. A run superseded with no progress is never re-begun in the same look.
- Recovery rule 1 is a hint: a dangling `begin` is re-queued (same attempt) only when its key is in the
  derived debt now; begins of superseded windows and covered answers are dropped.
- Stale rows are debt whatever the enable moment (an edit of an old message re-files it after
  /memory off+on and on forks).
- A split group's parts are tasks at once (each keyed by its last answer).
- A fork's enable moment sits before the earliest answer that was not yet accepted at the fork point
  (covers `wait ≥ 2`).
- Historian keys: a parked or recovered historian key whose window is now covered or no longer due is
  dropped; preemptions are counted per agent for the historian (its key moves), per key for filing.
- `memoryRetry` of a parked key that is not derived (a parked refile) queues it as a named task;
  `memoryRefile` refuses a hidden, not-yet-accepted or Compendium-off target in words; the undo binds
  to the effective row whose range holds the message (filing first); the undo line's hint names the pass
  (`/memory refile #n file`).
- `no_room` writes one begin + failed (`code: no_room`) and parks at once; a message too large for the
  historian's window is cut head+tail to fit instead of parking the historian.
- A failed attempt waits before the next one: 15 s × 2^(attempt−1), at most 5 min (auto mode; manual
  `memoryWait` ignores the wait).
- The lane does not start a task while its own session's turn runs, nor while the head is a user message
  younger than max(idleDelaySec, 2 s) (a `send` followed by `runTurn`) — deviation from §7.4.7's cloud row
  ("filing A(n−1) starts at send"), listed: on cloud the pass waits for the turn's end. `memoryWait` in
  auto mode only waits.
- Events: `started` on the slot grant; a superseded run ends with `agent{status:'skipped', reason:
  'superseded'}`; entries a refile or undo removed get `memory{change:'reverted'}`; `done.skipped` is the
  true count. Lane calls are counted in /usage and the TUI usage block. An unresolvable recorder gives
  `notice{recorder_unavailable}` once.
- A background call's budget runs only while it holds a slot (a §6.6 retry waiting behind a turn is not
  timed).
**The agents.**
- A cut-off answer (finish `length`): complete items are kept, the incomplete last one dropped; with no
  complete item the attempt fails (never an empty cover). `{"filings": null}`, `"none"`, `[]` read as
  nothing.
- Readers never throw on prototype keys; free-form map keys (e.g. `stakes_per_character`) are not
  renamed; a typeless list element is not reread as a type-keyed item; an item's `entry_type`/`type` at
  the item level wins over a `type` field inside its entry data.
- A historian answer whose summaries were all refused fails the attempt (it does not close the window);
  an empty answer still closes it.
- The lite filing prompt says the roster was left out for room instead of claiming an empty Compendium.
- Arcs: the plot is resolved through plot names and aliases (findMatch) before keying; the slot's pinned
  revision is the seq of the last row that changed the overview text, dropped when that row is no longer
  effective (undo, staleness) or after a fork renumbered it (the row with that seq must hold an op for
  the key); a pin applies only under the same profile and slot budget; full-profile overviews are cut
  head-first to fit the arc half.

## J. After the second live run (the lead)

**D-183 amended.** With the line «Write every field value in the language the story is written in.» the
live 12B historian still answered a Russian story in English. So when `compendium.language` is blank the
lane NAMES the story's language when the texts' dominant script tells it (`agents/compendium/
language.ts storyLanguage`: Cyrillic → Russian, or Ukrainian/Belarusian/Serbian/Macedonian by their own
letters; Greek, Japanese, Chinese, Korean, Arabic, Hebrew, Thai; Latin or mixed → nothing, the generic
line stays), and a named language (configured or detected) is ALSO the user message's last line
(«Write every field value in Russian.»), for filing and the historian. A blank, undetected language keeps
Bunraku's user text exactly. Listed deviation.

## K. Rulings after the final check (the lead)

- **Staging matches the fold (order#1).** A pass stages against exactly what the fold applies before its
  row: the head path's rows whose (anchor, kind, seq) sorts before it (apply.ts exports the anchor/order
  so the lane cannot drift from it), without the key's own rows.
- **Ties (order#2).** Rows sort by (anchor, kind, seq) with agent rows before human rows at the same
  anchor: a person's edit made while answer n was the head wins over any pass or re-write of answer n.
- **Handles (order#3, amends D-150).** `C<n>` numbers library entries first (seed order), then session
  entries by the seq of the row that created them (then op index), not by fold order; a lagging pass never
  takes the number of an entry a person made earlier. Retired entries keep their numbers.
- **Dry runs** fold without recording checkpoints (order#4).
- **Splits survive a reopen (lane#5).** The first part's mem row records `groupEnd: <last answer id of the
  whole group>`; the derivation turns the uncovered answers up to `groupEnd` after it into a task at once.
- **Parked keys are re-validated** like recovered ones: a parked filing key whose answers are now covered
  or hidden, or a parked historian window now covered, is dropped (lane#1 regression, cli#1).
- **Circuit breaker (cli#1).** When two tasks of one agent park in a row, that agent pauses: no new task
  of it starts until `/memory retry` or the next open; `notice{memory_paused}` once; `/memory status`
  shows it. `MemoryStatus.blocked?: {agent, reason}` also reports a recorder with no route (cli#9).
- **Refile (lane#2 regression).** `/memory refile #n` with no task refiles every pass bound to #n AND
  queues filing for #n when it is accepted and no filing row covers it.
- **The slot.** assemble passes the slot's real share to both slot choices; the second choice keeps the
  view's effects; `trace.recap` records `profile` and `share` (optional fields), and a pin applies only
  when both are unchanged; a pinned revision must be an arc-text op of that key in the row with that seq.
- **Arcs follow renamed plots.** An `arc` op resolves its plot through plot names, aliases and former
  names, and reuses the arc entry whose `arc` answers to any of them (renaming it to the current name).
- **Cut-off answers.** A historian answer that applies no summary while it was cut off, or offered
  summaries, fails the attempt; a cut-off answer whose root was a bare flat item is unreadable; the row
  and the done event record `cut_off` in `skipped`.
- **Words.** Refile/retry refusals name passes as the lane lines do ('filing #3'), never raw keys.
- **Notices.** `recorder_unavailable` also for a historian-only setup.
- **Accepted, documented.** Calls of a superseded or preempted run are not journaled, so /usage leaves
  them out (the bus reported them).
