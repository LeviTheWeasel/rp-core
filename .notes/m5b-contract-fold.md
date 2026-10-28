# M5b wave 1 — fold (D-179, D-177's seeding, the job index)

Builder: fold. Files: `src/agents/compendium/apply.ts`, `src/agents/compendium/library.ts`,
`src/session/tree.ts` (fold.ts unchanged). Nothing ported (no provenance note). Tests: new
`test/memory/fold-m5b.test.ts` (16), `test/memory/fold-m5b-library.test.ts` (8); M5a tests updated (below).

## Exported API

No signature changed except one new export and one new TreeIndex field.

```ts
// apply.ts (unchanged signature; behaviour below)
foldCompendium(rows: readonly MemEntry[], opts: FoldOptions): CompendiumView

// library.ts — new
isLibraryArc(e: LoreEntry): boolean
// unchanged signatures, wider scope: librarySeed(sources, cfg): LibrarySeed; routeBooks(sources, cfg): LoreSource[]

// session/tree.ts — new field, filled by buildTree
interface TreeIndex { …; jobs: Map<string, JobEntry[]> }   // task key → its job rows, seq order
```

`TaskState` (types.ts, the lead's) already had `stale?: true` and `range?`; the fold now fills them.
`JobEntry.state: 'retry'` and its guard were already in entries.ts (the lead's).

## Behaviour

### D-179 held ops (apply.ts `hold` / `release`)
- Held: an `edit` / `retire` / `restore` op of a HUMAN row (`key === null`) whose `ref` is a session key
  (matches `note:|arc:|<type>:` — `KEY_SHAPED` — and does not start with `lib:`) that no entry has at that
  point of the fold. A `C<n>` or a name resolves at once as before (not_found if nothing); a missing `lib:`
  key is `library_entry_missing` at once as before; ops in agent rows are never held.
- Released right after the op whose `insert` created that key (not after the whole row), per key in seq
  order (then op index). Held ops create nothing, so a release never cascades.
- Never met → issue `{seq, op, why:'not_found'}` (no `key`), the same shape as before.
- This applies to note keys too: a hand-written edit of `note:x` before the row that creates the note now
  applies after it (the M5a test pinning the opposite was changed, see below).
- Checkpoints: `FoldState.held` is copied with the state, so a resumed fold equals a fold from the seed
  (tested across the 2 048-row checkpoint).

Consequences the readers must know:
- `issues` are now always sorted by (seq, op) (stable sort, only when out of order).
- `effects` are in APPLICATION order: a held op's effect carries its own (older) seq and comes right after
  the effect of the op that created its entry. Filtering effects by a row's seq still gives that row's
  effects (session.ts `rowEffect` is unaffected: a verb's row targets a key that exists).
- `prov.lastSeq` after a held op = the held row's seq (the last op applied in fold order). It can be smaller
  than `createdSeq`. Chosen on purpose: the text an arc shows is the text of the row `lastSeq` names (the
  recap's revision read-back stays right). Ranking by lastSeq sees the human edit's seq, not the refile's.
- A refile / re-write still re-creates the entry at the END of the Map (handles after it shift, G-25).
- Keys are allocated deterministically, so a held op on `character:x#2` meets whatever entry gets `#2` on
  this fold (rare: two same-named entities and a re-ordering).

### TaskState (selectRows)
Let R = newest revert of K on the path, F = newest fresh row of K, A = newest row of K (any).
- R exists and (no F or R ≥ F.seq):
  - A newer than R (then A is stale: a refile after the undo, edited since) → `{seq: A.seq, status:'stale', range: A.range}`;
  - else `{seq: R, status:'reverted', range: A.range}` + `stale: true` when A is stale (A ≠ F).
    A = "the reverted row" = the newest row of K before the revert. No row at all → no range, no flag.
- else F → `{seq: F.seq, status:'applied', range: F.range}` (the applied row's, even when a newer row is stale);
- else `{seq: A.seq, status:'stale', range: A.range}`.
`superseded` is still never produced.

### Library [Arc] overviews (D-177, library.ts)
- `isLibraryArc(e)`: `meta.arc` is a string whose `normalizeName` is not '' AND `e.content` is non-blank.
  Typed or not (meta.arc wins: such an entry was neither typed nor classic in M5a). A blank plot or a
  blank text stays plain lore (as in M5a) and is never a classic name.
- Seeded (enabled ones, readable books, Compendium on) in BOOK ORDER among the typed entries, key
  `lib:<book>:<id>` (a repeated key keeps the first):
  `{key, type:null, name: plot, aliases:[], tagline:'', data:{}, keys:[], content: e.content, arc: plot,
  origin:{kind:'library', book, id, overlay:false}, order: e.order ?? 100, featured?: meta.featured===true,
  prov:{created:null, lastSeq:0, appended:{}, createdSeq:0}}` (plot = meta.arc trimmed). No `constant`,
  `secondary`, `logic`.
- `routeBooks` removes them (disabled ones too, like typed entries). `'off'` books, `'@'` books and a
  disabled Compendium: nothing seeded, nothing routed (plain lore, as before).
- The fold treats them like session arcs: `edit set.content|overview` replaces the overview and makes it
  an overlay; `set.name|title` → invalid; retire/restore work. `isNote` is false; the selector skips them
  (type null + arc); `search_lore` lists them as `C<n> <plot> (arc)`; `read_lore` renders `# [Arc] <plot>`.
- `LibrarySeed.hash` is unchanged (it already hashed every entry of the book).

### TreeIndex.jobs (tree.ts)
Every `job` row by `key`, each list in seq order (begin, failed, retry), all branches (not path-filtered),
not part of the tree or `version`. `foldViewAt` spreads the index, so it keeps `jobs`.

## Open questions for the lead
1. An `arc` op on a plot that has a LIBRARY arc creates a session `arc:<plot>` beside it (applyArc only
   looks for `arc:` keys); the slot could then show two overviews of one plot. Overlay the library arc
   instead (the typed-entry rule), or let the recap builder prefer the session arc? Not changed here.
2. `search_lore` labels a library arc `arc`, not `arc, <book>` (tools/builtin/lore.ts, type-null branch).
3. docs/M5A-DEMO.md records the M5a run (C16 Мира, "15 Compendium entries", "Narrative · 1"); the run now
   gives C17, 16, "Narrative · 2" with `C16 [Arc] Украденный свет`. Left as the M5a record; your call.
4. Between waves: library `[Arc]` overviews have left the lore engine but the `{{recap}}` slot (wave 2)
   is not wired yet, so they reach no prompt until it is.

## What the lane builder (wave 2) must know
- Coverage straight off `view.compendium.tasks`: an answer is covered when a key's state is `applied`, or
  `reverted` without `stale`, and its `range` (path ids) holds the answer. `stale`, or `reverted` +
  `stale`, is debt (re-file the key). A key the path never saw is absent. `reverted` without a range (a
  revert of a key never filed) covers nothing by range.
- Job rows: `tree.jobs.get(key)` (seq order). Parking: count `state:'failed'` rows with seq after
  max(newest `mem` row of the key — scan `tree.mems`, there is no per-key mem index —, newest
  `state:'retry'` row). Recovery rule 1: a `begin` with no `mem` row of the key after it and no later
  `failed`. The index is not path-filtered: check `on` against the path when that matters.
- A refile or re-write re-creates its entries: the row's effects say `created` even for an entity that
  existed under the superseded row, and the human ops held for it re-apply with THEIR seqs. For the
  `memory{change}` events "per entry the row really changed", compare the entries before and after the
  write (session.ts `sameEntry`) instead of trusting `created`.
- `/memory undo` then `/memory refile` now keeps the person's edits/retirements of the re-created entries
  (D-179), as does a re-write after staleness.
- The recap slot: library arcs are `e.arc !== undefined && e.origin.kind === 'library'`; their revision
  `prov.lastSeq` is 0 until a row changes them (rev 0 = the book's text, not a row's).

## M5a tests changed (and how)
- test/memory: `refs.test.ts`, `stale.test.ts`, `library.test.ts`, `compendium.test.ts` — the lantern kit's
  `[Arc]` (k2) is now seeded as `C4 lib:lantern:k2`: library key lists gain it, session handles shift by
  one, the routed lists lose the arcs, the `mixed()` book seeds `a1` and `a2` (both have meta.arc).
  `fold.test.ts` "rows apply in seq order": the edit of `note:мост` before its note now applies (D-179); a
  name-addressed one is still not_found.
- test/tools-m5a: `lore.test.ts`, `handles.test.ts` (handles +1 after C3; the `[Arc]` is a `C4 … (arc)`
  row, no L row), `export.test.ts` (the exported arc comes back as a library arc; typed compared apart).
- test/repl-m5a (`read`, `write`, `final`, `fixes`, kit comment) and test/demo-m5a: the lantern book has
  16 Compendium entries (15 typed + the arc C16): session handles C16→C17 (C17→C18…), "15 Compendium
  entries"/"15 live"/"· 15" → 16, `/memory list` gains an `Arcs (1)` group with
  `C16 [Arc] Украденный свет`, the book tree's `Narrative · 2` holds it; with two books Ян is C33 and the
  second book starts at C17.
- test/engine-m5a and test/compendium-select: nothing to change.

## Review fixes (fix-fold): D-184 story order, fold cost (review lane#2, breaker#2)

Files: `src/agents/compendium/apply.ts`, `src/agents/compendium/merge.ts`, `src/session/fold.ts` (tree.ts
unchanged). Tests: new `test/fold-m5b/` (`order.test.ts` 11, `cost.test.ts` 4, `lane.test.ts` 4); M5a/M5b
tests adapted (below).

### D-184: rows apply by (anchor, seq) — apply.ts `storyOrder`
- `FoldOptions.msgs?: ReadonlyMap<string, {seq}>` (new, optional): `TreeIndex.msgs`. `foldView` /
  `foldViewAt` pass it.
- Anchor (1-based path position, D-58): an agent row (task key set, `on` on the path) → the position of
  its `on`; a human row (or an agent row bound to nothing) → the position of the newest path message whose
  seq is below the row's, 0 when none (binary search over the path's seqs; parents are older than their
  children).
- Without `msgs` (a caller that passes only `path`): a human row anchors at the newest position that a row
  up to it (seq order, any row on the path) is bound to — a lower bound of the exact anchor. Without
  `path`: seq order, as before. Filtering (path, staleness, newest action per key) is unchanged.
- The sort is stable over seq order and runs only when anchors are out of order (the common chat with no
  re-write and no lagging pass behind a human row keeps seq order, the same `rev`).
- Consequences: `effects` follow story order (a re-written row's effects where its answer is); `rev`
  hashes the rows in that order; `lastSeq` is the max seq applied (no longer the last applied row's);
  `prov.lastSeq` = the seq of the last row in story order that changed the entry. D-179 holds still
  apply when the creating row comes later in story order (a refile of the answer the person's rows
  follow); a refile/re-write of an OLDER answer now applies before the person's rows, so their ops meet
  the entry at once.

### Checkpoints at the end of every fold
`CHECKPOINT_MIN_ROWS` (256) is gone: every fold resumes from the longest checkpoint whose rows are a
prefix of its (story-ordered) effective rows and keeps one at its end (plus every 2 048 rows, ≤ 6 per
chain, LRU, as before). A new message refolds no row, a new mem row only itself. Checked in the engine:
after a send, a turn and the lane's job + mem rows, entries no row touched keep the same `data` object
(test/fold-m5b/lane.test.ts). The lane's `foldWithout` resumes as well (≈ 0.9 ms per task).

### Near-duplicate collapse (merge.ts)
A list the merge made that collapses to itself (`SETTLED`, with its token postings in `SLOTS`, taken over
by the next merge's result) and whose strings stayed in place: only the strings a merge adds are compared
against it (same result as collapsing the whole list again: by the rule's order the old elements are kept
slots already). A result is settled when nothing collapsed, or when no slot that took a longer wording
nearly duplicates another slot (the only pairs not compared during the scan). Otherwise the next merge
collapses the whole list as before. Posting lists no longer `includes`-check (a duplicate is skipped by
the per-item `seen` mark). Differential test against a whole re-collapse per merge (400 random merges,
keyed and unkeyed lists, merges into older lists again): `test/fold-m5b/cost.test.ts`.

### Timings (this machine, others' tests running in parallel)
| | before | after |
|---|---|---|
| breaker#2 chat (157 rows, 301 msgs), fold from scratch | 1 907 ms | 67–83 ms |
| … after a new row | 1 881 ms | 0.3–0.4 ms |
| … after a new message | 1 900 ms | 0.3–0.6 ms |
| e2e (review/break/long.ts, 150 turns): memoryWait of 151 tasks | 195 s (reviewer), 173 s (skeptic) | 2.1–3.1 s |
| e2e after.ts: reopen / send+fold / one turn | 1 989 / 2 002 / 2 513 ms | 149–156 / 5–6 / 345–386 ms |
| skeptic bench (foldCompendium), breaker 150/250 rows | 2 059 / 3 519 ms | 117 / 110 ms |
| skeptic bench, namefacts 250 / moderate 250 | 751 / 311 ms | 29 / 28 ms |
M5a benchmarks unchanged (typed: cold 70–82, new row 7–10, earlier leaf 4–6 ms; notes 18–23 ms; unkeyed
5 000 rows 100–120 ms). The one turn's remaining ≈ 340 ms is the o200k token count of the Compendium block
(`prompt/assemble.ts` blockCount → countO200k over Фрол's 532 facts), not the fold.

### Tests changed
- `test/memory/fold-m5b.test.ts` "a refile … the edit and the retire made in between survive": the pass is
  now a2's (the person's rows follow a2, so the refile shares their anchor and the D-179 hold is still what
  the test pins); the old-answer case moved to test/fold-m5b/order.test.ts with D-184's effects order.
- `test/tools-m5a/kit.ts` `world()`: the session's rows sit in the log after #5 (before #6, #7) — they were
  all written in the story after #5 (the filing and historian rows are #5's) — so they apply in seq order
  as the M5a expectations say. With them after #7, D-184 applies #5's passes before the human rows.

### For the lead
1. `foldCompendium` callers that pass `path` but not `msgs` get the lower-bound anchor for human rows:
   `src/engine/lane.ts` `foldWithout` (staging) and `src/engine/session.ts` dry runs (`dryRun`,
   `memoryUndo`'s trial fold). They should pass `msgs: tree.msgs` (one field each) so a dry run folds in
   the view's order (else, with a person's row followed by a lagging pass of an earlier answer, a dry run
   can disagree with the view, and it cannot resume from the view's checkpoint past that row).
2. D-184 changes the order wherever human rows follow lagging passes or passes are written again: tests
   outside my dirs that pin handles, effects or `rev` in such sessions (lane-m5b, demo-m5b, repl-m5a,
   demo-m5a, recap-m5b, historian-m5b) were not run by me.

## Final-check fixes (fix2-fold): section K — row order export, ties, handles, dry runs, renamed plots

### API for the lane and the engine (posted first; details below)

```ts
// apply.ts — new exports
interface RowOrder { anchor: number; kind: 0 | 1; seq: number }   // kind 0: agent row (task key set), 1: human row
compareRowOrder(a: RowOrder, b: RowOrder): number                 // (anchor, kind, seq), agent before human at one anchor
rowOrder(row: { key: string | null; on: string | null; seq: number }, path: readonly string[],
         msgs?: ReadonlyMap<string, { seq: number }>): RowOrder   // the fold's own sort key for a row on `path`
foldStaged(rows, opts: FoldOptions & { path; msgs }, pass: { key: string; on: string }): CompendiumView
// FoldOptions — new optional fields
before?: RowOrder   // apply only the effective rows that sort strictly before this point (a prefix of the fold's order)
without?: string    // leave out the rows whose task key is this (the key's own rows)
trial?: true        // keep no checkpoint (a dry run's row is never written): reads checkpoints, keeps none
```

- **Lane staging (order#1):** replace `foldWithout(tree, key, task.on, seed)` with
  `foldStaged(tree.mems, { pathSet: view.pathSet, path: view.path.map((m) => m.id), touched: tree.touched,
  library: seed, msgs: tree.msgs }, { key: task.key, on: task.on })` — the HEAD path, not `pathTo(on)`.
  It folds exactly the rows the view applies before the pass's row: `rowOrder({key, on, seq: Infinity})` =
  `(pos(on) + 1, agent, ∞)`, i.e. every row anchored before `on`, plus the agent rows bound to `on` (other
  keys), never a human row anchored at `on` or later; without the key's own rows. Its checkpoint is kept
  on purpose (it is the prefix the landing pass resumes from); do NOT pass `trial` there.
- **Engine dry runs (order#4):** `session.ts dryRun` and `memoryUndo`'s trial fold pass `trial: true`.

### What changed (apply.ts, refs.ts; fold.ts and notes.ts needed nothing)

- **Ties (order#2).** `storyOrder` sorts by `2·anchor + kind` (stable over seq): at one anchor agent rows
  (task key set) apply before human rows. A person's edit made while answer n was the head now wins over
  any pass or re-write of n written later (lagging, stale re-write, refile); same result whatever the
  timing and on every branch. D-179 holds remain (a key a LATER answer's pass re-creates after an undo;
  the no-`msgs` fallback); a refile of the answer the person's rows follow now applies before them, so
  their ops meet the entries at once (no hold).
- **Handles (order#3, amends D-150).** The fold stamps each session entry with the (row seq, op index)
  that created it (`FoldState.born`, replaces `ordinal`); `view.entries` comes out library first (seed
  order), then session entries by that stamp (`inBornOrder`, a re-sort only when the story order made
  them out of order). So `entryRefs`/`refOf`/`resolveRefIn`/`noteRefs`/`notesBook` order and `findMatch`
  agree with handles by creation; `findIn`'s creation rank is the stamp too; a hand-written `C<n>` in a
  row resolves in that numbering. Retired entries keep their numbers; a refile/re-write re-creates its
  entries under its own (newer) seq (they move after entries made before it, as before).
- **Dry runs (order#4).** `trial: true` → the fold reads checkpoints and keeps none. Also: every fold
  keeps a checkpoint at its FRONTIER (right after the newest agent row in its order, before the person's
  trailing rows) and marks it used on every later fold that resumes past it, so a lagging pass lands on a
  kept prefix however many verbs, views and stagings came in between (evict repro: K=4 and K=8 → 1.6 ms,
  from scratch 64–67 ms).
- **Staging (order#1).** `rowOrder`, `compareRowOrder`, `FoldOptions.before/without`, `foldStaged` (above).
  The stage is a prefix of the fold's order, so it resumes from the frontier checkpoint and the
  checkpoint it keeps is the prefix the landing pass resumes from. `before` without a path compares
  rows as `(0, 0, seq)` (seq order).
- **Arcs follow renamed plots.** `applyArc` resolves the plot through its names, aliases and former names
  (findIn), then reuses the live SESSION arc whose `arc` answers to any of them (`sessionArcOf`: the one
  whose plot is the current name first, else the first created) and renames it (`arc` and `name`) to the
  plot's current name; `prov.lastSeq` moves when its text or its plot name changes. A new arc is keyed
  `arc:<normalized current name>` and named by the plot's name (an op naming the plot by an alias no
  longer makes `arc:<alias>`). Library arcs are untouched (ruling G). New export
  `plotArc(entries, plot)`: the arc such an op would rewrite, for the historian's no-op check.

### Tests
- New `test/fold-m5b/final.test.ts` (19): rowOrder/foldStaged (rename and hand-filed worldbuilding not
  in a2's stage; own rows out, other passes of `on` in; 150 random sessions: the stage's effects = the
  full fold's effects before the pass), ties (A/B timing, C wait-0 re-write, D two branches, an arc edit vs
  a window ending at that answer, a D-179 hold after an undo), handles (the lagging-pass case, a
  hand-written `C2`, library first + refile), trial (never resumed from) and the frontier (9 verbs with
  dry runs, views at another leaf, then a lagging pass resumes there; equals a fold from scratch), arcs
  (new name, former name, alias, plotArc). Each group checked to fail with its fix reverted (scratch copy).
- Changed: `test/fold-m5b/order.test.ts` (the "pass of the answer the edit follows" case flips to the
  edit winning; the no-`msgs` refile case too; the re-written window's summary key comes after a3's in
  creation order), `test/memory/fold-m5b.test.ts` (the a2 refile applies before the person's rows: effects
  order, no hold), `test/tools-m5a/kit.ts` `world()` (the person's rows before the first agent row sit
  after #4, the rest after #5, so the kit still folds in seq order under the tie rule).
- Run: test/fold-m5b, test/memory, test/compendium, test/engine-m5a, test/tools-m5a, test/repl-m5a,
  test/demo-m5a — 550 pass, 0 fail (with the lane/engine fixers' foldStaged and `trial` in place).

### For the lead / other owners
1. `src/agents/compendium/recap.ts arcRevisionText` reads an arc op of the pinned row by the KEY's plot
   name. An arc that followed a renamed plot keeps its key (`arc:lantern`) while later arc ops name
   'The Harbour Lantern', so an older revision written under the new name reads back null → the pin is
   dropped (the current text renders: one cache break). Fix there: read the op by the view's effect
   (`effects` hold `{seq, op, key}`: `row.ops[effect.op].overview` for the effect with that key and seq).
2. `historian.ts sessionArc(entries, n)` (the "arc already says exactly that" check) looks the arc up by
   the canonical name only; use `plotArc(entries, plot)` so a renamed plot's arc is found (else an
   identical overview is written again — harmless, it only renames the arc).
3. `rev` changes for sessions where a person's rows sit at the same anchor as a later-written pass (the
   order changed); one recompute, nothing persisted depends on equality across versions that I know of.
4. docs (ARCHITECTURE §5.8 / D-150 wording) should say handles count session entries by creating seq.
