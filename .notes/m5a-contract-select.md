# M5a contract — unit `select` (selector, block, profile, assemble hook)

Decisions: D-153 (selector), D-154 (profile, limits), D-155 (block, budget, trace), D-158
(`resolveCompendium`). Files: `src/agents/compendium/{select,place,profile}.ts` (new),
`src/prompt/assemble.ts` (the D-155 hook only). Tests: `test/compendium-select/` (44 tests:
select 14, place 12, profile 7, assemble-block 11). `test/assemble` and `test/golden` pass unchanged.

## Exported API

`agents/compendium/profile.ts`
```ts
export const LITE_WINDOW = 24_576;
export const COMPENDIUM_LIMITS: Readonly<Record<CompendiumProfile, BlockLimits>>;
//   full {maxEntries 12, fullChars 4000, briefChars 1200, blockTok Infinity}
//   lite {maxEntries 6,  fullChars 0,    briefChars 700,  blockTok 1600}   (frozen)
export function compendiumProfile(p: 'auto' | 'full' | 'lite' | undefined, window: number): CompendiumProfile;
export const DEFAULT_MIN_SHARE = 0.4;
export const DEFAULT_FILING_ALLOW: readonly EntryType[];   // every type but summary, ENTRY_TYPES order
export interface ResolvedCompendiumConfig { /* every CompendiumConfig field; nested tables filled */ }
export function resolveCompendium(c: CompendiumConfig | undefined): ResolvedCompendiumConfig;
```

`agents/compendium/select.ts`
```ts
export const WINDOW_MESSAGES = 4;
export interface SelectInput {
  entries: readonly CEntry[];        // live typed entries after freshness, in handle (Map) order
  refOf: (key: string) => string;    // C<n>
  uText: string;                     // U, no speaker prefix
  guidance?: string;                 // guided re-roll
  windowTexts: readonly string[];    // visible messages before U, oldest → newest, no prefix
  castNames: readonly string[];      // PathView.castNames
  recallPicks?: readonly string[];   // M5c; [] / absent in M5a
}
export function select(input: SelectInput): Pick[];
```

`agents/compendium/place.ts`
```ts
export const BLOCK_HEADER = '[Retrieved World Knowledge]';
export const blockSection: (name: string, text: string) => string;   // '[Lore: <name>]\n<text>'
export interface PlaceResult { text: string | null; tok: number; injected: CompendiumTrace['injected'];
                               cut: CompendiumTrace['cut']; repeated: string[] }
export function placeBlock(input: CompendiumBlockInput, budgetTok: number,
                           count: (text: string) => number, withTail: boolean): PlaceResult;
```

`prompt/assemble.ts`: `AssembleInput.compendium?: CompendiumBlockInput` (documented on the field).

## Behaviour the decisions note left open (my choices)

Selector
- Each of U and the guidance is matched as its own text (a phrase never spans the two).
- `windowTexts` may hold more than 4 messages: only the last `WINDOW_MESSAGES` are read.
- Defensive filters: `type === null`, `retired`, `arc` set, and a repeated key (first wins) are never
  picked, even if the caller passes them. Tier 3 needs `origin.kind === 'library'` and `constant === true`.
- Cast test: `normalizeName` of the entry's name or any alias equals `normalizeName` of a cast name.
- Tier 1 is ordered by the D-153 rule (cast last, `prov.lastSeq`, handle), not by recall's order.
- "Handle order" = the number in `refOf(key)` (`C<n>`); a ref of another shape sorts after every
  handle, then input order. Tier 2 "newer message first" = the newest window message naming the entry.

Block (`placeBlock`)
- Tokens are counted like Bunraku: the header once plus each `[Lore: …]` section; the separators
  (`\n`, `\n\n`) are not counted. `tok` = header + Σ injected (0 when nothing went in, `text: null`).
- `full` is used only when non-blank, `full.length <= limits.fullChars` (UTF-16 length; lite's 0 →
  always brief) and it fits; the request builder may pass `null` anyway. Otherwise the brief.
- The tail: appended as `brief + '\n' + briefTail` when `withTail` and `briefTail` is not blank. Its
  cost counts in the brief's `tok`. Never after a full render.
