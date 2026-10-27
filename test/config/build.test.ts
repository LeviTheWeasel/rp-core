// buildConnections: config → engine Connections (§8.2, §13, D-53, D-73, D-84).
// Most cases run on injected builders (buildConnectionsWith), so they test this module alone; the last
// block runs the real http / caps / openai-chat modules once they are implemented.
import { describe, expect, test } from 'bun:test';
import {
  buildConnections,
  buildConnectionsWith,
  CONFIG_TEMPLATE,
  ConfigError,
  parseConfig,
  type ConnectionBuilders,
} from '../../src/config/config.ts';
import { createSecretResolver, type SecretResolver, type SecretSpec } from '../../src/config/secrets.ts';
import type { CapsInput } from '../../src/providers/caps.ts';
import type { OpenAIChatOptions } from '../../src/providers/openai-chat.ts';
import { ProviderError, type ModelCaps, type Provider } from '../../src/providers/types.ts';
import { isLocalOrigin, originOf } from '../../src/providers/http.ts';
import { resolveCaps } from '../../src/providers/caps.ts';
import { createOpenAIChatProvider } from '../../src/providers/openai-chat.ts';

/** Stub builders that record what they were given. Caps carry their input so tests can read it back. */
function stubs() {
  const capsCalls: CapsInput[] = [];
  const providers: OpenAIChatOptions[] = [];
  const impl: ConnectionBuilders = {
    originOf: (url) => {
      const u = new URL(url);
      return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
    },
    isLocalOrigin: (origin) => /\/\/(127\.|localhost)/.test(origin),
    resolveCaps: (input) => {
      capsCalls.push(input);
      return { dialect: input.dialect, input } as unknown as ModelCaps;
    },
    createProvider: (o) => {
      providers.push(o);
      return { stream: async function* () {}, opts: o } as unknown as Provider;
    },
  };
  return { impl, capsCalls, providers };
}

/** A SecretResolver that records calls. */
function recordingSecrets(): SecretResolver & { calls: SecretSpec[]; remembered: string[] } {
  const calls: SecretSpec[] = [];
  const remembered: string[] = [];
  return {
    calls,
    remembered,
    resolve: async (spec) => {
      calls.push(spec);
      return spec.keyEnv ? `key-for-${spec.conn}` : null;
    },
    known: () => [...remembered],
    remember: (s) => void remembered.push(s),
  };
}

const CONFIG = `
[connections.ollama]
base_url = "http://127.0.0.1:11434"

[connections.box]
base_url = "http://192.168.1.20:5001"
local = true
max_in_flight = 2

[connections.openrouter]
base_url = "https://openrouter.ai/api"
key_env = "OPENROUTER_API_KEY"
headers = { "X-Title" = "RP_TITLE" }
extra_body = { provider = { allow_fallbacks = false } }
exclude_body = ["stream_options"]

[connections.claude]
dialect = "anthropic"
key_env = "ANTHROPIC_API_KEY"

[caps."ollama:qwen3:14b"]
tools = "native"
`;

