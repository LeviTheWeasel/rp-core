# M2 contract notes — integrate

State at hand-over from the module agents: `tsc --noEmit` clean, `RP_CORE_SKIP_SLOW=1 bun test`
1937 pass / 4 skip / 1 todo / 0 fail, full suite 1939 pass / 1 skip / 1 todo, no `not implemented`
in src/, purity test green. Nothing was broken across modules. What changed here, and what became of
every item in the other `m2-contract-*.md` notes:

## Contract changes (made consistently everywhere)

1. **`AssembleResult` (ok) gains `loreRegexErrors?: LoreRunResult['regexErrors']`** (present only when
   non-empty). Why: engine note "For the assemble/prompt owner" — request.ts found the entries named
   in the `lore_regex_invalid` notice by matching its message text against a second compile of every
   book's `/re/` keys (brittle; entries past the tenth were not told). Now `regexNoticesPerEntry(errors)`
   groups the structured list by entry label; `brokenRegexKeys` and its re-compile are gone (only its
   test used it). The once-per-entry rule is unchanged (test/engine-m2/notices.test.ts).
2. **Lore placement ties follow ST exactly: reverse acceptance order** (lore/place.ts; lore note
   "Readings" 10). ST sorts activated entries by order descending, stable, then unshifts each into its
   place. The SillyBunny golden captures (03, 05) show equal-order entries in reverse activation
   order; the place.ts contract comment said "acceptance order". Applies to every place, depth
   groups and outlets included; examples_before keeps the prompt agent's double-unshift re-sort.
   Tests updated: test/lore/place.test.ts, test/prompt-m2/runs.test.ts.
3. **A world is read once by name** (new `shadowedCastBooks` in prompt/assemble/lore.ts, used by
   `loreSources` and cli/refs.ts `bookRows`; `BookRow.shadowedBy?`). ST's getCharacterLore skips the
   character's world when the same world is global, chat or persona lore, and getPersonaLore skips the
   persona's when it is global or chat lore. Here: the card's / persona's embedded book is left out of
   the sources when a session book has the same (trimmed, non-empty) `name`; the card's also when the
   persona's book has its name. Why: Seraphina's embedded book IS Eldoria; with `--lore eldoria` every
   entry was scanned twice (both copies fired, or the second copy ate the budget). `/lore` marks the
   shadowed book ("not read: eldoria has the same name"); `/lore rm eldoria` brings the card's back, as
   in ST. Tests: test/prompt-m2/runs.test.ts, test/cli/m2-units.test.ts, test/repl/m2-render.test.ts.
   ARCHITECTURE.md §10.3 step 1 gained one sentence saying so; README too.
4. **Card import: `extensions.world` naming the embedded book is not warned** (formats/card.ts).
   ST embeds the linked world as `character_book` on export; "linked world book "Eldoria" is not part
   of the card; import it separately" was false for Seraphina and led straight to the double read of
   (3). A different name still warns. Tests: test/formats/{card,import}.test.ts.