- `maxEntries` caps INJECTED entries. Candidates after the cap are `cut` with the cost of the text they
  would have used (full if usable, else brief). `repeated` (key in `inPrompt`) takes no slot and has no
  cost. A candidate with no usable full render and a blank brief is skipped and listed nowhere (Bunraku).
- Duplicate candidate keys: the first is used, later ones ignored.
- The effective budget is `min(budgetTok, limits.blockTok)`; below the header everything is cut.

assemble hook
- `input.compendium` absent → nothing changes (byte-identical; no `trace.compendium`).
- Present with zero candidates → the lore run's budget is unchanged and messages are byte-identical,
  but `trace.compendium` IS written (`picks: []`, `budget.block: 0`). D-155's first bullet says "no
  trace key"; its last paragraph says a zero-pick turn records `picks: []`. I followed the last one:
  the request builder passes the input only when Compendium is enabled with ≥ 1 live typed entry.
- With candidates: lore run budget = `floor(loreBudget × (1 − minShare))`, `minShare` clamped to
  [0, 1], a non-finite one read as 0.4. `trace.lore.budget` then records that reduced budget (what the
  engine was given); `trace.compendium.budget.share` records the whole `loreBudget`.
- Block budget = `max(0, loreBudget − lore.run.used)`; the lite cap is applied inside `placeBlock`.
- Units: the block's `count` is the request's counter scaled by `tokenFactor` (ceil), i.e. budget
  tokens like `lore.run.used`. Every `tok` in `trace.compendium` and `budget.*` is in those units.
- `withTail` = a tool named `read_lore` is in the tools that SURVIVED the prefill rule (so: none on
  continue, none when a preset prefill turns tools off, none when caps.tools is 'none').
- The insert `{depth: 1, role: 'system', src: 'compendium', srcId: 'block'}` (PromptMsg.src
  `compendium:block`, placement inline) is spliced into `inserts` right before `input.placements`; its
  place in the request comes from SOURCE_RANK (below lore / author note / card depth at depth 1, above
  `director`). Its text is data: never macro-expanded. It is in the fixed part (never trimmed); when
  the fixed part cannot fit, the refusal's "in-chat inserts" item adds "the Compendium block".
- Nothing in `depth.ts` changed.

`resolveCompendium`
- Absent / non-object → `enabled: true` and every default. A field of the wrong kind or an unknown
  enum value → its default (config.ts validates on the way in; this keeps an old header readable).
  `enabled` that is not a boolean → true. `minShare` outside [0, 1] → 0.4.
- "By profile / origin" numbers (`recall.maxEntries`, `recall.contextMessages`, `recall.timeoutSec`,
  `filing.timeoutSec`, `historian.overlap`): absent unless a positive finite number (TOML's `0` = by
  profile). The key is absent, not `undefined`.
- `filing.allow`: only valid entry types, deduped; empty (or nothing valid) → `DEFAULT_FILING_ALLOW`.
- `books`: only `'read' | 'off'` values kept; a fresh object (never the stored table).
- Snake_case keys an old header stored (`min_share`…) are not read.

## For the engine builder (request.ts) — what assemble expects

- Pass `compendium` only when `resolveCompendium(cfg).enabled` and the view has ≥ 1 live typed entry.
- `select` input: `entries` = live typed entries (not notes, arcs, retired) after `visibleCopy`
  (hidden ones dropped), in view Map order; `refOf` from refs.ts over the same view; `uText` =
  `messageText(U)` from mention.ts; `windowTexts` = `messageText` of the last 4 non-hidden path
  messages before U, oldest first; `castNames` = `view.castNames`; `guidance` on a guided re-roll.
- One `BlockCandidate` per pick, in pick order: `name` = the entry's name; `full` = `renderContent`
  of the fresh copy, or null in lite / over `limits.fullChars`; `brief` = `renderBrief(copy,
  limits.briefChars, tail)` WITHOUT the tail line, and `briefTail` = the tail
  (`(more: read_lore C12)`) only when renderBrief had to leave something out, else `''`. Render the
  brief leaving room for the tail: placeBlock appends it and never trims.
- `limits = COMPENDIUM_LIMITS[compendiumProfile(cfg.profile, narrator window)]`, `profile` the same,
  `minShare = resolved.minShare`, `inPrompt = new Set()` (M5b), `hidden` from freshness, `rev =
  view.rev`.
