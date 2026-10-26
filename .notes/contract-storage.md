# Contract notes — storage agent (M1a)

Files: src/session/{entries (parse functions), log, tree, fold, fork}.ts, src/protocol/jsonl.ts.

## Problems in the contracts (worked around, not edited)

1. **`EntryInput` loses the `mem` member's fields.** `DistributiveOmit<MemEntry, 'seq'>` is
   `Omit<MemEntry, 'seq'>`, and `Omit` over a type with a string index signature collapses to
   `{ [k: string]: unknown }`. So `SessionLog.append` accepts *any* object at compile time and
   `input.t` is typed `unknown`. Workaround: append validates at runtime (see 4). Suggested fix in
   entries.ts: `type OmitKey<T, K> = { [P in keyof T as P extends K ? never : P]: T[P] }` and
   `DistributiveOmit<T, K> = T extends unknown ? OmitKey<T, K> : never` (keeps known keys and the
   index signature).
2. **Fork `vars0` = vars at the fork point (implemented as specified) double-counts on rewind.**
   The fork also copies the path's msg/edit entries with their `vars`. Because diffs are plain
   assignments, re-applying them on top of the fork-point state is idempotent, so the view at the
   fork's head equals the source at `at` (tested). But after a rewind *inside the fork* to a message
   before `at`, keys first set later on the path leak backwards (they are in vars0). Recommended:
   `vars0` = the source header's `vars0` (the whole path is copied anyway). One-line change in
   `planFork` if accepted.
3. **`edited` is undefined by the contract.** Implemented: `edited` is true when a `reason:'user'`
   edit carrying blocks applies. A continue edit alone (the model extending its own text) does not
   mark the message edited; it still replaces blocks and gen.
4. **Behaviour beyond the doc comments that callers should know:**
   - `append` serializes, re-parses with `parseEntry`, and **throws** on an entry the reader would
     reject (nothing is written; lastSeq unchanged). It also throws after `close()`, and throws
     `SessionLockedError` once the renew timer has seen another owner's lock (`lockLost`).
   - `append` returns (and indexes) the parsed copy, not the input object.
   - `entries()` returns a **frozen snapshot** cached until the next append, not the live array.
   - An unreadable header throws the new `SessionCorruptError` from `openSessionLog` /
     `readSessionFile` (the contract only names Locked/NotFound). `createSessionLog` throws a plain
     `Error('session already exists: …')`.
   - Session ids must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` (they become file names);
     open/read with any other id → `SessionNotFoundError`; create/fork → `Error`.
   - On open, a torn/invalid tail cuts the file back to the end of the **last good line**, so bad
     lines sitting between it and the tail go to `.torn` too (otherwise each reopen would eat one
     more line). Their `bad_line` notices are still reported.
   - A final complete line that parses but has a non-increasing seq is a `bad_line`, not a tail.
5. **Message id collisions.** 8-hex ids give ~1 % odds of at least one collision in a 10k-message
   session. `buildTree` keeps the first message with an id and ignores later duplicates (that commit
   would silently vanish from the tree). The engine should re-draw an id when `idx.msgs.has(id)`.
6. **Head entry in a fork is never needed in practice**: every ancestor of `at` has a smaller seq,
   so `at` is always the newest copied msg. The check is kept as the contract says.

## Decisions taken inside my files

- Guards (entries.ts): full shape checks for the envelope of every kind, blocks (unknown block
  kind = failure; the reserved `image` block will need a guard), generation, vars, the whole
  `SessionConfig`, character core fields (`name`, `description`, `greetings`) and persona
  (`name`, `description`). The trace is checked only for `seed`, `now`, `lore.fired` (what feeds
  state); dir/recall/config patches/lorebooks are checked only for being objects. Extra fields are
  kept. New exports: `checkEntry`, `checkHeader` (guards on already-parsed values).
- jsonl.ts: bytes are buffered until LF and each complete line is decoded by one TextDecoder
  (fatal:false), so multi-byte chars split across chunks reassemble without `stream:true`. One CR
  before LF is stripped; a lone CR inside a line is kept; only zero-length lines count as empty
  (whitespace-only lines are passed through). New export `splitLineSpans` (byte spans + torn line
  number) used by log.ts for truncation.
- log.ts: lock file is created with `'wx'` and not fsynced (a lost lock after power loss is just
  absent). An unparsable lock (a writer between its `wx` open and its write) is trusted while its
  mtime is within the TTL. Stale-steal re-reads the lock and only unlinks it if unchanged, then
  retries `wx` (4 rounds). TTL compares the injected clock with the other process's `renewed`, so
  tests must not mix a fake clock and the system clock across two opens. `close()` also
  fdatasyncs (chk lines). A failed write is rolled back with `ftruncate`; a failed fsync marks the
  log unusable.
- Bun check (§19.2 "проверка на M1a"): under Bun 1.3.14 on Linux 7.0, `fsyncSync` on a directory
  fd (`openSync(dir, 'r')`) and `fdatasyncSync` both work. `fsyncDir` still swallows errors and
  returns false, so an odd filesystem cannot fail a create.
- fold.ts: vars of hidden path messages still apply (hide affects prompts, not state). `fires`
  lists only non-empty `trace.lore.fired` of path msgs and their continue edits, in path order.
  New exports: `foldVars`, `mergePatch` (RFC 7396: objects merge, arrays/scalars replace, null
  removes) and `currentConfig(header, entries)` — the engine should use these for the current
  config rather than writing a second merge.
- fork.ts: written whole to `<newId>.jsonl.fork.tmp`, fsynced, `link()`ed into place (no
  overwrite; rename fallback where hard links are unsupported), dir fsynced, then opened (locked)
  through `openSessionLog`. The source title is kept. New export `planFork` (pure).
- listSessions takes the id from the file name and reads only the header line.
