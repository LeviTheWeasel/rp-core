// Shared setup for the structuredCall tests (not a test file itself): one scripted connection 'dir',
// the agent env with recorded events, and a plan-shaped reader standing in for readPlan.
import { realTimers, type DelayTimers } from '../../src/engine/abort.ts';
import type { Connection } from '../../src/engine/api.ts';
import { createScheduler, type Scheduler } from '../../src/engine/sched.ts';
import {
  chooseTransport,
  structuredCall,
  type AgentCallEnv,
  type AgentCallEvent,
  type StructuredInput,
  type StructuredResult,
} from '../../src/agents/structured.ts';
import type { ReadResult } from '../../src/agents/director/types.ts';
import { createScriptedProvider, SCRIPT_CAPS, scriptCapsWith, type ScriptCall, type ScriptedProvider, type ScriptStep } from '../../src/providers/scripted.ts';
import type { ModelCaps, ProviderError } from '../../src/providers/types.ts';
import { fakeClock, fakeRandom } from '../helpers.ts';

/** Calls from step lists. */
export const calls = (...steps: ScriptStep[][]): ScriptCall[] => steps.map((s) => ({ steps: s }));

/** The plan of the RoleCall probes (rolecall.md §5.4). */
export const P = '{"directive":{"mood":"tense"}}';

/** Caps whose json_schema output the user confirmed: the structured transport. */
export const STRUCTURED_CAPS: ModelCaps = scriptCapsWith({ structuredOutput: { mode: 'json_schema', confirmedBy: 'user' } });

export interface Plan {
  directive: Record<string, unknown>;
}

/** A stand-in for readPlan (the plan unit's): the root needs a directive object with a field. */
export function readPlanish(raw: unknown): ReadResult<Plan> {
  const d = (raw as Record<string, unknown>)['directive'];
  if (typeof d === 'string') return { ok: false, code: 'invalid', message: 'directive must be an object, not a string' };
  if (typeof d !== 'object' || d === null || Array.isArray(d) || Object.keys(d).length === 0) {
    return { ok: false, code: 'missing_directive', message: 'the plan has no directive' };
  }
  return { ok: true, value: { directive: d as Record<string, unknown> }, skipped: [] };
}

export interface RigOptions<T> {
  caps?: ModelCaps;
  timers?: DelayTimers;
  sched?: Scheduler;
  /** Overrides of the input (read, tag, transport, repair, budgetMs, …). */
  input?: Partial<StructuredInput<T>>;
  env?: Partial<AgentCallEnv>;
}

export interface StructuredRig<T> {
  provider: ScriptedProvider;
  conn: Connection;
  input: StructuredInput<T>;
  env: AgentCallEnv;
  events: AgentCallEvent[];
  /** Raw failures the debug tap saw. */
  tapped: { callKey: string; model: string; error: ProviderError }[];
  /** The turn's controller (Stop). */
  turn: AbortController;
  run(): Promise<StructuredResult<T>>;
}

/** One Director-like structuredCall on a scripted connection 'dir' (model 'm'). */
export function rig<T = Plan>(script: ScriptCall[], o: RigOptions<T> = {}): StructuredRig<T> {
  const timers = o.timers ?? realTimers;
  const provider = createScriptedProvider(script, { timers });
  const caps = o.caps ?? SCRIPT_CAPS;
  const conn: Connection = { id: 'dir', provider, caps, origin: 'script:dir', local: true };
  const events: AgentCallEvent[] = [];
  const tapped: StructuredRig<T>['tapped'] = [];
  const env: AgentCallEnv = {
    sched: o.sched ?? createScheduler(),
    fetch,
    timeouts: { firstByteMs: 60_000, idleMs: 60_000 },
    timers,
    clock: fakeClock(),
    random: fakeRandom(3),
    retryMaxDelayMs: 5,
    emit: (ev) => void events.push(ev),
    onProviderError: (info) => void tapped.push(info),
    ...o.env,
  };
  const turn = new AbortController();
  const input = {
    agent: 'director',
    schema: { name: 'plan', schema: { type: 'object', properties: { directive: { type: 'object' } } } },
    read: readPlanish,
    system: 'You plan the story.',
    user: ['Plan this turn.'],
    tag: 'plan',
    route: { conn, model: 'm', caps },
    transport: chooseTransport(caps),
    samplers: { temperature: 0.7 },
    maxTokens: 1500,
    repair: true,
    callKeyPrefix: 't_1:director',
    budgetMs: 180_000,
    turnSignal: turn.signal,
    env,
    ...o.input,
  } as StructuredInput<T>;
  return { provider, conn, input, env, events, tapped, turn, run: () => structuredCall(input) };
}

/** The text of a request message. */
export const textOfMsg = (m: { blocks: { k: string; text?: string }[] }): string => m.blocks.map((b) => (b.k === 'text' ? (b.text ?? '') : '')).join('');
