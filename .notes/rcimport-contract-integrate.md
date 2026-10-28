# RoleCall story import — contract note, unit `integrate` (D-185…D-194, rulings after wave 1)

Builds on the wave-1 units (zip, story, director). Zero new dependencies. No absolute paths, no data
from the user's export in any file below.

## Files

| file | what |
|---|---|
| `src/formats/rolecall-import.ts` (new, pure) | `planStoryImport`, `sessionJournal`, `rcSessionId`, `rcIsoTime`, `StoryImportError` |
| `src/cli/import-story.ts` (new, I/O) | `storyArchive`, `cmdImportStory`, `groupWarnings` |
| `src/cli/commands.ts` | `cmdImport` routes a ZIP with a `manifest.json` to the story importer before generic detection; story-only flags on another file are a usage error |
| `src/cli/main.ts` | `import` flags `--chat --model --compendium --dry-run --new --keep-raw` (+ `--as`, `--json`), usage and help; config.toml loaded lazily, only for a story |
| `src/formats/import.ts` | generic detection refuses with a reason: any other ZIP, RoleCall's account backup (`format: "rolecall-backup"`), a bare `story.jsonl` |
| `src/formats/st-preset.ts` | parity fix (ruling 1): in a RoleCall export a custom marker that carries text is sent |
| `src/formats/rolecall-story.ts` | ruling 3: "messages" context mode → `preset.context.maxMessages = N + 1`; `bookHash` exported (re-import reuse) |
| `test/rcimport/integrate.test.ts` (new) | 17 tests (below) |
| `test/rcimport/story.test.ts` | the context-mode test updated to the ruling, one test added |
| `test/formats-m2/st-preset.test.ts` | one test for the marker fix |

## Command

```
rp-core import <story.rolecall> [--chat main|all|<id prefix>[,…]] [--model conn:model]
               [--compendium on|off] [--as title] [--dry-run] [--new] [--keep-raw] [--json]
```

- Detection (`storyArchive`): `PK\3\4` + `openZip` + a `manifest.json` member → the story importer
  (parseStory then names a manifest of another format). A ZIP that cannot be opened: `import failed:
  <file>: not a readable ZIP archive (…)`. Everything else → the generic importer, unchanged.
- stdout: one line per library item (`kind id state "name" · detail`, state `new` / `same (already
  in the library)` / `reused (an equal book)`) and per session (`session id new "title" · N messages
  (V versions) · head <id> · director on|off[, its state at turn T] · compendium on from the import|off
  [· fork of <id>]`). stderr: `dry run: nothing was written`, skipped chats, the warnings grouped by
  code + text with `(×n)`, then the hint `rp-core chat <id>` / `rp-core tui <id>` and, without
  `--model`, the narrator the session got. `--json`: `{dryRun, library[{kind,id,name,state}],
  sessions[{id,chat,title,messages,versions,head,narrator,director,compendium,fork?}], skipped,
  warnings[{code,message,count}]}`.
