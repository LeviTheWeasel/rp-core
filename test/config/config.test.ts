// config.toml: parse, validation error paths, sessionDefaults, the starter template (§13, D-53, D-73).
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_TEMPLATE,
  ConfigError,
  configPath,
  loadConfig,
  parseConfig,
  splitBinding,
} from '../../src/config/config.ts';
import { tmpHome } from '../helpers.ts';

/** A minimal valid config with one local connection, plus `more`. */
const withConn = (more: string): string => `[connections.local]\nbase_url = "http://127.0.0.1:8080"\n\n${more}`;

/** The ConfigError parseConfig throws for `text` (fails the test when it parses). */
function errorOf(text: string): ConfigError {
  try {
    parseConfig(text, null);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected a ConfigError, but the config parsed');
}

/** The §13 example of ARCHITECTURE.md, verbatim. */
const SECTION_13 = `# ~/.rp-core/config.toml — секретов здесь нет
[connections.local]
dialect = "openai-chat"
base_url = "http://127.0.0.1:8080"
max_in_flight = 1              # локально по умолчанию 1; 2 — только с -np 2 --no-kv-unified и id_slot (§7.4.7) [D-84]

[connections.openrouter]
dialect = "openai-chat"
base_url = "https://openrouter.ai/api"
key_env = "OPENROUTER_API_KEY"

[connections.anthropic]
dialect = "anthropic"
key_cmd = ["secret-tool", "lookup", "service", "rp-core", "conn", "anthropic"]
api_version = "2023-06-01"
cache_ttl = "1h"

[roles]                        # значения по умолчанию для новых сессий; сессия может переопределить
narrator = "local:qwen3-14b"
director = "narrator"          # ссылка: следует за /model narrator
recorder = "local:qwen3-14b"   # filing и historian
recall = "recorder"           # ссылка: следует за recorder [D-85]
narrator_fallback = ""         # пусто — без запасной модели

[narrator]
max_rounds = 4
prefill_vs_tools = "prefill"   # prefill | tools   [D-28]

[director]
enabled = false
profile = "auto"               # auto | full | lite
on_swipe = "reuse"             # reuse | replan    [D-29]
instructions = ""
style = "the-balanced"         # id личности [D-64]
creativity = "moderate"        # subtle | moderate | dramatic [D-64]

[compendium]                   # заменяет [memory]; §7.4.9
enabled = true
profile = "auto"               # auto | full | lite; auto — lite при окне агента < 24 576 [D-79]
language = ""                  # "" — язык истории
guidance = ""                  # ≤ 4 000; filing и historian; только сужает [D-66]
min_share = 0.4                # пол блока Compendium в доле лора
max_attempts = 3
idle_delay_sec = 8             # задержка фона на локальном origin [D-84]

[compendium.recall]
mode = "auto"                  # auto | sync | prefetch | lexical | off [D-78]
on_miss = "auto"               # auto (lexical локально, sync удалённо) | lexical | sync
max_entries = 0                # 0 — по профилю: full 10, lite 4
min_entries = 0
context_messages = 0           # 0 — по профилю: full 20, lite 6
grace_sec = 4
timeout_sec = 0                # 0 — 30 локально, 20 удалённо; от гранта
on_swipe = "reuse"             # reuse | rerun
guidance = ""                  # ≤ 8 000

[compendium.filing]
enabled = true
wait = 1                       # [D-23, D-86]
every_n = 1
allow = []                     # [] — все типы, кроме summary

[compendium.historian]
interval = 20                  # 0 — выключен
recap_after = 24               # [D-33]
overlap = 0                    # 0 — по профилю: full 10, lite 6

[compendium.books]             # "<книга>" = "read" | "off"; по умолчанию read [D-76]

[caps."local:qwen3-14b"]
tools = "native"               # оверрайд после того, как \`rp-core probe\` подтвердил

[prices."openrouter:anthropic/claude-sonnet-5-5"]
in_per_m = 2.0
out_per_m = 10.0
as_of = "2026-10-06"
`;

describe('CONFIG_TEMPLATE', () => {
  test('parses, with the four starter connections and a narrator binding', () => {
    const cfg = parseConfig(CONFIG_TEMPLATE, null);
    expect(Object.keys(cfg.connections)).toEqual(['ollama', 'llamacpp', 'lmstudio', 'openrouter']);
    expect(cfg.connections.ollama).toEqual({
      id: 'ollama',
      dialect: 'openai-chat',
      baseUrl: 'http://127.0.0.1:11434',
      local: true,
    });
    expect(cfg.connections.llamacpp!.baseUrl).toBe('http://127.0.0.1:8080');
    expect(cfg.connections.lmstudio!.baseUrl).toBe('http://127.0.0.1:1234');
    expect(cfg.connections.openrouter).toEqual({
      id: 'openrouter',
      dialect: 'openai-chat',
      baseUrl: 'https://openrouter.ai/api',
      keyEnv: 'OPENROUTER_API_KEY',
    });
    expect(cfg.sessionDefaults).toEqual({
      roles: { narrator: { conn: 'ollama', model: 'qwen3:14b' } },
      narrator: { maxRounds: 4, prefillVsTools: 'prefill' },
    });
    expect(cfg.caps).toEqual({});
    expect(cfg.prices).toEqual({});
  });

  test('every commented example in it parses too once the "# " is removed', () => {
    const example = /^# (\[[^\]]+\]|[A-Za-z0-9_."-]+ = .*)$/;
    const lines = CONFIG_TEMPLATE.split('\n');
    const turnedOn = lines.filter((l) => example.test(l)).length;
    expect(turnedOn).toBeGreaterThan(15);
    const cfg = parseConfig(lines.map((l) => (example.test(l) ? l.slice(2) : l)).join('\n'), null);

    expect(cfg.connections.deepseek).toEqual({
      id: 'deepseek',
      dialect: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/beta',
      keyCmd: ['secret-tool', 'lookup', 'service', 'rp-core', 'conn', 'deepseek'],
    });
    expect(cfg.connections.openrouter!.headers).toEqual({ 'X-Title': 'RP_CORE_APP_TITLE' });
    expect(cfg.connections.openrouter!.extraBody).toEqual({ provider: { allow_fallbacks: false } });
    expect(cfg.sessionDefaults.roles).toEqual({
      narrator: { conn: 'ollama', model: 'qwen3:14b', fallback: { conn: 'openrouter', model: 'vendor/model' } },
      director: 'narrator',
      recorder: 'narrator',
      recall: 'recorder',
    });
    expect(cfg.sessionDefaults.director).toEqual({
      enabled: false,
      profile: 'auto',
      onSwipe: 'reuse',
      instructions: '',
      style: 'the-balanced',
      creativity: 'moderate',
    });
    expect(cfg.caps).toEqual({
      'ollama:qwen3:14b': { contextLength: 16384, tools: 'native', reasoning: { tags: ['<think>'] } as never },
    });
    expect(cfg.prices).toEqual({ 'openrouter:vendor/model': { inPerM: 1, outPerM: 2, asOf: '2026-10-06' } });
  });
});

describe('the §13 example', () => {
  test('parses: anthropic gets its official base_url, compendium maps to camelCase (D-158)', () => {
    const cfg = parseConfig(SECTION_13, '/x/config.toml');
    expect(cfg.path).toBe('/x/config.toml');
    expect(cfg.connections.local).toEqual({ id: 'local', dialect: 'openai-chat', baseUrl: 'http://127.0.0.1:8080', maxInFlight: 1 });
    expect(cfg.connections.anthropic).toEqual({
      id: 'anthropic',
      dialect: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      keyCmd: ['secret-tool', 'lookup', 'service', 'rp-core', 'conn', 'anthropic'],
      apiVersion: '2023-06-01',
      cacheTtl: '1h',
    });
    expect(cfg.sessionDefaults.roles).toEqual({
      narrator: { conn: 'local', model: 'qwen3-14b' }, // narrator_fallback "" = no fallback
      director: 'narrator',
      recorder: { conn: 'local', model: 'qwen3-14b' },
      recall: 'recorder',
    });
    expect(cfg.sessionDefaults.compendium).toEqual({
      enabled: true,
      profile: 'auto',
      language: '',
      guidance: '',
      minShare: 0.4,
      maxAttempts: 3,
      idleDelaySec: 8,
      recall: { mode: 'auto', onMiss: 'auto', maxEntries: 0, minEntries: 0, contextMessages: 0, graceSec: 4, timeoutSec: 0, onSwipe: 'reuse', guidance: '' },
      filing: { enabled: true, wait: 1, everyN: 1, allow: [] },
      historian: { interval: 20, recapAfter: 24, overlap: 0 },
      books: {},
    });
    expect(cfg.caps).toEqual({ 'local:qwen3-14b': { tools: 'native' } });
    expect(cfg.prices).toEqual({
      'openrouter:anthropic/claude-sonnet-5-5': { inPerM: 2, outPerM: 10, asOf: '2026-10-06' },
    });
  });
});

describe('bindings', () => {
  test('split at the FIRST ":" (Ollama tags and hf.co paths keep theirs)', () => {
    expect(splitBinding('ollama:hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M')).toEqual({
      conn: 'ollama',
      model: 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M',
    });
    expect(splitBinding('local:qwen3:14b')).toEqual({ conn: 'local', model: 'qwen3:14b' });
    expect(splitBinding('openrouter:anthropic/claude-sonnet-5-5')).toEqual({ conn: 'openrouter', model: 'anthropic/claude-sonnet-5-5' });
  });

  test('a role binding in the file splits the same way', () => {
    const cfg = parseConfig(
      `[connections.ollama]\nbase_url = "http://127.0.0.1:11434"\n[roles]\nnarrator = "ollama:hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M"\n`,
      null,
    );
    expect(cfg.sessionDefaults.roles!.narrator).toEqual({ conn: 'ollama', model: 'hf.co/bartowski/MN-12B-Mag-Mell-R1-GGUF:Q5_K_M' });
  });

  test('missing parts and bad connection names throw ConfigError with the given path', () => {
    for (const bad of ['qwen3', ':qwen3', 'local:', 'local: ', 'lo cal:x', 'local: qwen3']) {
      let err: unknown;
      try {
        splitBinding(bad, 'roles.narrator');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).path).toBe('roles.narrator');
    }
    expect(() => splitBinding('nope')).toThrow('binding: expected "<connection>:<model>"');
  });
});

