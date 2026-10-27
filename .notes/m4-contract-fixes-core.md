# M4 fixes — unit `core` (the pure Director core: D-120, D-123)

Files touched: `src/agents/director/{state,reduce,plan,render}.ts`; tests `test/director/{state,fit,reduce,
arc-match,title,plan-tolerance,render}.test.ts` and the new `test/director/state-roundtrip.test.ts`
(the D-123 property test, named `state*` so it sits with the state unit's tests). No contract file touched.

## 1. Changes

- **D-120 (render.ts).** `contractText` = NARRATOR_AUTHORITY + `\n\nNEVER act, speak or decide for <who>.`
  + `\n` + `LANGUAGE_LINE` ("Write the story in the language it is already written in; these constraints
  are in English only for you."), the note's exact text, as the line right after the persona line (no
  blank line between). `LANGUAGE_LINE` is a new export. Render tests updated; engine-m4 tests compare with
  `contractText(...)` and follow by themselves. Director off: no request changes (the contract is sent
  only while `director.enabled`).
- **D-123 relatedArcId.** state.ts `readSeed` reads it leniently (a 1..2 000-code-point string is kept,
  anything else dropped, never a refusal). reduce.ts resolves it through the arc matcher (`findArc` →
  `matchArc`, echoes included) to the arc's id on plant (new and re-plant) and reinforce; no arc matches
  → not stored and `{path:'seedUpdates[i].relatedArcId', why:'no arc matches "…"'}` (a known seed keeps
  what it had); '', blanks and 'none' / 'null' / 'undefined' / 'n/a' / '-' / '—' → absent, no skip.
  fitState's capTexts holds a seed's relatedArcId to the title cap (80) as a backstop for journals an
  older build wrote (person's seeds untouched).
- **D-123 every stored text within the caps.** applyPlan clips every string of the round to
  STATE_LIMITS.text with `clipText` (readPlan's output already is, so this is silent and only matters for
  other callers); the joined chapter goal (`objectives.join('; ')`, up to 12 × 300) is cut to 300 with
  `{path:'chapterUpdate.objectives', why:'cut to 300 chars'}`.
- **D-123 id echoes.** reduce.ts: new `idEchoes(selector, 'arc' | 'hidden')` reads leading
  (`[arc-1]`, `arc-1:`, `(arc-1)`, `ARC-1 —`, repeated) and one trailing bracketed echo. `matchArc`:
  exact id → an echoed id that exists → match key of the selector as sent, then of `cleanTitle(selector)`
  → token overlap of either form. `matchHidden`: exact ids (arcId, then title) → echoed `hidden-N` ids that
  exist → match key of the title as sent and as `cleanHiddenTitle(title)`. New export `cleanHiddenTitle`:
  hidden echoes cut, whole-title quotes of the prompt line ("…", «…», “…”, „…“) taken off, then
  `cleanTitle`, repeated to a fixed point (idempotent). New hidden arcs are titled with it, and a changed
  title is skipped as for arcs: `invisibleArcUpdates[i].title: cut to "…"`.
- **D-123 safe-integer turns.** plan.ts `turnOf` drops a target turn that is not a safe integer after
  rounding (1e20, 2^53, "123456789012345678901") with the usual `not a turn number` skip; -0 reads 0.
  state.ts `readBeat` drops a bad `targetTurn` instead of refusing the state (plannedAtTurn and
  deliveredAtTurn stay strict: the core writes them).
- **D-123 summaryOf.** `seeds ~N`: seeds in both states whose newest reinforcement turn is newer and that
  are not paid off now; `hidden ~N`: hidden arcs in both with another status or another LAST clue / LAST
  stage. Order inside a part: `+ ~ -` (`seeds +1 ~1 -1 · hidden +1 ~2`).
- **Property test** (state-roundtrip.test.ts): 8 seeds × 60 turns of fuzzed raw plans (random shapes,
  junk types, 3 000-char Cyrillic / CJK / emoji / combining-mark texts, numeric and nullish strings,
  1e20 / 2^53+2 / ±1e308 / -0, id echoes of existing and missing arc-/hidden-/seed- ids, sections as JSON
  strings, lite and full): every turn `checkState(json(fitState(applyPlan(…)).state))` is not null, equals
  the stored JSON and reads back as itself; refused plans keep the state with the new turn. Plus four
  end-to-end witnesses of the review (87-char relatedArcId, unknown relatedArcId, targetTurn 1e20 and its
  string form, '[arc-1] …' / '[hidden-2] "…"' over turns without duplicates). All failed before the fix.

## 2. Deviations from section H, and why

- `matchArc` also matches `cleanTitle(selector)` for selectors WITHOUT an echo (H says "else the cleaned
  title" for echoes): a selector whose new arc would get an existing arc's title ("The Lighthouse: the
  keeper lies", "Маяк. Смотритель лжёт.") made the same duplicate the echo did; RoleCall sanitizes before
  findArcMatch too. Key steps (as sent, cleaned) run before the token steps. The 19 VVS-264 vectors keep
  their results.
- New hidden-arc titles get all of cleanTitle (first sentence / part before ": ", stutter, 80), not only
  the echo and quote cut: H says "cleaned too", and a hidden title is its match key like an arc's.
- Seeds that were reinforced and paid off in the same turn count only as `-`; a deleted hidden arc counts
  nowhere (as a removed arc).

## 3. Needed in files I do not own

- Nothing required. Optional follow-up for the prompt/reduce owners: the prompt lists seeds as
  `- [h] "hint" (id: seed-N, …)`; a model that copies the quotes into a seed title misses the seed (seeds
  match by folded hint) — not part of D-123, left as is.
- ARCHITECTURE rev 14 (D-105/D-123): the summary format is now `arcs +1 ~2 · seeds +1 ~1 -1 · hidden +1 ~1 · chapter 2`.

Results: `bunx tsc --noEmit -p .` 0 errors; full `bun test` 4254 pass, 3 skip, 0 fail (199 files).
