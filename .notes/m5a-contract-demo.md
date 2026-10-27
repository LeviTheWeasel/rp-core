# M5a contract — unit `demo` (wave 3)

The §15 M5a demo end to end on the scripted model through the real CLI, its transcript
(`docs/M5A-DEMO.md`), the two engine changes the lead ruled on after wave 2, and one integration fix.
Decisions: D-141, D-146, D-150, D-153, D-155, D-157, D-159/D-161 (size ruling), D-160, D-162, D-163,
D-164 (suffix ruling), D-167. Nothing ported (no provenance note).

## Files

| file | what |
|---|---|
| `test/demo-m5a/lantern.test.ts` | new: the demo (9 tests over one recorded run; the last prints the transcript) |
| `test/demo-m5a/card.json`, `persona.json` | new: a narrator card «Рассказчик» (CCv2; its greeting names no book entry) and the persona Ян |
| `test/demo-m5a/script.txt` | new: the 20 lines piped into `rp-core chat` (the test reads it; the live run uses it too) |
| `test/demo-m5a/chat.jsonl` | new: the scripted model, 3 calls (a tagged Russian plan, the answer, the swipe's answer) |
| `test/demo-m5a/editor.ts` | new: the `$EDITOR` stand-in (`bun test/demo-m5a/editor.ts <file>`); exports `MIRA_FILE`, `ULYANA_STATE`, `answer()` |
| `docs/M5A-DEMO.md` | new: intro, claim table, setup, the transcript step by step (a–g), the live recipe, the fixes |
| `src/engine/turn.ts` | `requestFileName(callKey, n = 1)`: `-n` before `.json` for n ≥ 2; `keepRequest` creates each file exclusively (`flag: 'wx'`) and moves on to `-2`, `-3`… on `EEXIST` |
| `src/engine/session.ts` | `memoryRow`: `size` = `content.length` for notes and arcs (`type === null` with string content), else `JSON.stringify(data).length` |
| `src/engine/api.ts` | the `MemoryRow.size` doc comment only |
| `src/cli/main.ts` | `rp-core help import` names the RoleCall Compendium export in the detection order (integration fix) |
| `test/engine-m5a/keep.test.ts` | the file-name test extended (n = 1/2/3); new: a retry then a fallback under one call key → `…_0.json`, `…_0-2.json`, `…_0-3.json` with the right models |
| `test/engine-m5a/verbs.test.ts` | pins: an arc's size = its overview's length (also after `set.content`), a note's = its text's length |

## How the demo runs

`beforeAll` spawns `bun src/cli/main.ts` four times (test/cli/kit.ts `run`) in one `tmpHome`:
`import lantern.compendium.json`; `new --card card.json --persona persona.json --no-chat`; `chat <id>
--keep-requests --provider script:chat.jsonl` with `script.txt` on stdin and `EDITOR='<bun>' '<editor.ts>'`,
`VISUAL=''`; `import <home>/exports/lantern2.compendium.json`. The chat's stdout is cut into one segment
per typed line (an echo `you › <line>` that equals the next script line; the head re-shown after
`/rewind` and `/fork` stays inside its segment). After the CLI exits the test reads the journal, the
library files, the kept requests, and opens both sessions with an in-process engine (`memoryList`,
`memoryGet`) to compare keys and data. ≈ 0.9 s for the four runs, ≈ 1 s for the file.

Assertions per step: a. stdout `lantern`, 18 entries / 16 typed / 1 arc; b. `/lore add` line, the tree's
first two lines and its Cast/Places/Narrative nodes, C1…C15 all `[lib: lantern]`; c. the human `file` row
= `mira.character.json`, C16, `/trace`'s compendium line, `/preview`: block and directive are the two
messages right above the last user message (block first), the block starts with Мира's brief and has no
`## ` heading; d. book bytes equal before/after, the `edit` row on `lib:lantern:…e03`, `/memory show`'s
overlay line and new state, the second tree (`General · 1: C16 Мира`); e. `/memory list character`
identical after `/r`, `/rewind 2` and in the fork, human rows equal (minus `seq`), engine keys/handles
equal in both sessions, the fork's overlay data; f. the export line, `tree: null`, `nodeConstraints: []`,
re-import `lantern2`, {type, name, aliases, data} equal to the session's exported entries, Мира's data =
the payload; g. exactly three request files (Director + narrator of the reply, narrator of the swipe),
`[COMPENDIUM CONTEXT]` with `- Мира:` first and the Мира/Селина tension, both narrator requests hold the
block with Мира, no requests dir for the fork.

## Choices

1. **The real CLI, spawned**, not the in-process REPL rig: the transcript is exactly what a person sees,
   and `import`/`new` are covered as commands. Ids and times vary per run; nothing asserted depends on
   them. The four runs stay well under the 10 s bound.
2. **The message says «Мире»** (dative), not §15's «Миру» (accusative of мир): correct Russian, the same
   stem (`мир`). The doc says so.
3. **`/preview` after the answer** (a swipe preview whose U is the message): a preview needs a user
   message at U, and the REPL runs a turn on every message. It shows the reused plan's directive under
   the block.
4. **Lite through the window**: the scripted caps' 8 192 window makes `auto` lite, so the brief is shown
   without a config change (A.6).
5. **A narrator card** whose greeting names no entry, so the block holds only what the message names
   (Мира, «маяк», and the library summary through its trigger «Мира»).
6. **Order**: the overlay edit comes after the turn (so the turn's snapshot still says Ульяна is
   `missing`; the doc says why); a second `/memory tree` shows the session tree with Мира.
7. Keep-requests suffix by exclusive create, not an in-memory counter: it never overwrites, whatever
   wrote the folder before (a reopened session, a second process).

## Seen, not changed

- `src/cli/repl-render.ts:1033` still computes a note's/arc's size from the entry; with the engine fix it
  gives the same number and could go (CLI unit's file).
- A session tree under 5 entries is one `General` group (Bunraku's rule, ported unchanged), so right
  after `/memory new` Мира is not under Cast. Documented in the demo.
- `/trace` says `block 290 tok`, `/preview` shows the block message as `256 tok`: budget tokens (o200k ×
  the EMA factor 1.15 before any usage, D-50) vs plain o200k. Not a bug; documented.
- The `[Arc]` row fires as constant plain lore (`lore_after`) until M5b, as D-141 says.

## What the docs need (lead)

- README: a test-table row for `bun test test/demo-m5a` (next to demo-m4, ≈ :1566) and `docs/M5A-DEMO.md`
  in the demo list (≈ :1598); the M5a section can link the demo.
- ARCHITECTURE.md:560: `--keep-requests` "пока не реализовано" → built (D-164), with the rule: a call key
  that repeats (retry, fallback of round 0; a Director attempt's retry) gets `-2`, `-3`… before `.json`.
  The CLI help line (`<call key>.json`) could say the same; left as it is.
- D-159/D-161: `MemoryRow.size` = data JSON chars, notes and arcs: their text length.
- `rp-core help import` now lists the Compendium export; README's command table (`import`, ≈ :1525: "a card,
  a SillyTavern preset, world info or a character_book") and the config table (`[compendium]` "Reserved for
  M5", ≈ :1345) still describe M4.

## Open questions

None blocking. Should `/memory new` warn while the Compendium is off (the CLI unit's open question) —
untouched here.