describe('sessionDefaults', () => {
  test('roles become Bindings, references stay references, tables map to camelCase', () => {
    const cfg = parseConfig(
      withConn(`[connections.remote]
base_url = "https://example.test/v1"

[roles]
narrator = "local:qwen3:14b"
narrator_fallback = "remote:big/model"
director = "remote:director-model"
recorder = "narrator"
recall = "recorder"

[narrator]
max_rounds = 8
prefill_vs_tools = "tools"

[director]
enabled = true
profile = "lite"
on_swipe = "replan"
instructions = "Keep it grim."
style = "the-trickster"
creativity = "dramatic"
timeout_sec = 90

[compendium]
enabled = false
guidance = "names only"
`),
      null,
    );
    expect(cfg.sessionDefaults).toEqual({
      roles: {
        narrator: { conn: 'local', model: 'qwen3:14b', fallback: { conn: 'remote', model: 'big/model' } },
        director: { conn: 'remote', model: 'director-model' },
        recorder: 'narrator',
        recall: 'recorder',
      },
      narrator: { maxRounds: 8, prefillVsTools: 'tools' },
      director: {
        enabled: true,
        profile: 'lite',
        onSwipe: 'replan',
        instructions: 'Keep it grim.',
        style: 'the-trickster',
        creativity: 'dramatic',
        timeoutSec: 90,
      },
      compendium: { enabled: false, guidance: 'names only' },
    });
  });

  test('tables that are absent stay absent; an empty file is an empty config', () => {
    expect(parseConfig('', null)).toEqual({ path: null, connections: {}, sessionDefaults: {}, caps: {}, prices: {} });
    const cfg = parseConfig(withConn('[narrator]\nmax_rounds = 2\n'), null);
    expect(cfg.sessionDefaults).toEqual({ narrator: { maxRounds: 2 } });
  });

  test('a fallback alone (no narrator) is a partial narrator binding', () => {
    const cfg = parseConfig(withConn('[roles]\nnarrator_fallback = "local:small"\n'), null);
    expect(cfg.sessionDefaults.roles).toEqual({ narrator: { fallback: { conn: 'local', model: 'small' } } });
  });
});

