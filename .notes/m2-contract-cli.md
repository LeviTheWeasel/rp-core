# M2 contract notes — cli agent

No contract file was changed. Additions inside src/cli only:

- `args.ts`: FlagKind `'list'` (repeatable string flag, values in order) and `list(p, name)`.
  `Parsed.flags` values are now `string | true | string[]`.
- `provider.ts`: `parseProviderSpec` returns `{scheme: 'script'|'record'|'replay', file}`;
  new `prepareProvider(spec, command)` → `{spec, attach(rt)}`, `replayConnection`,
  `recordingConnections`, `readRecording`. `scriptConnection` kept (script only).
- `refs.ts` (new): `resolvePresetRef`, `resolveLoreRef`, `RefError`, `expandHome`, `bookRows`,
  `entryTitles`, `loadSessionBook`.
- `preview.ts` (new): `cmdPreview` for `rp-core preview`.
- `render.ts`: `hasServerWords` is false for `replay_mismatch` and `script_exhausted` (no server
  spoke; the "--debug shows the server's words" hint was misleading there).

## Decisions taken here (please confirm)

1. **Replay caps** (the open question in m2-contract-infra.md). `--provider replay:<file>` is one
   override connection (id `replay`, origin `replay:<abs file>`), as the task says, but its
   `capsFor(model)` returns the caps of the connection the call was recorded on
   (`RecordedCall.model.connection`) when config.toml still defines it, else SCRIPT_CAPS; `local`
   follows the first recorded call's connection. Without this a recording made on a real
   connection never replays (shaping differs: e.g. mid_system as-user vs SCRIPT_CAPS native) —
   test/cli/m2.test.ts proves record → replay round-trips on an openai-chat mock.
2. **record:** wraps every config.toml connection (`{...conn, provider: createRecordingProvider(...)}`,
   so id, caps, capsFor, origin, local, resolveKey stay), `secrets: () => rt.secrets.known()` (all
   known keys and header values, a superset of the connection's own), sink `appendFileSync(file,
   line + '\n')`. The file is created (append, never truncated) before anything runs, so a bad
   path exits 1 at once.
3. **Replay order**: every process plays from line 1 (like script:). Multi-turn replays need one
   process (`chat` with piped input). Documented in README.
4. **--lore** values are appended in order, deduplicated; config.toml has no lorebooks default.
5. **`/lore test`** prints every fired and every "loud" miss (chance, cooldown, delay, budget-cut,
   group-lost, exclude-recursion, secondary-logic, regex-error); `no-key-match` / `disabled` lines
   beyond 40 total lines are folded into one count line (`… and N more not fired (no-key-match X,
   disabled Y)`). `rp-core preview --verdicts` prints all lines. A miss's `loop` is not shown (the
   engine reports the last loop it was judged in, which reads as noise).
6. `/preview n` refuses a user message or a greeting in the REPL before calling the engine; an id
   prefix is resolved like /goto and must be on the active path.

## For other owners (nothing changed outside src/cli)

- **formats**: `rp-core import package.json` succeeds as a CCv1 character (name + description). Maybe
  intended (CCv1 is just that), but a stray JSON file lands in library/characters.
- **engine**: preview of a fresh session (head = greeting) is `nothing_to_swipe`; the REPL adds a
  hint, the one-shot exits 5. Fine by the contract, just noting it.
- **engine / README**: `/lore test` uses the preview seed, not the next turn's, so entries with a
  probability < 100 % can disagree with the turn; README says so.
- **integrate**: README now says milestone M2 (status line, "What works today", Install: two runtime
  deps, data layout, command reference, two new sections). Please check those claims once
  everything is merged.