- The block is recomputed per assemble call (pass A and pass B both pick; the tail only in pass B).
- D-156 `unfiredLore`: "a live typed entry the block did not inject" = not in
  `trace.compendium.injected` (by ref).

## Open questions

1. Opening (blank or no U) and `continue`: Bunraku gives an opening no block. assemble places whatever
   it is given, so the request builder decides; I suggest no input on an opening, and on continue the
   selector over the U the answer replies to.
2. The zero-candidate trace key (above) — confirm the reading.
3. Tier 1 order: D-153's rule is applied; M5c may want recall's own order instead.

## Fixes after the final check (fixer: fix-matching)

Section I "D-169 narrowed" and the matching lens of the final check. Files: `mention.ts` (the lead's
contract file, edited for this ruling), `select.ts` and `world.ts` (header comments only),
`library.ts` (seed and data rule, see m5a-contract-memory.md). Tests: `test/compendium-select/select.test.ts`,
`test/compendium/world.test.ts`, `test/memory/library.test.ts`.

### mention.ts
- `entryMatchers(e)` returns `EntryMatcher[]`: `StemKey & { run: boolean; secondary?: readonly string[];
  logic? }`. `mentionText(text)` returns a `MentionText` (a `StemText` plus `raw` and a per-text
  `KeyMatcher`); `mentioned(matchers, text)` takes it. `select` and `worldSnapshot` are the only users.
- Names and aliases of character, location, item, power, organization, creature, threat and
  worldbuilding entries: every word's stem in one text, any order — unless a word of the phrase has ≤ 2
  letters (`\p{L}` count, so numbers such as «13», «II», «K9» bind too) or is a stop word: then the
  phrase is `compileStemKey(phrase)` matched as a run (`matchStemKey`), stop words included.
  "Stop word" = `STOP_WORDS` plus the Russian function words that `normalizeTerm` marks with
  `FUNCTION_WORD_MARK` (том, нам, под, ним …): those are what a pronoun or preposition anywhere in a
  message meets. This is my reading of the ruling; it is what keeps «Старый Том» from being named by
  «Старая дверь … о том», which the plain `STOP_WORDS` list would not.
- Event, plot and summary names and aliases (and a note's, never a candidate): always a run.
- A library entry's non-regex lore key (the `/re/` test is unchanged; a key or name with < 2 letters
  still never matches): a run, like the lore engine's stem keys. When the entry has secondary keys,
  `logic` (and_any default; an unknown value reads as and_any) must hold against the same text:
  `text.keys.match(secondary, raw, {match:'stem'})` and `secondaryPasses` — the lore engine's own code,
  so a `/re/` secondary key is re2js on the NFC text. The guard applies to keys only: the name and the
  aliases stay unguarded. `caseSensitive` is not honoured (listed deviation).
- Spaceless-script phrases: a folded substring, as before (known limit «山田 太郎» vs «山田太郎», pinned).
- Dedupe: names and keys separately, by run/any-order and stems.

### Not changed (outside the ruling)
- A hyphenated name («Жан-Поль») is two words with no short or stop word, so it still matches in any
  order («Жан упал на пол» names it). Binding hyphen parts would be a small addition if the lead wants it.
- A primary key whose text looks like `/…/` but that the lore engine reads as a literal (an unescaped
  `/` inside) is still no trigger here (mention.ts keeps its own `isRegexKey`).

### Tests
- select (27): stop-word names as runs (replaces "stop words are not significant"); «Корпус В/Г»,
  «Wing A/B», «Блок А/Б», «Plan A»; «Elizabeth I/II», «Агент К/Джей»; «Старый Том»; event, plot and
  summary titles and an event alias (with and without stop words); multi-word library keys («старый
  капитан», «black market», «the old man»); a guarded «Will» key (and_any, and_all, not_any, not_all, a
  `/re/` secondary, the secondary in another text, case folding, the name unguarded); the positive cases
  («Гордея», «Миру», «Ванс и Мира», alias «охотник» → Глеб); the spaceless limit.
- world (24): «Дом на холме» as a run; «Elizabeth I/II» with «Courtier 13» kept under the cap; «Wing A/B»;
  a guarded library key in the snapshot.
- Every new or changed test fails on the code before the fix (checked in a throw-away copy).