describe('connections', () => {
  test('every field maps; dialect defaults to openai-chat', () => {
    const cfg = parseConfig(
      `[connections.box]
base_url = "http://192.168.1.20:5001"
key_env = "BOX_KEY"
max_in_flight = 2
local = false
headers = { "X-Title" = "RP_TITLE", "HTTP-Referer" = "RP_REFERER" }
extra_body = { cache_prompt = true, provider = { order = ["a", "b"] } }
exclude_body = ["stream_options"]
`,
      null,
    );
    expect(cfg.connections.box).toEqual({
      id: 'box',
      dialect: 'openai-chat',
      baseUrl: 'http://192.168.1.20:5001',
      keyEnv: 'BOX_KEY',
      maxInFlight: 2,
      local: false,
      headers: { 'X-Title': 'RP_TITLE', 'HTTP-Referer': 'RP_REFERER' },
      extraBody: { cache_prompt: true, provider: { order: ['a', 'b'] } },
      excludeBody: ['stream_options'],
    });
  });

  test('gemini parses with its official base_url (refused only when used)', () => {
    const cfg = parseConfig('[connections.g]\ndialect = "gemini"\nkey_env = "GEMINI_API_KEY"\n', null);
    expect(cfg.connections.g!.baseUrl).toBe('https://generativelanguage.googleapis.com');
  });
});

