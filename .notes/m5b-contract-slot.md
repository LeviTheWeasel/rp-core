# M5b contract — unit `slot` (the `{{recap}}` slot in the request)

Decisions: D-178, D-177's slot side, section G (a session arc replaces the library arc of its plot;
`search_lore` labels a library arc `arc, <book>`). Files: `src/prompt/assemble.ts`,
`src/prompt/assemble/recap.ts` (new), `src/engine/request.ts`, `src/tools/builtin/lore.ts` (the arc label
only). `budget.ts` unchanged. Tests: new `test/recap-m5b/` (41: assemble 19, stability 8, request 11,
engine 3); `test/tools-m5a/lore.test.ts` two expectations follow the new label. Green: test/golden,
test/assemble, test/prompt-m1b|m2|m3|small, test/engine-m4, test/engine-m5a, test/tools-m5a,
test/historian-m5b, test/purity (737 with mine). `bunx tsc --noEmit -p .`: nothing in these files.

## API

`prompt/assemble.ts`
```ts
interface AssembleInput { …; recap?: RecapRequest }   // present ⇔ the Compendium is on (request.ts)
// trace.recap = the slot's {ids, arcs, boundary}; {ids: [], arcs: [], boundary: null} without a slot
// trace.compendium.repeated = the block candidates the slot holds; budget.block = the block as sent
```

`prompt/assemble/recap.ts` (pure)
```ts
interface RecapRequest {
  previous: RecapTrace | null;                       // the previous request's trace.recap
  books?: Readonly<Record<string, string>>;          // its trace.loreHashes; absent → not compared
  profile: CompendiumProfile;                        // compendiumProfile(cfg.profile, narrator window)
  revisionText?: (key: string, rev: number) => string | null;
}
recapMsg(text): PromptMsg                            // {role:'system', src:'recap', placement:'inline'}
emptyRecapTrace(): RecapTrace; recapTraceOf(slot | null): RecapTrace
readRecapTrace(v: unknown): RecapTrace | null       // lenient journal read
sameBooks(was: unknown, now): boolean                // same keys + hashes, '@notes' left out
replacedLibraryArcs(entries, arcs: {key}[]): Set<string>
chooseRecap(input: RecapInput): RecapSlot | null     // recapSlot + section G's replacement
```

`engine/request.ts`
```ts
interface PreviousRecap { recap: RecapTrace; books?: Record<string, string> }
previousRecap(view, tree, upTo): PreviousRecap | null
recapRequest(view, tree, upTo, cfg: ResolvedCompendiumConfig, window): RecapRequest | undefined
unfiredCompendium(c, injected, inSlot: readonly string[] = [])   // + the slot's keys count as in the prompt
```
`buildRequest` passes `recap` (both tool passes) and `trace.recap.ids` to `unfiredCompendium`.

## Choices

- **The circularity** (slot ↔ cut ↔ budget), resolved once: (1) the cut without the slot = the M5a
  request; (2) the slot for that cut within `share = ⌊10 % × window⌋` budget tokens (its message overhead
  inside); null → nothing reserved, byte-identical; (3) else its cost (the fixed part measured with the
  slot in it) comes out of the history's budget and `trimHistory` runs once more (same protections,
  same room, the greeting never dropped for it); (4) the slot is chosen again for that cut within
  min(share, what that cut left); (5) the block is placed again with the slot's keys as `inPrompt`,
  capped at the size it had (only when a candidate is in the slot); (6) the whole is checked against
  the window; failing (4) or (6) → the request without the slot (the M5a one). Only the slot's ACTUAL
  size is taken, not the whole 10 %: a 200-token library arc must not cut history that fit before.
  Counts: the request's counter × the EMA factor (budget tokens), as the block's.
- **Place**: one system message right before the first chat message sent after the cut (= after the
  greeting when nothing is cut; first in the chat area without a greeting), inserted after the depth
  inserts so it never counts as a chat message for depths; the D-96 gap note goes between it and that
  message. A preset that holds `{{recap}}` (top level, enabled block, any placement, the history block
  too) gets the text there — its first `{{recap}}` only, later ones render '' — and no `recap`
  message; such a block is not sent while the slot is empty (as today). The text is never expanded
  (filled after the macro run). To refill, the blocks are now expanded once (`expandBlocks`) and laid
  out by a pure `layoutBlocks(blocks, value)`; the macro run's call order is unchanged.
