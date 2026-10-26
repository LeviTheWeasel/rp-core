# M2 contract notes — prompt agent (prompt/{assemble,tokens,budget}.ts, prompt/assemble/*)

No exported name, type or signature was changed. Additions and decisions:

## Contract readings

1. **`loreBudget(window, reserve)` follows the contract file, not the task text.** The task said
   `loreBudget(window) = max(1, floor(window × 0.25))`; budget.ts (fixed signature, two params)
   says ST's `Math.round(0.25 × (window − reserve)) || 1`. Verified in SillyBunny: script.js passes
   `getMaxPromptTokens()` (= max context − response length) to checkWorldInfo, which does
   `Math.round(world_info_budget * maxContext / 100) || 1`. Implemented that. Builtin session
   (32768 / 8192) → 6144. NaN / negatives → 1; an unusable reserve reserves nothing.
2. **The lore budget and `count()` are in corrected tokens** (counter × tokenFactor, rounded up like
   the history budget). So `LoreVerdict.tokens` / `detail.cost` / `detail.left` are corrected numbers too.
3. **Expansion order is now:** lore entries (in the engine's acceptance order, source
   `lore:<book>:<id>`) → preset blocks (preset order) → new_chat → card_depth → author_note →
   guidance. A lore `{{setvar}}` is visible to every block. Because the engine expands an entry
   before its budget check, a budget-cut entry's `{{setvar}}` still lands in `varsDiff` (engine
   contract; noting it).
4. **Keys get identity macros** (ST `normalizeWorldInfoKey` runs `substituteParams` over keys; lore
   agent's gap 1). Done in assemble on shallow copies (`withExpandedKeys` in assemble/lore.ts), only
   for keys containing `{{` or `<user>/<bot>/<char>`, via `run.userText` (identity only, read-only:
   a key cannot `{{setvar}}`). `loreHashes` hash the books as loaded. Verdict `matched` and
   regex-error keys show the expanded key.
5. **`traceForSent`** recounts with `counterById(trace.tokens.counter)` and keeps `counter`, so a
   trace re-derived by the engine stays counted the way assemble counted it.

## Placement (all mirrored from SillyBunny; see the header of src/prompt/assemble/lore.ts)

6. **wi_format applies only to `{{lore::before}}` / `{{lore::after}}`** (ST formatWorldInfo wraps
   worldInfoBefore/After only); a blank format is no format. `renderSlot` changed accordingly:
   **outlets are no longer wrapped** (M1's renderSlot wrapped them; ST does not), nor example slots.
   test/assemble/helpers.test.ts updated.
7. **Example slots** = example dialogue: each entry chunked on `<START>` (one implied), every chunk
   headed by `formats.newExampleChat`, or `<START>` without one; joined with '\n'. `fillSlots` joins
   an example slot to non-empty neighbouring text with one '\n' (the default layout writes
   `{{lore::examples_before}}{{examples}}{{lore::examples_after}}` back to back).
   **examples_before runs in DESCENDING order** (ST unshifts those entries twice: checkWorldInfo,
   then script.js), the one place that does; assemble re-sorts it from `run.fired` (place.ts's
   ascending list is kept for every other place).
8. **Author's note:** `${noteBefore}\n${note}\n${noteAfter}` with edge newlines removed, at the note's
   depth/role; with no note set (or a blank one) the AN lore goes to depth 4 / system (ST default,
   or the blank note's own depth/role). ST keeps the blank line where an empty note was:
   `NB\n\nNA`. A note with no AN lore is sent as written (M1, not trimmed). src stays
   `author_note` (rank 4).
9. **top / bottom / recap:** one system message each, entries joined with '\n'. `lore:top` is first
   (before top pins) and joins the leading system run (`placement: 'head'`); `lore:bottom` is last
   (after bottom pins; the prefill still follows in shape). `lore:recap` sits after `new_chat`, right
   before the chat messages (and before depth inserts clamped above the first message).
10. Outlets: `{{outlet::name}}` by exact (trimmed, case-sensitive) name, entries joined with '\n'.
    Unknown `{{lore::x}}` names render ''. A slot the preset lacks is not sent; the entry is still
    in `trace.lore.fired` and still cost budget.

## Trace / result

11. `lore.fired` = accepted hits `{book, id, why}` (why 'sticky' kept); `lore.cut` = `entryLabel` of
    every cut hit (including those skipped after the overflow); `lore.budget` = loreBudget;
    `loreHashes` = `{sourceKey: loreBookHash(book)}` for every source, persona → card → session order,
    books with nothing enabled included; `tokens.counter` = counter id.
12. `verdicts` present iff `explain` (`[]` when there are no books).
13. Notice `lore_regex_invalid` (warn), one per call, names up to 10 `book:id key` pairs then
    "and N more"; never the content or the compiler message. Emitted on every assemble: the engine
    should dedupe per session if it wants "once".

## New exports (additive)

- tokens.ts: `o200kLoaded()`, `counterById(id)`.
- assemble.ts: re-exports `loreBookHash(book)` (assemble/hash.ts) — for `preview --turn`'s
  `preview_inputs_changed` comparison against `trace.loreHashes`.
- assemble/lore.ts: `loreSources`, `loreHashes`, `runAssembleLore`, `loreSlotValue`, `noteWithLore`,
  `regexNotice`, `DEFAULT_NOTE_DEPTH`, `DEFAULT_NOTE_ROLE`.

## Performance

14. o200k loads on the first count (~0.3–0.45 s). Importing src/index.ts does not load it (tested in
    a subprocess). O200K_COUNTER memoizes counts of texts ≥ 64 chars (LRU, 4096 entries / 8 M chars):
    a warm turn re-counts nothing it counted last turn.
15. History sizes are measured lazily (getter on `{id, tok}`), so `trimHistory`'s early stop holds:
    a 5000-message path with a 128k window tokenizes only what fits.
16. Measured: 2000-message path, 200k window, book of N always-matching entries, cold counts:
    N=150 ≈ 140 ms, N=300 ≈ 340 ms per assemble — the lore engine's cumulative recount is O(N²)
    in text (lore agent's note 4). Fine for tens of entries; if huge books matter, the engine could
    count incrementally (ST is exact; a sum of per-entry counts would err high, the safe side).

## For the engine / integrate owner

- `test/engine*` did not need changes: none pinned chars/3 numbers through the default counter.
- `traceWith()` in test/session/fixtures.ts has no `tokens.counter` (= 'chars' by Trace's doc);
  `ema.ts tokenFactorFor(..., counter.id)` already filters by counter.