describe('buildConnections', () => {
  test('one Connection per openai-chat connection; anthropic and gemini are skipped and reported', () => {
    const { impl } = stubs();
    const cfg = parseConfig(CONFIG + '\n[connections.g]\ndialect = "gemini"\n', null);
    const out = buildConnectionsWith(cfg, { env: { RP_TITLE: 'rp-core' }, secrets: recordingSecrets(), capsCache: {} }, impl);
    expect(Object.keys(out.connections)).toEqual(['ollama', 'box', 'openrouter']);
    expect(out.skipped).toEqual([
      { id: 'claude', why: "dialect 'anthropic' is not supported yet (M7)" },
      { id: 'g', why: "dialect 'gemini' is not supported yet (M8)" },
    ]);
  });

  test('origin, local (guessed or overridden), dialect, baseUrl; no key read at build time', () => {
    const { impl } = stubs();
    const secrets = recordingSecrets();
    const { connections } = buildConnectionsWith(parseConfig(CONFIG, null), { env: { RP_TITLE: 't' }, secrets, capsCache: {} }, impl);
    const ollama = connections.ollama!;
    expect(ollama.id).toBe('ollama');
    expect(ollama.origin).toBe('http://127.0.0.1:11434');
    expect(ollama.local).toBe(true);
    expect(ollama.dialect).toBe('openai-chat');
    expect(ollama.baseUrl).toBe('http://127.0.0.1:11434');
    expect(ollama.key).toBeUndefined();
    expect(connections.box!.local).toBe(true); // overridden: the stub would say remote
    expect(connections.openrouter!.local).toBe(false);
    expect(connections.openrouter!.origin).toBe('https://openrouter.ai:443');
    expect(secrets.calls).toEqual([]);
  });

  test('the provider gets the connection id, base URL, locality and the resolved overrides', () => {
    const { impl, providers } = stubs();
    buildConnectionsWith(parseConfig(CONFIG, null), { env: { RP_TITLE: 'rp-core' }, secrets: recordingSecrets(), capsCache: {} }, impl);
    expect(providers).toEqual([
      { connectionId: 'ollama', baseUrl: 'http://127.0.0.1:11434', local: true },
      { connectionId: 'box', baseUrl: 'http://192.168.1.20:5001', local: true },
      {
        connectionId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api',
        local: false,
        overrides: {
          headers: { 'X-Title': 'rp-core' },
          extraBody: { provider: { allow_fallbacks: false } },
          excludeBody: ['stream_options'],
        },
      },
    ]);
  });

  test('header values come from env and are remembered for scrub', () => {
    const { impl } = stubs();
    const secrets = recordingSecrets();
    buildConnectionsWith(parseConfig(CONFIG, null), { env: { RP_TITLE: 'title-value-1' }, secrets, capsCache: {} }, impl);
    expect(secrets.remembered).toEqual(['title-value-1']);
  });

  test('a missing or unusable header variable fails only that connection, at its first call (review M1b: it locked out every command)', async () => {
    const cases: [Record<string, string>, string][] = [
      [{}, "connection 'openrouter': header X-Title: environment variable RP_TITLE is not set"],
      [{ RP_TITLE: '' }, "connection 'openrouter': header X-Title: environment variable RP_TITLE is not set"],
      [{ RP_TITLE: 'my app\u200b' }, "connection 'openrouter': header X-Title: environment variable RP_TITLE holds a character an HTTP header cannot carry"],
      [{ RP_TITLE: 'line\nbreak' }, "connection 'openrouter': header X-Title: environment variable RP_TITLE holds a character an HTTP header cannot carry"],
    ];
    for (const [env, why] of cases) {
      const { impl, providers } = stubs();
      const secrets = recordingSecrets();
      const out = buildConnectionsWith(parseConfig(CONFIG, null), { env, secrets, capsCache: {} }, impl);
      // Every connection is built; the others work as before.
      expect(Object.keys(out.connections)).toEqual(['ollama', 'box', 'openrouter']);
      expect(await out.connections.ollama!.resolveKey!()).toBeNull();
      // The header is not sent half-set, and the connection's first call fails with the reason.
      expect(providers.find((p) => p.connectionId === 'openrouter')?.overrides?.headers).toBeUndefined();
      const err = await out.connections.openrouter!.resolveKey!().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).toRecord()).toEqual({ category: 'auth', code: 'key_unavailable' });
      expect((err as ProviderError).message.startsWith(why)).toBe(true);
      if (env.RP_TITLE) expect((err as ProviderError).message).not.toContain(env.RP_TITLE);
      expect(secrets.calls.map((c) => c.conn)).toEqual(['ollama']); // openrouter's key is not even looked up
    }
  });

  test('caps: model "" for the connection, capsFor(model) with the cache row in the catalog/probe slots, user overrides, memoised', () => {
    const { impl, capsCalls } = stubs();
    const capsCache = {
      // M3: catalog facts → catalog slot, active-probe facts → probe slot.
      'ollama:qwen3:14b': { server: 'ollama', catalog: { contextLength: 40960 }, probe: { streamUsage: 'stream_options' as const } },
      // A row written by M1b/M2 (`caps` only) holds catalog facts.
      'ollama:other': { caps: { tools: 'none' as const } },
    };
    const { connections } = buildConnectionsWith(
      parseConfig(CONFIG, null),
      { env: { RP_TITLE: 't' }, secrets: recordingSecrets(), capsCache },
      impl,
    );
    const ollama = connections.ollama!;
    expect((ollama.caps as unknown as { input: CapsInput }).input).toEqual({
      dialect: 'openai-chat',
      origin: 'http://127.0.0.1:11434',
      local: true,
      model: '',
      server: 'ollama',
    });
    const before = capsCalls.length;
    const c1 = ollama.capsFor!('qwen3:14b');
    expect((c1 as unknown as { input: CapsInput }).input).toEqual({
      dialect: 'openai-chat',
      origin: 'http://127.0.0.1:11434',
      local: true,
      model: 'qwen3:14b',
      server: 'ollama',
      catalog: { contextLength: 40960 },
      probe: { streamUsage: 'stream_options' },
      user: { tools: 'native' },
    });
    expect(ollama.capsFor!('qwen3:14b')).toBe(c1);
    expect(capsCalls.length).toBe(before + 1);
    // A model with its own cache row but no server: the connection's known server is used.
    expect((ollama.capsFor!('other') as unknown as { input: CapsInput }).input).toMatchObject({ server: 'ollama', catalog: { tools: 'none' } });
    // An explicit max_in_flight reaches the resolver; no cache row, no server.
    expect((connections.box!.capsFor!('m') as unknown as { input: CapsInput }).input).toEqual({
      dialect: 'openai-chat',
      origin: 'http://192.168.1.20:5001',
      local: true,
      model: 'm',
      maxInFlight: 2,
    });
  });

  test('resolveKey is lazy and goes through the SecretResolver with the connection spec', async () => {
    const { impl } = stubs();
    const secrets = recordingSecrets();
    const { connections } = buildConnectionsWith(parseConfig(CONFIG, null), { env: { RP_TITLE: 't' }, secrets, capsCache: {} }, impl);
    expect(secrets.calls).toEqual([]);
    expect(await connections.openrouter!.resolveKey!()).toBe('key-for-openrouter');
    expect(await connections.ollama!.resolveKey!()).toBeNull();
    expect(secrets.calls).toEqual([{ conn: 'openrouter', keyEnv: 'OPENROUTER_API_KEY' }, { conn: 'ollama' }]);
  });

  test('a key_cmd connection resolves through a real resolver once, with the key never in the Connection', async () => {
    const { impl } = stubs();
    let runs = 0;
    const secrets = createSecretResolver({
      env: {},
      run: async () => ({ exitCode: 0, stdout: `cmd-key-${++runs}`, timedOut: false }),
    });
    const cfg = parseConfig('[connections.ds]\nbase_url = "https://api.deepseek.com"\nkey_cmd = ["secret-tool", "lookup", "conn", "ds"]\n', null);
    const { connections } = buildConnectionsWith(cfg, { env: {}, secrets, capsCache: {} }, impl);
    const ds = connections.ds!;
    expect(await ds.resolveKey!()).toBe('cmd-key-1');
    expect(await ds.resolveKey!()).toBe('cmd-key-1');
    expect(runs).toBe(1);
    expect(JSON.stringify({ ...ds, provider: undefined, caps: undefined })).not.toContain('cmd-key-1');
  });
});

