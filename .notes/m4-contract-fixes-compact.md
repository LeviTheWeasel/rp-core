# M4 fixes — unit `compact` (D-124)

Files touched: `src/session/log.ts` (compact section + its imports `fchmodSync`, `futimesSync`, `type Stats`, and
the header comment's compact line), `src/cli/compact.ts`, `test/cli-m4/compact.test.ts` (new describe
`compact hardening (D-124)`, 15 tests; 14 fail on the pre-fix code, 1 is a control that passes on both).

## Changes

- **Re-check before the rename.** The journal is read through an fd kept open until the rename (`fstat` → exactly
  `size` bytes by positional reads; a short read = changed). After the temp file is complete and right before
  `renameSync`: (1) the journal must still be the same file (`statSync(path)` dev/ino = the fd's at read time) with
  the same size AND mtime (`fstat(fd)`); (2) the lock file must still name us (`sameOwner`). Journal first, then
  the lock (a writer had to hold the lock, so a write found here also names its owner if it still holds it).
  Else the temp file is unlinked and `SessionLockedError` is thrown (→ `session_locked`, exit 5) with one of three
  messages: "changed while it was being compacted (another process wrote to it)", "was taken over … (locked by
  pid P on H)", "lost its lock … (another process took it over)" (lock file gone). compact never releases a
  lock that is not its own (unchanged `releaseLock`).
- **The reader accepts the same lines.** Choice: KEEP the rows, not refuse. `planCompaction` walks the lines with
  the seq the rewritten file's reader would hold: when a parsed-but-skipped line (seq not increasing) would be
  accepted because the rows before it go, the newest of those rows stays (its seq ≥ the line's, so the line stays
  skipped and every kept accepted line stays accepted). Also kept: a dropped LAST row whose removal would leave a
  line that does not parse as the last line (the reader would cut it off as a torn tail). Then the rewritten bytes
  are read back through `parseJournal` itself and must give exactly the expected entries (JSON-equal, in order) with
  no tail cut; else `Error("… would change the lines its reader accepts; nothing was changed")` (exit 1) — a guard
  that the keep rule makes unreachable.
- **Mode.** Temp file: any leftover of this pid unlinked, then `openSync(tmp, 'wx', 0o600)` (never follows a link),
  `fchmodSync(fd, journalMode & 0o7777)` before the first byte is written.
- **mtime.** `futimesSync(tmp, atime, mtime of the journal as read under the step-2 lock)` after the write, before
  the fsync and the rename (seconds as floats: sub-ms precision is kept on Linux/Bun).
- **Dropped draft.** `cmdCompact` stops after step 1 when any open event is `recovered` with a non-empty `draft`
  (outcome dropped or abandoned): the draft is shown first (text: the existing describeEvent line; --json: the event's
  JSON line), then the refusal `draft_recovered` (exit 5, hint "save the draft above if you want it, then run compact
  again (that run removes it)"). The next run finds the turn closed by its `end`, recovers nothing, and compacts.
- **--json.** Every open event (recovered, notice) is written to stderr as one JSON line (the event object as
  `send --json` prints it, with its sessionId and ts); stdout holds only the result object (or nothing on a
  refusal, as before). Text mode unchanged.

## Additive API

```ts
interface CompactResult { …; kept?: number }      // rows kept so the reader's view does not change; only when > 0
interface CompactSeams { beforeRename?: () => void }   // test seam: runs once the temp is complete, before the re-checks
function compactSessionLog(home, id, opts?: LogOptions, seams?: CompactSeams): CompactResult;
```
`--json` output adds `"kept": N` only when rows were kept; text mode appends "; N kept: removing it/them would
change the lines the reader accepts".

## Deviations from section H, with reasons

- The identity check also compares the journal's **mtime** (D-124 names dev/ino and size): it catches an in-place
  rewrite of the same size; a `touch` meanwhile only costs a refused run.
- No lock **renewal** during compact (the review called it optional): the re-check already refuses a stolen lock;
  the only remaining window is a steal plus a write in the microseconds between the lock check and the rename,
  and only after compact itself stalled past the TTL.
- `fchmod` and `futimes` are best effort: a filesystem without modes keeps 0600 (narrower, never broader), one
  that refuses times only costs the list order. Ownership (uid/gid) is not copied.
- The draft stop is a **refusal** (`draft_recovered`, exit 5), so a script sees that nothing was compacted.

## Needed in files I do not own

- `src/cli/main.ts` (help of `compact`): mention `draft_recovered` among the exit-5 cases ("an interrupted answer
  that recovery could not save is shown first; run compact again after saving it"), that with `--json` the
  recovery events go to stderr as JSON lines, and the optional `"kept"` in the JSON object.
- `src/engine/api.ts` (lead): if `--stdio` (M6) exposes compact, `RefusalCode` needs `'turn_open'` and
  `'draft_recovered'`.
- ARCHITECTURE.md §12.3 (lead): the same three points; §5.3 compact: re-check before the rename, mode/mtime kept,
  rows kept to keep the reader's view.

## Results

`bunx tsc --noEmit -p .` clean; `bun test test/cli-m4` 30 pass; full `bun test` 4249 pass, 3 skip, 0 fail
(199 files, other fix units' work in progress included).
