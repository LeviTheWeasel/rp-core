# M4 contract note — unit `fix` (wave 2: the lead's D-116 / D-117 calls on the wave-1 pure core)

Files changed: `src/agents/director/state.ts`, `src/agents/director/momentum.ts`, `src/agents/structured.ts`;
tests `test/director/{fit,state,momentum,enrich}.test.ts`, `test/director/fixtures-state.ts`,
`test/structured/plan-tag.test.ts`. No exported signature changed. Full suite: 4131 pass, 3 skip, 0 fail;
`bunx tsc --noEmit -p .` clean.

## 1. Changes needed in files I do not own

- **ARCHITECTURE.md §7.3** (lead, rev 14): "В v1 … шаг 5 всегда укладывает состояние в потолок" is replaced by
  D-116: steps 6 `texts` and 7 `last-directive`; `fit:over-cap` only with a person's items; checkState bounds
  are each string ≤ 2 000 code points and the JSON ≤ 4 × hardBytes. §7.3's "сравнение подстрокой" (enrich) →
  whole words (stem run) or id. The grace rule is gone (A.2 stands).
- **PROVENANCE.md** (lead merge): the rows of `.notes/m4-provenance-{state,momentum,structured}.md` that say
  "JSON ≤ 2 x 32 KB", "the grace rule", "the loose contained-name compare" and "D-99 read strictly" are stale;
  replacement wording in `.notes/m4-provenance-fix.md`.
