# M5a contract — unit `tools` (wave 2: handles, lore tools, export, two wave-1 fixes)

Decisions: D-150 (handles), D-156 (lore tools over the Compendium), D-163 (export builders), D-152 fix
(trim range), D-162 fix (typed row content). Nothing ported: `export.ts` is fresh (rolecall.md §5.4
"Write" used as a fact reference only), so there is no provenance note.

## Files

| file | change |
|---|---|
| `src/tools/handles.ts` | C<n> bound by `entryRefs` (all entries); signatures unchanged |
| `src/tools/types.ts` | doc comments of `ToolCtx.lore`, `.compendium`, `.handles` |
| `src/tools/builtin/lore.ts` | search_lore / read_lore over the whole Compendium; descriptions |
| `src/agents/compendium/export.ts` | new: `exportScope`, `exportCoreBook`, `exportCompendiumRows`, `writeCompendiumFile`, `ExportLimitError` |
| `src/agents/compendium/fresh.ts` | fix 1: `Visibility.cut` replaces `firstVisible` |
| `src/formats/compendium-v1.ts` | fix 2: typed rows keep RoleCall's text in `content` |
| `test/tools-m5a/{kit.ts, handles, lore, export}.test.ts` | new, 29 tests |
| `test/tools-parse/handles.test.ts` | pin at :78 changed + one D-150 test |
| `test/tools-builtin/lore.test.ts` | description pin; no-hit texts; a note's read_lore text gains `[Memory: …]` |
| `test/compendium/fresh.test.ts` | D-152 tests on `cut`; protected-head and `from` cases added |
| `test/formats-m5a/compendium-{read,write}.test.ts` | typed content pins; blank-content render case added |

## API

### tools/handles.ts (CONTRACT signatures unchanged)
`new HandleTable(view?)`, `bindNotes(view)`, `handleFor(target)`, `resolve(handle)`, `handleShaped(s)`.
- `bindNotes(view)` now binds EVERY entry of the view (notes, typed, arcs, library, overlays; live and
  retired) to its `entryRefs` handle. The name is M3's; it is no longer about notes only.
- A compendium key the bound view does not hold (or any key on an unbound table) gets
  `C<view size + k>` by first appearance — never reached by the tools (they only list view entries).
- L<n>: unchanged (per turn, first appearance). Lenient resolve unchanged (NFKC, quotes, Cyrillic С).

### tools/builtin/lore.ts
- search_lore docs = enabled entries of `ctx.lore` (minus `@notes`, minus any entry whose
  `lib:<source key>:<id>` is in `ctx.compendium` — a second guard behind the engine's routing) + every
  live (not retired) Compendium entry in handle order.
  - Compendium row: `C<n> <name> (<label>): <snippet>`; label `note` | `arc` | `<type>` (session) |
    `<type>, <book name>` (library and overlays). Book name = the `ctx.lore` source with key =
    `origin.book` (routing keeps the book and its name), else the library id.
  - LexDoc: title = name; keys = note keys / typed aliases + `e.keys` (library lore keys, edited keys);
    text = a note's / an arc's own text, a typed entry's `renderEntry` (every field searchable);
    rank = `prov.lastSeq` (session) or `order ?? 100` (library, overlays included).
  - Snippet: typed → the brief (`renderBrief`, no tail) without its `# <name>` line, lines joined
    ` | `, whole lines while ≤ LORE_SNIPPET, then ` | …` (a brief that is only the name → head of the
    full render); notes and arcs → excerpt around the first match of their text (M3 behaviour).
  - Texts changed: "This chat has no lore or Compendium entries to search.", "No lore or Compendium
    entry matches. Try …".
- read_lore C<n>: `C<n> <name> (<label>):\n<renderEntry(e)>` — full render, no freshness. A note is
  now its `noteText` (`[Memory: <title>]\n<text>`, D-156 literal; M3 gave the bare text), an arc
  `# [Arc] <plot>\n\n<overview>`. Retired / unknown → the existing "no such handle" line.
- `renderEntry` texts are cached per CEntry object (WeakMap; view entries are never mutated).
- READ_LORE_MAX, LORE_SNIPPET, LORE_HITS_MAX, READ_LORE_IDS_MAX unchanged.

### agents/compendium/export.ts
```ts
exportScope(view: PathView): CEntry[]                       // session entries + overlays, live and retired, handle order
exportCoreBook(view: PathView, name: string): LoreBook      // validated with validateLoreBook (throws on a bug)
exportCompendiumRows(view: PathView): CompendiumRowInput[]
class ExportLimitError extends Error { readonly limit: 'entries' | 'bytes' }
writeCompendiumFile(path: string, head: { name: string; exportDate: string }, rows: readonly CompendiumRowInput[]): void
```
Core book: `{name, match:'stem', entries}`; ids = the entry keys (unique by construction, deterministic).
- typed (summaries too): `{id, title: name, content: renderEntry, [enabled:false], [constant:true],
  keys: [name, ...aliases, ...e.keys] (deduped, blanks dropped), position:'after', [order],
  meta:{type, data+service fields, [aliases], [featured]}, [extras.disableReason]}`.
- note: `{id, title, content: raw text, keys (else [title]), position:{depth:4, role:'system'},
  scanDepth:4}`. arc: `{id, title:'[Arc] <plot>', content: overview, constant:true, keys:[],
  position:'after', meta:{arc}}`.
- retired → `enabled:false`, `extras.disableReason` = reason, `'retired'` when blank.
Rows: typed `{key, title: name, content: renderEntry, enabled, constant, keys (as core), type, data
(+ service fields, + `aliases` = e.aliases when non-empty), [featured], [disableReason]}`; arc
`{title:'[Arc] <plot>', content, constant:true, keys:[], arc}`; note classic `{title, content, keys}`.
Service fields (both shapes, on a copy): summary with `range` on the path → `turn_range {from: pos,
to: pos+1}` + `messages_covered`; each `memories[j]` record whose `prov.appended.memories[j]` is on the
path → `source_turn` = user messages at positions ≤ that message.
`writeCompendiumFile`: > 5 000 rows → `ExportLimitError('entries')` before touching disk; creates the
folder; opens `<path>.tmp-<n>` with `wx` (first free n, ≤ 10 000); streams `compendiumChunks`; passing
10 MB → `ExportLimitError('bytes')`, temp removed, an existing target untouched; fsync, rename over
`path` (replaces), best-effort dir fsync.

### fix 1 — agents/compendium/fresh.ts
`interface Visibility { cut: readonly [number, number] | null; pos }` (**`firstVisible` removed**).
`cut` = positions of `trimmed.from` and `trimmed.to`; `isVisible(id)` = on the path and not inside
`cut`. `to` unreadable / off the path → `cut: null` (all visible, as before); `from` unreadable or off
the path → 0 (the old behaviour); `from` after `to` → null. `visibleCopy` unchanged. No other src file
read `firstVisible`; `.notes/m5a-contract-render.md` §1/§3 still describes it (stale).

### fix 2 — formats/compendium-v1.ts
Typed row: `content` = RoleCall's text when non-blank, else `renderContent(type, data)` (headed by the
row title when the data names no name/title/topic, like `renderEntry`). `extras.content` is no longer
written. The seed ignores `content` (D-141 builds from meta), so the Compendium is unaffected.