// ---- with the real provider modules (implemented in parallel by other agents) -------------------------

/** True once originOf / resolveCaps / createOpenAIChatProvider no longer throw 'not implemented'. */
const realReady = (() => {
  try {
    originOf('http://127.0.0.1:8080');
    isLocalOrigin('http://127.0.0.1:8080');
    resolveCaps({ dialect: 'openai-chat', origin: 'http://127.0.0.1:8080', local: true, model: '' });
    createOpenAIChatProvider({ connectionId: 'x', baseUrl: 'http://127.0.0.1:8080', local: true });
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('not implemented')) return false;
    throw err;
  }
})();

describe.skipIf(!realReady)('buildConnections with the real provider modules', () => {
  test('the starter template builds: local servers are local, OpenRouter is remote', () => {
    const secrets = createSecretResolver({ env: {} });
    const { connections, skipped } = buildConnections(parseConfig(CONFIG_TEMPLATE, null), { env: {}, secrets, capsCache: {} });
    expect(skipped).toEqual([]);
    expect(Object.keys(connections)).toEqual(['ollama', 'llamacpp', 'lmstudio', 'openrouter']);
    expect(connections.ollama!.origin).toBe('http://127.0.0.1:11434');
    expect(connections.llamacpp!.origin).toBe('http://127.0.0.1:8080');
    expect(connections.lmstudio!.local).toBe(true);
    expect(connections.openrouter!.local).toBe(false);
    expect(connections.openrouter!.origin).toBe('https://openrouter.ai:443');
    for (const c of Object.values(connections)) {
      expect(c.caps.dialect).toBe('openai-chat');
      expect(typeof c.provider.stream).toBe('function');
    }
  });

  test('a user override and the explicit max_in_flight show in capsFor', () => {
    const cfg = parseConfig(
      '[connections.local]\nbase_url = "http://127.0.0.1:8080"\nmax_in_flight = 2\n[caps."local:qwen3:14b"]\ncontext_length = 12345\n',
      null,
    );
    const { connections } = buildConnections(cfg, { env: {}, secrets: createSecretResolver({ env: {} }), capsCache: {} });
    const caps = connections.local!.capsFor!('qwen3:14b');
    expect(caps.contextLength).toBe(12345);
    expect(caps.source).toContain('user');
    expect(caps.maxInFlight).toBe(2);
  });
});
