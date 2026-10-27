# M5a contract note — fixer `fix-prompt` (review findings prompt#2, prompt#3, prompt#5, breaker#3 render side, D-169, fidelity#6 b, fidelity#3)

Files: `src/agents/compendium/{render,world,select,fresh,tree}.ts`, `src/engine/request.ts`; tests in
`test/compendium/{render,world,fresh,tree}.test.ts`, `test/compendium-select/select.test.ts`,
`test/engine-m5a/block.test.ts`. No contract file was edited. `place.ts`, `profile.ts`, `assemble.ts`
needed no change.

## API changes

- `render.ts`: new `export const RENDER_MAX_DEPTH = 32`. `lines()` takes a depth again (Bunraku's
  unused parameter, now checked): a list or object nested deeper than 32 (a field's own value is depth
  0) renders as `…`. renderContent, renderEntry, renderBrief and renderBriefParts never overflow the
  stack, whatever the depth (tested at 20 000 levels). Listed as render deviation 5.
- `fresh.ts`: `visibilityAt(view, tree, upTo: string | null)`. `null` = a request that answers no user
  message (an opening): U's place is after the path's end, so the newest assistant message on the path
  (the greeting, by its last `continue` edit's trace) is the last request.
- `tree.ts`: new `export function narrativeBucket(entries: readonly CEntry[]): TreeNode` (Bunraku's
  export, for M5b's historian / `{{recap}}`): the typed tree's Narrative node built from the live
  summaries and arcs among `entries` (others ignored), id `bucket:summary`, plots in 'en' order with the
  arc first, then 'Unlinked Summaries'. Same node `deriveTree` holds for those entries. The internal
  builder is `narrativeNode`.

## Behaviour changes

- **Openings (prompt#2, section H ruling).** `compendiumBlockInput` no longer returns undefined when
  the path has no user message. It runs the selector with `uText: ''` and `windowTexts` = the last
  `WINDOW_MESSAGES` visible messages of the whole path (the greeting and what precedes): tier 2 and
  tier 3 (constants), plus tier 0 from a guidance text if one is ever passed. Input is still absent when
  the Compendium is off or the view has no live typed entry. So an opening with a live typed entry
  always writes `trace.compendium` (`picks: []` when nothing is named and nothing is constant), and a
  constant typed library entry reaches the opening request through the block. `/preview` cannot show an
  opening (it previews a reply or a swipe), so the tests read the turn's request and prep trace.
- **Brief tail (prompt#3).** In `genericBrief`, an uncapped field whose value is a list of scalars (every
  item non-blank text, a number or a boolean) is shown whole, like a capped list within its cap: no
  `(more: read_lore …)` tail for it. A list holding a record or a blank item still brings the tail.
- **World snapshot ties (prompt#5).** Equal ranks among library entries: higher `order` first (`order`
  missing = `DEFAULT_LORE_ORDER`, 100), as the lore engine and search_lore rank it; then handle order
  (= Bunraku's book order). Session entries and mixed pairs unchanged. The world.test.ts fixtures no
  longer number `order` by position (book order is handle order).
- **One text for U and the guidance (D-169).** The selector matches tier 0 against U and a guided
  re-roll's guidance as ONE text (`U + '\n' + guidance`), so a phrase's words may be split between
  them. Window messages stay one text each; words spread over two window messages do not match.
  Matching itself is mention.ts's (lead-owned, already any-order).

## Tests (each fails before its fix)

- `test/compendium/render.test.ts`: "deep data (review breaker#3)" (the 32 bound exactly; 20 000 levels
  through renderContent / renderEntry / renderBrief / renderBriefParts), "an uncapped list of scalars
  printed whole is no reason for the tail (review prompt#3)".
- `test/compendium/world.test.ts`: tie order rewritten (higher order first, default 100, then book
  order), the reviewer's WORLD_LITE case (heroes at 200 kept over extras at 100; locations too), the
  overlay case, a D-169 case (any order, one message, stop words, both words of «Двор Сыча»).
- `test/compendium/fresh.test.ts`: `visibilityAt(…, null)` for an opening.
- `test/compendium/tree.test.ts`: `narrativeBucket`.
- `test/compendium-select/select.test.ts`: 'a phrase name needs every word in order' replaced by the
  any-order rule ('Ванс и Мира' names 'Мира Ванс'); «фонарь вашего мужа, Гордея» → «Фонарь Гордея»;
  «Ватага Сыча» needs both words; stop words (and a stop-word-only name); one text (window messages
  apart; U + guidance together); an opening's empty U picks tiers 2 and 3.
- `test/engine-m5a/block.test.ts`: the "opening gets no Compendium input" test is replaced by two (a
  greeting naming «Серый маяк» plus a constant typed law → block with both, picks window + constant,
  the law not in the lore; an opening naming nothing → no block, `picks: []` recorded); the live-run
  case «Это фонарь вашего мужа, Гордея?»; a library entry nested 20 000 levels deep (written compactly:
  the library's pretty print grows with the square of the depth) → memoryGet, preview and a turn work.

## Not changed / for the lead

- fidelity#3 in these dirs: every test file here that ports Bunraku or RoleCall cases already carries
  the `Ported from … / Copyright (C) 2026 Coneja-Chibi; changes … / SPDX` header (render, fresh, tree,
  world, fixture-book, place, assemble-block); select, profile, kit, fixtures and the engine-m5a tests
  are fresh.
- `.notes/m5a-provenance-render.md` still says "ties by … order (library)" and "book order = library
  `order`" for world.ts / world.test.ts: now "higher order first; book order = handle order".
- The deviation list (D-166) gains: render deviation 5 (depth > 32 → `…`), world ties by higher
  `order`, openings selected with an empty U.
