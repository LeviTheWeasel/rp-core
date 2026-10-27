# M3 contract notes — agent `builtins` (history, lore, index)

Files: src/tools/builtin/{index,history,lore}.ts, test/tools-builtin/. No exported signature
changed; index.ts untouched. Readings, deviations and additions the loop / cli / integrate agents and
the rev-13 docs need:

## Deviations from the contract comments (please confirm / carry into ARCHITECTURE rev 13)

1. **read_history cut mark.** The contract comment wrote `[#n continues for N more characters:
   read_history from=n to read on]`, but `{from, to?}` has no offset: `from=n` re-reads the same head,
   so that line would send the model into a loop (and the loop guard would end it). Implemented
   Bunraku's honest form: `[#n continues for N more characters, which read_history cannot show]`;
   next_from is n + 1. (A per-turn offset table would need state on ToolCtx; v1 RP messages are
   ~1 800 characters against a ≥ 6 000 page, so the cut is rare.)
2. **D-58 "no fewer than two whole messages"** is not forced: the contract's "at least one" is
   implemented. A forced second message would pass the page and, when the page is the room
   (pageChars = min(page, room)), get cut blindly by runTools. With a page ≥ 6 000 two typical
   messages fit anyway (test: an 18 000 page holds nine 1 800-char messages, a 6 000 page three).
3. **read_history output layout:** messages joined by a blank line, then `returned: #a to #b`,
   `next_from: k|null`, then either `You have not read #k to #end yet. Call read_history with
   from=k before you say anything about them.` or (to omitted / past the end) `The chat ends at #N.`
   `next_from: null` is printed explicitly (the contract only named the continuing case); the
   description says "null once the whole range is read". The paging lines are after the messages so
   a cut never leaves a `returned` line that claims more than arrived.
4. **search_history texts:** no hits → `No messages match. That is about the words, not the story:
   try a shorter root, another word or a name before you decide it never happened.`; with `before`
   → `No messages before #k match.`; a query with no words → error result. summary: `3 hits`,
   `10 hits, more before #51`, `no hits`.
5. **search_lore rows for notes** say `(note)` where a book name stands (NOTES_BOOK_NAME is the
   Russian 'Заметки'; model-facing text is English). A book with an empty name shows `card` /
   `persona` / its source key; an untitled entry its first plain (non-regex) key, else `(untitled)`.
   Extra lines: `N more match; add a word to narrow it.`; `This chat has no lore entries or notes to
   search.`; `No lore entry or note matches. Try …`. Disabled entries are left out entirely (Bunraku
   listed them flagged "switched off"; decisions D7 says enabled entries only).
6. **read_lore:** unknown handle → `"X": no such handle. Use the handles search_lore gave, like L3 or
   C2.` (error: true only when no handle was known); a handle asked twice is shown once; the total is
   ≤ READ_LORE_MAX: an entry that does not fit is cut (`[Ln continues for N more characters past the
   8000-character limit]`) when ≥ 500 characters are left (always for the first), the handles after
   it are named in `Not shown, the result is full: L5, L6. Call read_lore with them again.`

## Additions (new exports, no signature changed)

7. history.ts: `PAGE_SLACK_CHARS` (1 000), `PAGE_FLOOR_CHARS` (500: read_history's page is
   max(500, ctx.pageChars)), `SEARCH_OUTPUT_MAX` (8 000), `outputRoom(ctx, max)`,
   `snippetAround`, `excerptAround`, `headOf`. lore.ts: `READ_LORE_IDS_MAX` (20, schema maxItems).
8. **maxOutput per tool:** search_history `outputRoom(ctx, 8000)` (20 hits × ±110 snippets ≈ 5–6 k
   characters would pass the 4 000 default); read_history `max(500, pageChars) + 1000`; search_lore
   `outputRoom(ctx, 4000)`; read_lore `outputRoom(ctx, 8000)`.
9. **outputRoom:** a listing tool fits its own lines to ctx.pageChars when pageChars < PAGE_MIN_CHARS
   (a page is never below 6 000, so a smaller pageChars can only be the room, decisions C6); then the
   search cursor / "more match" line / read_lore "not shown" line stay correct instead of the
   runner's blind cut. **For the loop agent:** this relies on pageChars = min(historyPageChars(window),
   roomChars) exactly as C6 says. runTools still splits roomChars evenly over a round's distinct
   calls, so two big calls in one round can still be cut by the runner (a tool cannot see its share).
   A seen symptom in test/repl/m3-flows.test.ts (window 1200): `search_history … 563 chars · cut` and
   `ended: room` — with pageChars passed as C6 says, search_history now fits that room itself.
10. **Schemas:** search_history `{query: string (required), before: integer ≥ 1, limit: integer ≥ 1}`
    — no `maximum` on limit: 50 is clamped to 20 (the task's "limit clamp"), 0 is refused by the
    argument chain; read_history `{from: integer ≥ 1 (required), to: integer ≥ 1}`; search_lore
    `{query}`; read_lore `{ids: string[] 1..20}` (a bare string is wrapped by the chain). All
    `additionalProperties: false`, every property described.
11. **Handles:** lore targets are `{kind:'lore', book: <LoreSource key>, id}` (the key, not the book
    name, so read_lore finds the source in ctx.lore); notes `{kind:'compendium', key}`. Numbering is
    first appearance per turn (decisions D4, HandleTable), so the tool's `C<n>` is in general NOT the
    REPL's `C<n>` (noteRefs = creation order). The test plan recommended making them equal; the
    decision chose first appearance. Docs should say so (or integrate may switch notes to noteRefs
    numbering — it would need HandleTable to accept a fixed number).
12. **search_lore ranking across sources:** lexScore rank = lore `order` (default 100) for entries
    and `prov.lastSeq` for notes, as D7 says; the scales differ, it only breaks ties after "matched
    parts" and "parts in title/keys". Doc order for the final tie: books in ctx.lore order (the
    '@notes' source skipped), entries in book order, then live notes in creation order.
13. **upTo:** the tools read `ctx.view.path` up to `ctx.upTo`; if upTo is not on the path the whole
    path is used (the request's view is folded at upTo, so it is the head in practice).
14. **Text read:** text blocks only, joined with '' (as streamed, decisions C4); reasoning, tool_call
    and tool_result blocks are never searched or read. Words are cached per MessageView (a WeakMap,
    re-checked against the text): 2 000 messages × 1 500 chars ≈ 190 ms cold, ≈ 9 ms warm.

## SessionHandle.search (memory agent's code, tested here)

15. test/tools-builtin/session-search.test.ts covers it on a real scripted session: numbering,
    stems/phrases/stop words, `before` paging without gaps, hidden messages leaving the search,
    `(in context)` = the head answer's request (trace.trimmed range and the head itself excluded; a
    user head → nothing marked), refusals (before 0 / 1.5, limit 0, non-string query, null input),
    and a search while a turn is paused (sees only committed messages). No change needed.

## Fast suite at the time of writing

16. `RP_CORE_SKIP_SLOW=1 bun test` (last run): 2902 pass, 4 skip, 2 fail, both outside the builtins'
    files: test/assemble/assemble.test.ts "only text blocks are rendered (D-16)" (expects two text
    blocks; assemble now joins them per decisions C4 — prompt agent) and test/lore/engine.test.ts
    "book match 'stem' is matched as literal in M2" (text agent's note 1). An earlier run in the same
    session also failed cli subprocess tests and repl/m3-flows while other agents were mid-edit.
