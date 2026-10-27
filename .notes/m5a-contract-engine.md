# M5a contract — unit `engine` (wave 2)

Decisions: D-141 (session-level library), D-142 (routing), D-155 (request side of the block), D-156
(offer rule), D-157 (Director wiring), D-158 (config), D-159 (verbs, events, notices), D-164
(`--keep-requests`). Nothing ported (no provenance note).

## Files

| file | what |
|---|---|
| `src/engine/request.ts` | `SessionLibrary`, `loadLibrary`, `compendiumConfigOf`, `liveTyped`, `compendiumBlockInput`, `unfiredCompendium`, `compendiumNotices`; `RequestInput.library?`; `startView(…, seed?)`; routing + block input in `buildRequest` |
| `src/engine/session.ts` | the library cache, seeded `view()`, preview with the seed, the verbs, `entryKind`, notices |
| `src/engine/api.ts` | `EngineOptions.keepRequests`, `MemoryRow`, the new `SessionHandle` verbs |
| `src/engine/turn.ts` | `TurnHost.library()`, seeded Director view, `worldSnapshot` when enabled, `requestsDir`, `requestFileName`, keep-requests writer |
| `src/engine/narrate.ts` | `CallInput.keepRequest?` (streamCall hands it the request right before `provider.stream`; narrateRounds passes it on) |
| `src/agents/structured.ts` | `AgentCallEnv.keepRequest?` passed to streamCall |
| `src/engine/context.ts`, `src/engine/engine.ts` | `EngineCtx.keepRequests` (one line each: the option has to reach the turn) — outside the task's list |
| `src/config/config.ts` | `parseCompendium` (snake_case → camelCase, ranges) |
| `src/session/entries.ts` | `DEFAULT_SESSION_CONFIG.compendium = {enabled: true}`; header guard of the compendium fields |
| `src/lore/engine.ts:75`, `test/lore/engine.test.ts:198` | D-142 comment / test name |
| `test/config/config.test.ts` | the §13 example now expects the camelCase table (it pinned the old "kept as written") |
| `test/engine-m5a/*` | new: kit, library, block, director, verbs, export, config, keep (33 tests) |

## API

