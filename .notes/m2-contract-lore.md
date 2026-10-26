# M2 contract notes — lore (lore/{keys,timers,scan,engine,place}.ts, text/normalize.ts)

No exported name, type or signature was changed. Additions inside the owned files:

- `text/normalize.ts`: `SPACELESS_SCRIPT_CLASS`, `gluesToLoreKey(ch)`, `charBefore(text, end)`, `charAt(text, start)`.
- `lore/timers.ts`: `stickyLeft(t, key, sticky)` (messages left in an open window; verdict detail).
- `lore/engine.ts`: `DEFAULT_GROUP_WEIGHT = 100` (ST's DEFAULT_WEIGHT).

## For the assemble / engine agents (how to call it)

1. **Trace.** `trace.lore.fired = res.fired.map(h => ({ book: h.book, id: h.id, why: h.why }))` — keep
   `why: 'sticky'` as is: timers read it to tell a reinjection (starts no window) from a fresh fire.
   Budget-cut entries must NOT go into `fired` (ST starts timers only for accepted entries).
   `trace.lore.cut = res.cut.map(h => entryLabel(h.book, h.id))`.
2. **`cut` also lists entries skipped after the overflow.** ST never rolls them (it `continue`s/`break`s
   once the budget overflowed); they were dropped because of the budget, so they are in `cut` with their
   RAW content as `text` (never expanded) and verdict `budget-cut`. The contract comment said "activated
   and rolled"; I widened the comment in engine.ts.
3. **Inputs:** `scan = scanMessages(view, upTo, names)`, `chatLength = chatLengthAt(view, upTo)`,
   `fires = pathFires(view, upTo)`. All three throw `lore: message … is not on the active path` for an
   `upTo` off the path (a caller bug). Fires after `upTo` are excluded, so a regeneration of a message
   never sees that message's own fires.
4. **Cost.** *(M2 fix: now linear — per-entry counts far from the budget, the joined text counted
   only near it; m2-contract-fix.md item 5.)* Every accepted budgeted entry costs one `count()` of the cumulative accepted text (ST
   semantics, exact), so a turn with many entries counts O(total²) characters. With o200k that is fine
   for tens of entries; if it shows up in profiles, the counter passed in should cache.
   `budget: Infinity` skips the per-entry totals (one count at the end for `used`).

## Readings and named deviations (decided inside my files; please confirm or overrule)

1. **Delay is checked first, constants included** (ST checks `isDelay` before everything). The step list
   in engine.ts's contract comment put `constant → fires` before `delay`; that would let a delayed
   constant fire early. Order implemented: delay → sticky → cooldown → constant → keys. Sticky stays
   before constant on purpose: a sticky constant entry must record `why:'sticky'` inside its window,
   else every 'constant' fire would restart the derived window and the cooldown would never start
   (ST does not need this because it stores the window).
2. **"Not yet activated" = ST's rule.** A later loop skips entries already accepted, failed rolls, cut,
   and delay/cooldown-blocked ones; a **group loser is looked at again** in the next loop (it loses again
   if its group got a member accepted, else the group is drawn again among that loop's members — e.g. when
   the earlier winner failed its roll).
3. **excludeRecursion in recursion loops: skipped entirely** (ST), not "matched against chat text only".
   The two differ only for an excludeRecursion group loser (ST never looks at it again).
4. **`book.recursive: false`** = the book takes no part in recursion: its accepted entries do not feed the
   buffer and its entries are not looked at in recursion loops (contract only spoke of the source side).
5. **Draws.** 'lore.prob' is index-addressed: the entry at position k of the gather order (disabled entries
   keep their place) reads the k-th value, so a roll never depends on other rolls, the loop, or entries
   toggled on/off. 'lore.group' gives one value per contested group in the order groups are met (loop by
   loop; sticky first, then gather order). Both are `subRng(seed, label)` as the contract says.
6. **'regex-error'** replaces only `no-key-match` / `secondary-logic` (the broken key is the likely cause);
   `chance`, `budget-cut`, `cooldown`, … stand, with `regexErrors` listed on the verdict. Keys are compiled
   only when an entry gets to key matching, so `regexErrors` lists keys that were actually tried.
7. **Broken '/re/' fallback** matches the pattern text (without slashes, RoleCall) as a literal under the
   entry's own caseSensitive / wholeWords. ST instead treats a JS-invalid key as the whole literal
   `/…/`; JS-valid lookaround keys work in ST but not in re2js.
8. **Verdict `loop`** is the last loop the entry was judged in (a `no-key-match` entry rechecked in loop 2
   says loop 2).
9. **Timers vs ST** (both follow from the contract, recorded so golden tests expect them). *M2 fix:
   the second and third bullets are superseded — the cooldown after a sticky window now starts at the
   first scan at or after L + S (pathScans), and a continue's fires sit at index + 1; see
   m2-contract-fix.md item 2.*
   - `chatLengthAt` counts hidden messages; ST's chat for WI is `coreChat`, which drops `is_system` ones.
   - The cooldown after a sticky window starts exactly at `L + sticky`; ST re-arms it lazily at the first
     scan at or after the window end, so with two messages per turn and cooldown 1 ST may block one turn
     that the core does not.
   - A continue's own fires get `at` = the message index (ST's continue scans one message later).
10. **Placement ties** keep acceptance order (contract). Exact ST (sort by order descending, stable, then
    `unshift`) puts equal-order entries in REVERSE acceptance order.
11. **ignoreBudget text does not count** against later entries (contract). ST adds it to `acceptedContent`,
    so in ST an ignoreBudget entry eats budget from the entries after it.
12. **Whole-word keys are matched with a loop, not the lookbehind regex in the keys.ts comment:**
    JavaScriptCore (Bun 1.3.14) reads one UTF-16 unit of a surrogate pair inside a lookbehind, so
    `/(?<![\p{L}])a/u.test('\u{10400}a')` is `true` under Bun (V8: `false`). M3's `normalizeTerm` should not
    rely on lookbehind over `\p{…}` classes either.

## Gaps (need a decision; nothing changed outside my files)

1. **Macros in keys.** ST runs `substituteParams` over every key (`normalizeWorldInfoKey`), so keys like
   `{{char}}` or `{{user}}` work there. `LoreRunInput` has only `expand(key, content)` for content
   ("called once per entry that passes its roll"), so keys are matched as written. Options: an optional
   `expandKey?(text: string): string` on LoreRunInput (identity macros only), or assemble pre-expands
   `keys`/`secondary` on a copy of the books before runLore.
2. **ST `groupOverride` (group priority) and group scoring** have no field in LoreEntry; such entries are
   drawn by weight (st-worldinfo.ts already warns "not honoured"). No action needed for M2.
3. **`LoreVerdict.detail` for a fired sticky entry** carries `{ remaining }` (messages left in the window);
   the doc comment lists remaining only for cooldown/delay.
