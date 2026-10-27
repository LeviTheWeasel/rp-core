// Live M3 demo against a hosted OpenAI-compatible API (OpenRouter, DeepSeek, …): SKIPPED unless
// RP_CORE_LIVE=1 and RP_CORE_CLOUD_URL is set. It costs money: at most 9 answered calls (3 tries ×
// 3 rounds), each prompt under the window minus the reply reserve (12k tokens by default); a round 0
// the server refuses with 429/5xx is retried once (refused requests are usually not billed).
//   export OPENROUTER_API_KEY=…            # the key stays in your shell; the test reads it by name
//   RP_CORE_LIVE=1 RP_CORE_CLOUD_URL=https://openrouter.ai/api RP_CORE_CLOUD_MODEL=deepseek/deepseek-v4-pro \
//     RP_CORE_CLOUD_KEY_ENV=OPENROUTER_API_KEY bun test test/live/m3-cloud.test.ts
// The scenario is m3-ollama.test.ts's (m3-kit.ts): the innkeeper-200 chat, the §15 question, the
// protocol invariants on every try, and the demo claim (a search_history call and an answer naming
// Тихон) in one of 3 tries. First the server's model list is read, as `rp-core probe --write` does
// (a free GET): its facts about the model (OpenRouter: tools, tool_choice, reasoning) are used, a
// refused key stops the run before any paid call, and an id the list lacks is reported. Env:
//   RP_CORE_CLOUD_URL         the connection's base_url (as in config.toml)
//   RP_CORE_CLOUD_MODEL       the model id on that API
//   RP_CORE_CLOUD_KEY_ENV     the NAME of the environment variable holding the key (never the key)
//   RP_CORE_CLOUD_CTX         the window rp-core assumes (default 16384: smaller than the 40k-token
//                             chat, so the history is trimmed and the history tools are offered)
//   RP_CORE_CLOUD_TOOLS       'native' (default) or 'prompted'
//   RP_CORE_CLOUD_MAX_TOKENS  the reply limit (default 4096; a thinking model's thinking counts)
//   RP_CORE_CLOUD_TIMEOUT_MS  the whole test's time limit (default 1800000, 30 minutes)
// The logged transcript holds the answers, the tool calls and the usage (with the cost when the API
// reports it); never the key.
import { describe, expect, test } from 'bun:test';
import { looksLikeKey } from '../../src/config/config.ts';
import { fetchCatalog, type CapsCacheRow } from '../../src/providers/probe.ts';
import { connectionFromToml, innkeeperDemo } from './m3-kit.ts';

const env = process.env;
const LIVE = env.RP_CORE_LIVE === '1';
const BASE = env.RP_CORE_CLOUD_URL?.trim() ?? '';
const MODEL = env.RP_CORE_CLOUD_MODEL?.trim() ?? '';
const KEY_ENV = env.RP_CORE_CLOUD_KEY_ENV?.trim() ?? '';
const CTX = Number(env.RP_CORE_CLOUD_CTX ?? 16_384);
const TRANSPORT = env.RP_CORE_CLOUD_TOOLS === 'prompted' ? 'prompted' : 'native';
const MAX_TOKENS = Number(env.RP_CORE_CLOUD_MAX_TOKENS ?? 4096);
const TIMEOUT_MS = Number(env.RP_CORE_CLOUD_TIMEOUT_MS ?? 1_800_000);
const CONN = 'cloud';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The key, read from the named variable (null when none is named or it is not a name). */
const key = (): string | null => (KEY_ENV !== '' && NAME.test(KEY_ENV) ? (env[KEY_ENV] ?? '').trim() || null : null);

