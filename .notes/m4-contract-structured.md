# M4 contract note — unit `structured`

Files: `src/agents/structured.ts` (new), `src/engine/narrate.ts` (the D-98/D-101 amendment only),
`test/structured/{kit.ts, structured.test.ts, plan-tag.test.ts, filing-draft.test.ts, narrate-agent.test.ts}`.
`test/structured/kit.ts` is a shared helper of my test directory (not a test file).

## 1. Changes needed in files I do not own

- **`src/engine/abort.ts`** (M5b): `AbortReason` has `budget:director` and `budget:recall` only. structuredCall
  maps `filing` and `historian` budgets to `budget:director` for now (`BUDGET_REASON`). Add
  `'budget:filing' | 'budget:historian'` when M5b wires those agents, then change the two map entries.
- **Integrate unit (turn.ts / call.ts)** — how to use structuredCall:
  - Build `AgentCallEnv` from EngineCtx: `{ sched: ctx.sched, fetch: ctx.fetch, timeouts: timeoutsFor(route.conn, ctx.timeouts),
    timers: ctx.timers, clock: ctx.clock, random: ctx.random, retryMaxDelayMs: ctx.retryMaxDelayMs, prices: ctx.prices,
    emit: (ev) => this.emit(ev), onProviderError: (i) => ctx.onProviderError?.({ sessionId, turnId, ...i }) }`.
  - `turnSignal`: the turn's signal, or a child of it. **Do not arm a budget timer yourself**: structuredCall arms
    it from `budgetMs` at the first `onSlot` (D-101) and maps `budget:*` → `timeout`, any other abort → `aborted`.
    (If you abort the passed signal with `budget:director` yourself, it maps the same way.)
  - `result.calls` are `Trace.calls` rows (agent 'director', model 'conn:model'); `usage` and `retry` events are
    already emitted through `env.emit` — do not emit them again. `result.calls.length` is what `callsBefore` needs.
  - `transport_unsupported` → send `notice{level:'warn', code:'caps.suggest', message: structuredRefusedMessage(label)}`
    once per session under the key `STRUCTURED_REFUSED_KEY` (`'caps.suggest:structured_output'`), like
    narrate.ts's `ECHO_REFUSED_KEY` pattern (`firstNotice(key)`).
  - `Attempt` is assignable to `DirectorAttempt` (types.ts) as is; `StructuredFailCode` maps to `DirectorFailCode`
    except `invalid` (DirectorFailCode has none): map `invalid` → `missing_directive` (or add `invalid` to
    `DirectorFailCode` in types.ts — lead's call). readPlan only returns `missing_directive`, so `invalid` can only
    come from a reader that uses it.
- **`RoundsInput` (narrate.ts)** extends `Omit<CallInput, …>`, so it now also has the optional `agent`,
  `responseSchema`, `onSlot` fields; `narrateRounds` ignores them (it builds its own streamCall input). Harmless;
  if the lead wants them gone from RoundsInput, add the three names to its `Omit` list (I did not, to touch nothing
  but the amendment).

## 2. Deviations from m4-decisions.md and why

- **Structured transport + `tag:'plan'`**: D-99's "a bare object is accepted only if its root has `directive`" is
  applied to the TAGGED transport only. On the structured transport the answer is the object by construction
  (response_format), so any root object goes to `read()`, which then says `missing_directive` (more precise than
  `no_output`). A `<plan>` block is still looked for first on both transports.
- **Correction texts for `tag:null` agents** (D-99 gives only the Director's): "Your answer was not usable
  (<reason>). Answer again with exactly one JSON object following the schema above. Write nothing else." (tagged)
  / "… with one JSON object following the schema." (structured). `no_output`'s reason phrase is "no plan block was
  found" for a tagged plan, else "no JSON object was found"; `invalid` → read()'s message cut to 200 (blank: "the
  answer did not follow the schema").
- **Retry key**: the `retry` event carries the FAILED call's callKey (`…:0`), `attempt: 1`, as turn.ts does for
  the narrator; the retried call gets the next key (`…:1`). A Stop or the budget during the retry wait ends the
  call with `aborted` / `timeout` and adds no attempt (no request was sent).
- **No call after an abort**: when the budget ran out between the first answer and the correction (or the turn was
  already stopped), no call is sent and no attempt is added; the code is `timeout` / `aborted`.
- **Timeout mapping**: a ProviderError `code:'timeout'` WITHOUT a status (streamCall's own first-byte / idle
  deadline) → `timeout`; a server 408 (with status) is a retryable provider error → `provider_error` if it repeats.
- **Inline think tags** are stripped from the visible text before reading (createReasoningSplitter with the caps'
  tags or the defaults) and their content joins the reasoning. openai-chat already does this; the scripted
  provider does not, so the rule holds for every adapter.
- **`attempt.finish`** is the normalised FinishReason ('end', 'length', …), not the raw provider string.
- **Strict alternation** (`caps.alternation === 'strict'`): several user messages are joined with a blank line
  into one (shape.ts does this for the narrator; agents do not go through shape).

## 3. Additive API (exports)

`src/agents/structured.ts`:
```ts
type StructuredAgent = 'director' | 'recall' | 'filing' | 'historian';
type Transport = 'structured' | 'tagged';
type StructuredFailCode = 'transport_unsupported' | 'provider_error' | 'no_output' | 'undecodable' | 'invalid'
                        | 'missing_directive' | 'timeout' | 'aborted';
type AttemptOutcome = 'ok' | 'ok_reasoning' | 'retried' | 'no_output' | 'undecodable' | 'invalid' | 'missing_directive'
                    | 'provider_error' | 'transport_unsupported' | 'timeout' | 'aborted';
interface Attempt { transport: Transport; outcome: AttemptOutcome; ms: number; status?: number; finish?: string; tokens?: number }
interface TraceCall { callKey: string; agent: StructuredAgent; model: string; ms: number; usage?: Usage }
type AgentCallEvent = Extract<EventBody, { type: 'retry' } | { type: 'usage' }>;
interface AgentCallEnv { sched: Scheduler; fetch: typeof fetch; timeouts: CallTimeouts; timers: DelayTimers; clock: () => Date;
  random: RandomBytes; retryMaxDelayMs?: number; prices?: EngineOptions['prices']; emit(ev: AgentCallEvent): void;
  onProviderError?(info: { callKey: string; model: string; error: ProviderError }): void }
interface StructuredInput<T> { agent; schema: { name: string; schema: JSONSchema }; read(raw: unknown): ReadResult<T>;
  system: string; user: string[]; tag: 'plan' | null; route: { conn: Connection; model: string; caps: ModelCaps };
  transport: Transport; samplers: Partial<Samplers>; reasoning?: ModelRequest['reasoning']; maxTokens: number;
  repair: boolean; callKeyPrefix: string; budgetMs: number; turnSignal: AbortSignal; env: AgentCallEnv }
type StructuredResult<T> =
  | { ok: true; value: T; transport: Transport; skipped: Skip[]; attempts: Attempt[]; calls: TraceCall[]; fromReasoning?: true }
  | { ok: false; code: StructuredFailCode; message?: string; attempts: Attempt[]; calls: TraceCall[] };

function structuredCall<T>(input: StructuredInput<T>): Promise<StructuredResult<T>>;
function chooseTransport(caps: ModelCaps): Transport;
function firstObject(text: string): FoundObject | null;            // FoundObject = { json: string; whole: boolean }
function findPlan(text: string, opts?: { anyObject?: boolean }): Found;   // D-99; Found = none | broken{why} | json{json, whole, block, extra}
function readAnswer<T>(answer: { text: string; reasoning: string },
  opts: { tag: 'plan' | null; transport: Transport; finish?: string; read: (raw: unknown) => ReadResult<T> }):
  { ok: true; value: T; skipped: Skip[]; fromReasoning: boolean } | { ok: false; code: 'no_output' | 'undecodable' | 'invalid' | 'missing_directive'; message: string };
function correctionReason(code, message: string, tag, transport): string;
function correctionText(reason: string, tag: 'plan' | null, transport: Transport): string;
function correctionEcho(answer: { text: string; reasoning: string }): string;
const PLAN_TAGS: readonly OfferedTool[];                            // [{name:'plan'}, {name:'commit_planning_round'}]
const STRUCTURED_REFUSED_KEY = 'caps.suggest:structured_output';
function structuredRefusedMessage(label: string, agent?: StructuredAgent): string;
```
The messages structuredCall sends have `src` `${agent}:system`, `${agent}:user`, and on the corrective pass
`${agent}:answer` (assistant echo) and `${agent}:correction`.

`src/engine/narrate.ts` (amendment): `CallInput.agent?: CallAgent` (default 'narrator'),
`CallInput.responseSchema?: { name: string; schema: JSONSchema }`, `CallInput.onSlot?(): void` (called once right
after the slot was acquired; not called when the call is stopped in the queue; a throw releases the slot and
propagates); `RequestFields` picks `agent` and `responseSchema`; `modelRequest` sets `req.agent = input.agent ??
'narrator'` and `req.responseSchema` when given (after the tool fields). Narrator requests are key-for-key what
they were (tested).

prompted.ts: no change needed (`parsePromptedCalls` with `OfferedTool = {name, schema}` was enough).

## 4. What I could not do / open points

- A nameless `<tool_call>{"directive": …}</tool_call>` is a broken block (`undecodable`, then the corrective pass),
  and so is a `<plan>` mention in prose followed by a bare (untagged) plan object — D-99 read strictly. Both could be
  accepted cheaply (search the block's raw text / fall back to the bare object); left for the lead.
- A `<plan>` python call (`<plan>commit_planning_round(directive={…})</plan>`) is unreadable (the D-97 name-tag
  reader takes only JSON bodies); the same call inside `<tool_call>` is read (tested).
- `firstObject` stops at the first JSON-looking `{` that never closes: a stray `{"x": …` in prose before the real
  object would hide it. Chosen so a cut-off plan is not read as one of its inner fragments.
