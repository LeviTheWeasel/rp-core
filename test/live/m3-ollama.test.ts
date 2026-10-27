// Live M3 demo against the user's own Ollama: SKIPPED unless RP_CORE_LIVE=1.
//   RP_CORE_LIVE=1 bun test test/live/m3-ollama.test.ts
//   RP_CORE_LIVE=1 RP_CORE_OLLAMA_M3_MODEL=gemma4:26b RP_CORE_OLLAMA_CTX=4096 RP_CORE_OLLAMA_TOOLS=native \
//     RP_CORE_OLLAMA_MAX_TOKENS=1024 bun test test/live/m3-ollama.test.ts
// The innkeeper-200 chat (seeded in-process, no model), then the §15 question on a local model with
// prompted (default) or native tools: the protocol invariants are checked on every try; the demo
// claim (a search_history call and an answer naming Тихон) must hold in one of 3 tries (the first
// answer, then 2 swipes). Nothing is pulled, created or deleted; narrator.maxRounds 2, so at most
// 3 tries × 3 calls. Env: RP_CORE_OLLAMA_URL (default http://127.0.0.1:11434), RP_CORE_OLLAMA_M3_MODEL
// (default magmell-16k:latest, a Modelfile alias with num_ctx 16384), RP_CORE_OLLAMA_CTX (default
// 16384: the window the model really runs with on /v1, docs/M3-DEMO.md), RP_CORE_OLLAMA_TOOLS
// ('prompted' or 'native') and RP_CORE_OLLAMA_MAX_TOKENS (default 300; a thinking model's thinking
// counts against it). A JSON transcript is logged. The scenario lives in m3-kit.ts; a hosted model:
// m3-cloud.test.ts.
import { describe, expect, test } from 'bun:test';
import { connectionFromToml, innkeeperDemo } from './m3-kit.ts';

const LIVE = process.env.RP_CORE_LIVE === '1';
const BASE = process.env.RP_CORE_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.RP_CORE_OLLAMA_M3_MODEL ?? 'magmell-16k:latest';
const CTX = Number(process.env.RP_CORE_OLLAMA_CTX ?? 16_384);
/** 'prompted' (default) or 'native': the caps' tools transport for the model. */
const TRANSPORT = process.env.RP_CORE_OLLAMA_TOOLS === 'native' ? 'native' : 'prompted';
/** The reply reserve: a thinking model needs more than the default 300 (its thinking counts). */
const MAX_TOKENS = Number(process.env.RP_CORE_OLLAMA_MAX_TOKENS ?? 300);

describe.skipIf(!LIVE)(`live: the M3 demo on Ollama (${TRANSPORT} tools)`, () => {
  test(
    'the innkeeper question: invariants on every try; a search_history call and Тихон in one of 3 tries',
    async () => {
      const toml = `[connections.ollama]\nbase_url = "${BASE}"\n\n[caps."ollama:${MODEL}"]\ncontext_length = ${CTX}\ntools = "${TRANSPORT}"\n`;
      const tries = await innkeeperDemo({
        connId: 'ollama',
        connection: connectionFromToml(toml, 'ollama'),
        model: MODEL,
        transport: TRANSPORT,
        maxTokens: MAX_TOKENS,
        label: { base: BASE, window: CTX },
      });
      expect(tries.some((t) => t.searched)).toBe(true);
      expect(tries.some((t) => t.searched && t.named)).toBe(true);
    },
    900_000,
  );
});
