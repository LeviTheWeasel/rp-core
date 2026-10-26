# Contract notes — cli agent (M1a)

Files: src/cli/{main, oneshot, signals, render, args, commands, home, io, provider}.ts; README.md
usage section; tests in test/cli/ (+ fixtures in test/fixtures/scripts/). No file outside my paths
was edited; src/index.ts needed no new exports.

## Gaps in the contracts (worked around)

1. **There were no CLI stubs.** src/cli/ was empty, so the module shapes are mine:
   `main(argv, deps) → Promise<exit code>` (main.ts), `runSend(opts)` + `EXIT` + `exitCodeOf`
   (oneshot.ts), `installTurnSignals(actions, source)` (signals.ts), `renderPath`,
   `createTextRenderer`, `describeEvent` (render.ts). main.ts starts with `#!/usr/bin/env bun`
   (needed for package.json `bin`); the SPDX header follows on line 2.
2. **The user message's `changed` is not in the turn stream.** `SessionHandle.send()` (and so
   `submit()`) publishes `changed{msg}` for the user line only to `engine.events()`; `TurnHandle.events`
   starts at `start`. One-shot `--json` therefore prints open events + the turn's events (start, text…,
   changed, done); the user message id is `start.parentId`. If M6 wants it in the stream, `submit()`
   could put it on the turn queue before `start`.
3. **`--debug` "raw provider errors" has nothing raw to print.** The engine reduces a ProviderError to
   `failed{category, code, message}` (and `retry{code, status}`); status, retry-after and response body
   never reach a client. `--debug` prints the `failed`/`retry` events as JSON on stderr plus stack traces
   of internal errors. M1b (HTTP) wants a debug channel: e.g. `EngineOptions.debug?: (e: unknown) => void`
   or `status?` on `failed`.
4. **No lock reader is exported.** `show` must say whether an unclosed turn is running elsewhere or was
   interrupted; log.ts exports `isLockStale` and `LockInfo` but not its lock parser, so commands.ts
   parses `<id>.lock` itself. Suggest `export function readLock(home, id): LockInfo | null` in log.ts.
   `show` also uses `openTurns` from engine/recover.ts (an internal export).
5. **`SessionHandle.submit()` has no guidance/fallback/emptyReply.** `--guidance` on a reply is therefore
   a usage error (64) checked by the CLI: `send()` + `runTurn({kind:'reply', guidance})` would write the
   user line before the engine refuses `invalid_params`.

## Decisions the contract left open

- **Exit codes**: §12.3 table (0/2/3/4/5), plus 1 for other errors (unreadable card/persona/script,
  `show` of a missing session, internal errors), 64 usage, 130 second SIGINT, 143 SIGTERM.
  `send` to a missing or locked session is a refusal (5: `session_not_found`/`session_locked`).
- **Refusal output**: stderr always ends with `{"type":"refusal","code","message"}`; text mode first
  prints a human line and, for `no_connection`/`nothing_to_reply`/`nothing_to_swipe`/`session_locked`,
  a hint. stdout stays empty (or holds only the open events with `--json`).
- **Signals** are installed only between the turn's admission and its end (nothing awaits between
  `engine.session()` and `submit()/runTurn()`, so no signal can land in between). First SIGINT →
  `turn.stop()`; SIGINT or SIGTERM after that → immediate exit (130/143); SIGTERM first →
  `session.close()` and exit 143 once the `stopped` event is out. An immediate exit leaves the lock and
  the open turn behind: the next open recovers it like a crash.
- **show --json** prints exactly `view.path` (MessageView[]), not the whole PathView (it has a Set).
- **new --json** prints `{sessionId, title, greetings: [{id, text}]}` (greeting roots as stored, macros
  expanded). `--card` falls back to a library id when no such file exists. `--persona` is a native
  persona JSON checked with `validatePersona`.
- **`send <session> -`** reads the reply text from stdin (one trailing newline dropped).
- **--provider script:<file>** → Connection `{id:'script', origin:'script:<absolute path>', local:true,
  caps:SCRIPT_CAPS}`; `record:`/`replay:` are a usage error naming M2. A script that fails `parseScript`
  is exit 1 before the session is opened.
- **Output flushing**: under Bun 1.3.14 `process.exit()` right after a big write to a pipe loses the
  tail (measured: 512 KiB of 8 MiB arrived), and awaiting an empty write's callback does not help; the
  CLI tracks the last real write's callback (io.ts) and exits after it.

## Not done (open)

- `--sandbox --seed <file>` (§5.2, §12.3, Kintsu K4): the seed format (character, persona, connection)
  has no definition in M1a; `--sandbox` alone works.
- Checkpoint cadence is the engine default (1 s / 400 chars); the crash demo test waits for the first
  `chk` line (~1 s) rather than shrinking it, so it exercises the real cadence.