describe('caps overrides', () => {
  test('snake_case fields map onto ModelCaps camelCase', () => {
    const cfg = parseConfig(
      withConn(`[caps."local:qwen3:14b"]
tools = "native"
tool_choice = ["auto", "none"]
tool_choice_honored = false
parallel_tool_calls = "send-true"
strict_tools = false
tool_id_format = "mistral9"
structured_output = "json_schema"
prefill = "assistant-last"
mid_system = "as-user"
alternation = "strict"
context_length = 40960
max_output = 8192
max_tokens_field = "max_completion_tokens"
stream_usage = "timings"
caching = "auto-prefix"
max_in_flight = 1
cache_min_tokens = 1024
stop_max = 4
samplers_accepted = ["temperature", "min_p"]
extra_body = { chat_template_kwargs = { enable_thinking = false } }
reasoning.output = "tags"
reasoning.tags = ["<think>"]
reasoning.control = "toggle"
reasoning.can_disable = true
reasoning.echo = "never"
reasoning.efforts = ["low", "high"]
`),
      null,
    );
    expect(cfg.caps['local:qwen3:14b']).toEqual({
      tools: 'native',
      toolChoice: ['auto', 'none'],
      toolChoiceHonored: false,
      parallelToolCalls: 'send-true',
      strictTools: false,
      toolIdFormat: 'mistral9',
      structuredOutput: { mode: 'json_schema', confirmedBy: 'user' },
      prefill: 'assistant-last',
      midSystem: 'as-user',
      alternation: 'strict',
      contextLength: 40960,
      maxOutput: 8192,
      maxTokensField: 'max_completion_tokens',
      streamUsage: 'timings',
      caching: 'auto-prefix',
      maxInFlight: 1,
      cacheMinTokens: 1024,
      stopMax: 4,
      samplers: { accepted: ['temperature', 'min_p'] } as never,
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      reasoning: { output: 'tags', tags: ['<think>'], control: 'toggle', canDisable: true, echo: 'never', efforts: ['low', 'high'] },
    });
  });

  test('a samplers table works as well as the flat fields, but not both', () => {
    const cfg = parseConfig(withConn('[caps."local:m"]\nsamplers = { accepted = ["temperature"], fixed = true, wire = { max_tokens = "n_predict" } }\n'), null);
    expect(cfg.caps['local:m']!.samplers).toEqual({ accepted: ['temperature'], fixed: true, wire: { max_tokens: 'n_predict' } });
    const err = errorOf(withConn('[caps."local:m"]\nsamplers = { fixed = true }\nsamplers_accepted = ["x"]\n'));
    expect(err.path).toBe('caps."local:m".samplers_accepted');
  });

  test('unknown caps keys, wrong enum values and non-user fields are refused', () => {
    expect(errorOf(withConn('[caps."local:m"]\ntool = "native"\n')).path).toBe('caps."local:m".tool');
    expect(errorOf(withConn('[caps."local:m"]\ntools = "maybe"\n')).message).toContain('must be one of "native", "prompted", "none"');
    expect(errorOf(withConn('[caps."local:m"]\ndialect = "anthropic"\n')).path).toBe('caps."local:m".dialect');
    expect(errorOf(withConn('[caps."local:m"]\nsource = ["user"]\n')).path).toBe('caps."local:m".source');
    expect(errorOf(withConn('[caps."local:m"]\nreasoning.bogus = 1\n')).path).toBe('caps."local:m".reasoning.bogus');
    expect(errorOf(withConn('[caps."local:m"]\ncontext_length = 100\n')).path).toBe('caps."local:m".context_length');
    expect(errorOf(withConn('[caps."local:m"]\nextra_body = { model = "x" }\n')).path).toBe('caps."local:m".extra_body.model');
  });

  test('the table name must be "conn:model" with a declared connection', () => {
    expect(errorOf(withConn('[caps.local]\ntools = "native"\n')).path).toBe('caps.local');
    expect(errorOf(withConn('[caps."nowhere:m"]\ntools = "native"\n')).message).toContain('connection "nowhere" is not defined');
  });
});

