# M5a contract — memory core (builder: memory)

Scope: D-141 (seed / routing helpers), D-143 (fold), D-144 (file), D-145 (arc), D-146 (edit), D-147
(vanished base), D-148 (merge), D-149 (provenance), D-150 (handles). Contract files (`types.ts`,
`entry-types.ts`, `mention.ts`) untouched.

## Files

| file | status |
|---|---|
| `src/agents/compendium/merge.ts` | new (adapt BR `merge.ts` + RC `compendium-definitions.ts:66-349`) |
| `src/agents/compendium/apply.ts` | rewritten fold (normalizeName unchanged) |
| `src/agents/compendium/library.ts` | new |
| `src/agents/compendium/refs.ts` | new |
| `src/agents/compendium/notes.ts` | `isNote` excludes arcs; `noteRefs` / `resolveNoteRef` number by `entryRefs` |
| `src/session/tree.ts` | `TreeIndex.touched` |
| `src/session/fold.ts` | `foldView(…, opts?)`, `foldViewAt(…, opts?)`, `FoldViewOptions` |
| `test/memory/{merge,compendium,library,refs,stale,checkpoint}.test.ts` | new |
| `test/memory/{fixtures,kit}.ts` | helpers (`file`, `filing`, `hist`; `typed`, `classic`, `source`, `lantern`) |
| `test/memory/fold.test.ts`, `view.test.ts`, `test/prompt-m3/m2-scenarios.ts` | M3 pins updated (`tasks`/`effects`, file/arc/revert apply, C<n> in rows, issue keys), benchmarks |

## Exported API

### merge.ts
```ts
normKey(s: unknown): string                       // foldText + whitespace collapse + trim; '' for non-strings
ARRAY_KEY_FNS: Readonly<Record<string, (item: unknown) => string>>   // '' = no key
deepEq(a, b): boolean                             // re-export of formats/wire.ts deepEq
collapseNearDuplicates(items: readonly unknown[]): { items: unknown[]; from: number[] }
NEAR_DUP_MIN_TOKENS = 3; NEAR_DUP_JACCARD = 0.8; NEAR_DUP_SCAN_LIMIT = 400
interface MergeOptions { keep: readonly string[]; on: string | null; appended: Readonly<Record<string,(string|null)[]>> }
interface MergeResult { data: Rec; appended: Record<string,(string|null)[]>; changed: boolean }
mergeData(old: Rec, incoming: Rec, opts: MergeOptions): MergeResult
```
`collapseNearDuplicates.from[j]` = index in `items` whose value ended in slot j; nothing collapsed →
`items` itself. `mergeData` returns `old` itself and `opts.appended` itself when nothing changed.

### apply.ts
```ts
normalizeName(name: string): string               // unchanged (D-95)
interface FoldOptions { pathSet; path?: readonly string[]; touched?: ReadonlyMap<string, number>; library?: LibrarySeed }
foldCompendium(rows: readonly MemEntry[], opts: FoldOptions): CompendiumView
entryNames(e: CEntry): string[]                   // normalized: name, data.title, data.topic, aliases, formerNames
findMatch(entries: Iterable<CEntry>, type: EntryType, names: string[]): CEntry | null
resolveRefIn(entries: ReadonlyMap<string,CEntry>, ref: string, prefer?: 'live'|'retired', namesOf?): CEntry | null
handleNumber(ref: string): number | null          // 'C12' / 'c12' / 'С12' / 'с12' → 12
NOTE_KEY_PREFIX = 'note:'; LARGE_ENTRY_CHARS = 12_000
```
### library.ts
```ts
isCompendiumEntry(e: LoreEntry): boolean
bookAccess(cfg: CompendiumConfig, libraryId: string): 'read' | 'off'
librarySeed(sources: readonly LoreSource[], cfg: CompendiumConfig): LibrarySeed
routeBooks(sources: readonly LoreSource[], cfg: CompendiumConfig): LoreSource[]
```
### refs.ts
```ts
entryRefs(view): { ref: string; entry: CEntry }[]    // C<i+1> in Map order
refOf(view, key): string | null
resolveEntryRef(view, ref, prefer = 'live'): CEntry | null
```
### notes.ts (signatures unchanged)
`noteRefs(view)` = `entryRefs` filtered to notes (same numbers). `resolveNoteRef(view, ref, prefer)` →
notes only: a handle of a typed entry/arc → `undefined`. `isNote` = type null, session, no `arc`, string content.
### session
`TreeIndex.touched: Map<string, number>`; `foldView(header, entries, idx?, opts?: FoldViewOptions)`,
`foldViewAt(header, idx, leaf, opts?: FoldViewOptions)`, `interface FoldViewOptions { library?: LibrarySeed }`.
Existing callers work unchanged (no seed → session rows only).

