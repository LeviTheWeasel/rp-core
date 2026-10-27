# M5a contract note — unit `render`

Files (all new): `src/agents/compendium/{render,fresh,tree,world}.ts`;
`test/compendium/{kit,fixture-book}.ts` (helpers), `test/compendium/{render,fresh,tree,world}.test.ts`.
Imports: `entry-types.ts` (deriveTagline, identityField, knownFields, ENTRY_TYPE_INFO), `notes.ts`
(noteText), `apply.ts` (normalizeName), `mention.ts`, `types.ts`, `session/{tree,view}.ts` (types),
`director/types.ts` (WorldBudget). No contract file was edited; none blocked.
Tests build CEntry objects by hand and a PathView without the fold (`test/compendium/kit.ts` `chat()`),
so they do not depend on apply.ts's fold.

## 1. Exported API

### render.ts
```ts
export const PRESERVED_PROSE = 'preserved_prose';
export const RENDER_HIDDEN: ReadonlySet<string>;  // writer_source source_turn source_job_id turn_range messages_covered preserved_prose
export const label: (field: string) => string;    // 'current_state' → 'Current state'
export function renderContent(type: EntryType, data: Rec): string;
export function renderEntry(e: CEntry): string;
export function renderBrief(e: CEntry, maxChars: number, tail?: string): string;
export function renderBriefParts(e: CEntry, maxChars: number, tail?: string): { text: string; tail: string };
```
### fresh.ts
```ts
export interface Visibility { firstVisible: number; pos: ReadonlyMap<string, number> }
export function visibilityAt(view: PathView, tree: TreeIndex, upTo: string): Visibility;
export function isVisible(vis: Visibility, id: string | null | undefined): boolean;   // the "vis(id)" helper
export function visibleCopy(e: CEntry, vis: Visibility): { entry: CEntry | null; dropped: number };
```
### tree.ts
```ts
export interface TreeNode { id: string; label: string; summary?: string; entryIds: string[]; children: TreeNode[] }
export interface DeriveTreeOptions { rootLabel?: string; categoryOf?: (e: CEntry) => string | undefined }
export const TYPED_THRESHOLD = 0.5, TYPED_MINIMUM = 5;
export function deriveTree(entries: readonly CEntry[], opts?: DeriveTreeOptions): TreeNode;
export function shouldUseTyped(entries: readonly CEntry[]): { use: boolean; typedCount: number; totalEnabled: number; ratio: number };
export function entryCountOf(node: TreeNode): number;          // entries on a node and below
export interface TreeStats { nodeCount: number; maxDepth: number; leafCount: number }
export function treeStats(root: TreeNode): TreeStats;
export const canonicalSeverity: (sev: string) => string;
export const severityRank: (sev: unknown) => number;
```
### world.ts
```ts
export const WORLD_RECENT = 6;
export const WORLD_CLIP = { description: 200, role: 60, state: 120, notes: 100, place: 160 };
export function worldSnapshot(view: PathView, budget: WorldBudget): string;   // '[COMPENDIUM CONTEXT]…' or ''
```

## 2. For the other builders and the engine wiring

- **Block (select/place, request builder):** one `const vis = visibilityAt(view, tree, upTo)` per
  request (U on `view.path`; the request view is folded at U). Per candidate `const r = visibleCopy(e,
  vis)`: `r.entry === null` → not a candidate; `trace.compendium.hidden = Σ r.dropped` (1 per hidden
  entry, else the list elements dropped). `full = renderEntry(r.entry)` (null when over the limit or
  lite). For `brief`/`briefTail` use `const p = renderBriefParts(r.entry, limits.briefChars, '(more:
  read_lore C12)')` → `brief = p.text`, `briefTail = p.tail` (`''` when nothing was left out). Both
  `p.text` and `p.text + '\n' + p.tail` fit `briefChars`, so place.ts can add the tail only in pass B.
- **Director (turn.ts):** `runDirector({..., worldSnapshot})` — the function as is, only when
  `compendium.enabled`. `view.compendium` must be the fold WITH the library seed (D-141); the snapshot
  reads it directly (live `character`/`location` entries, no freshness).
- **memoryTree:** session tree = `deriveTree(entries with origin.kind 'session')`; per readable book
  `deriveTree(entries with origin.kind 'library' && book === id, { rootLabel: <book name>, categoryOf })`.
  The seed CEntry carries no `extras`, so `categoryOf` needs a lookup the engine builds from the loaded
  books: `(libraryId, entryId) → extras.category`. Without it a book below the typed threshold gives
  one General node.
- **Tools:** `read_lore C<n>` → `renderEntry(e)`; the `search_lore` excerpt → `renderBrief(e, 200)` (no tail).
- **notes.ts:** `isNote` still counts arcs until the memory builder amends it (D-145). My code tests
  `e.arc !== undefined` before `e.type === null`, so it does not depend on that.

## 3. Choices the decisions note left open

### render.ts
- Fix 1 is applied everywhere (`lines()` skips hidden keys in any object); a list item or a section
  left with nothing to show is not printed (also a plain `{}` object: Bunraku printed a bare `## X`).