describe('prices', () => {
  test('rows need in_per_m, out_per_m and a quoted as_of date', () => {
    expect(errorOf(withConn('[prices."local:m"]\nin_per_m = 1\nout_per_m = 2\n')).path).toBe('prices."local:m".as_of');
    expect(errorOf(withConn('[prices."local:m"]\nout_per_m = 2\nas_of = "2026-10-06"\n')).path).toBe('prices."local:m".in_per_m');
    expect(errorOf(withConn('[prices."local:m"]\nin_per_m = -1\nout_per_m = 2\nas_of = "2026-10-06"\n')).path).toBe(
      'prices."local:m".in_per_m',
    );
    expect(errorOf(withConn('[prices."local:m"]\nin_per_m = 1\nout_per_m = 2\nas_of = "2026-02-30"\n')).message).toContain(
      'must be a date string "YYYY-MM-DD"',
    );
    expect(errorOf(withConn('[prices."local:m"]\nin_per_m = 1\nout_per_m = 2\nas_of = "2026-10-06"\ncurrency = "EUR"\n')).path).toBe(
      'prices."local:m".currency',
    );
  });
});

describe('validation errors', () => {
  test('a TOML date literal names the line and advises quotes (D-73)', () => {
    const err = errorOf(withConn('[prices."local:m"]\nin_per_m = 1\nout_per_m = 2\nas_of = 2026-10-06\n'));
    expect(err.path).toBe('line 7');
    expect(err.message).toContain('line 7: TOML date and time literals are not supported');
    expect(err.message).toContain('as_of = "2026-10-06"');
  });

  test('date-time and time literals too; the rest of the line is never echoed', () => {
    expect(errorOf('as_of = 1979-05-27T07:32:00Z\n').message).toContain('as_of = "1979-05-27T07:32:00Z"');
    expect(errorOf('[x]\nat = 07:32:00\n').message).toContain('at = "07:32:00"');
    const err = errorOf('x = { secret_thing = "do-not-echo-me", when = 2026-01-01 }\n');
    expect(err.message).toContain('when = "2026-01-01"');
    expect(err.message).not.toContain('do-not-echo-me');
  });

  test('dates inside inline tables and arrays, which Bun would silently mangle, are caught too', () => {
    expect(errorOf('x = [2026-01-01]\n').message).toBe(
      'line 1: TOML date and time literals are not supported; write the date as a quoted string: "2026-01-01"',
    );
    expect(errorOf('x = { a = 1, b = 07:32:00 }\n').message).toContain('b = "07:32:00"');
    expect(errorOf('x = [\n  "a",\n  2026-01-01,\n]\n').path).toBe('line 3');
    expect(errorOf('x = """\nline\n"""\ny = 2026-01-01\n').path).toBe('line 4');
    expect(errorOf("x = '''\nline\n'''\ny = [1, 1979-05-27T00:32:00-07:00]\n").path).toBe('line 4');
    expect(errorOf('x = "a\\"b"\ny = 2026-01-01\n').path).toBe('line 2');
  });

  test('date-looking text in strings, comments and keys is left alone', () => {
    const cfg = parseConfig(
      [
        '# written 2026-10-06 at 07:32:00',
        '[director]',
        'instructions = "On 2026-01-01 at 07:32:00 # not a comment"',
        "style = 'the-balanced' # 2026-10-06",
        '[compendium]',
        '[compendium.books]',
        '"2026-01-01" = "read"', // (Bun 1.3.14 cannot read a bare key that starts like a date at all)
      ].join('\n'),
      null,
    );
    expect(cfg.sessionDefaults.director!.instructions).toBe('On 2026-01-01 at 07:32:00 # not a comment');
    expect(cfg.sessionDefaults.compendium!.books).toEqual({ '2026-01-01': 'read' });
  });

  test('other TOML syntax errors name the line', () => {
    const err = errorOf('[connections.local]\nbase_url = \n');
    expect(err.message).toMatch(/^line 2: invalid TOML: /);
    expect(errorOf('a = 1\na = 2\n').message).toContain("line 2: invalid TOML: Cannot redefine key 'a'");
  });

  test('a byte-order mark does not swallow the first key', () => {
    const cfg = parseConfig(`﻿[connections.local]\nbase_url = "http://127.0.0.1:8080"\n`, null);
    expect(Object.keys(cfg.connections)).toEqual(['local']);
  });

  test('key-like fields are refused at any depth, and the value is never echoed', () => {
    const cases: [string, string][] = [
      ['[connections.local]\nbase_url = "http://127.0.0.1:8080"\napi_key = "hunter2-value"\n', 'connections.local.api_key'],
      ['key = "hunter2-value"\n', 'key'],
      ['[connections.local]\nbase_url = "http://127.0.0.1:8080"\ntoken = "hunter2-value"\n', 'connections.local.token'],
      ['[connections.local]\nbase_url = "http://127.0.0.1:8080"\nextra_body = { auth = { password = "hunter2-value" } }\n', 'connections.local.extra_body.auth'],
      ['[connections.local]\nbase_url = "http://127.0.0.1:8080"\nextra_body = { opts = { Client-Secret = "hunter2-value" } }\n', 'connections.local.extra_body.opts.Client-Secret'],
      ['[compendium]\nenabled = true\n[compendium.recall]\nOPENAI_API_KEY = "hunter2-value"\n', 'compendium.recall.OPENAI_API_KEY'],
      [withConn('[caps."local:m"]\nsecret = "hunter2-value"\n'), 'caps."local:m".secret'],
    ];
    for (const [text, path] of cases) {
      const err = errorOf(text);
      expect(err.path).toBe(path);
      expect(err.message).toContain('never go in config.toml');
      expect(err.message).not.toContain('hunter2-value');
    }
  });

  test('values shaped like API keys are refused wherever they sit', () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    for (const text of [
      `[connections.or]\nbase_url = "https://openrouter.ai/api"\nkey_env = "${key}"\n`,
      `[connections.or]\nbase_url = "https://openrouter.ai/api"\nkey_cmd = ["echo", "${key}"]\n`,
      `[director]\ninstructions = "${key}"\n`,
    ]) {
      const err = errorOf(text);
      expect(err.message).toContain('looks like an API key');
      expect(err.message).not.toContain(key);
    }
  });

  test('header names are identifiers, not fields: a secret-sounding header read from env is allowed', () => {
    const cfg = parseConfig('[connections.gw]\nbase_url = "https://example.test/openai"\nheaders = { "X-Gateway-Secret" = "GW_SECRET" }\n', null);
    expect(cfg.connections.gw!.headers).toEqual({ 'X-Gateway-Secret': 'GW_SECRET' });
  });

  test('protected headers and body fields are refused (D-53)', () => {
    expect(errorOf('[connections.a]\nbase_url = "http://h"\nheaders = { Authorization = "AUTH" }\n').message).toContain('protected');
    expect(errorOf('[connections.a]\nbase_url = "http://h"\nheaders = { "X-Api-Key" = "K" }\n').message).toContain('protected');
    expect(errorOf('[connections.a]\nbase_url = "http://h"\nextra_body = { stream = false }\n').path).toBe('connections.a.extra_body.stream');
    expect(errorOf('[connections.a]\nbase_url = "http://h"\nexclude_body = ["messages"]\n').message).toContain('"messages" is a protected');
    expect(errorOf('[connections.a]\nbase_url = "http://h"\nheaders = { "X-Title" = "not an env name" }\n').path).toBe(
      'connections.a.headers.X-Title',
    );
    expect(errorOf('[connections.a]\nbase_url = "http://h"\nheaders = { "Bad Header" = "X" }\n').message).toContain('not a valid HTTP header name');
  });

  test('bad base_url: missing, not http(s), not a URL, credentials, a key in the query, a fragment', () => {
    const at = 'connections.a.base_url';
    expect(errorOf('[connections.a]\nlocal = true\n').path).toBe(at);
    expect(errorOf('[connections.a]\nbase_url = "ftp://127.0.0.1"\n').path).toBe(at);
    expect(errorOf('[connections.a]\nbase_url = "127.0.0.1:8080"\n').path).toBe(at);
    expect(errorOf('[connections.a]\nbase_url = "not a url"\n').path).toBe(at);
    const creds = errorOf('[connections.a]\nbase_url = "https://user:hunter2pass@example.test"\n');
    expect(creds.path).toBe(at);
    expect(creds.message).not.toContain('hunter2pass');
    expect(errorOf('[connections.a]\nbase_url = "https://example.test/v1?key=abc123"\n').message).toContain('query string');
    expect(errorOf('[connections.a]\nbase_url = "https://example.test/v1#x"\n').path).toBe(at);
    expect(errorOf('[connections.a]\nbase_url = 8080\n').path).toBe(at);
  });

  test('bad bindings', () => {
    expect(errorOf(withConn('[roles]\nnarrator = "qwen3"\n')).path).toBe('roles.narrator');
    expect(errorOf(withConn('[roles]\nnarrator = "narrator"\n')).path).toBe('roles.narrator');
    expect(errorOf(withConn('[roles]\ndirector = "recorder"\n')).message).toContain('expected "<connection>:<model>" or "narrator"');
    expect(errorOf(withConn('[roles]\nrecall = "director"\n')).message).toContain('or "narrator" or "recorder"');
    expect(errorOf(withConn('[roles]\nnarrator = "remote:m"\n')).message).toContain('connection "remote" is not defined in [connections]');
    expect(errorOf(withConn('[roles]\nnarrator = "local:"\n')).path).toBe('roles.narrator');
    expect(errorOf(withConn('[roles]\nnarrator_fallback = "nope"\n')).path).toBe('roles.narrator_fallback');
    expect(errorOf(withConn('[roles]\nnarrator = 3\n')).path).toBe('roles.narrator');
    expect(errorOf(withConn('[roles]\nwriter = "local:m"\n')).path).toBe('roles.writer');
  });

  test('unknown top-level tables and keys are refused', () => {
    const err = errorOf(withConn('[memory]\nenabled = true\n'));
    expect(err.path).toBe('memory');
    expect(err.message).toContain('unknown table; expected one of connections, roles, narrator, director, compendium, caps, prices');
    expect(errorOf('debug = true\n').path).toBe('debug');
    expect(errorOf('roles = "x"\n').message).toBe('roles: must be a table');
  });

  test('unknown fields are refused, with a hint for a near miss', () => {
    const err = errorOf('[connections.a]\nbase-url = "http://h"\n');
    // base_url is missing as well; the unknown field is the better message, but either names the table.
    expect(err.path.startsWith('connections.a.')).toBe(true);
    const typo = errorOf('[connections.a]\nbase_url = "http://h"\nMax_In_Flight = 2\n');
    expect(typo.message).toBe('connections.a.Max_In_Flight: unknown field; did you mean max_in_flight?');
    expect(errorOf(withConn('[narrator]\nrounds = 3\n')).path).toBe('narrator.rounds');
    expect(errorOf('[connections.a]\nbase_url = "http://h"\ncache_ttl = "1h"\n').message).toContain('only anthropic');
    expect(errorOf('[connections.a]\nbase_url = "http://h"\napi_version = "2023-06-01"\n').message).toContain('only anthropic');
  });

  test('numbers are range-checked', () => {
    const conn = (v: string) => `[connections.a]\nbase_url = "http://h"\nmax_in_flight = ${v}\n`;
    for (const v of ['0', '65', '1.5', '"2"', 'true']) {
      expect(errorOf(conn(v)).message).toBe('connections.a.max_in_flight: must be a whole number from 1 to 64');
    }
    // Bun reads inf/nan as strings and -inf as 0: refused before they reach a range check.
    for (const v of ['inf', '-inf', '+inf', 'nan']) {
      expect(errorOf(conn(v)).message).toBe(
        `line 3: ${v} is not supported (the TOML reader does not keep it as a number); write a finite number`,
      );
    }
    expect(parseConfig(conn('64'), null).connections.a!.maxInFlight).toBe(64);
    expect(errorOf(withConn('[narrator]\nmax_rounds = 0\n')).path).toBe('narrator.max_rounds');
    expect(errorOf(withConn('[narrator]\nmax_rounds = 9\n')).path).toBe('narrator.max_rounds');
    expect(errorOf(withConn(`[director]\ninstructions = "${'x'.repeat(2001)}"\n`)).message).toContain('at most 2000 characters');
    expect(parseConfig(withConn(`[director]\ninstructions = "${'ж'.repeat(2000)}"\n`), null).sessionDefaults.director!.instructions).toHaveLength(2000);
    expect(errorOf(withConn('[director]\ntimeout_sec = 0\n')).path).toBe('director.timeout_sec');
  });

  test('enums and types of the session tables', () => {
    expect(errorOf(withConn('[narrator]\nprefill_vs_tools = "both"\n')).path).toBe('narrator.prefill_vs_tools');
    expect(errorOf(withConn('[director]\nprofile = "max"\n')).path).toBe('director.profile');
    expect(errorOf(withConn('[director]\ncreativity = "wild"\n')).path).toBe('director.creativity');
    expect(errorOf(withConn('[director]\nenabled = "yes"\n')).path).toBe('director.enabled');
    expect(errorOf(withConn('[compendium]\nenabled = 1\n')).path).toBe('compendium.enabled');
  });

  test('connection names: no ":" and nothing that needs quoting', () => {
    const colon = errorOf('[connections."a:b"]\nbase_url = "http://h"\n');
    expect(colon.path).toBe('connections."a:b"');
    expect(colon.message).toContain('cannot contain ":"');
    expect(errorOf('[connections."a b"]\nbase_url = "http://h"\n').message).toContain('letters, digits');
    expect(errorOf('connections = { a = 1 }\n').path).toBe('connections.a');
  });

  test('key sources: key_env must be a variable NAME, key_cmd a non-empty argv, not both', () => {
    expect(errorOf('[connections.a]\nbase_url = "http://h"\nkey_env = "my key"\n').message).toContain('NAME of an environment variable');
    expect(errorOf('[connections.a]\nbase_url = "http://h"\nkey_cmd = []\n').path).toBe('connections.a.key_cmd');
    expect(errorOf('[connections.a]\nbase_url = "http://h"\nkey_cmd = "secret-tool lookup x"\n').path).toBe('connections.a.key_cmd');
    expect(errorOf('[connections.a]\nbase_url = "http://h"\nkey_env = "K"\nkey_cmd = ["x"]\n').message).toContain('not both');
    expect(errorOf('[connections.a]\nbase_url = "http://h"\ndialect = "openai"\n').path).toBe('connections.a.dialect');
  });
});