## Behaviour choices the decisions note left open

Fold / rows
- `FoldOptions.path` absent → staleness is not checked (only pure tests do that; `foldView` always passes it).
- A malformed `range` on an agent row (not two strings) → stale ("cannot be checked"). Human rows never stale.
- A revert and a row of the same key in the same row: the revert wins (closes the key).
- `tasks`: one state per key seen on the path (rows with the key, or a revert of it). `reverted` (seq of the
  revert row; range of the newest row of the key on the path), `applied` (the applied row, its range),
  `stale` (newest stale row). **`superseded` is never produced**: superseded rows are older rows of an
  applied key and have no key-level state of their own.
- `rev` = sha256 over (seed hash, then a per-row digest of seq + ops JSON) of the applied rows, 16 hex;
  the per-row digest is FNV-1a 64 (cached per row object). `lastSeq` = newest applied row.
- `effects`: one per applied op (`note`, `created`, `merged`, `edited`, `arc`, `retired`, `restored`). An
  `arc` op that creates its plot records two effects with the same (seq, op): `created` (plot key), then
  `arc`. A `file` op records exactly one. `revert` records none (no issue either).
- `issues[].key`: the resolved entry for invalid edits/retires, the classic entry's `lib:` key for
  `classic_conflict`, the ref for `library_entry_missing`, the entry for `large_entry`; absent for
  `not_found`, `unknown_type`, `unknown_op`, `missing_required` and invalid file/arc/note ops.
- `large_entry`: once per key per fold, at the LAST op that changed the entry's data, when its data JSON is
  ≥ 12 000 at the end of the fold; issues are then sorted by (seq, op). Only data counts (not note/arc text).
  It is not a failure: the verbs' dry-run must ignore it.

Refs in rows (hand-written)
- A ref shaped like a key (`note:` / `arc:` / `lib:` / `<entry type>:` prefix) is looked up only: missing
  `lib:…` → `library_entry_missing`, any other missing key → `not_found`. Anything else (C<n>, a name) is
  resolved like `resolveEntryRef` at that point of the fold (edit/retire prefer live, restore prefers retired).
  The M3 test that expected `restore C1` → `not_found` now resolves it (changed to `C9`).

file / arc / edit
- `file` names: identity value (trimmed) + string aliases of the op. Classic check covers aliases too.
- Merge with no data/alias/name change: effect `merged`, `lastSeq` unchanged, and a library entry does
  NOT become an overlay. Any real change (or an edit / retire / restore) makes it an overlay.
- "name = identity value if the entry had none": applied when the entry's data had no non-blank identity
  field (a library entry named from its LoreEntry title); the old name is then kept as an alias.
- The filed name used to match (an alias) is not added to `aliases` (Bunraku parity) unless it is in the
  op's `aliases`. `CEntry.aliases` = union of the entry's aliases and the op's (`data.aliases` merges by
  the `aliases` key fn on its own).
- New entry data is `mergeData({}, op.data)`: blanks dropped at every depth, lists deduplicated; `[]`/`{}`
  for an absent field are stored (D-148 "take incoming").
