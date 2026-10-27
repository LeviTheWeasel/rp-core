# M4 contract note — unit `integrate`

Files: `src/agents/director/call.ts` (new), `src/engine/turn.ts`, `src/engine/request.ts`,
`src/engine/session.ts` (preview), `src/engine/admit.ts` (`resolveDirector`), `src/engine/api.ts` (doc
comment), `src/prompt/assemble.ts` (contract / core block), `src/session/entries.ts` (DirectorRecord),
`src/session/view.ts` + `src/session/fold.ts` (comments); tests `test/engine-m4/` (kit, turn, accounting,
preview, call), `test/demo-m4/` (kit, thirty-turns, three-hundred, swipes), fixtures
`test/fixtures/scripts/director-reply.jsonl`, `director-broken.jsonl`. Provenance: `.notes/m4-provenance-integrate.md`.

## 1. Changes needed in files I do not own

- **cli unit** (`/director show`, one-shot line, `/usage`):
  - the state at the head: `directorAt(buildTree(entries) | session tree, view.head)` → `{state, record}`;
    "last result" = `record.reusedFrom ? 'reused' : record.ok ? 'planned' : 'failed (' + code + ')'`.
    A readable dump in that order is in `test/demo-m4/kit.ts dumpState` (test-only; copy what helps).
  - `trace.calls` now holds the Director's rows FIRST (prep and commit), then the narrator's; each row's
    `model` is the Director's `conn:model`. `gen.usage` is still the narrator's only.
  - Events: `director{planning}` (silent), `planned{summary}`, `reused{summary}`, `failed{reason: code}`.
    No `skipped` EVENT is sent on continue (only `trace.agents.director = {status:'skipped'}`), so the
    REPL prints nothing for a continue. A Stop during planning sends `failed{reason:'aborted'}` and then the
    turn's `stopped` (message null).
  - A `dir` read from the journal is typed `StoredDirectorRecord` (`DirectorRecord | Record<string, unknown>`):
    read it with `checkRecord` (as D-117 says), never by property access.
- **state unit / lead**: `test/director/fold.test.ts` casts `dir` to `Record<string, unknown>` (lines 27,
  170). It compiles because of the union above. If the lead wants the field typed exactly `DirectorRecord`
  (no union), those two casts become `as unknown as DirectorRecord` and nothing else changes.
- **lead / ARCHITECTURE.md rev 14**: record the core block's src `core:director` (contract only) next to
  `core:tools`; `runDirector`'s real input/output (§2 below); notice levels (`director_lite` info,
  `director_state_invalid` warn, `caps.suggest` warn); preview's directive rules (D-106 as built).
- **M5a**: `RunDirectorInput.worldSnapshot` is not wired by the turn yet (absent → '' → no section). The
  turn's `runDirector({...})` call in `turn.ts direct()` is the one place to pass it.

## 2. Deviations from m4-decisions.md (and why)

1. **runDirector's shape (D-105).** No `window` input: the Director's window is computed inside from its
   route (`contextWindow({caps, local, configWindow: config.window})`, D-101), since the caller has no
   route-independent window. `notice(key, Notice)` takes the once-per-session key (STRUCTURED_REFUSED_KEY
   differs from its code). It returns `DirectorRun {record, calls, agent}` instead of the bare record:
   the turn needs the TraceCall rows (trace.calls, CALL_CEILING) and the trace.agents row.
2. **entries.ts**: `DirectorRecord` is the type re-export of types.ts (D-117), and the `dir` FIELDS are
   `StoredDirectorRecord = DirectorRecord | Record<string, unknown>` — what a writer puts there and what
   the anyObj guard lets a reader get back. Writers need no cast; readers are pushed to checkRecord; the
   state unit's fold test compiles unchanged.
3. **skipped of the copies and failures**: a reused record's `skipped` is the persona filter's re-run
   (normally `[]`, non-empty only when today's names remove something); a failed record's `skipped` is
   fitState's on `{...prev, turn}` (normally `[]`). Failed records keep `transport`, `profile`, `model`
   when a call was made (`no_connection` has none).
4. **max_tokens**: the binding's limit is `binding.maxTokens ?? binding.samplers.max_tokens` (as
   replyLimits reads it); full `min(16 384, window − prompt, maxOutput, binding)` floored at 1 when a
   forced `full` prompt does not fit (the call then fails as a provider error, honestly). Lite's +1 024
   applies when the call would think: `output !== 'none'` and not (`reasoning === 'none'` and
   `canDisable`) — so a binding asking for reasoning on a model that can turn it off gets it too.