/** What is wrong with the env, in fixed words that never repeat a value that could be a key. */
function envProblems(): string[] {
  const problems: string[] = [];
  if (MODEL === '') problems.push('RP_CORE_CLOUD_MODEL is not set (the model id on that API)');
  else if (looksLikeKey(MODEL) || (key() !== null && MODEL === key())) {
    problems.push('RP_CORE_CLOUD_MODEL holds an API key; set it to the model id (e.g. deepseek/deepseek-v4-pro)');
  }
  if (KEY_ENV !== '') {
    if (!NAME.test(KEY_ENV)) {
      problems.push('RP_CORE_CLOUD_KEY_ENV must be the NAME of the variable that holds the key (e.g. OPENROUTER_API_KEY), not the key itself');
    } else if (key() === null) {
      // Not named: a key pasted in by mistake can look like a variable name.
      problems.push('the variable named by RP_CORE_CLOUD_KEY_ENV is not set in this shell (export it first)');
    }
  }
  if (!Number.isInteger(CTX) || CTX < 4096) problems.push('RP_CORE_CLOUD_CTX must be a whole number of tokens, 4096 or more');
  if (!Number.isInteger(MAX_TOKENS) || MAX_TOKENS < 1 || MAX_TOKENS * 2 > CTX) problems.push('RP_CORE_CLOUD_MAX_TOKENS must be a whole number, at most half of the window');
  return problems;
}

/** config.toml for the one connection: values quoted as TOML basic strings (JSON's escapes are TOML's). */
function toml(): string {
  const q = JSON.stringify;
  return [
    `[connections.${CONN}]`,
    `base_url = ${q(BASE)}`,
    ...(KEY_ENV !== '' ? [`key_env = ${q(KEY_ENV)}`] : []),
    '',
    `[caps.${q(`${CONN}:${MODEL}`)}]`,
    `context_length = ${CTX}`,
    `tools = ${q(TRANSPORT)}`,
    '',
  ].join('\n');
}

/** The server's model list, read as `rp-core probe --write` reads it: the caps-cache row for the model. */
async function catalogRow(): Promise<Record<string, CapsCacheRow>> {
  let info;
  try {
    info = await fetchCatalog(BASE, { fetch, key: key(), signal: new AbortController().signal, model: MODEL });
  } catch {
    console.log('catalog: the model list could not be read; going on with the built-in caps only');
    return {};
  }
  if (info.authFailed) throw new Error('the server refused the key when listing its models (HTTP 401/403): check the key, nothing paid was sent');
  const ids = info.models.map((m) => m.id);
  if (ids.length > 0 && !ids.includes(MODEL)) {
    const tail = (MODEL.split('/').pop() ?? MODEL).toLowerCase().slice(0, 10);
    const near = ids.filter((id) => id.toLowerCase().includes(tail)).slice(0, 8);
    console.log(`catalog: ${MODEL} is not in the server's list of ${ids.length} models${near.length > 0 ? `; close: ${near.join(', ')}` : ''}. An alias the list omits still works; a typo fails on the first call.`);
  }
  const caps = info.caps[MODEL] ?? {};
  console.log(`catalog: server ${info.server}; facts for the model: ${Object.keys(caps).join(', ') || 'none'}`);
  return { [`${CONN}:${MODEL}`]: { as_of: new Date().toISOString().slice(0, 10), server: info.server, catalog: caps } };
}

describe.skipIf(!LIVE || BASE === '')(`live: the M3 demo on a hosted model (${TRANSPORT} tools)`, () => {
  test(
    'the innkeeper question: invariants on every try; a search_history call and Тихон in one of 3 tries',
    async () => {
      const problems = envProblems();
      if (problems.length > 0) throw new Error(`the cloud test's environment:\n- ${problems.join('\n- ')}`);
      const capsCache = await catalogRow();
      const tries = await innkeeperDemo({
        connId: CONN,
        connection: connectionFromToml(toml(), CONN, env, capsCache),
        model: MODEL,
        transport: TRANSPORT,
        maxTokens: MAX_TOKENS,
        label: { base: BASE, window: CTX, keyEnv: KEY_ENV || null },
      });
      expect(tries.some((t) => t.searched)).toBe(true);
      expect(tries.some((t) => t.searched && t.named)).toBe(true);
    },
    Number.isInteger(TIMEOUT_MS) && TIMEOUT_MS > 0 ? TIMEOUT_MS : 1_800_000,
  );
});