- Arc: the plot is created only when no live plot matches AND the name is not a classic name (no issue then).
  A retired arc is not reused: the next arc op creates `arc:<plot>#2`. An unchanged overview does not move
  `lastSeq`. Arc edits: `set.content` wins over `set.overview` when both are given; other `set` keys go to
  `data` (as notes).
- Typed edit: `set` values are stored as given (`null` included; `undefined` skipped); `set.aliases` must be
  a string array; a rename removes the new name from `formerNames` and from `aliases`; a former name is
  pushed only when its normalized form differs from the new one. Summaries rename by `title`.
- Names: `CEntry.name` of typed entries is trimmed; notes keep their title as written (M3).

Merge (D-148)
- `affiliations` key = first non-blank of `org`, `with`; `key_moments` = first non-blank of `label`,
  `description` (blank-aware form of `??`).
- Near-duplicate collapse runs over the whole merged list, but only when the merge added or reworded a
  string item (a merge that only touches objects leaves strings alone). A rephrasing that collapses back
  into the old wording returns the old list (no change).
- Provenance of a slot a collapse took over follows the text it kept: the incoming (longer) text → the
  row's `on`; an old unchanged text → its own old value. Only TOP-level arrays carry it. Entries created by
  human rows get all-null arrays; library base elements have no entry (= null).

Library seed
- `aliases`: `meta.aliases` when it is an array, else `data.aliases`; strings only, trimmed, deduplicated
  by normalizeName, the name left out. Blank and regex keys are dropped from `keys`. `order` = the
  entry's `order`, else 100 (DEFAULT_LORE_ORDER). Duplicate `lib:` keys keep the first.
- `books` and `hash` cover every readable book, including one with no typed entries (its classic names
  count). No readable book (or `enabled:false`) → `EMPTY_SEED` itself.
- `bookAccess` knows nothing of `enabled`; `librarySeed`/`routeBooks` check `enabled` themselves.

## Performance (D-143 cost)

The fold keeps state checkpoints: a fold of ≥ 256 effective rows saves its state at the end (and every
2 048 rows); the next fold whose effective rows start with the same row OBJECTS (same seed object)
resumes from the longest one (≤ 6 kept per chain, LRU). Results are identical to a fold from the seed
(`test/memory/checkpoint.test.ts`). Also memoized: normalizeName (fold side), normKey, near-dup tokens,
taglines (16 384 texts each), per-row digests, the seed's names (WeakMap by seed).
Benchmark (`test/memory/fold.test.ts`, typed: 5 000 rows — filing merges with 3 lists each, arcs,
summaries, overlays, edits, notes — over a 1 500-entry seed, 6 000-message path), on this machine
under parallel load: refold after one new row ≈ 6–8 ms; a view at an earlier leaf ≈ 4–7 ms; **from
scratch (fresh row objects, e.g. opening a session) ≈ 45–70 ms** (asserted < 150 as a guard). The
notes benchmark from scratch ≈ 13–17 ms (< 30).
M5b note: real filing rows carry up to 12 items; a cold fold grows with the number of merges
(~10 µs each), refolds stay cheap as long as rows are appended.

## What other builders / the engine must know

- Pass the SAME `LibrarySeed` object while the books are unchanged (seed names and checkpoints are
  cached by seed identity). Pass it to `foldView`/`foldViewAt` (`{ library }`) and the verbs' dry run.
- Views are read-only. `CEntry` objects, `aliases`, `keys`, `formerNames`, `issues`, `effects` are the
  view's own, but `data` (and everything inside it), `prov.appended` arrays and `range` are shared with
  the seed, the rows and checkpoints: never mutate them.
- Never mutate a mem row after it was folded (digests and checkpoints are keyed by row object).
- Verbs (D-159): the effect of a `file` row is `view.effects.find(e => e.seq === seq && e.op === 0)`;
  `created`/`merged`. Refuse on any issue of the candidate seq except `large_entry`.
