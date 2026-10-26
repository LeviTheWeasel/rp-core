// Fakes for the M1b engine tests (not a test file itself): a provider that answers from a function of
// the request (so usage can be reported relative to what was sent) and records the env it was given,
// and connections with per-model caps and a lazily resolved key.
import type { Connection } from '../../src/engine/api.ts';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import type { ModelCaps, ModelRequest, Provider, ProviderEnv, StreamEv, Usage } from '../../src/providers/types.ts';

export interface FakeProvider extends Provider {
  readonly requests: ModelRequest[];
  readonly envs: ProviderEnv[];
}

/** A provider whose call n answers with respond(req, n). Every event checks the request's signal. */
export function fakeProvider(respond: (req: ModelRequest, n: number) => StreamEv[]): FakeProvider {
  const requests: ModelRequest[] = [];
  const envs: ProviderEnv[] = [];
  return {
    requests,
    envs,
    async *stream(req: ModelRequest, env: ProviderEnv): AsyncGenerator<StreamEv> {
      const n = requests.length;
      requests.push(req);
      envs.push(env);
      for (const ev of respond(req, n)) {
        req.signal.throwIfAborted();
        yield ev;
      }
    },
  };
}

/** A plain answer: text, then (optionally) usage, then the finish with an optional served model. */
export function answer(text: string, opts: { usage?: Usage; model?: string } = {}): StreamEv[] {
  const out: StreamEv[] = [{ t: 'text', i: 0, d: text }];
  if (opts.usage) out.push({ t: 'usage', u: opts.usage });
  out.push(opts.model !== undefined ? { t: 'finish', reason: 'end', raw: 'stop', model: opts.model } : { t: 'finish', reason: 'end', raw: 'stop' });
  return out;
}

export interface FakeConnOptions {
  /** Connection-default caps (Connection.caps). */
  caps?: Partial<ModelCaps>;
  /** Per-model caps: capsFor(model) returns SCRIPT_CAPS + caps + perModel[model] when listed, else conn.caps. */
  perModel?: Record<string, Partial<ModelCaps>>;
  origin?: string;
  local?: boolean;
  key?: string | null;
  resolveKey?: () => Promise<string | null>;
}

/** A connection over any provider; records the models capsFor was asked about. */
export function fakeConn(id: string, provider: Provider, o: FakeConnOptions = {}): Connection & { capsAsked: string[] } {
  const base: ModelCaps = { ...SCRIPT_CAPS, ...o.caps };
  const capsAsked: string[] = [];
  const conn: Connection & { capsAsked: string[] } = {
    id,
    provider,
    caps: base,
    origin: o.origin ?? `script:${id}`,
    local: o.local ?? true,
    capsAsked,
  };
  if (o.perModel) {
    const perModel = o.perModel;
    conn.capsFor = (model: string): ModelCaps => {
      capsAsked.push(model);
      const row = perModel[model];
      return row ? { ...base, ...row } : base;
    };
  }
  if (o.key !== undefined) conn.key = o.key;
  if (o.resolveKey) conn.resolveKey = o.resolveKey;
  return conn;
}