- **Boundary**: `chat.ids[keepFrom]` when something is cut, else the first history message sent.
- **The previous request**: the nearest assistant message at or before upTo (reply/swipe → the answer
  before U; a swipe of a past answer → its predecessor's; continue → A itself), its newest continue
  edit's trace when it has one; stop at the first assistant (a greeting → null). Its trace.loreHashes
  ride along: a book added, removed or changed since (not `@notes`) → `previous` ignored (fresh), so a
  book attached mid-session shows its arcs without waiting for the cut to move.
- **trace.recap is empty when the slot is** (the lead's "empty as today"): an empty slot never pins,
  so the first eligible content appears at the next request even while the boundary holds (one cache
  break). The historian wave-1 note suggested recording the boundary of an empty slot too.
- **Section G**: a library arc is dropped only when a session arc of the same plot (normalizeName) is
  IN the slot (the slot is chosen once more without those library arcs; session arcs are placed first,
  so they stay). A session arc that is not eligible (its summaries still in view) leaves the book's
  overview in place. Works on the again-path too (a pinned library arc stays until the boundary moves).
- **Lore tools (D-156)**: an entry the slot holds is not "left out" (pass B is not triggered by it).
- **`search_lore` / `read_lore`**: a library arc's row is `C<n> <plot> (arc, <book name>)`; session
  arcs keep `(arc)`.

## For wave 3 (CLI/TUI) and the lane/session builder

- `/preview` already shows the slot: a message with `src: 'recap'`, role system, in the chat area (or
  inside a preset block). `/trace` can print `trace.recap` (ids, `arcs[{key, rev}]`, boundary) and
  `trace.compendium.repeated`. `/preview --turn` rebuilds it from the predecessor's trace (pinned).
- session.ts `sentChanged` (not mine): a `recap` row falls into `isBlock`, so a slot that came, went or
  changed since a past answer reads "the text of the system blocks (the card, the persona or the lore
  that fired)". Suggest its own reason ("the recap (summaries and arcs)") and treating `recap` like
  `compendium` when `inputs.compendium` explains it.
- Sessions that read a book with an `[Arc]` entry (the lantern kit) now send the slot after the greeting
  in every request (D-177's arcs reach the prompt again). test/repl-m5a, test/demo-m5a and the CLI
  suites were not run here (the rules); prompts they pin may move.

## Open questions

1. Empty slot and stability: keep "empty as today" (the slot appears at once) or record the boundary
   of an empty slot too (it then waits for the cut to move)?
2. A `{{recap}}` in a preset: inside the block (as lore slots do, src = the block id) — or should the
   slot keep its own `recap` message at that place?
3. The Compendium config's book modes (`'off'` → `'read'`) do not change loreHashes: arcs of a book
   switched on mid-session wait for the boundary to move (only when a slot is already pinned).

## After the final check (fix2-agents; the lead's ruling K)

Files: `src/prompt/assemble.ts` (slotAt), `src/prompt/assemble/recap.ts`, `src/session/entries.ts` (only
`Trace.recap`'s optional `profile` / `share`), `src/agents/compendium/recap.ts` (see the historian note).
Tests: `test/recap-m5b/ruling-k.test.ts` (new, 11); pins in `stability.test.ts`, `assemble.test.ts`,
`engine.test.ts` (trace.recap now holds `profile` and `share`). Each new test fails on the code before.

- **The share in both choices** (historian#9 regressed, agents-cli assemble.ts:867): `slotAt` passes
  `shareTok: share − overhead` and `share` (⌊10 % × window⌋) to both chooseRecap calls, so the arcs' half
  is the same in the first choice, the second (whose budget is about the first slot's size) and a pin;
  at one boundary the arc is cut alike as the chat grows (the final check's p2/p2b: same text).
- **G's second choice keeps the effects** (historian#6, assemble/recap.ts:110): `view: {...input.view,
  entries: kept}`.
- **trace.recap records `profile` and `share`** (historian#8, assemble/recap.ts:39): `recapTraceOf` writes
  the slot's profile and share (an empty slot still records `{ids: [], arcs: [], boundary: null}`);
  `readRecapTrace` reads both back (an unreadable one makes the whole trace unreadable: a fresh choice);
  a trace without them (older journals) still pins, not compared. A pin under another profile or share
  is chosen afresh (the final check's p3/p3b: lite→full, 16k→64k).
- `RecapRequest.revisionText` takes an optional third argument `op` (see the historian note).

For the lead / request.ts owner (not my file): `recapRequest` builds `revisionText: (key, rev) =>
arcRevisionText(tree.mems, key, rev)`; to read a pinned revision's exact op it should forward the index:
`(key, rev, op) => arcRevisionText(tree.mems, key, rev, op)`. Until then a pin of an arc whose plot was
renamed (its later arc ops name the new name) cannot be read back and renders the current text (one
cache break at that boundary), as before this round.