- Notices: `large_entry` and `library_entry_missing` carry `issue.key`.
- D-142 leftovers outside my files: the comment at `src/lore/engine.ts:75` and
  `test/lore/engine.test.ts:198` (typed entries are lore only for a plain engine call / 'off' books).
- D-150 leftovers: `tools/handles.ts` should bind by `entryRefs`; `test/tools-parse/handles.test.ts:78`
  (a non-note record numbered after the notes) changes with it. Notes-only views keep M3 numbers.
- `isNote` now excludes arcs (`tools/builtin/lore.ts` uses it: arcs are not notes there).
- `prov.appended` readers (fresh.ts, export): missing field or index = null.

## Fixes after the review (fixer: fix-memory)

Findings fold#1, fold#2, fold#4, breaker#1, breaker#3 (merge side), breaker#6, fidelity#3 (test
headers) and the library ruling of section H. Files: `apply.ts`, `merge.ts`, `library.ts`, tests in
`test/memory/`. `refs.ts`, `notes.ts`, `session/tree.ts`, `session/fold.ts`, `formats/wire.ts`
unchanged.

### apply.ts (D-168)
- **Pinned `file` ops.** `{op:'file', type, data, target}`: the fold applies the op to `target` and
  nothing else. An entry with that key and the op's type (live or retired, session or library) →
  `mergeInto` (same rules as a name match: identity kept, aliases unioned, overlay on a library entry);
  `target` starting `lib:` and missing (or now of another type) → issue `library_entry_missing` with
  `key: target`; a missing session key → created with exactly that key (`allocKey(target)` only when an
  entry of another type holds it, e.g. `note:x` → `note:x#2`); required fields and a nameable identity
  are still checked (`missing_required`, `invalid`); a non-string or empty `target` → `invalid`. No name
  matching, no `classic_conflict`. Effects as before (`created` / `merged`). A pinned summary merges
  into an existing summary at its key (D-168's "merge into it"; it only happens when a hand-written row
  names a taken key). Rows without `target` (agent rows, M5b) stay name-addressed.
- **Hand-filed summary key** (a row without a range): `summary:user:<normalizeName(title)>`, `#2`… when
  taken; never from the seq, so a fork keeps it. Range rows keep `summary:<range[1]>.<i>`.
- **Engine side (not in my files):** the verb writes the key of its name-addressed dry run into the op
  (`memoryFile` in session.ts folds the unpinned op, then the pinned one, and checks both land on the
  same key). The fold guarantees that: a pinned op on a key that is free creates exactly it.
