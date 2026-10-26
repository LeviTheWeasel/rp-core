# Contract notes — integrate (M1a)

State at hand-over from the module agents: `bun test` 634 pass / 0 fail, `tsc --noEmit` clean, no
`not implemented` left in src/, purity test green. Nothing was broken across modules; the work below
resolves the issues the agents raised in `.notes/contract-*.md`. After it: 637 pass / 0 fail (three
runs), typecheck clean.

## Contract changes (made consistently everywhere)

1. **`EngineOptions` gains `timeouts?: {firstByteMs?, idleMs?}` and `timers?: DelayTimers`**
   (engine note 1). The engine already read them from the same object through a cast
   (`EngineOptions & EngineTuning`); a host could not pass them without that cast. `api.ts` now
   declares them, `engine.ts` reads them directly, `EngineTuning` stays as
   `Pick<EngineOptions, 'timeouts' | 'timers'>` for callers that spell it, the engine test kit no
   longer needs it. `hooks` was NOT added: the hook runner is M9 and the M1a call points ignore their
   argument, so an `EngineOptions.hooks` would be silently dropped — it belongs with the runner.
2. **`EntryInput` keeps MemEntry's known keys** (storage note 1). `DistributiveOmit` now uses a
   key-remapping omit (`OmitKey`) instead of `Omit`, which collapsed `MemEntry` (string index
   signature) to `{[k: string]: unknown}` and let `SessionLog.append` accept any object at compile
   time. The only fallout was one test literal with a loosely typed `trace` (cast added).
3. **`PrepEntry.model?: {connection, model}`** (engine note 4). turn.ts writes the primary binding
   into `prep`; recover.ts copies it into the recovered answer's `gen.connection` / `gen.model`
   (before: `{kind, finish:'interrupted'}` only). The entry guard accepts it; old journals without it
   still read. A crash during a fallback attempt is labelled with the primary — the same limitation
   `prep.cont` has (engine note 5), left as is.
4. **`EventBody` exported from `protocol/events.ts`** and from `src/index.ts` (engine note 6);
   turn.ts re-exports it for session.ts instead of deriving its own.
5. **`readLock(home, id): LockInfo | null` exported from `session/log.ts`** (cli note 4). The internal
   file reader became `readLockFile`; `cli/commands.ts` dropped its private lock parser and uses it.
   `LogOptions.clock` now documents that it must be wall time (engine note 2, storage "TTL compares
   the injected clock with the other process's renewed").

## Behaviour fixes

6. **Preset validation agrees with assembly on `{{history}}`** (assemble "problems" 1, formats note).
   `validatePreset` counted the exact substring; it now counts with `historySlots` from
   `prompt/assemble/slots.ts` (the macro lexer), so `{{ History }}` is one slot, an escaped
   `\{{history}}` or one nested in a macro argument is none. New test in test/formats/native.test.ts.
   (native.ts → slots.ts is a runtime import; slots.ts imports only types from native.ts, no cycle.)
7. **Fork `vars0` = the source header's `vars0`** (storage note 2). The fork copies the path's
   msg/edit entries with their own diffs, so a fork-point snapshot double-counted and leaked keys
   backwards after a rewind inside the fork. View at the fork head is unchanged (tested); new test for
   the rewind case; the three expectations in test/session/fork.test.ts updated.

## Provenance / headers

8. `src/protocol/events.ts` carries the RoleCall port header (infra note 1, engine "for other
   agents"); authors from `git log` of stream-delta.ts at fb8dc623e: Coneja-Chibi, NemoVonNirgend.
9. `src/formats/native.ts` carries the Bunraku port header for `canonicalId` (authors from `git log`
   of canonical.ts at 702d8120: Coneja-Chibi, Livingooal); the formats agent had only an inline note.
10. The two ported test files (`test/infra/events.test.ts`, `test/formats/png.test.ts`) got port
    headers. All rows merged into PROVENANCE.md (32 rows, commits shortened, sorted by core file).

## Raised but deliberately left (with reasons)

- **User message `changed` not in the turn stream** (cli 2): `submit()` publishes it only to
  `engine.events()`; one-shot `--json` shows `start.parentId` instead. Event ordering of the wire is
  M6's to freeze (§12.2), so it is not changed here.
- **No raw provider error for `--debug`** (cli 3): nothing raw exists until M1b's HTTP adapter; the
  debug channel (`EngineOptions.debug?` or `status?` on `failed`) is an M1b decision.
- **`submit()` has no guidance** (cli 5): a guided reply makes no sense (guidance is swipe-only,
  D-41); the CLI's usage error is correct.
- **`--sandbox --seed`** (cli "not done"): the seed format is undefined in M1a; `--sandbox` works.
- **`TurnEntry.parent` non-empty for a continue of a root greeting** (engine 3): the engine writes the
  target id; recovery of a continue never reads `parent`. Making it nullable would widen the doc's
  type for no reader.
- **Fallback on continue with different `caps.prefill`** (engine 5): needs a `prep` per attempt;
  unreachable with one scripted connection, revisit with M1b's real adapters.
- **`gate_unsupported` unreachable** (engine 7): `RunTurnOptions.inspect` arrives with M9 gates.
- **Native type gaps** (formats 1–6: `selective`, characterFilter & scan sources, CCv3 `nickname`,
  an `ImportError` code for "right kind but broken", one `st_preset` kind): M2 decisions (lore engine,
  preset importer); the values ride `extras` with warnings, so nothing is lost meanwhile.
- **`categoryOf` could move to providers/types.ts** (infra 3): its second user is M1b's openai-chat
  adapter; move it then.
- **Macro error channel** (macros 3): additive `errors()` for the trace when the bounds are surfaced.
- **CJK token estimate** (prompt-small 7): the §11 M1 formula has no class for it; belongs with the
  EMA / tokenizer work (M1b/M2).
- **Two `fsyncDir` helpers** (`session/log.ts` swallows errors, `formats/library.ts` rethrows
  unexpected ones): both correct for their callers; not merged to avoid a formats → session import.
- **`CONTRACT FILE: … agent implements the bodies` comments** in the stubs are stale now but harmless;
  left for the architect to reword when the contracts are frozen.