- Exit: 0; 1 for a refusal (`import failed: …`: no character card, --chat names nothing or is
  ambiguous, already imported, unreadable zip, parseStory's why); 64 for a bad flag value
  (`--compendium maybe`, `--model` not conn:model or an unknown connection, story flags on a card).

## Pure planner — `src/formats/rolecall-import.ts`

```ts
planStoryImport(bundle: StoryBundle, opts?: { chat?: string; compendium?: boolean; title?: string;
  config?: DeepPartial<SessionConfig> }): { items: PlannedItem[]; sessions: PlannedSession[];
  skipped: { chatId; why }[]; warnings: ImportWarning[] }        // throws StoryImportError
sessionJournal(s: PlannedSession, ctx: { id; now; preset?; lorebooks; fork?: { from; at } })
  → { header: SessionHeader; entries: EntryInput[] }
rcSessionId(chatId, n = 1)   // 's_' + 8 hex of sha256(chat id); n ≥ 2: sha256(chat id NUL n)
```

- Items, in write order: character (parseStory's card reading, validated), persona (`personaFromRow`),
  preset (`presetFromRow`, the row as RoleCall stored it), per chat whose own settings change it a
  copy `<preset> (<session title>)`, then the books (`booksFromRows`) with their hash. Every value is
  validated before it is planned.
- Chats: `main` (default) = `bundle.mainChatId`; `all` = every chat in manifest (BFS) order, a chat
  whose `fingerprint` equals an earlier one's is skipped (`skipped`); otherwise comma-separated id
  prefixes (case-insensitive; none / several matches refused). A chat without messages is skipped.
- Per session: header `title` (`--as`, else the main chat's title, else the character's name; other
  chats: their own title, else `<story> · <branch name | chat id8>`), `created` = chat `created_at`
  (Postgres text parsed), `imported {from:'rolecall', chat, exportedAt}`, `cast {character,
  persona?}`, config = DEFAULT ← config.toml session defaults ← `--model` ← `{director: {enabled,
  style?}, compendium: {enabled: false}}`, then `preset` and `lorebooks` (library ids) at write time.
  Entries: `chatMessages` (the preset's CoT tag passed as `extraTags`), `dir` on the head reply and
  the reply before it, `hide` per `plan.hidden` (none today), a `head` entry when `headMove`, and with
  the Compendium on the closing `config {compendium: {enabled: true}}` (its seq = the enable moment;
  ts = the import time; the others carry the last message's ts).
- Director: `directorSettingsFor(chat.config).director` (RoleCall's rule; no model stored, so the
  Director follows the narrator). With a dm-context: turn = user messages up to the head reply
  (`PlannedMessage.users`), `turnAt` from the user messages' timestamps (binary search),
  `directorRecordsFor(state, turn, {analysis, beforeTurn: users up to the reply before})`; the
  `before` record goes on the previous assistant message on the path (the one a replan walks to).
- Books: a chat's enabled `active_lorebooks` ids → the item that lists them in `rcIds`, deduped, in
  RoleCall's order; ids not in the export → `rc_book_missing`.
- Branch fork: a chat with a parent and `branch_point_index` ≥ 1 whose first bpi messages equal the
  parent's by `contentHash` is re-planned with `prefixFrom` (the parent's own prefix salt when it has
  one); if the active ids then equal the parent's, `fork {chatId: parent, at: parent's message bpi-1}`.
  Otherwise `rc_branch_detached` and its own ids.
- Not carried, one warning each for the imported chats: `rc_tracker` (n), `rc_storyboard` (n, rows),
  `rc_chat_summary` (n, chars), `rc_modules` (TunnelVision, immersion modules, mind, agent loop). Plus
  `rc_no_persona`, `rc_no_preset`, `rc_preset_missing`, `rc_persona_other`, `rc_book_missing`,
  `rc_book_unreadable`, and every wave-1 warning passed through.

## I/O — `src/cli/import-story.ts`

- Members are read lazily from `openZip` (a generator over the entries); `story.jsonl` is never read.
- Session ids: `rcSessionId(chat)`; the file exists and its header line (read in chunks to its
  newline) says `imported.chat` = this chat → refused unless `--new`; `--new` (or a file of another
  chat) → the next `rcSessionId(chat, n)` that is free. Checked for every session before any write.
- Library ids: the same walk as `saveToLibrary` without writing (`peekSlot`: an identical file is
  `same`, ids claimed earlier in the run count); a `new` lorebook whose library namesake (trimmed name)
  has the same `bookHash` is `reused` instead of a `-2` (ruling 7's identity).
- Every header (`checkHeaderForCreate`) and entry (`parseEntry`) is checked before anything is
  written; `--dry-run` stops there. Then the `new` items (`saveToLibrary`), then each journal
  (`createSessionLogWith(...).close()`), then `--keep-raw`: the chat's `tracker.json`,
  `storyboard.json`, `dm-context.json` bytes → `<home>/imports/<session id>/`.

## Rulings implemented

1. `st-preset.ts`: `markerWithText` = marker + text and (plain ST with `system_prompt: false`, or the
   D-71 path). An empty custom marker stays `unknown_marker`, disabled. Plain ST unchanged.
2. Emptied answers: unchanged from `chatMessages` (reasoning block + empty text).
3. `rcPresetExport` returns `maxMessages` and `presetFromRow` sets `context.maxMessages`: mode = the
   chat's `contextMode` ('tokens'|'messages') else the preset row's `system_prompts.context_mode`; N =
   the chat's `maxMessages` (≥ 0) else the row's `max_messages` (> 0, RoleCall's loader rule);
   messages mode with an N → N + 1, `rc_context_messages` says so; a change against the row's own
   setting marks the copy overridden. The old `not_honoured` line for it is gone.
4. DM notes: dropped by import-rc (`rc_director_dropped`).
5. `turnAt` passed.
6. Director: RoleCall's rule; no `rolecall:` model in records or config.
7. Book identity: booksFromRows' hash (ids, extras, row order, name aside) — also the reuse key.
8. Lazy members, no `story.jsonl`.

## Tests (TMPDIR=… bun test test/rcimport test/formats-m2)

`test/rcimport/integrate.test.ts`, 17 tests, synthetic export only (kit.ts):
- spawned CLI: dry run writes nothing (home not created); import → library + one session, `show`
  works; second import exit 1 `already imported as`; `--new` → a second session, items `same`, no
  `-2`; account backup and a bare story.jsonl refused with reasons; `--chat` on a card → 64.
- in process (`cmdImport`, `planStoryImport`, `sessionJournal`): main only by default (header,
  `imported`, Director on with the chat's style, narrator from config, no `rolecall:`); persona and
  preset copy in the session (toggles on the copy only); swipes as siblings in swipe order, RoleCall's
  active swipe on the path (incl. a non-last one), the opener as greeting; think split (unclosed and
  closed); head + `head` entry when a later swipe was written last; `dir` on path[9] and path[11],
  `directorAt` at the head = turn 5, a replan reads turn 4 without directive; books deduped (3 of 4)
  and attached in order, consumed rows disabled, `[Arc]` rows = `memoryList({type:'arc'})`;
  enable moment = the closing config seq, `memoryStatus` owes nothing, `preview()` builds;
  `--compendium off`; `--chat all` (the copy skipped, the detached run its own session, the matching
  branch a fork with main's prefix ids, three preset copies); `--chat <prefix>` + unknown + ambiguous;
  a second export (other ids) reuses the books; `--as`, `--keep-raw`, `--model` (bad and good);
  `--json` and non-story ZIPs; the not-carried warnings.
- size: 1 200 messages import in ≈ 0.1 s (bound 3 s), open + view + memoryStatus ≈ 30 ms (bound 500).

Runs: test/rcimport 97 pass + 1 skip (the opt-in real-export zip test); test/formats-m2 107; test/cli +
test/formats + test/purity 487; test/parity 144; `bunx tsc --noEmit -p .` clean.

## The user's export (counts only; temp home, deleted after)

- Dry run (main): exit 0, nothing written; 1 character, 1 persona, 2 presets (the row + the chat's
  copy), 5 lorebooks (8 in the export, 3 identical copies merged); 1 session: 809 messages, 837
  versions (28 tails), Director on, state at turn 402, 2 records, compendium on. `--chat all`: 3
  sessions (809, 3, 282 messages), 1 skipped (exact copy), 4 presets, no fork (`rc_branch_detached`
  ×1: the branch's prefix differs), `rc_preset_missing` ×1.
- Import (main, in process): 0.83 s; journal 1.9 MB, 838 entries (837 msg, 2 with `dir`, 1 config);
  5 books attached; enable moment = the config entry. A second import: exit 1, refused.
- Warnings (main): 56 lines over 23 codes — unknown_marker 14 (empty custom markers), not_honoured 8,
  rc_director_dropped 6, marker_disabled 5, rc_book_consumed 3, rc_book_duplicate 3, and one each of
  rc_hidden_unavailable, rc_images_unavailable, unknown_field, rc_preset_settings, rc_export,
  unknown_macro, rc_reasoning_split, rc_reasoning_tag, rc_preset_overrides, rc_director_derived,
  rc_director_refs, rc_director_details, rc_director_fit, rc_tracker, rc_storyboard,
  rc_chat_summary, rc_modules.
- Open (lane manual, scripted connection, no model call): session + view + memoryStatus 70–100 ms;
  path 809, tails 28; memoryList 849 rows in 3–4 ms (arc 48, event 207, character 169, location 92,
  plot 88, worldbuilding 82, organization 52, item 48, threat 29, power 18, creature 11, summary 5);
  memoryStatus: queued 0, backlog 0, parked 0, nothing running or blocked.
- Preview: at an 8 192 window refused `context_length_exceeded` (the preset and lore alone exceed it);
  at 65 536: ok (a swipe of the head), 104 messages, 49 890 tokens estimated (o200k), history trimmed,
  lore 54 fired / 932 cut, Compendium block 12 entries, {{recap}} 48 arcs, Director block present,
  notice lore_unsent; the preview took 1.3–1.5 s. Provider calls: 0.
- The marker fix on this preset: 19 custom markers carry text, 5 of them enabled (sent now; before:
  disabled with unknown_marker). Token context mode: no maxMessages.

## Deviations

- Fork header only when the parent chat is imported in the same run (it is provenance: the lane uses
  `fork` only for a header created with the Compendium on). A matching prefix also needs equal
  message ids (RoleCall's chunk copy keeps them; its legacy copy writes new ids → separate session).
- The plain preset is always a library item; the persona is also saved to `library/personas`; every
  book of the export is saved, not only the imported chats' books.
- A chat whose preset / persona is not in the export gets the story's (warned), the preset with that
  chat's own sampler settings as a copy.
- Book reuse needs the same trimmed name as well as the same hash (so "read once by name" cannot
  shadow a reused book).
- `--new` ids are deterministic (`rcSessionId(chat, 2…)`), not random.
- `--keep-raw` copies tracker, storyboard and dm-context, not chat.json.
- `--json` added; any ZIP with a manifest goes to the story importer (parseStory names the format).
- RoleCall protects no greeting in its message window; rp-core's limit counts the greeting it keeps.

## Open questions

1. The marker fix covers RoleCall exports (D-71 path) only. ST files "born in RoleCall" (rcBorn:
   `prompt_post_processing`, `{{message_history}}`) still disable a custom marker with text, though
   their header says they are read as RoleCall reads them. Extend?
2. 14 `unknown_marker` lines for empty custom markers on one preset: fold them into one?
3. Preview of the imported story costs 1.3–1.5 s (lore over five large books, 932 entries cut); not
   the importer's, but the first turn will pay it. Worth a look in the lore engine.
4. A branch imported later (`--chat <branch>` after the main) gets no fork header even though its ids
   match an imported parent; link to an existing parent session?
5. Branches copied with new message ids (RoleCall's legacy path) could take the parent's ids by
   position to become forks; not done.

## Provenance (references, no code taken)

- `st-preset.ts` marker fix: RoleCall:apps/rc/src/lib/ai/preset-loader.ts:542 (`enabled && (content
  || marker)`) @ fb8dc623e.
- `rolecall-story.ts` context mapping: RoleCall:apps/rc/src/lib/ai/preset-loader.ts:426-447
  (`system_prompts.context_mode` / `max_messages`), lib/ai/jobs/message-context-window.ts (the
  window), hooks/scene/useSamplerConfiguration.ts:396-410 and lib/groups/sampler-config.ts (the
  chat's override) @ fb8dc623e.
- `import.ts` backup refusal: RoleCall:apps/rc/src/lib/backup/types.ts:36 (`BACKUP_FORMAT_NAME`);
  story.jsonl manifest line: lib/scenes-export/per-chat-export.ts:308-316 @ fb8dc623e.

## Review fixes — CLI (robust#1, #6; ux#3…#8; D-195's import half; fidelity#4's note)

Files: `src/cli/import-story.ts`, `src/cli/commands.ts`, `src/cli/main.ts` (help), `src/formats/import.ts`
(a comment), `test/rcimport/integrate.test.ts` (+12 tests; `imp` is async now).

- **All or nothing (robust#1).** Everything is planned and checked first (ids, slots, each journal's
  bytes as `createSessionLogWith` writes them, every line through `parseEntry`). `StagedWrites`
  (exported for tests) writes each new library item, each journal and each `--keep-raw` folder under a
  dotfile temp name beside its place (`.<name>.<pid>-<n>.import.tmp`: no clock, no randomness; the
  library, `sessions` and `imports` listings skip it) and fsyncs files; `publish()` then puts them in
  place in order — files by hard link (never overwrites; a rename after an existence check on
  filesystems without links), folders by a rename onto a free name — and fsyncs the folders. Any
  failure → `discard()`: temp names, everything published and the folders the run made (when empty
  again) are removed, then `import failed: <why>; nothing was imported` (exit 1). Items `same` /
  `reused` are never written. A place taken between the plan and the end fails the run ("appeared
  while importing; run the import again"); `saveToLibrary`'s move to the next id is not used any more.
  The journals no longer go through `createSessionLogWith` (same bytes, no lock taken).
- **Refusal reasons (robust#6).** A planner refusal gets the parser's warnings on the card and the
  chosen chats (`rc_character_unreadable`, `rc_missing_member`, `rc_bad_line`, `rc_unreadable`; at
  most three, `; N more`). `parseStory`'s "holds no chat" gets each chat folder's fault, found with the
  three checks `readChat` makes (no chat.json, not JSON / not an object, no id) — a CLI-side copy,
  because `parseStory`'s `{ok:false}` carries no warnings (moving them into the failure branch of
  `StoryParse` would let this go).
- **Warning subjects (ux#3).** `groupWarnings(ws, subjectOf)` groups by code + text and returns
  `{code, message, count, paths, subjects?}` (`--json` too); text: `warning: <subjects>: <message>`,
  `(×n)` only when it came more often than its subjects. Subjects: a session id, or `lorebook <id>`,
  `preset <id>`, `persona <id>`, `character <id>` (library ids). Sessions (two or more): the planner's
  list is the story's own warnings, each session's block in order, then the not-carried tail (paths
  `chats/*/…`); planning each session alone gives each block's length (story part g = (Σ singles −
  all) / (n − 1)); the split is checked against the single plans and a list that does not split keeps
  its warnings unnamed. Items: what the card reading, `personaFromRow`, `presetFromRow` and
  `booksFromRows` say about each, matched in order (`lorebooks[i]` paths → that row's book). A
  planner-side tag per warning would replace both matchers.
- **--chat (ux#4).** Resolved in the CLI before the planner (which gets `main`, `all` or full ids):
  `main`/`all` in any case; `main` may stand in a comma list, `all` only alone ("--chat all already
  takes every chat; give it alone"); a prefix naming none or several lists `id8 "title" (N messages)`
  (all chats for none). Session lines show `chat <id8>` after the title; skipped lines the title.
- **Imported before (ux#5).** Without `--new`, a planned chat whose session exists (`importedAs`: the
  first `rcSessionId(chat, n)` whose header names it) is skipped with `skipped chat <id8> "title":
  already imported as s_…` and the rest is planned again without it; when every planned chat is
  imported the run is refused as before, plus `--chat all imports the chats not imported yet` when the
  choice was not `all` and such chats exist. A branch whose parent chat is not in the run links its
  `fork` to the parent's earlier session when that journal holds the branch point; otherwise
  `rc_fork_unlinked` (subject the session). This replaces deviation 1 and open question 4.
- **Unreadable path (ux#6).** `cmdImport` (now async) refuses a file it cannot read at once:
  `import failed: cannot read <file>: <reason>` (exit 1), before the story flags are looked at.
- **ZIP without manifest (ux#7).** `storyArchive` refuses it itself: `a ZIP archive with no
  manifest.json at its top[ (one is inside <dir>/: the archive was repacked)]; the only archive
  rp-core imports is a RoleCall story export, which has one: import the .rolecall file as RoleCall
  exported it`. `import.ts`'s ZIP reason (with its `rp-core import <file>` advice) now only reaches
  the other callers (`new --card`, `/preset`, `/lore add`).
- **--keep-raw (ux#8).** One stderr line per session: `kept <files> of <session> in <dir>` (`would
  keep` in a dry run); `--json` gets `kept[{session, dir, files}]`. The folder is
  `<home>/imports/<session>` or, when that exists, `<session>-2`…. With the flag the tracker and
  storyboard lines end `(a copy is in <home>/imports/)` (dry run: `(--keep-raw puts a copy in …)`)
  instead of advertising it.
- **Fit check (D-195, the import half).** After the writes, with a runtime (the CLI always has one;
  in-process callers without `rt` skip it): one engine in lane manual, each session opened and
  `preview()` built (a swipe of the head; a reply to an empty draft when only a greeting is there);
  nothing is sent, nothing written (no lock left). `context_length_exceeded` → warning
  `context_length_exceeded` (subject the session): `the story does not fit its narrator <conn:model>:
  its next request needs about N tokens, but only M are available (window W - reply reserve R), so
  every turn would be refused; choose a narrator with a larger window (/model in the chat, --model
  when importing) or the built-in layout (/preset builtin); \`rp-core preview <id>\` shows the parts`.
  Other refusals are the chat's to report; an exception → `fit_unchecked`. No check in a dry run
  (nothing to open).
- **Compendium start (fidelity#4's line).** With the Compendium on, one warning per session,
  `rc_compendium_start`: `the Compendium starts after the imported N turns: it files and summarises
  new turns only; …` — RoleCall's newest `tv_summary` row of that chat in the session's books
  (`extras.metadata.turnNumber`) gives `RoleCall's summaries in the lorebooks reach turn T, so turns
  T+1–N are summarised nowhere (the history keeps them while they fit)`; without such rows `the
  imported ones stay in the history and the lorebooks`; T ≥ N: `… cover the imported ones`.

Runs: test/rcimport + test/cli + test/formats 595 pass + 1 skip (was 583 + 1); `bunx tsc --noEmit -p .`
clean. The 12 new tests fail on the code before these fixes (checked on a copy).

The user's export (temp home, deleted after; counts only): main import 2.9 s including the fit check;
with a 16 384-token narrator the fit warning reads need 40 113, available 8 384 (window 16 384 − reply
reserve 8 000); the Compendium line says turns 365–402 are summarised nowhere (RoleCall's summaries
reach turn 364 of 402). `--chat all` afterwards: 2 more sessions, 1 skipped as a copy, 1 as already
imported; both new sessions get a fit warning (need 38 016 / 31 644 against 8 192 / 8 384); 22 warning
lines name a session, 36 a library item.