## For the engine builder (wave 2) and the CLI builder (wave 3)

- `ToolCtx.compendium` must be the view's fold WITH the library seed, and `ToolCtx.lore` the routed
  sources (`routeBooks`) — as D-141/D-142 say. lore.ts binds `ctx.handles` itself on the first tool
  run (`new HandleTable()` in request.ts is fine; `new HandleTable(view.compendium)` also works).
- D-156 `unfiredLore` (a live typed entry the block did not inject) is the request builder's; nothing
  in lore.ts depends on it.
- `memoryExport({name, format, force})`:
  - core: `book = exportCoreBook(view, name)` → `saveToLibrary(home, 'lorebooks', name, book)`; the
    "existing id refused unless --force, then overwritten in place" rule needs a check before
    `saveToLibrary` (it never overwrites: it picks `id-2` on different content). `entries` =
    `book.entries.length`; `id` = `canonicalId(name)`.
  - compendium: `path = <home>/exports/<canonicalId(name)>.compendium.json`; refuse when it exists
    unless `force` (writeCompendiumFile itself replaces); `rows = exportCompendiumRows(view)`;
    `writeCompendiumFile(path, {name, exportDate: <engine clock ISO>}, rows)`; map `ExportLimitError`
    to `Refusal('invalid_params', err.message)`. `compendiumWarnings(rows)` (featured_dropped,
    too_many_entries) is worth printing. `id` = `canonicalId(name)`, `entries` = `rows.length`.
  - "view" = the head view (`compendium()` / `view()`), folded with the seed (overlays need it).
- `/memory export` prints the path; an empty scope still writes a valid (empty) file/book.

## Choices left open

1. Notes in read_lore now show `[Memory: <title>]` (D-156 "notes: noteText"); search snippets of notes
   and arcs stay around-the-match excerpts (not `renderBrief`, which for prose is just the head). Flip
   either in `compendiumDoc` / `snippetOf` if the lead prefers.
2. Typed export keys include the entry's own `keys` (library triggers, edited keys) besides name and
   aliases — a superset of D-163's `[name, ...aliases]` so an overlay keeps its triggers.
3. No `turnNumber` in the compendium rows: RoleCall's freshness hides a plot/event whose turnNumber ≥
   its live turn start, so this chat's turn numbers would hide them in a new RoleCall chat. (The
   required `turn_range`/`source_turn` have the same RoleCall quirk; kept as D-163 says.)
4. No `writer_source` stamped on memories (rolecall.md proposal; the fold does not record which agent
   filed an element).
5. search_lore lists session typed entries even with `compendium.enabled === false` (the view still
   folds them; the seed is empty, so library typed entries are then plain lore L rows).
6. Core book `match: 'stem'` (notes were stem-matched in the session); notes carry `scanDepth: 4`.
