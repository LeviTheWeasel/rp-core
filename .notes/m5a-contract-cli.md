# M5a contract note — unit `cli` (wave 3)

Decisions: D-160 (editor UX), D-161 (REPL commands), D-164 (`--keep-requests`), D-150 (handles), the lead's
rulings on the wave-2 questions. Nothing ported (no provenance note).

## Files

| file | change |
|---|---|
| `src/cli/repl-commands.ts` | `/memory list [type\|note\|arc] [--retired]`, `show`, `tree [book]`, `new <type> [name]`, `edit <ref>` (editor) and the M3 one-line note edit, `retire`, `restore`, `add`, `export <name> [--format core\|compendium] [--force]`; `commandClass` (list/show/tree read, the rest edit); `MEMORY_LATER` now a table (undo/refile/retry → `M5b (Compendium agents)`, recall/profile/mode → `M5c (recall)`); help |
| `src/cli/repl-memory.ts` | new, pure: the editor's JSON (`newEntryText`, `editEntryText`, `editBase`, `enumsOf`, `templateFields`), `parseEntryText`, `prune`, `namesOf`, `diffEntry` |
| `src/cli/repl.ts` | `/memory` over the session verbs (`memoryList/Get/Tree/File/Edit/Retire/Restore/Export`, `compendium()`); `memoryNew`, `memoryEditor`, `noteEditor` loops; `titles()` and `/trace` names from `memoryList` |
| `src/cli/repl-render.ts` | `renderMemoryList` (replaces `renderNoteList`), `memoryRowText`, `sizeText`, `renderEntryCard`, `renderMemoryTree`, `compendiumTraceLine`; `renderTrace(…, names?)`; memory side line |
| `src/cli/preview.ts` | note titles from `session.memoryList({type:'note'})` |
| `src/cli/commands.ts` | `rp-core show` folds with the library seed (`loadLibrary(...).seed`) |
| `src/cli/runtime.ts` | `Runtime.keepRequests` → `engineOptions().keepRequests` |
| `src/cli/main.ts` | `--keep-requests` on `new`, `chat`, `tui` (flags, usage, help); "(milestone M5a)" |
| tests | new `test/repl-m5a/{kit.ts, read, write, export}.test.ts` (24), `test/cli/keep-requests.test.ts` (3); pins updated in `test/repl/{repl, commands, m2-commands, m3-commands, m3-flows, m3-render, m4-commands, render}.test.ts`, `test/tui/e2e.test.ts` |

No file outside `src/cli/` was edited. The TUI needed no change (it runs the same REPL; its input edits in place).

## What the commands print

- `/memory` = `/memory list`: a header `The Compendium of this path: 15 live, 1 retired (/memory list --retired shows
  them) · /memory show <ref> prints one`, then groups in ENTRY_TYPES order by `ENTRY_TYPE_INFO.bucket` (`Cast (3)`,
  `Places (3)`…), then `Arcs`, then `Notes`; one line each, refs padded:
  `  C6  Серый маяк (aka маяк) — <tagline> [lib: lantern] [featured] [217]`. Overlay `[lib: <id>, edited]`, retired
  `[retired: <reason>]` / `[retired]` (dimmed; listed only with `--retired`, always counted). A note shows the start of
  its text and `· keys: …`, an arc `[Arc] <plot> — <overview start>`. Size: `n` below 1000, else `2.1k`. Empty:
  `nothing in the Compendium on this path yet: …`; filtered empty: `no character entries on this path`.
- `/memory show <ref>` (`memoryGet`, live first): a note keeps its M3 card; a typed entry or arc: `C6 Серый маяк ·
  location · lib:lantern:<id>`, `aka`, `origin` (book + entry, overlay; or `this session, written by you at journal
  row N` / `filed on message <id> …`, `last changed at row M`), `covers messages a … b` (summaries), `keys`, `former
  names`, `featured`, `retired …`, a blank line, then `render` indented by two.
- `/memory tree [book]`: `World Knowledge (this session) · N`, then `Lantern (lib: lantern) · 15`; nodes `label · N:
  C1 Name, …` (8 named, then `… k more`); a node that is one entry (a place with sub-places) prints as `C4 Вельмар · 3`.
- `/trace`: `  compendium: lite · picked 3: C16 "Мира" (mention), … · injected 3: C16 "Мира" brief 11 tok, … · cut by
  the budget k: … · already in the prompt k · n hidden by freshness · block N tok` (parts only when non-empty; zero
  picks → `nothing picked`). Names = the entries' names now (by the pick's key).