5. **reasoning 'low'** only when `control === 'effort'` and `efforts` (if listed) has 'low'.
6. **History**: blank-text messages (e.g. a reasoning-only reply) are left out besides hidden ones.
7. **preview({turn})** re-renders the stored directive whatever today's `director.enabled` (it was
   sent); the contract follows today's config (preview_inputs_changed then names the system blocks).
8. **Notices**: `director_lite` is level `info`, `director_state_invalid` `warn` (D-115 names no level).
9. The turn passes the view the Director read (folded at U on a swipe) as `request.view`, so buildRequest
   does not fold it again (startView returns it as is; the Director-off path is unchanged).
10. assemble's refusal message names "the Director's contract" instead of "the tool instructions" when
    the core block holds only the contract.

## 3. Additive API

```ts
// src/agents/director/call.ts
export type DirectorProfile = 'full' | 'lite';
export type DirectorEvent = Omit<Extract<EventBody, {type:'director'}>, 'type' | 'turnId'>;
export interface DirectorAgentRow { status: 'done' | 'reused' | 'failed'; code?: string; transport?: Transport }
export interface DirectorPersona { name: string; description?: string; aliases?: string[] }
export interface RunDirectorInput { tree; view /* at U */; upTo; kind: 'reply'|'swipe'; replaced?; guidance?;
  config: SessionConfig; persona?: DirectorPersona; charName: string; route: Route | null; binding: Binding;
  counter: TokenCounter; turnId: string; turnSignal: AbortSignal; env: AgentCallEnv;
  worldSnapshot?(view, budget: WorldBudget): string; emit(ev: DirectorEvent): void; notice(key: string, n: Notice): void }
export interface DirectorRun { record: DirectorRecord; calls: TraceCall[]; agent: DirectorAgentRow }
export function runDirector(input: RunDirectorInput): Promise<DirectorRun>;
export function directiveInsert(d: NarratorDirective | undefined): DepthInsert[];   // depth 1, system, 'director'; [] when '' renders
export function stubInsert(): DepthInsert[];                                        // STUB_DIRECTIVE at depth 1
export function personaNames(p: DirectorPersona | undefined): string[];
export function swipeReuses(config: SessionConfig, guidance: string | undefined): boolean;
export function reusedRecord(tree: TreeIndex, replaced: string, persona?: DirectorPersona): DirectorRecord | null;
export function withoutDescriptions(schema: unknown): unknown;                      // lite tagged schema text (D-117)
export function capSkipped(lists: readonly (readonly Skip[])[]): Skip[];             // one cap, '+N more' folded
export const PLAN_SCHEMA_NAME = 'director_plan';
// src/engine/admit.ts
export function resolveDirector(ctx, config, narrator: {binding, primary}): { binding: Binding; route: Route | null };
// src/prompt/assemble.ts
AssembleInput.contract?: string;  export const CORE_DIRECTOR_SRC = 'core:director';
// src/session/entries.ts
export type { DirectorRecord };  export type StoredDirectorRecord = DirectorRecord | Record<string, unknown>;
```
Behaviour: `buildRequest` sets `contract = contractText(persona name)` while `config.director.enabled`, on
every kind (continue too) and in previews; the core block = contract + tools protocol/catalog; "tools are
offered" is `tools.length > 0` everywhere in assemble (room, declarations, gap note, `result.tools`).

## 4. Results, and what I could not do

- Tests: `test/engine-m4` 37 (turn 22, accounting 3, preview 5, call 7), `test/demo-m4` 5 (30 turns 1,
  300 turns 2, swipes/small model 2; ≈ 7 s together). Full `bun test`: 4150 pass, 3 skip, 0 fail;
  `bunx tsc --noEmit -p .` clean.
- 300-turn demo (fitState steps 6–7 of D-116 were already in state.ts when it ran): every stored state
  ≤ 32 768 bytes. Directive filled to every limit: median 20 401, max 20 539 bytes, but its authored
  directive alone is over the cap, so `fit:last-directive` runs every turn (no self-audit ever) and the
  working sets are cut to 8/10/4. A usual directive: median 24 140, max 32 766 bytes; `fit:texts` on 289
  of 300 turns; the 16 KB "typical" target is not reached by a verbose Russian planner (0 of 300 under it).
- `summaryOf` (render) counts neither reinforcements nor clues: such turns read "no changes" (visible
  in the 30-turn demo output). Render's call; not changed here.
- `/director show` itself is the cli unit's; the demos print their own dump.
- No live-server check of the structured transport (scripted provider only).
