# RoleCall story import — decisions (the lead's design note; authoritative for the build)

Goal: continue a long RoleCall story in rp-core. Input: RoleCall's per-story export, the `.rolecall` zip
(`format: "rolecall-story-zip"`, v1, written by RoleCall `lib/scenes-export/per-chat-export.ts:440-621`
@ fb8dc623e). Research (the lead gives the absolute path): `<session scratchpad>/rcimport/understand/`
`format.md` (the format from RoleCall's code), `survey.md` (a real export, structure and statistics only),
`mapping.md` (rp-core mapping, 20 open decisions). These decisions become D-185…D-196 in ARCHITECTURE.md
(rev 18). PRIVACY: the user's real export lives outside the repo; nothing from it (text, names, ids) may
enter a tracked file. Tests use a synthetic export built by a test helper. Public-repo rules as always.

**D-185 Command.** `rp-core import <file.rolecall>` detects a ZIP (magic `PK\x03\x04`) whose
`manifest.json` has `format: "rolecall-story-zip"` (a `.rolecall` JSON is RoleCall's other format, the
backup: refused with a clear message). Flags: `--chat main|all|<id prefix>` (default `main`: the chat with
`is_main_timeline`, else the manifest's `main_chat_id`), `--model conn:model` (the session's narrator; else
the config's default), `--compendium on|off` (default on), `--dry-run` (print the plan, write nothing),
`--new` (import again as new sessions), `--as <title>`. Zip members never go through generic detection.
`story.jsonl` alone is not supported in this step (the zip holds the same data).

**D-186 Zip reading, no new dependency.** A small reader (`formats/zip.ts`): the end-of-central-directory
record, the central directory, local headers, methods 0 (stored) and 8 (deflate via `node:zlib`
`inflateRawSync`), CRC-32 checked, member size and count limits (a member ≤ 64 MB, the whole ≤ 512 MB,
≤ 10 000 members), names normalised (no `..`, no absolute paths). Tests write zips with a tiny writer.

**D-187 Library items.**
- Character: `characters/<name>.json` (chara_card_v3) through the existing card importer; `.raw.json` is
  never imported (it is the database row).
- Persona: the RoleCall persona row → a session persona `{name, description}` whose description is
  RoleCall's rendering of `details` + `section_order` (port `generatePersonaXml` with its authors'
  header), falling back to `description` when `details` is empty.
- Preset: the RoleCall preset row (`prompts`, `categories`, their order) is turned into RoleCall's preset
  EXPORT shape (with `extensions.rolecall`), then read by the existing ST preset reader so D-71's RoleCall
  rules apply (+1 depths, lore and persona slots on, numeric {{random}}). Check RoleCall's preset loader
  for the real prompt order first. The chat's own overrides (prompt toggles, samplers) are applied to a
  copy saved as `<preset> (<story>)`. Macros rp-core does not know (`{{if}}`, `{{setvar}}`, `{{.x}}`) stay
  as text — one warning listing them.
- Lorebooks: each book's rows are wrapped as a `rolecall-compendium` file and read by `readCompendium`;
  books with byte-identical row sets are one library book (dedupe by a hash of the normalised rows); a
  different book with the same name gets a suffix (else "read once by name" hides it). Rows marked
  `consumed_by_split` are imported disabled (check RoleCall's own prompt path for how it treats them and
  say so). A re-import reuses a library item whose content hash is equal instead of writing `-2`.

**D-188 Sessions and messages.** One session per imported chat (default: main only; `--chat all` adds the
others, skipping exact duplicates of another chat). Messages become `msg` entries in order: each message's
`swipes[]` are sibling `msg` entries (swipe order), the active one is the swipe whose text equals `content`
(fallback: the last swipe, with a warning) and is the parent of the next message; ids are deterministic
hex8 from (chat id, message id, swipe index) — never RoleCall's UUIDs (a `-` breaks `hist:` keys); the
first message is the greeting (`gen.kind: 'greeting'`); timestamps kept; the session's head is the last
active message. A leading `<think>…</think>` becomes a reasoning block (port RoleCall's
`splitThinkingFromContent` for parity, incl. its rule for an unclosed tag). Hidden flags and images are
not in the export: one warning each. The journal is written in one atomic step (`createSessionLogWith`),
never replayed turn by turn. Branches with a matching prefix may become forks (`fork` header) only when the
prefix matches by content; otherwise they import as separate sessions with a warning.

**D-189 The Compendium at import.** The header stores `compendium.enabled: false`; with `--compendium on`
a final `config` entry turns it on, so its seq is the enable moment (D-171): the imported past is neither
filed nor summarised again. The attached books seed the Compendium (typed entries, `[Arc]` overviews in
the `{{recap}}` slot). RoleCall summaries stay library entries (no ranges, so not in the slot; found by
name, search_lore and M5c recall).

**D-190 The Director.** `chats/*/dm-context.json` → rp-core `DirectorState` through an adapter (renumber
ids to `arc-N`/`seed-N`/`hidden-N`/`chapter-N` and fix references, derive `createdAtTurn` where missing,
skip malformed rows with a warning, `fitState` to 32 KB, `checkRecord` valid), stored as a `dir` record on
the head reply and on the reply before it (turn = user messages up to it), so a plain swipe and a replan
both start from RoleCall's state. The Director is enabled in the session when the chat had it on (check
`chat.json`), else off. Parts rp-core does not have (hidden events, core memories, the shadow world beyond
what D-61 kept) are dropped with one warning.