5. **RoleCall exports (rc-parity notes 1–3), in st-preset.ts:**
   - `injection_position` 4 / 3 → `at: 'top'` / `'bottom'`, each group stable-sorted by
     `injection_order` (default 100, RoleCall's preset-loader.ts) in the places the group holds; the
     rc_export warning counts the pins. The parity `test.todo` "08, pins" is now a `test()`.
   - `injection_position` 2 (append) → imported **disabled**, relative, `extras.injection_position` /
     `injection_depth` kept, warning `rc_append` (folded). Nothing that reads as chat is sent.
   - `wi_format`, `personality_format`, `scenario_format` of an RC export ride `extras`, unapplied,
     warning `rc_formats` (option (a): RoleCall's export route always writes them, RoleCall never
     applies them; D-71 mixed = RC exports behave like RoleCall). `new_chat_prompt` /
     `new_example_chat_prompt` stay applied (RC-5 unchanged). *M2 fix: no longer — they ride extras
   unapplied too (m2-contract-fix.md item 10).*
   ST files are untouched by all three. docs/PARITY-RC.md updated (RC-8 row, "Exact parity" 08, the
   "Open" pins item removed). Tests: test/formats-m2/st-preset.test.ts (3 new).
6. **Unknown-macro report names ST macro-engine forms by their tag** (prompt/macros.ts): `{{#if .x}}`
   → `#if`, `{{.var = …}}` → `.var`, `{{$n += 2}}` → `$n` (before: only `{{/if}}` was listed; heads with
   spaces were skipped as prose). Found in the demo: Geechan's v5.2 preset uses SillyBunny's block-if
   and dot-variable shorthands, which rp-core sends literally; `/trace` now says so. Prose like
   `{{ some words }}` is still not reported. test/macros/macros.test.ts updated.

## CLI / REPL additions (no library contract)

7. **The preset's window cap is visible.** The REPL banner before the first answer now applies the
   preset's `context.maxContext` (and `windowFor(..., presetWindow?)` applies it to a `[caps]`
   override; a trace's window already has it). `/preset <id>` says "it caps the window at N of the
   model's M tokens" when it shrinks it. Why: the formats note — ST's Default.json says 4095, so a 16k
   model silently ran at 4095 while the banner said 16384. `ReplRigOptions.windowOf` added to the
   test kit. Tests: test/repl/m2-flows.test.ts, test/repl/journal.test.ts.

## Golden snapshots (§15 M2 "golden-снимки SillyBunny")

8. The captures and tooling existed (test/golden/st/*, tools/st-golden/*) but **no test read them**.
   Added `test/golden/run.ts` (harness: rp-core's importers → assemble → shape) and
   `test/golden/st-golden.test.ts`: all 7 cases equal SillyTavern's request apart from four named
   deviations, normalised on both sides and asserted separately (G-1 example dialogue as one message,
   G-2 plain-text example lore kept, G-3 = D-47 merging, G-4 = D-46 boundary). Item 2 above came out
   of it. test/golden/st/README.md has the table.

## Provenance

9. All `m2-provenance-*.md` rows merged into PROVENANCE.md (33 rows + the RC export-route fact row
   + two golden-fixture rows; sorted by core file; backticks around source paths normalised; commit
   legend gains `68afe385`, the rc-recorder pin) and an "M2 adds, fresh" paragraph.
10. Port headers added to the six adapted lore tests (test/lore/{keys,timers,scan,engine,recursion,
    groups}.test.ts; authors from `git log` at 702d8120: Coneja-Chibi). src/lore/keys.ts copyright
    line now names "SillyTavern contributors (parseRegexFromString)" (rule: SillyTavern-derived
    RoleCall code is attributed to SillyTavern).

## Items from the other notes

- **cli 1–6** (replay caps from the recorded connection, record wraps every connection, replay from
  line 1, --lore order, /lore test folding, /preview n): confirmed as decided; the live demo used
  record → replay on a fork (docs/M2-DEMO.md).
- **cli "for other owners": `rp-core import package.json` → CCv1 character.** Left: test/formats/
  import.test.ts pins `{name, description}` as a card (M1a contract); a stray JSON is still the user's
  explicit import and prints `character`. Tightening tried and reverted.
- **cli: README claims** checked against the merged code; README gained three notes (the preset's
  context size, SillyBunny-only macros, a world read once by name).
- **engine 1–9**: confirmed. The regex-notice brittleness is item 1. Preview being synchronous (no
  M9 hooks) stays open for M9.
- **formats 1–3**: confirmed. "Default.json caps at 4095" → item 7.
- **infra**: the open question (replay caps) was answered by the cli agent (cli 1); confirmed.
- **lore readings 1–9, 11, 12**: confirmed as named deviations/readings (11: ignoreBudget text does
  not count against later entries, contract, unlike ST — not exercised by the golden cases). 10 →
  item 2. **Gaps:** 1 (macros in keys) solved by the prompt agent (identity macros); 2 (groupOverride,
  group scoring) stays an import warning; 3 (detail for sticky fires) — the LoreVerdict.detail doc
  comment now says so. The engine.ts header's step 2 now lists delay first, as implemented.
- **prompt 1–16**: confirmed. 13 (`lore_regex_invalid` on every assemble) → item 1.
- **rc-parity 1–3** → item 5.

## Housekeeping

- Removed a stray empty `x.jsonl` from the repo root (created 14:52 by a manual `record:` run; no
  test recreates it).
