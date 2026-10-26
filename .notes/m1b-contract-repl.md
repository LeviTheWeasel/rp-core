# Contract notes — repl agent (M1b)

Owned: `src/cli/repl.ts`, new `src/cli/repl-commands.ts`, `src/cli/repl-render.ts`, `src/cli/repl-journal.ts`,
`test/repl/`. `src/cli/render.ts` unchanged (the REPL only imports `messageText`, `markers`, `describeEvent`).
`runRepl(deps: ReplDeps): Promise<number>` and `ReplDeps` are unchanged.

## 1. Contract problem: `/rewind n` needs an exact select (engine change requested)

`SessionHandle.select({messageId})` writes `head` on `newestDescendant(messageId)`. On a straight path
(G → U1 → A1 → U2 → A2) the newest descendant of every path message is the head itself, so select is a
no-op and **a rewind (§5.5 "Откат — head на более раннее сообщение") is impossible through the API**.
The api.ts comment ("select a swipe, rewind, go to a tail") assumed otherwise.

Proposed fix (two lines, engine owner):

```ts
// api.ts
select(input: { messageId: string; expectedVersion: number; exact?: boolean }): { version: number };
// session.ts SessionImpl.select
const leaf = input.exact === true ? input.messageId : newestDescendant(idx, input.messageId);
```

The REPL already calls `select({messageId, expectedVersion, exact: true})` for `/rewind` (built as a
variable so it compiles against today's signature) and checks `view().head` afterwards; on today's
engine it prints `! could not rewind to message n: this engine only selects the newest message below it`
instead of pretending. Verified on a scratch copy with the patch applied: the e2e test
`/rewind then a new message makes the old continuation a tail; /tails lists it; /goto returns` passes,
and test/engine + test/session + test/cli stay green (303 pass). That test is `test.skipIf(!EXACT_SELECT)`
(feature-probed at load), its counterpart for the old engine is `skipIf(EXACT_SELECT)`, so the suite is
green before and after the engine change, and the real test switches on by itself.

(Alternative without an API change: "select of a message ON the active path = exact, off it = newest
descendant". Workable, but it silently changes a verb's meaning; the flag is clearer.)

## 2. Additive exports (my files)

- `repl.ts`: `ReplOptions { interactive?, exitWindowMs?, env? }` and `runReplWith(deps, opts)`;
  `runRepl(deps)` = `runReplWith(deps, {})`. `interactive` decides how a line that arrives during a turn
  is judged (below); default: true only for the default stdin input when stdin is a TTY.
- `repl-commands.ts`: `parseLine`, `Command`, `commandClass`, `isLocalCommand`, `resolveBindingArg`,
  `helpText`, `ROLE_NAMES`, `DEFAULT_NOTE_DEPTH` (4).
- `repl-render.ts`: `createProseStyler`, `Screen`, `TurnPrinter`, `statusLine`, `formatMessage`,
  `renderNumberedPath`, `renderTails`, `renderUsage`, `renderTrace`, `refusalText`, … (pure).
- `repl-journal.ts`: pure readers over (header, entries): `configOf`, `siblingIds`, `tailRows`,
  `resolveMessageId`, `pathUsage`, `latestTrace`, `windowFor`.

## 3. For the integrate agent (wiring `rp-core open` / after `new`)

- Wiring: `engine = await Engine.open({home, connections: buildConnections(cfg, …), prices: cfg.prices})`,
  `session = engine.session(id)` (Refusal `session_locked` / `session_not_found` → report as one-shot does),
  `code = await runRepl({engine, session, config: cfg, home, io: processIo()})`, then `await engine.close()`
  and exit with `code`. `openSession` may be omitted: the default is `engine.session(id)`.
- **Signals**: do not install `signals.ts` handlers while the REPL runs. The REPL owns SIGINT: by default it
  listens to readline's `'SIGINT'` (a TTY in raw mode) and to `process` `'SIGINT'` (piped stdin, `kill -INT`).
  SIGTERM is not handled by the REPL; suggestion: main maps it to `engine.close()` (stops the turn, keeps the
  partial text, unlocks) and exits 143.
- **Exit codes**: 0 for /quit, EOF, a double Ctrl+C at the prompt; 1 for an internal error; **130** when the
  user pressed Ctrl+C three times on a turn that would not settle after Stop (a server ignoring the abort):
  the REPL returns at once without waiting for the turn and the lock stays for the next open to recover —
  the caller must `process.exit(code)` promptly in that case.
- The REPL closes the session it ends with (another one after /open or /fork), never the engine.
- **Piped stdin is a script**: every line waits until the previous turn settles (`printf 'Hi\n/r\n/show\n' |
  rp-core open <id>` works; that is the live-demo form). On a TTY, a line typed mid-answer is held (text),
  queued (read-only commands) or refused locally with `refused [session_busy]` (editing commands).
- `/probe` prints a pointer to `rp-core probe <connection> [model]`; tell me if the CLI command is named
  differently.
- `/model` validates the connection against `config.connections` (config.toml), not against the engine's
  connections; with `--provider script:` every role resolves to the override anyway.
- Banner `ctx`: the window of the last answer by the same binding (its trace), else `[caps."c:m"]
  contextLength`, capped by the session `window`; `ctx ?` before a model's first answer, because
  `EngineHandle` does not expose `Connection.capsFor`. If an exact banner window matters, an optional dep
  (e.g. `windowFor(conn, model)`) could be added to ReplDeps later.
- The REPL reads the journal read-only with `readSessionFile(home, session.id)` (no lock) for /tails, /usage,
  /trace, /model, /note and sibling lists, because SessionHandle has no `config()` / entries accessor.
- `/note off` writes the merge-patch `{authorNote: null}` (mergePatch deletes; the entry check accepts it);
  `/think show|hide` persists `reasoningShown` via `configure` when no turn runs.
- Not in M1b: the §12.4 "held answer: keep / discard?" prompt on open (needs commitAnyway/discard, M6); a
  `held_pending` refusal is printed as such.

## 4. Engine behaviour observed (no change asked)

- `fork` copies only the active path (greeting siblings are not copied): a fork shows `greeting 1/1`.
- The `fallback` notice is emitted on every fallback (not once per session); the REPL dedupes notices by code.
- A provider error without an HTTP status is never retried (`isRetryable` needs `status`), so scripted
  `{error:{code:'overloaded'}}` fails at once; tests that want a retry/fallback give a status.