**D-191 Not carried.** Trackers, the storyboard, RoleCall's chat summary, TunnelVision/immersion modules,
images, hidden flags: one warning line each with counts. `--keep-raw` copies the export's non-chat JSON
files to `<home>/imports/<session id>/` for reference (off by default).

**D-192 Provenance and idempotence.** `SessionHeader.imported?: {from: 'rolecall', chat: <chat id>,
exportedAt}`; session id = `s_` + hex8 of the chat id; importing a chat whose session exists refuses
unless `--new` (then a fresh id). Output: one line per library item and session, then the warnings, then
`rp-core chat <id>` / `tui` hints.

**D-193 Size.** 1 000+ messages must import in seconds and open fast (the fold, the view and the lane must
not choke: Compendium off in the header until the final config; nothing back-filled). Measure the main
chat of a synthetic 1 000-message export in a test (≤ 3 s import, ≤ 500 ms open).

**D-194 Tests and fixtures.** A synthetic export generator (test helper) covering: swipes with a non-last
active swipe, an unclosed `<think>`, a custom opener, two chats (one an exact duplicate, one detached),
four lorebooks (two identical, one typed Compendium with `[Arc]` and consumed rows), a preset row with
categories and chat overrides, a persona row with `details`, a dm-context with malformed rows. Never the
user's file.

## Rulings after wave 1 (the lead)

- RoleCall custom markers that carry text are SENT by RoleCall's loader: the D-71 path of st-preset.ts
  enables them (a parity fix that also applies to RoleCall preset exports), with a test.
- Answers left with no visible text after the think split keep RoleCall's behaviour (reasoning block,
  empty text) — that is what RoleCall sent as history.
- RoleCall's "messages" context mode maps to the preset's message limit (N + 1) when rp-core has the field,
  else a warning.
- RoleCall DM notes are dropped with one warning (rp-core's Director `notes` are the player's).
- The integrator passes `turnAt` built from the user messages' timestamps.
- Director settings: enabled by RoleCall's own rule; the Director's model follows the narrator (a
  `rolecall:` model id means nothing to rp-core and is not stored).
- Book identity for dedupe ignores `id`, `lorebook_id`, `origin*`, timestamps and wiped metadata.
- The importer reads members lazily (`openZip`) and never inflates `story.jsonl`.

## Rulings after the review (the lead)

- Privacy (done by the lead): the kit's character renamed (its first name was a proper noun of the real
  export); the git name of a RoleCall author written as Levi; no absolute paths in notes. Every fixture
  proper noun is checked against the real export before a commit (count 0).
- **D-195 Fit check at import (ux#1).** After writing, the importer opens the session (lane manual, no model
  calls) and builds a preview for each imported session; a `context_length_exceeded` refusal becomes a
  warning that names the needed vs available tokens and suggests a narrator with a larger window
  (`--model`, `/model`) or `/preset builtin`. The engine refuses a turn that cannot fit BEFORE the
  Director's calls (ux#2): a pre-check of the fixed part runs first.
- **Atomic import (robust#1).** Everything is planned first; library items and sessions are written
  through temp names and renamed at the end; a failure removes what this run created; an existing item
  this run would reuse is never touched.
- Macros in imported messages: `{{user}}`/`{{char}}` (and RoleCall's case variants) are expanded to the
  persona's and the character's names at import, as RoleCall did when it showed and sent them
  (fidelity#2).
- The Director records go on every version (swipe sibling) of the head reply and of the reply before it
  (fidelity#3).
- Only the chat's own Start Reply With adds a reasoning tag (not the preset's assistant prefill,
  fidelity#1); a reasoning block caught inline is not doubled (fidelity#7); preset parity: a structural
  marker's own text is sent, duplicate identifiers follow RoleCall's content filter (fidelity#8, #9).
- Per-book token budgets (fidelity#6): mapped when rp-core's book has a budget field, else one warning
  naming the books. TunnelVision suppression (fidelity#10): one precise warning naming the managed books.
- The enable moment stays after the last message (fidelity#4, accepted): turns RoleCall never summarised
  stay in the history and the lorebooks; the import says so in one line.
- The think splitter is made linear (robust#2): rewrite the quadratic patterns (a listed deviation from
  the RoleCall code, same results on RoleCall's own tests); extreme timestamps, duplicate book ids,
  prototype keys are handled (robust#4, #5, #7); refusals keep the parser's reasons (robust#6).
- UX: warnings name the chat/session/book they belong to (text and --json); `--chat` lists candidates on
  an ambiguous or unknown prefix and shows chat ids next to sessions; `--chat all` after the main chat
  imports the rest (existing ones skipped with a line), and a branch imported later links its fork to an
  already-imported parent; a missing file says "cannot read"; a zip without a manifest gets plain words;
  `--keep-raw` says what it kept and where; "not carried" lines only for features that were on and books
  that exist; per-marker and duplicate warnings folded into counts; `/preview n` on an imported answer
  works or refuses in words (ux#3…#11).