### request.ts
```ts
interface SessionLibrary { sources: LoreSource[]; notices: KeyedNotice[]; seed: LibrarySeed }
loadLibrary(home, config: SessionConfig, cast): SessionLibrary   // loadLorebooks + librarySeed(loreSources(cast, sources), cfg)
compendiumConfigOf(config): CompendiumConfig                    // config.compendium ?? {enabled: true}
liveTyped(c: CompendiumView): CEntry[]                          // type !== null, not retired, no arc; handle order
compendiumBlockInput(view, tree, cfg: ResolvedCompendiumConfig, window, guidance?): CompendiumBlockInput | undefined
unfiredCompendium(c, injected: {ref}[]): boolean                // D-156
compendiumNotices(c): KeyedNotice[]                             // keys compendium_large_entry:<key>, library_entry_missing:<key>
startView(header, tree, view, upTo, seed?)                      // seed passed to foldViewAt
RequestInput.library?: SessionLibrary                           // absent: loaded here, view refolded at upTo with the seed (unless EMPTY_SEED)
```
### session.ts (SessionImpl)
`library(): SessionLibrary` (also `TurnHost.library()`), cached on `libraryKey` = JSON of (config.lorebooks,
resolved `enabled`, resolved `books`, each `<id>.json`'s `mtimeMs:size` / `-` missing / `!` unsafe id). The
seed object is the same while the key is; `view()` caches on (version, memSeq, seed object). Exported
`entryKind(e): EntryType | 'note' | 'arc'`.
### api.ts
```ts
EngineOptions.keepRequests?: boolean
interface MemoryRow { ref; key; type: EntryType | 'note' | 'arc'; name; aliases: string[]; tagline;
  origin: 'session' | { book: string; id: string }; retired?: { reason: string }; size: number; featured?: true; overlay?: true }
memoryFile({type, data}) → {key, ref, change: 'created' | 'merged'}
memoryEdit({ref, title?, keys?, content?, set?, unset?, featured?}) → {key}
memoryRetire({ref, reason?}) / memoryRestore({ref}) → {key}            // any entry
memoryList({type?, includeRetired?}) → MemoryRow[]
memoryGet({ref}) → {ref, entry, render, brief}
memoryTree({book?}) → TreeNode[]
memoryExport({name, format, force?}) → {path, id, entries}
compendium() → CompendiumView
```
### turn.ts
`requestsDir(home, sessionId)` = `<home>/sessions/<id>.requests`; `requestFileName(callKey)` = callKey with
every char outside `[A-Za-z0-9._-]` → `_`, plus `.json`.

## Behaviour

- **U and openings.** U = the newest user message on the request view's path (folded at upTo): reply →
  U itself, swipe → the replaced answer's parent, continue → the answer's user message. None (a continue
  of a greeting) → no Compendium input, no `trace.compendium`.
- **Block input.** `cfg = resolveCompendium(plan.config.compendium)`; input only when enabled, U exists and
  `liveTyped(view.compendium)` is not empty. Fresh copies by `visibleCopy` over every live typed entry
  (`hidden` = Σ dropped). `windowTexts` = `messageText` of the non-hidden path messages before U (the last
  4; blank ones count). `full` = `renderEntry(copy)` in the full profile when `length ≤ fullChars`, else
  null; `brief`/`briefTail` from `renderBriefParts(copy, briefChars, '(more: read_lore C<n>)')`. Profile
  from the narrator's request window. `inPrompt` empty, `rev` = view's.
- **Routing.** `routeBooks(lib.sources, compendiumConfigOf(config))` before assemble (books never removed, so
  assemble's shadowing is unchanged); the notes book stays first. No typed entry → the same array (bytes M4).
- **Offer rule.** Lore tools when `unfiredLore(...)` OR (enabled AND `unfiredCompendium(view, pass A
  trace.compendium.injected)`).
- **Notices.** `compendiumNotices` only while the Compendium is enabled (a disabled one makes every overlay
  "missing"; telling that would be noise). Turn: through `keyedNotices` (once per key per open session);
  preview: all of them; verbs: published as session events after the write, same once-per-key set.
  `compendium_large_entry` is level info, `library_entry_missing` warn.
- **Verbs.** Every writing verb: `guardMemory` (session_busy) → input checks (refusals in words) →
  dry run = `foldCompendium([...tree.mems, row], {pathSet, path, touched, library: seed})` with `seq =
  log.lastSeq() + 1` → any issue of that seq but `large_entry` → `Refusal('invalid_params', words)` →
  append → the entry and change from the row's last effect (an arc op records `created` then `arc`).
  `memoryAdd` goes through the same path. Notes take title/keys/content/featured (M3 rules, featured new);
  typed, library and arc entries take set/unset/keys/featured (title/content refused with a hint; arcs:
  `set.content`/`set.overview` = the overview, name/title refused). `data`/`set` are JSON-copied.
  `memoryRetire` of a retired entry → invalid_params "is already retired" (the live-first resolver finds the
  retired one); `memoryRestore` of a live one → "is not retired".
- **memoryGet**: `resolveEntryRef(live first)`; `brief` = `renderBrief(e, 1200)` (no tail).
- **memoryTree**: session tree (`deriveTree` of session-origin entries, default root label) then one per
  `seed.books` entry (`rootLabel` = book name, `categoryOf` from the loaded books' `extras.category`); with
  `book` only that book's (not_found when it is not a readable book).
- **memoryExport**: name needs a letter/digit; `format` defaults to core when absent. core:
  `exportCoreBook(view, name)`; `<library>/lorebooks/<canonicalId(name)>.json` exists → invalid_params unless
  force, then overwritten in place (temp + fsync + rename; `saveToLibrary` never overwrites); else
  `saveToLibrary`. compendium: `<home>/exports/<id>.compendium.json`, same refusal rule, `writeCompendiumFile`
  with `exportDate = now()`; `ExportLimitError` → invalid_params. No row, no event.
- **keep-requests.** The request object minus `signal`, pretty JSON + newline. A call key that repeats (a
  retry of round 0, a fallback's `…:narrator:0`) keeps the LAST request (D-164's path has no attempt
  number — open question). A write failure → one `keep_requests_failed` warn notice, the turn goes on.
- **Config (D-158).** Ranges: `min_share` 0–1, `max_attempts` 1–10, `idle_delay_sec` 0–60, `language` ≤ 80,
  `guidance` ≤ 4000; recall: `max_entries` 0|1–30, `min_entries` 0–20, `context_messages` 0|5–100,
  `grace_sec` 0–60, `timeout_sec` 0|1–3600, `guidance` ≤ 8000, enums as §7.4.9; filing: `wait` 0–5, `every_n`
  1–10, `allow` ⊆ ENTRY_TYPES, `timeout_sec` 0|1–3600; historian: `interval` 0–100, `recap_after` 1–1000,
  `overlap` 0|1–100; books values "read"/"off". Unknown keys refused (Fields.done). 0 kept as stored.
- **Header guard.** `compendium: obj({enabled}, {profile: oneOf, minShare: num, books: record(read|off),
  recall/filing/historian: anyObj})` — configure refuses those; other stored keys (old snake_case) pass. A
  header that stored a bad `profile`/`books` value would no longer open (none can come from an M4 config
  except a hand-written invalid one).

## For the CLI builder (wave 3)

- `test/repl/repl.test.ts:358` builds a fake `SessionHandle`: it needs the new verbs (tsc fails there now).
- `/memory list|show|tree|new|edit|retire|restore|export` → `memoryList`, `memoryGet`, `memoryTree`,
  `memoryFile`, `memoryEdit`, `memoryRetire/Restore`, `memoryExport`; refusal messages are user-ready.
  `memoryFile` merges by name by design: `/memory new`'s "already C12" check is the CLI's (memoryList +
  normalizeName of name/aliases, same type).
- Arc edits from the editor diff: the overview goes as `set.content`.
- `repl.ts:1521/1545` and `cli/preview.ts:109` still use `noteRefs`/`resolveNoteRef` (notes only); `/trace`'s
  compendium line needs names of typed entries too (`memoryList`/`compendium()`).
- `cli/commands.ts:355` folds a closed session with `foldView(header, entries)` (no seed): with books attached
  its C<n> differ from an open session's. `loadLibrary(home, currentConfig(header, entries), header.cast).seed`
  → `foldView(..., undefined, { library: seed })` fixes it.
- `--keep-requests` → `Engine.open({ ..., keepRequests: true })`.

## Open questions

1. keep-requests: repeated call keys overwrite (retry, fallback). Add `~2` suffixes?
2. `MemoryRow.size` for notes and arcs is their `data` JSON (`{}` → 2), literally per D-159; their text
   length may be more useful to `/memory`.
3. Compendium notices are silent while the Compendium is disabled.

## Fixes after the review (fix-engine; the lead's rulings in m5a-decisions.md §H)

Supersedes the "Verbs", "Notices", "keep-requests" and "Header guard" lines above where they differ.

### API (api.ts)
```ts
interface MemoryWrite { key: string; changed: boolean; notices?: Notice[] }   // new, exported
memoryAdd(...)     → MemoryWrite                                  // changed always true
memoryFile(...)    → MemoryWrite & { ref: string; change: 'created' | 'merged' }
memoryEdit(...)    → MemoryWrite
memoryRetire(...)  → MemoryWrite                                  // retired entry: still Refusal "… is already retired"
memoryRestore(...) → MemoryWrite                                  // live entry: {key, changed:false}, no Refusal any more
memoryExport(...)  → { path; id; entries; warnings?: ImportWarning[] }   // ImportWarning from formats/native.ts
configure({ compendium: { enabled: true | false } })               // the on/off switch (unchanged signature)
```
- `changed:false`: the dry run showed nothing would change (an edit setting what is there / unsetting what is
  absent / featured as it is, a note edit with the same text, a file that merges nothing new, a restore of a
  live entry). No row, no `memory` event. Compared: type, name, aliases, tagline, data, keys, content, retired,
  featured, arc, formerNames (provenance bookkeeping and the overlay flag aside; a no-op never makes an overlay).
- `notices`: the Compendium's notices (`compendium_large_entry` info, `library_entry_missing` warn) of the fold
  after the verb that were not told yet in this open session; returning them marks them told. Verbs no longer
  publish them on the session bus. Absent when none and while the Compendium is disabled. A key no verb
  returned is told by the next turn (keyedNotices), as before; previews still show all, marking none.
- `warnings` (compendium format only): `compendiumWarnings(rows)` — `featured_dropped` (RoleCall keeps one
  featured entry per type), `too_many_entries` (cannot reach the caller: the write refuses first). Absent when none.

### Behaviour
- **D-168 verb side.** memoryFile dry-runs the name-addressed op (matching, classic_conflict, required fields),
  takes the key it produced, then dry-runs and writes `{op:'file', type, data, target: key}`; the refold of a
  pinned op lands on that key (an internal Error if not). Edit/retire/restore keep storing the key.
- **Rename refusal.** memoryEdit of a typed entry whose `set.<identity>` normalizes to a name (name, alias,
  former name) another LIVE entry of the same type answers to → `invalid_params`:
  `"Мира" (C1) already answers to the name "мира"; a character cannot be renamed to a name another character has`.
  A new spelling of the entry's own name is not a rename (allowed); retired entries and other types do not count.
- **Export.** `--format core`: a name whose canonical id is in the session's `config.lorebooks` →
  `invalid_params` "the library lorebook "<id>" is one of this session's books: exporting over it would replace it
  with this session's part of it; choose another name", with or without force. `--force` over an existing
  file uses `replaceFile` (export.ts: exclusive `<path>.tmp-<n>`, fsync, rename, folder fsync; the temp file is
  removed on any failure, the old file stays whole); writeCompendiumFile shares the same writer.
- **Header guard / config.** `compendium: obj({enabled: bool})` only; everything else a header holds passes and
  `resolveCompendium` reads it: a value of the wrong kind or out of config.toml's range → its default; a field
  whose camelCase name is absent is read from the older snake_case name (`min_share`, `max_attempts`,
  `idle_delay_sec`, recall `on_miss`/`max_entries`/`min_entries`/`context_messages`/`grace_sec`/`timeout_sec`/
  `on_swipe`, filing `every_n`/`timeout_sec`, historian `recap_after`); the camelCase name wins when both are there.
  `configure()` checks a patch's `compendium` part with `compendiumPatchProblem` (config.ts, exported): the
  config.toml ranges over the camelCase names (parseCompendium after renaming), null = remove (unchecked), a
  snake_case name refused; Refusal(invalid_params, `invalid config: compendium.<camelPath>: <why>`).
- **On/off.** `configure({compendium:{enabled}})` takes effect at once: the library key holds `enabled`, so the
  next `view()`, `compendium()`, `memoryList`, a preview and the next turn fold with the new seed (off: no seed,
  no routing, no block, no `trace.compendium`). A header whose stored table holds M4 junk accepts it too.
- **preview --turn.** `inputsChanged` also compares `trace.compendium?.rev` (absent = none) and names
  "the Compendium"; when it does, the block's row is not reported again as "the author's note or other in-chat inserts".
- **keep-requests.** The kept file is the provider-level ModelRequest minus `signal` and minus every message's
  `replay`; documented as such in api.ts (not the wire body). Repeats: `<key>.json`, `<key>-2.json`, `<key>-3.json`.

### Tests
`test/engine-m5a/verbs.test.ts` (pinned rows, attach-later, fork of user summaries, no-op verbs, renames,
returned notices), `config.test.ts` (old header, resolve, configure checks, on/off), `export.test.ts`
(warnings, own-book refusal, failed overwrite, replaceFile), `keep.test.ts` (no replay), `preview-turn.test.ts`
(new: "the Compendium"), `test/memory/session.test.ts` (changed:true, restore of a live note).

### For the CLI fixer
- `/memory on|off` → `session.configure({ compendium: { enabled: true|false } })`; state for `/memory`:
  `resolveCompendium(currentConfig(header, entries).compendium).enabled` (repl-journal's config).
- Print `r.notices` of every write verb (level + message) and `r.warnings` of `/memory export`.
- `changed:false` → say nothing changed (e.g. `"Brother" is not retired`, `nothing changed`) instead of the
  success line. `test/repl/m3-flows.test.ts:127` expects `/memory restore: "Brother" is not retired`: the engine
  no longer refuses, so the REPL must print that line itself from `changed:false`.
- `main.ts` help for `--keep-requests` still says "the JSON body sent": it is the engine's provider-level
  request (see `EngineOptions.keepRequests`), not the wire body.

## Fixes after the final check (fix-engine-2; the lead's rulings §I)

Supersedes the lines above where they differ.

### API / behaviour
- **No-op check.** `sameEntry` (session.ts, now exported for its test) compares `e.data` with merge.ts
  `sameData` (fix-memory-2's bounded deepEq: no JS recursion past MERGE_MAX_DEPTH, canonical text past
  it, where key order counts) and the rest of the entry state (name, aliases, tagline, keys, content,
  retired, featured, arc, former names) with `sameData` too. `wire.ts deepEq` is no longer used here.
- **`set.aliases` already shown = no change.** memoryEdit of a typed entry drops `set.aliases` when the
  list, cleaned as the fold cleans it beside the name after the edit (trimmed; blanks, repeats and the
  name dropped), equals the aliases the entry shows (`e.aliases`, in order). Nothing else in the edit →
  `{key, changed:false}` (no refusal, no row, no overlay); with other fields the row holds only those.
- **One name per live entry of a type** (`nameTaken`): refused with `invalid_params`, nothing written:
  - memoryEdit: a rename (wording unchanged) and any other name the edit gives the entry (a new alias,
    a `title`/`topic` field: `entryNames(after) − entryNames(before)`, checked after the dry run and only
    when the edit changes something): `"Кай" (C3) already answers to the name "кай"; a character cannot
    take a name another character has`.
  - memoryFile: a merge that gives the matched entry a name another live entry answers to (a file naming
    two entries): `"Ада" (C4) already answers to the name "Ада"; filing it into "Кай" (C3) would give a
    character a name another character has`.
  - memoryRestore: while another live entry of the type answers to one of the restored entry's names
    (name, alias, former name): `"Ада" (C2) already answers to the name "Ада"; "Ада" (C1) cannot be
    restored while another character answers to one of its names`. No "rename first" advice: a rename
    keeps the old name as a former name, so only retiring the other clears it.
  - Exempt: summaries (never matched by name: a rename onto another summary's title and its restore are
    free), notes and arcs (untyped). Names of other types and of retired entries are free.
- **trace.loreHashes** hash the books as loaded (before routing). `AssembleInput.booksAsLoaded?`
  (assemble.ts; same keys and order as `lorebooks`, the notes book first when there is one) is passed by
  buildRequest only when routing removed something; assemble hashes `loreSources(cast, booksAsLoaded)`.
  Requests are byte-identical (only the trace field). Preview `--turn`: the Compendium turned on or off
  names "the Compendium" only; a typed entry edited in its book file names `lorebook <id>, the Compendium`
  (the book file did change); a verb's edit names "the Compendium".
- **Export while off.** memoryExport folds the head with the readable books' seed (`librarySeed` with
  `enabled: true`, the books table as configured: an `'off'` book stays out) while the Compendium is
  off; while on it reads `view()` as before. Overlays are exported either way.
- **Notices on no-op verbs** (engine#2): unchanged engine behaviour, now pinned by a test: every verb
  returns the untold notices whether or not it changed anything (`changed:false` included) and marks
  them told. A refusal returns none and leaves them untold.

### For the CLI fixer
- Print `w.notices` on every verb path, the `!w.changed` branches included (`/memory restore` of a live
  entry, `/memory edit` that changes nothing — the one-line note form and the editor —, `/memory new`
  that merges nothing): the engine has already marked them told, so a branch that drops them loses them.
- New refusals reach the REPL as `Refusal(invalid_params)` with user-ready words: `/memory edit` adding an
  alias another entry has, `/memory restore` of an entry whose name a live entry has, `/memory new` whose
  data names two entries. A summary's rename is no longer refused.
- `/memory edit` sending `aliases` unchanged next to other fields: only the other fields are written; an
  alias-only diff equal to what the entry shows returns `changed:false`.
- `/memory export` while off now exports the overlays: any "not exported while off" warning is wrong.

### Tests
`test/engine-m5a/verbs.test.ts` (describe "after the final check": bounded no-op check via stack depth
at a 2 000-level leaf, 2 000-level values through the verbs, aliases no-op, alias/file/restore refusals,
summaries exempt, notices of a no-op verb; the rename test's "own spelling" case now builds its shared
name by filing while the Compendium is off), `export.test.ts` (export while off), `preview-turn.test.ts`
(on/off names only the Compendium; book-file edit names both), `test/memory/session.test.ts` (notes exempt).