describe('loadConfig', () => {
  test('a missing file is an empty config with path null', () => {
    const home = tmpHome('rp-core-config-');
    expect(loadConfig(home)).toEqual({ path: null, connections: {}, sessionDefaults: {}, caps: {}, prices: {} });
    expect(loadConfig(join(home, 'does-not-exist'))).toEqual({ path: null, connections: {}, sessionDefaults: {}, caps: {}, prices: {} });
  });

  test('reads <home>/config.toml and records its absolute path', () => {
    const home = tmpHome('rp-core-config-');
    writeFileSync(join(home, 'config.toml'), CONFIG_TEMPLATE);
    const cfg = loadConfig(home);
    expect(cfg.path).toBe(join(home, 'config.toml'));
    expect(configPath(home)).toBe(join(home, 'config.toml'));
    expect(Object.keys(cfg.connections)).toContain('ollama');
  });

  test('an unreadable config.toml is a ConfigError, and a bad one keeps its error path', () => {
    const home = tmpHome('rp-core-config-');
    mkdirSync(join(home, 'config.toml'));
    expect(() => loadConfig(home)).toThrow(ConfigError);
    const home2 = tmpHome('rp-core-config-');
    writeFileSync(join(home2, 'config.toml'), '[memory]\n');
    expect(() => loadConfig(home2)).toThrow('memory: unknown table');
  });
});

describe('a required field written with a typo (review M1b)', () => {
  test('base-url names the typo with a did-you-mean, not "base_url: required"', () => {
    for (const [line, key] of [
      ['base-url = "http://127.0.0.1:1"', 'base-url'],
      ['Base_URL = "http://127.0.0.1:1"', 'Base_URL'],
    ] as const) {
      let err: unknown;
      try {
        parseConfig(`[connections.a]\n${line}\n`, null);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toBe(`connections.a.${key}: unknown field; did you mean base_url?`);
    }
    // Truly missing: still "required".
    expect(() => parseConfig('[connections.a]\nkey_env = "K"\n', null)).toThrow('connections.a.base_url: required');
  });
});
