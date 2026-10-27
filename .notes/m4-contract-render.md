# M4 contract note — unit `render`

Files: `src/agents/director/render.ts`, `test/director/render.test.ts`, `test/director/persona-filter.test.ts`,
`test/fixtures/ru/director-persona.json`. render.ts imports only `text/normalize.ts` and `./types.ts`.

## 1. Changes needed in files I do not own

- **integrate (call.ts / turn.ts / assemble.ts / session preview):**
  - contract: `AssembleInput.contract = contractText(persona?.name ?? '')` on every kind while
    `director.enabled` (D-106). The text depends only on the persona name, so it is cache-stable.
  - directive at depth 1: `renderDirective(record.directive)`; '' → nothing placed.
  - preview stub: `STUB_DIRECTIVE`.
  - persona filter in runDirector (after enrichFromMomentum) and again on swipe reuse (D-104):
    `sanitizeForPlayerCharacter(directive, persona ? [persona.name, ...(persona.aliases ?? [])] : [])`;
    append its `skipped` to the record's `skipped` (the 20-entry cap of D-107 is readPlan's; apply it
    to the merged list if you want the record bounded). No persona → pass `[]` (directive unchanged).
  - event summary: `summaryOf(prevState, record.state)` for `planned{summary}`; for `reused` use the
    replaced reply's own prev/next pair (or the state it was planned from) — `summaryOf(s, s)` is
    `'no changes'`.
  - Optional: the planner may write `{{user}}` literally in a directive; passing `'{{user}}'` as one
    more name makes the filter catch it (names with punctuation work).
- **lead / docs:** ARCHITECTURE.md §7.3 "Фильтр персоны" still names the `(?<![\p{L}\p{N}_])`
  lookbehind; per A.5 it is a per-code-point check now. The Russian rules (case forms, the grammatical
  gate, lists) are documented in render.ts above `EN_VERBS` and in the fixture's `_about`.
- PROVENANCE.md: rows in `.notes/m4-provenance-render.md`.
- types.ts: nothing missing.

## 2. Deviations from m4-decisions.md (and from Bunraku/RoleCall) and why

- **Tension** shown as `Tension: <word> (n/10)` with n rounded AND clamped to 0..10 (Bunraku rounded only
  the word and printed the raw value; the task said "rounded"). NaN → no line.
- **Whitespace-only text** (mood, setting, goal, hook, motivation…) counts as absent in renderDirective;
  an unknown pacing value (old record) renders no pace line.
- **Every list the filter empties loses its key**, not only `include.characters` (cleaner records;
  hasDirectiveContent-style checks see no empty arrays). Nothing removed → the very same object.
- **Word characters** = `isLoreWordChar` (`[\p{L}\p{N}\p{M}_]`), Bunraku had `[\p{L}\p{N}_]`: marks join
  words (decision A.5). Texts are folded (NFKC, case, ё → е) before matching.
- **The bare pattern is case-aware for Russian names**: an interiority verb counts after the name as
  written (nominative); an experiencer word (кажется, хочется, страшно, жаль …) only after a dative form.
  Without this, «Брат Елисея думает» (the brother thinks) would be cut. Latin names are always "as
  written", so English behaviour is Bunraku's.
- **Fillers** (не, вдруг, уже, начинает, может, будет … ≤ 3) between name and verb in the bare pattern —
  Russian words only; the English bare pattern stays adjacent-only as in Bunraku (not widened, to keep
  the tested English behaviour; "Merlin slowly realizes" is still a Bunraku-parity miss).
- **Russian possessive** is `NOUN NAME` (мысли Елисея); Russian order words (пусть, заставь, дай,
  позволь, покажи, помоги, вынуди, подтолкни …) join Bunraku's leads.
- **Russian verbs are explicit forms**, not stems: normalizeTerm cuts no verb endings besides the
  reflexive ones (думает/думал/думать never meet). Nouns are generated from stem + declension endings.
- **Russian name forms**: singular case endings by the last letter (й/ь/а/я/consonant), no plural
  endings, so Иван never matches Иванов/Ивановна; names < 3 letters, Latin names and names ending in
  other vowels are matched only as written.
- **names[]**: any non-empty entry filters (RoleCall ignored aliases when the name was empty).
- **Skip paths**: `directive.characterBeats[i]`, `directive.dialogueGuidance[i]`,
  `directive.include.characters[i]`, `directive.arcDirections[i]`, `directive.callbacks[i]` — i is the
  index in the list the filter received; why is always `'persona'`.
- **Contract line**: appended after a blank line as `NEVER act, speak or decide for <name>.` (the
  contract's own "NEVER acknowledge…" style); whitespace in the name collapsed so it stays one line.
- assemble-director.test.ts placement tests are not ported here (the integrate unit owns placement);
  their text halves are.

## 3. API (additive; all from `src/agents/director/render.ts`)

```ts
export const DIRECTOR_HEADER = '[DIRECTOR CONSTRAINTS - BINDING THIS TURN]';
export const DIRECTOR_FOOTER = '[/DIRECTOR CONSTRAINTS]';
export const STUB_DIRECTIVE: string;      // header + '(the Director plans this when the turn runs)' + footer
export const NARRATOR_AUTHORITY: string;  // the contract without the persona line
export function contractText(personaName: string): string;
export function renderDirective(d: NarratorDirective): string;  // '' when nothing renders
export function sanitizeForPlayerCharacter(d: NarratorDirective, names: readonly string[]): { directive: NarratorDirective; skipped: Skip[] };
export function summaryOf(prev: DirectorState, next: DirectorState): string;  // 'no changes' when nothing changed
export const RU_INTERIORITY_VERBS: readonly string[];  // folded forms (exported for the table test)
```

## 4. What I could not do / known limits

- Known misses (documented in render.ts): «сомнения мучают Елисея» (noun–verb–name), fleeting vowels in
  names (Павел/Павла, Лев/Льва), adjective names/aliases («Хромой», «старый землемер» in other cases),
  two-letter names not inflected, «Елисей так и не может решить» (unlisted fillers), «кажется» with a
  nominative name (on purpose: a look).
- Known false positives: a verbed order about someone of the persona's («Пусть брат Елисея решит»,
  English "Have Merlin's brother decide" is Bunraku's own); Надежда/Любовь as an NPC directly before the
  persona's name («Надежда Елисея ждёт»).
- Results: my tests 105 pass (render 24, persona-filter 81); full `bun test` 4033 pass, 3 skip, 0 fail;
  `bunx tsc --noEmit -p .` 0 errors (at the time of the run).