- **Arc over a classic name (fold#4):** when no live plot matches and `LibrarySeed.classic` has the
  name, no plot is created and an issue `{why:'classic_conflict', key:<the plot's would-be key>}`
  (`plot:<name>`, or `#n` when taken — computed, not allocated) is recorded on the arc op; the arc
  itself still applies (effect `arc`). It is an issue on an applied op, like `large_entry`: a verb
  dry-running an arc row would refuse on it (no M5a verb writes arcs).
- `allocKey` = `freeKey` (the first free `base`/`base#n`, nothing taken) + taking it.

### merge.ts
- `MERGE_MAX_DEPTH = 32` (exported). A top-level field is level 1. Past level 32 a value is a scalar:
  it replaces the old value unless equal (compared by a bounded canonical text), is stored as given
  (blanks inside it are kept, lists in it are not deduplicated) and is never recursed. 20 000-level
  data merges and folds (`test/memory/merge.test.ts` "depth bound", `compendium.test.ts`).
- Unkeyed list items (no key fn, or an item whose key is '') dedupe through a set of canonical texts
  (`PLAIN_INDEX`, cached per list and handed to the successor list like `KEY_INDEX`): one lookup per item.
  The canonical text equals iff `deepEq` (keys sorted, an undefined field absent, an undefined array item
  not null; NaN/functions/symbols have none, so they are never duplicates — as with deepEq). Past 32
  levels below the item the rest is `JSON.stringify` text. Results are the same as the deepEq scan
  (deterministic differential test in `merge.test.ts`).
- `prov.appended` of a list without a collapse is built by copying the old array and appending (no
  per-merge `map` over the list); after a collapse as before. Same values.
- Cost, from scratch, this machine under parallel load: 5 000 rows each adding to one unkeyed list
  ≈ 100–150 ms (was 3.5–5.6 s; asserted < 500 in `fold.test.ts`); one keyed list (memories) ≈ 140 ms
  (was ≈ 300–440). The typed benchmark is unchanged (cold ≈ 65–110 ms under load).
- Not fixed (outside the findings given to me): the near-duplicate collapse is O(L²) per merge on
  string lists whose facts share tokens (≤ 400 items): 5 000 rows each adding a string to `likes`
  fold from scratch in ≈ 2.6–2.9 s. A skeptic of breaker#6 flagged it as a separate issue.

### library.ts (ruling: a typed library entry needs data)
`isCompendiumEntry(e)` = valid `meta.type`, no `meta.arc`, and `meta.data` an object with at least one
filled field (not blank — undefined, null, whitespace — and not an empty list or object). Otherwise the
entry is plain lore: not seeded, not routed, and a classic name when it has a title. `seedEntry` is
unchanged (its `data` is always that object now).

### Tests (test/memory)
- `compendium.test.ts`: summary keys by title (incl. a seq-independence check), pinned ops (attach a book:
  no re-homing; retired / library targets merge; `library_entry_missing`; key held by another type;
  pinned vs unpinned summary fold the same), arc over a classic name, 20 000-level data in a fold.
- `stale.test.ts`: a fork (planFork drops the head entry, seqs move) keeps hand-filed summary keys; the
  retire and the edit still apply.
- `merge.test.ts`: depth bound; deepEq-scan equivalence of the unkeyed dedupe; keyed lists with unkeyed items.
- `fold.test.ts`: the breaker#6 shape (5 000 rows into one unkeyed list, from scratch, < 500 ms);
  `time()` takes an optional run count.
- `library.test.ts`: the data rule (seed, classic, routing).
- `merge.test.ts` and `compendium.test.ts` carry the ported-file header (Bunraku filing.test.ts@702d8120,
  RoleCall vvs-811-adopt-render-order.test.ts@fb8dc623e; Coneja-Chibi).

### For the lead
- `types.ts` (lead's) `CEntry.key` doc still says `'summary:user:<seq>.<i>'`; now
  `'summary:user:<normalizeName(title)>'`.
- D-144.2 / D-145 text in the decisions note: the summary key and the arc's `classic_conflict` issue.

## Fixes after the final check (fixer: fix-memory-2)

Section I of the decisions note: "Pinned rows tightened" (final-check regression "A library book replaced
under the same id…") and the bounded comparison for the verbs' no-op check (final-check `breaker#3-merge`,
remaining). Files: `apply.ts`, `merge.ts`, tests in `test/memory/`.

### apply.ts (pinned `lib:` rows)
- `filePinned`: when `target` starts with `lib:` and the entry there has the op's type, it must answer to
  a name of the op's data — `data.name`, `data.title`, `data.topic`, the strings of `data.aliases`
  (normalizeName). Otherwise the op is skipped with `{why:'library_entry_missing', key: target}`: no
  effect, no merge, the entry is untouched (it does not become an overlay, its name is not taken over).
- "Answers to" = the entry's names at that point of the fold (`entryNames`: its name, title, topic,
  aliases and former names), i.e. the book's names plus those the session gave it (an alias filed or set,
  a rename, whose old name stays a former name). That is exactly what the verb's name-addressed dry run
  matched on (its names ⊆ the ones checked), so `memoryFile`'s "named and pinned land on the same key"
  check always holds; a strict check against the book's names alone would refuse filing under a name the
  session gave a library entry.