- Side line of a memory event: `⋯ memory: <kind> "<name>" <created|merged|overview written|added|edited|…>[ by <agent>]`.
- Confirmations name `<kind> C<n> "<name>"`: `character C16 "Мира" filed (from the next turn)`, `… changed: set a, b;
  removed c (from the next turn; the book file stays as it is)`, `… retired: it leaves the story: no block, no lore
  tools (/memory restore C6 brings it back)` (a note keeps M3's `it no longer fires`). Export: `exported 3 entries as
  the library lorebook <id>: <path>` / `… as a RoleCall Compendium file (compendium-v1.0.0): <path>`.
- Errors are one red line, the engine's words after `/memory <sub>: `. Wording chosen for lookups: the engine's
  `no single entry matches "C9" (use its C<n> handle or key)` for show and edit alike (M3 said "note").

## Editor flows (D-160)

- `/memory new <type> [name]`: a name that matches a live entry of that type (the fold's `entryNames`: name, aliases,
  former names, normalizeName) is refused before the editor: `/memory new: "Мира" is already C16; use /memory edit
  C16` (by an alias: `"маяк" is already C6 (Серый маяк); …`). Template: `{"//": help, <templateFields> empty by kind}`
  (`[]` lists and aliases, `{}` objects, `""` else; summary: SUMMARY_TEMPLATE). Help: `fill what you know; blank fields
  are ignored. role: a|b; current_state.status: …; relationships[].nature: …; relationships[].status: …;
  memories[].emotional_weight: …` (enums of the fields plus the NESTED ones of each field).
- Save: JSON → must be an object → `//` stripped → `prune` (blank strings, null, `[]`, `{}` at every depth) → the
  names (identity + aliases) are checked again → `memoryFile`. A JSON error, a non-object, a taken name or a refusal:
  one line `…; the editor opens again`, and the editor opens on the text that failed. A cancelled editor →
  `cancelled: nothing written`; empty text or the text it was opened with → `nothing changed, nothing written`
  (so saving a failed text again gives up).
- `/memory edit <ref>` alone: a note → its text; a typed entry → `{"//": help, <identity>, aliases, ...data}`
  (identity = the data's, else `e.name`; aliases = the entry's own list, shown when it has some or the type's
  template has them); an arc → `{"//", overview, ...data}`. `diffEntry` compares pruned objects: new/changed → `set`
  (an arc's `overview` → `set.content`), gone → `unset`; aliases emptied → `unset: ['aliases']`. No diff → nothing
  written. Re-open rules as for new.
- `/memory edit <ref> <title> | <keys> | <text>` stays a note's; on a typed entry or arc it says to use the editor.

## Choices and deviations

1. **Note and arc size** = their text length in the list (lead's ruling), computed in `memoryRowText` from the entry
   when the row is a note or an arc: the engine's `MemoryRow.size` is still `JSON.stringify(data).length` (= 2 for
   them) in `src/engine/session.ts:293`. Once the engine follows the ruling the CLI's branch is a no-op.
2. **`rp-core show`** prints no handles; it now folds with the seed anyway (as asked), at the cost of reading the
   session's library books (no lock involved).
3. `/memory list` accepts plurals (`notes`, `characters`, `summaries`); `/memory --retired` lists too.
   `/memory tree <book>` (memoryTree's `book`) added. `[featured]` tag shown (MemoryRow has it).
4. The export refusal for an existing target gets a CLI hint appended: `… export with force to overwrite it
   (/memory export <name> --format <f> --force)`.
5. Help's "Later" line: `Later: /memory undo|refile|retry (M5b, the Compendium agents), /memory recall|profile|mode
   (M5c, recall).`; `later` replies `/memory undo arrives with M5b (Compendium agents)`.
6. `--keep-requests` is refused by `send`/`preview` (only chat, tui, new per D-164); it travels as
   `Runtime.keepRequests` so every engine the chat opens gets it.

## What the docs need (lead)

- README: the Notes section (≈ :335, :938–:968) describes M3's notes-only `/memory`; the `/memory` table, the "rest of
  `/memory` comes with the Compendium in M5" sentence, and the command list need the M5a set; `--keep-requests` for
  chat/tui/new. `test/cli/review-m3.test.ts:178` pins one README sentence (unchanged by me).
- docs/M3-DEMO.md:220 shows the old list header (`notes on this path: 1 live (…)`); the new one is `The Compendium
  of this path: 1 live · /memory show <ref> prints one` + `Notes (1)` + the line with `[size]`.
- ARCHITECTURE.md §7.4.8 "Что работает сейчас (M3)" and §12.4 (REPL list, "остальные подкоманды /memory … придут с
  M5"), §15 M5a; the CLI help strings above.

## Open questions

1. keep-requests `-2`/`-3` suffixes (ruling) and `MemoryRow.size` of notes/arcs (ruling) are engine changes
   (`src/engine/turn.ts:244`, `src/engine/session.ts:293`) — not in my files, not done here.
2. Should `/memory new` warn when `compendium.enabled === false` (the entry folds, no block reads it)? Not done.

## Fixes after the review (fix-cli; the lead's rulings in m5a-decisions.md §H)

Supersedes the lines above where they differ. Files: `src/cli/{repl.ts, repl-commands.ts, repl-render.ts, main.ts}`;
tests `test/repl-m5a/fixes.test.ts` (new, 14), pins in `test/repl-m5a/{write,export}.test.ts`,
`test/repl/{m3-flows,m3-commands}.test.ts`, `test/cli/keep-requests.test.ts`; `test/repl/kit.ts` rig takes `env`.

- **`/memory on|off`** (engine#3): `Command {name:'memory', action:'on'|'off'}` (edit class, refused mid-turn);
  `configure({compendium:{enabled}})`; state = `resolveCompendium(configOf(journal).compendium).enabled`. Lines:
  `the Compendium is on for this session: N live entries on this path, sent as they come up from the next turn
  (/memory lists them)`, `COMPENDIUM_OFF` (+ `; the books' typed entries are sent as plain lore` when the session
  has books), `the Compendium is already on|off …`. Help: `/memory on|off`; the unknown-subcommand error lists
  `…, export, on, off`.
- **While off** (`COMPENDIUM_OFF` = `the Compendium is off for this session: entries are kept but not sent
  (/memory on)`, exported from repl.ts): `/memory list` prints it (yellow) above the list; new/edit say
  `<what> filed; COMPENDIUM_OFF`, `… changed: set x; COMPENDIUM_OFF`; retire `… retired (/memory restore Cn brings
  it back); COMPENDIUM_OFF`; restore `… restored; COMPENDIUM_OFF`. Notes keep their M3 lines (notes are sent
  either way).
- **No-op verbs** (`MemoryWrite.changed === false`): `/memory edit: nothing changed, nothing written` (one-line
  note edit, editor edit, note editor), `/memory restore: "<name>" is not retired; nothing changed`, `/memory new:
  nothing changed, nothing written (<kind> Cn "<name>" already holds all of it)`. No success line, no row.
- **Notices** (engine#2): every write verb's `notices` print after its confirmation, one line each
  (`! <message> (<code>)`, yellow, through `notice()`). `notice()` now dedupes `compendium_large_entry` and
  `library_entry_missing` by code + message (the engine already tells them once per entry), so a turn with two
  entries' notices shows both; other codes stay once per code per session.
- **Export warnings** (fidelity#5, breaker#10): after the export line, `  ! <message> (<path>)` per warning
  (yellow), as an import's warnings print.
- **Editor after an error** (engine#5): the editor opens again only when `source.interactive` or the REPL has
  an editor of its own (`ownEditor`: a named $VISUAL/$EDITOR, or the host's `editText`); otherwise `…; nothing
  written` and the command ends. In-place editing on a non-interactive source now takes an already-queued line
  as the text (a piped script's lines are often queued before the command runs; before, the editor waited and
  the line ran later as story text), and a queued end of input cancels it. This also applies to `/e`.
- **`/lore rm`** (engine#8) of a book the Compendium reads: `lorebook X removed (from the next turn; it stays in
  the library); its N Compendium entries leave /memory now[, and the C<n> of the entries after them change][;
  this session's changes to K of them are kept and come back if the book returns (/lore add X)]` (K = overlay
  rows). Off, an 'off' book or no typed entries: the M2 line alone. `/lore add` is unchanged.
- **`/trace`** (prompt#8): `splitCompendiumCut(trace)` (repl-render.ts, exported) walks `picks` (placeBlock's
  candidate order) counting injected ones: a cut row after the block held `COMPENDIUM_LIMITS[profile].maxEntries`
  is `over the entry limit (lite: 6) k: …`, the rest `cut by the budget k: …` (both parts when both occur).
- **`--keep-requests` help** (engine#6): "the engine's provider-level request for each model call (messages,
  tools, samplers), not the HTTP body (/preview --wire shows that), never headers or keys".

## Fixes after the final check (fix-cli-2; the lead's rulings in m5a-decisions.md §I)

Supersedes the lines above where they differ. Files: `src/cli/{repl.ts, repl-commands.ts, repl-view.ts,
repl-render.ts}` (the last two: comments only); tests `test/repl-m5a/final.test.ts` (new, 11), pins in
`test/repl-m5a/write.test.ts` (arc line), `test/repl/{m3-commands,m3-flows}.test.ts` (edit parsing),
`test/demo-m5a/lantern.test.ts` (b: the /lore add line, which docs/M5A-DEMO.md already shows).

- **Notices on every path** (engine#2 remaining): the `!changed` branches (restore of a live entry, the
  one-line note edit, the note editor, the entry editor, `/memory new` that merges nothing) print the
  verb's `notices` after their "nothing changed" line; the engine has marked them told either way.
- **Dedupe** (`notice()`): one key, `code + "\0" + message` (the redacted message), for every code;
  `PER_ENTRY_NOTICES` is gone. Two missing books are two `lorebook_missing` lines; the engine still tells
  each keyed notice once per open session.
- **`/lore add`** of a book the Compendium reads: `lorebook X "N" added: k entries (from the next turn); its
  M Compendium entries join /memory now[, and the C<n> of the entries after them change][; this session's
  changes to K of them apply again]` (`bookJoins`: the list before the configure against the list after;
  "change" only when a handle that existed before moved; K = overlay rows of the book). A book that
  replaces another (same name): `…brings the old one back); <old>'s M Compendium entries leave /memory and
  <new>'s M' join it now[, …]`. Off, an 'off' book, no typed entries: the M2 line alone.
- **Piped input** (`skipEditorLine`, only on a non-interactive source with in-place editing): a `/memory
  new <type> <name>` refused for a taken name, a `/memory edit <ref>` whose ref resolves to nothing, a
  parse error of `/memory new …` or a bare `/memory edit` (EDITOR_FORM), and the in-place editor's own
  `⏎` refusal take the next line (queued or still to come) and say `(the next line, meant for the editor,
  was skipped)`. A queued end of input takes nothing. The `⏎` refusal is inlineEdit's, so `/e` of a message
  holding `⏎` in a pipe skips its line too.
- **`/memory edit <rest>`**: without a `|` the whole rest (outer quotes removed) is the ref and opens the
  editor (`/memory edit Серый маяк`); with one it is the M3 note form, ref = first word or quoted. So
  `/memory edit C3 New title` (no `|`) is now the ref "C3 New title"; a title-only change is `… New title |`.
- **While off**: `/memory list note` prints no off line; `/memory list` (all) and `/memory off` print
  `COMPENDIUM_OFF_NOTES` = `the Compendium is off for this session: typed entries are kept but not sent;
  notes still are (/memory on)` when the path has live notes, else `COMPENDIUM_OFF`; a typed or arc filter
  keeps `COMPENDIUM_OFF`. Confirmations of typed entries keep `COMPENDIUM_OFF`.
- **Arc editor confirmation** names the field the editor shows: `changed: set overview` (memoryEdit still
  gets `set.content`).
- **fidelity#4**: `/memory new location` opens the template whose help line ends `type: city|…|plane;
  current_state.status: normal|under_attack|destroyed|abandoned|occupied|sealed|hidden` (pinned).

Open (not ruled, not done): `/memory retire <two words>` still takes the first word as the ref and the
rest as the reason (`/memory retire Арсений Кеттер` retires C1 by its alias with reason "Кеттер"); a
pretty-printed multi-line JSON after `/memory new` in a pipe still gives the editor only its first line.

## The lead, after round 2
- `/memory retire <name of several words> [reason]` is done (repl.ts `retireTarget`): the longest run of
  leading words that names a live entry is the ref, the rest the reason; a C<n> keeps the parser's split.
  Test: test/repl-m5a/final.test.ts "/memory retire <name of several words> [reason]".
- `/memory edit <handle or key> <title>` stays M3's title-only rename (repl-commands.ts `handleFirst`);
  `/memory edit <name with spaces>` without '|' is the editor form.
