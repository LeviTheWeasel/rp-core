| File | Source | Commit | Kind | Notes |
|---|---|---|---|---|
| `src/cli/repl.ts`, `src/cli/repl-commands.ts`, `src/cli/repl-render.ts`, `src/cli/repl-journal.ts`, `test/repl/*` | — | — | fresh | Written fresh (§19.2: cli/repl.ts and cli/render.ts are "fresh"; REPL Kit on OpenTUI/React not suitable). Nothing ported, so no port headers. The RoleCall vvs-805 lesson (a Stop pressed before the turn id exists must not be lost) is honoured by design: `submit`/`runTurn` return the TurnHandle synchronously, so there is no window without a handle. |