- **integrate (`call.ts`)** — nothing required. Notes: (a) `fitState`'s `skipped` may now hold `fit:texts`
  and `fit:last-directive` (path `state`); (b) after `fit:last-directive` the stored state has no
  `lastDirective`, so the next turn's self-audit is skipped (D-110 condition `state.lastDirective?.turn ===
  state.turn` is false) — intended (D-116); (c) structuredCall still returns `invalid` only from a reader
  that uses it; the D-117 mapping `invalid → undecodable` is call.ts's.
- **cli** — nothing required.
- **types.ts** (lead) — nothing required. state.ts now uses `STATE_LIMITS.themes` (was
  `READ_LIMITS.directiveList`; both 12) — the wave-1 state note's request is settled.

## 2. Deviations from m4-decisions.md and why

1. **Step 6 cuts by bytes too: 120 code points AND 240 UTF-8 bytes** (`LAST_RESORT_TEXT`). D-116 says 120 chars.
   Measured at every D-61 limit (all texts 300, titles 80, 12 themes, 5 intentions, lastDirective at readPlan's
   limits), after all 8 steps with a plain 120-char cut: Cyrillic 24.9 KB, Latin 16.2 KB, but **Chinese 38.4 KB
   and emoji 37.0 KB — over the cap**, so "Chinese at every limit ends ≤ hardBytes" was not reachable. 240 bytes
   = 120 Cyrillic letters, so a Latin or Cyrillic text is cut at exactly 120 chars as D-116 says (a Russian text
   of 120 letters with no space at all is the only one that loses a letter or two); a CJK text keeps 79 chars +
   '…', a 4-byte script ~59. With it: Chinese 28.4 KB, emoji 26.9 KB, pure 4-byte (𝔄𝔅…) 27.9 KB.
2. **"Every model text"** = arc and hidden-arc descriptions, stage titles, nextBeat descriptions, seed hints and
   payoffs, clues, surfaceCondition, chapter title / premise / tone / majorGoal / closingMoment / themes,
   intention type and description, and `pacing.currentMood`. D-116's list leaves out surfaceCondition, chapter
   title, themes, intention type and the mood; without them the CJK case is over the cap again (themes alone
   12 × 900 B). **Arc and hidden-arc titles are NOT cut** (they stay ≤ 80 from the limit): they are the arcs'
   match keys (D-108), and a '…'-cut title would stop matching the model's next mention. `lastDirective` is not
   cut by step 6 (step 7 drops it whole), per the lead's order.
3. **Step order kept as the lead set it** (texts before last-directive), although a huge lastDirective then
   costs the story its detail before it is dropped. In practice: a small story + a lastDirective at readPlan's
   limits in Chinese (~300 KB) goes straight to `fit:last-directive` (steps 1–6 change nothing there); a big
   story + a big lastDirective runs 1–7. Tested both.
4. **checkState's string bound is in code points** (2 000 emoji = 4 000 UTF-16 units is taken), as clipText.
   It applies to the strict fields (ids keep their 1..80); the lenient `lastDirective` strings are still CUT at
   4 × 300 (not refused), as before. The 4 × hardBytes JSON bound is measured on the INPUT value, as before.
   Consequence: a person's text (byUser / userAuthored / note, never cut by fitState) over 2 000 code points
   makes the state unreadable — the later `dirEdit` must refuse such a text at authoring (not in v1).
5. **structuredCall, the fallback after failed blocks** takes a fenced/bare object only when it is WHOLE and
   DECODES with a `directive` (an envelope unwrapped first); a cut-off object or an undecodable one leaves the
   broken block's result (`undecodable`, "the plan block was cut off / could not be read"). So probe 8
   (`<plan>{"directive":{"mood":"te`) and "a broken plan in the text is not replaced by the reasoning" keep
   their results, and a cut answer is never read as an earlier draft's fragment.
6. **A nameless `<tool_call>`** is read from its block's span (`text.slice(start, end)` → `firstObject`): the
   scanner gives a nameless block no body (`name:null`, `args:''`, error "no name"). Its object must be whole
   and have a root `directive` (an envelope unwrapped); a nameless `{"arguments": {"directive": …}}` is not taken
   (no name to unwrap by). It counts in block order: before a `<plan>` it is the plan, after one an
   `extra block`.
7. **Envelope unwrap = tag `'plan'` only, any transport, any source** (block, fence, bare object); tag:null agents
   (recall, filing) never unwrap. On the TAGGED transport a bare (untagged) envelope
   `{"name":"commit_planning_round","arguments":{…directive…}}` is now a plan too (the directive test runs after
   the unwrap) — the same rule applied to the text path; no earlier probe covered it.
8. A third answer is now accepted besides the lead's two: on the structured transport an object whose own string
   holds `<plan>` (e.g. `"narrativeGoal":"write the <plan> on the wall"`) used to be a broken block
   (`undecodable`); the fallback takes it (every block failed, a whole directive object exists).
9. **enrich `names()`** keeps an exact folded-equality check besides the stem run and the id: a name with no word
   characters (punctuation, emoji) has no stems, and equal strings are trivially whole-word. A CJK name still
   matches as a folded substring (`stemKeyMatches`' spaceless rule: there are no word boundaries to find).

## 3. Additive API

`src/agents/director/state.ts`:
```ts
export const FIT_STEPS = ['completed-5', 'completed-0', 'lists', 'descriptions', 'chapters', 'working-sets',
                          'texts', 'last-directive'] as const;              // two entries added (D-116)
export const LAST_RESORT_TEXT: { chars: 120; bytes: 240 };                  // step 6's cut
export const CHECK_LIMITS: { string: 2_000; jsonBytes: 131_072 };           // checkState (D-116)
```
Skips: `{path:'state', why:'fit:texts'}`, `{path:'state', why:'fit:last-directive'}`; `fit:over-cap` only
after step 7. Step 6 = working sets 8 arcs / 10 seeds / 4 hidden arcs (step 5's ordering: every person's
item plus the newest of the model's, list order kept, `lastPlantTurn` kept), chapters → the current one
(none when `currentChapterId` is unset, as step 5's rule), clues → the newest 1 (a person's hidden arc too:
the model writes clues), every model text → 120 cps / 240 bytes (a person's items untouched).

`src/agents/director/momentum.ts`: no API change. `turnsSinceProgress = turn − (lastProgressTurn ??
createdAtTurn)` (stale, forced, the report and pressures). `enrichFromMomentum`: whole words (stem run),
folded equality or id.

`src/agents/structured.ts`: no API change; `Found.block` now means "found in a plan block" (it no longer
decides the unwrap). `findPlan` / `readAnswer` behave as in §2.5–2.8.

Tests: `test/director/fixtures-state.ts` adds `zh(n, from)` (Chinese prose) and `proseOf(src, n, from)`;
`ru` is unchanged in output.

## 4. What I could not do / open points

- A person's items stay exempt (as the lead said), so the cap and the 4× read bound still can fail for a
  state full of long person-written texts — not reachable in v1 (no dirEdit). Worth a bound at authoring.
- The worst measured state after step 7 is ≈ 28 KB (CJK / 4-byte text, core ids `arc-N`); ids up to 80 chars
  (checkState allows them) would add ≈ 3 KB and could, in theory, push a 4-byte-script state at every limit
  over 32 KB. Only a hand-written file can hold such ids.
- The 300-turn verbose Russian run still uses fit.test.ts's stand-in planner, not reduce.ts (wave-1 note); the
  integrate demo should repeat it with the real `applyPlan`.