- An op with no names answers to nothing (no verb writes one: the named dry run needs a name to match).
- Session keys are not checked (only `lib:` ids can be reused by a replaced book).
- Not covered (outside the ruling): an `edit`/`retire`/`restore` row addresses its entry by key and
  carries no names, so one written against the old book still applies to the new entry under that id
  (and a name it gave carries over to it).

### merge.ts: `sameData(a: unknown, b: unknown): boolean`
- deepEq's answers for JSON-shaped values (key order ignored, an undefined field = an absent one, NaN
  equal to nothing, `[undefined]` ≠ `[null]`), walking at most `MERGE_MAX_DEPTH` levels below its
  arguments (a value directly in `a` is level 1, as a top-level field is for the merge). A deeper value
  compares as the merge compares one past its bound (the canonical text: keys sorted for another 32
  levels, then JSON.stringify's text, where key order counts — equal values can then only be called
  different, so a no-op may at worst be written as a row that changes nothing). Identical references
  short-cut at every level (views share data with the rows and the seed).
- Measured stack (filler frames left, this machine): 2 000 levels ≈ 80 frames fewer than 40 levels (the
  extra canonical frames); deepEq loses ≈ 3 600 at 2 000 levels.
- **For the engine fixer (session.ts):** `sameEntry` should use it instead of wire's `deepEq`:
  `sameData(entryState(a), entryState(b))` (import from `../agents/compendium/merge.ts`; drop the
  `deepEq` import if nothing else uses it). Through `entryState` the data sits one level lower (its
  fields are level 2), which only moves the bound by one; `sameData(a.data, b.data)` next to the flat
  parts gives the merge's exact levels if wanted. Either way no unbounded walk is left in the no-op check.

### Tests (test/memory)
- `compendium.test.ts` (pinned file ops): a book replaced under the same id — the pinned row merges into
  e1 with the old book, is `library_entry_missing` with the new one (e1 renamed; and e1 named only by its
  LoreEntry title, the review's A2), e1 untouched, e9 (the real Мира) untouched, the same op by name goes
  to e9; a nameless pinned op is missing. A second test: a pinned row still lands by an alias of the book,
  a session rename, a former name, an alias set in session, an op alias, a worldbuilding topic; a topic
  the entry does not have is missing.
- `merge.test.ts` (sameData): agrees with deepEq on every pair of a pool (distinct copies); past the
  bound (2 000 levels): equal / different leaf / missing level / extra field / key order (ignored through
  level 64 below the arguments, counted past it); the stack it needs at 2 000 levels is within 500 filler frames of
  what 40 need, with deepEq as the control (it loses > 1 000).

## Fixes after the final check (fixer: fix-matching)

### library.ts
- **Data rule (section I, final check H-library-data).** `isCompendiumEntry` needs `meta.data` with at
  least one non-blank value at any depth: `filled` walks lists and objects iteratively (an explicit
  stack, a shared object visited once), so `{traits:['  ','']}` and `{physical:{hair:' '}}` are blank
  and stay plain lore (not seeded, not routed). A number or a boolean (`0`, `false`) is a value. 2 000
  levels of nesting are tested; no recursion, so deeper data cannot overflow the stack.
- **Seed (section I).** A seeded entry keeps `secondary` (non-blank strings, `/re/` keys included, as
  written) and `logic` when it is one of and_any, and_all, not_any, not_all (else absent: and_any).
  Neither field when there is no non-blank secondary key. `caseSensitive` is not copied.
- Tests in `test/memory/library.test.ts`: the deep blank rule (and through seed and routing), the seeded
  fields, and seed → `select` for a guarded common-word key.
- For the lead: `export.ts` (not mine) writes a library entry's `keys` but not `secondary` / `logic`,
  so a core export of an overlaid guarded entry loses its guard.