- Fix 4: a name/title/topic is skipped as a section when it supplied the heading or its value equals
  the heading; any other one stays (`event {name:'Siege', title:'The Long Night'}` keeps `## Title`).
- `renderEntry`: arc = `# [Arc] <plot>\n\n<overview>` (task text; the full form has paragraphs);
  the arc brief = `# [Arc] <plot>\n<overview>` (D-151 table). A typed entry whose data has no
  name/title/topic is headed by `e.name` (the identity field is filled in a copy before renderContent),
  so a library entry named by its lore title does not read `# Character`.
- `renderBrief` lines: `# <name>`; tagline = `e.tagline || deriveTagline(type, data)` (a summary shows
  only an explicit `data.tagline`, since its text is shown as `Summary:`); fields as `Label: value`,
  whitespace flattened, list items joined `; `. A list item that is a record shows its
  `name|title|topic|with|what_happened|description`, else its rendered keys. Character: `Role:`,
  `State: <status≠alive>, <condition>, at <location>`, `Relationships:` tense ones (status strained or
  nature rival/enemy) first, then stored order, ≤ 3, as `with (nature[, status≠active])`; `Memories:`
  the last 2 as `what_happened — changed_belief` (`changed_behavior` when no belief; `event` when no
  `what_happened`).
- "Something was left out" (the tail) = the text was cut, a list was capped, or the data holds a
  non-empty field the lines do not show whole (identity fields, aliases, tagline and RENDER_HIDDEN
  never count; `description` counts unless the tagline is all of it; a record or a list of records
  counts unless its keys are all shown: `current_state` ⊆ status/condition/location, relationships ⊆
  with/nature/status).
- Cut: lengths in UTF-16 units; the last line break or sentence end (`.!?…` + whitespace) inside the
  room, else the last space + `…`, else a code-point cut + `…`. `maxChars` is a hard bound; when the
  tail cannot fit at all (room < 1) the tail is dropped.

### fresh.ts
- "Reply" = any assistant message before U on the path (a greeting has no trace → 0); a hidden reply
  still counts (its request happened). Only `trimmed.to` is read (D-152): a protected head before
  `trimmed.from` counts as not visible.
- Unreadable cut → everything visible (0): `trimmed` not an object, `to` not text, `to` not on the
  path, no trace; U not on the path → 0. (RoleCall's branch-trim test idea: a malformed trim state
  never moves the window.)
- Only `type === null` (notes, arcs) short-circuits. Library entries need no special case: their
  `prov.created` and base `appended` slots are null. Overlay elements appended by filing rows ARE
  dropped while their message is visible (rolecall.md §8 q.2, per D-149).
- The copy is a `structuredClone`; `prov.appended[field]` loses the dropped slots; `tagline` unchanged.

### tree.ts
- Labels: Bunraku's ASCII per-word capitals are kept AND the first code point is upper-cased
  (`toUpperCase`, locale-free): `extinction_level` → `Extinction Level` (Bunraku parity), `закон` →
  `Закон`, `дух моря` → `Дух моря`. Cast orgs, event plots, place and plot names stay as written.
- Narrative plots sort by `localeCompare(b, 'en')` (Bunraku: the machine's default locale).
- Categories (names only): first-appearance order, ids `category:<encodeURIComponent(name)>`, General
  `category:general`; a category named "general" (any case) joins General.
- Typed ratio: notes and arcs (type null) count as untyped, as in Bunraku; a session of mostly notes
  gets the category tree (one General node). Retired entries are left out and do not count.
- Node ids: `root`, `bucket:<type>`, `bucket:unsorted`, `<type>/<encodeURIComponent(label)>`,
  `place:<entry key>`. `summary` is always set. No `kind`/`entryCount` on TreeNode (the lead's
  interface); `entryCountOf` computes counts.

### world.ts
- Mentions through mention.ts `entryMatchers` (task instruction): a library entry's non-regex lore keys
  also put it in the scene (D-157 text says name/aliases only). Each of the last 6 non-hidden path
  messages is matched separately (hidden ones are dropped before counting six).
- Equal ranks: library by `order` (undefined last), session by larger `prov.lastSeq`; a session entry
  against a library one falls to handle order, so library entries come first (the seed precedes
  session entries in the Map). An overlay is a library entry here.
- Fit: units are a character (with its relationships line), a tension, a location; taken first-fit in
  section order; `(+N more not shown)` on the last line, N = units skipped for `chars` (not entries
  beyond the count caps). '' when no unit fits or there is none.
- `clip`: whitespace flattened, code points, cut at a word when past half, trailing punctuation
  stripped, `…` (not an em dash).
- Tension pairs: the other side is resolved to a live character's key by normalizeName of its name or
  an alias, else `name:<normalized>`; the higher-ranked side's line is the one printed.
- A non-text `status` is not printed (Bunraku printed `Status: `); a missing `with`/`nature` prints
  `unknown` as Bunraku, but a missing `with` never makes anyone "related".

## 4. Deviations for the D-166 list (docs/COMPENDIUM-DEVIATIONS.md)
render fixes 1–4 (+ empty items/sections not printed); tree: Unicode first capital, normalizeName
places, `org ?? with`, 'en' collation, categories by name; world: B32 as built, C10 pair dedupe,
non-text status not printed, library lore keys count as mentions.
