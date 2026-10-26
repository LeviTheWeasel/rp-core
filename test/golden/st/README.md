# SillyTavern golden snapshots

What SillyTavern actually sends for a given card, persona, preset, world book and chat. rp-core's
assembler is compared against these (ARCHITECTURE.md §14, "Golden-фикстуры сборщика").

## A case

`<case>/`:

- `card.json`: a CCv2 card, as ST writes it (legacy top-level fields plus `data`).
- `persona.json`: `{ name, description }`. ST's persona description position is "in prompt" (0).
- `preset.json`: an ST chat-completion preset, as ST exports it. Based on SillyBunny's
  `Default.json`, with the case's prompts and settings applied.
- `world.json` (optional): an ST world info file. It is selected as a global world book.
- `chat.json`: `messages` (`user: true|false`, `text`), starting with the greeting. The last message
  is the user's current one. The optional `note` is the author's note text and in-chat depth
  (role system, interval 1). `about` says what the case is for.
- `expected.json`: the captured request: `messages` (`role`, `content`, and `name` for ST's
  example dialogue), `params` (max_tokens, samplers, and so on) and `source`/`settings`
  describing where it was captured.

ST's world info settings are SillyBunny's shipped defaults:

| Setting | Value |
|---|---|
| Scan depth | 2 |
| Budget | 25 % |
| Include names | on |
| Recursive | on |
| Case-sensitive | off |
| Whole words | on |
| Strategy | character first |
| Max recursion steps | 0 (unlimited) |

These match rp-core's lore defaults, except the last: rp-core stops recursion after 3 loops (G-5).

## The test

`test/golden/st-golden.test.ts` (harness: `test/golden/run.ts`) imports each case with rp-core's own
importers (card, preset, world info), assembles it with the o200k counter, and compares the request
with `expected.json`. Equal, apart from four named deviations that the test normalises on both sides
and checks separately, and one (G-5) that no case reaches:

| ID | What differs | Why |
|---|---|---|
| G-1 | ST sends example dialogue as an `[Example Chat]` marker plus one named system message per line; rp-core sends the examples slot as one system message with `Name: text` lines | §10.2 example slots |
| G-2 | Example-positioned lore with no `Name:` lines: ST keeps only the marker and drops the text; rp-core sends the text (case 02) | no silent loss |
| G-3 | ST joins the author's note, the card's depth prompt and world info at one depth and role into one message; rp-core keeps one message per source, in the same order (case 06) | D-47 |
| G-4 | ST's ASCII whole-word check fires `мир` inside `мирный`; rp-core does not (case 03) | D-46 |
| G-5 | Recursion deeper than 3 loops: SillyBunny's `max_recursion_steps` 0 loops until nothing new fires; rp-core stops after 3 loops. An entry the next loop would wake says so in `/lore test` (`no-key-match`, "recursion would wake it, but it stops after 3 loops"). Case 05 is exactly 3 levels deep | §10.3 step 8; bounded cost |

Everything else is exact: block order, slot texts, lore activation, budget (case 04: 250 tokens),
recursion, entry order inside a place (ties in reverse activation order, as ST unshifts), in-chat
depths and roles, the author's note wrap, macros, samplers and the reply cap.

## Capturing again

The inputs come from `tools/st-golden/cases.ts`. Edit it there, never by hand. To capture:

1. `bun tools/st-golden/cases.ts` rewrites every case's inputs. It leaves `expected.json` alone.
2. Start `bun tools/st-golden/recorder.ts <captures dir> 5199`. It is a stand-in model server that
   saves each chat-completions body as `req-NNN.json`.
3. Start SillyBunny on a throwaway data folder, so your own data is never touched:
   `bun server.js --configPath <copy of config.yaml> --dataRoot <scratch>/data --port 8456 --browserLaunchEnabled false`.
   The first start fills the folder with ST's default content.
4. For each case:
   1. Close the SillyBunny page. An open page saves its own settings over the staged ones.
   2. Run `bun tools/st-golden/stage.ts <case> <scratch>/data`.
   3. Open the page. The staged chat `golden` with Mira opens.
   4. Put the author's note text into `#extension_floating_prompt` and fire `input`. ST reads the
      note from that textbox, not from the chat metadata.
   5. Run `SillyTavern.getContext().generate('normal')`.
   6. Run `bun tools/st-golden/save.ts <case> <captures>/req-NNN.json`.

Rules for new cases are in the header of `cases.ts`.

## What the captures showed (2026-10-26, SillyBunny 3021edcae)

- **Entries in one place are joined with `\n`, lowest `order` first.** With equal `order`, the most
  recently activated entry comes first. ST sorts by order (descending, stable over activation
  order) and then unshifts each entry, which reverses the ties.
- **In-chat entries with the same depth, role and order are merged into one message.** The same
  goes for the author's note and the card's depth prompt. Within the merged message the order is
  author's note, card depth prompt, world info (case 06): all world info sits in ST's order-100
  extension group, so an entry's own `order` sorts it only among the world info. rp-core keeps them
  as separate messages (D-47), in that order.
- **The author's note wraps its world info as `top \n note \n bottom`** (case 02).
- **Examples-positioned entries (5/6) are parsed as example dialogue.** Plain text with no `{{user}}:`
  or `{{char}}:` lines leaves only an empty `[Example Chat]` marker (case 02).
- **Dialogue examples are sent as separate system messages** named `example_user` and
  `example_assistant`, after an `[Example Chat]` marker (all cases).
- **ST's whole-word check uses ASCII `\W`, so `мир` fires inside `мирный`** (case 03). rp-core uses a
  Unicode boundary and does not fire there (D-46).
- **`{{char}}` in the user's own message is expanded; an unknown `{{macro}}` stays literal** (case 07).
