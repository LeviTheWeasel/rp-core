// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// A stand-in OpenAI-compatible server for capturing SillyTavern golden snapshots (test/golden/st):
// SillyBunny's "Custom (OpenAI-compatible)" source points at it, and every chat-completions body
// it receives is written to <out>/req-NNN.json. It answers "OK." so ST finishes the turn.
// Usage: bun tools/st-golden/recorder.ts <out dir> [port=5199]

import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('usage: recorder.ts <out dir> [port]');
const port = Number(process.argv[3] ?? 5199);
mkdirSync(out, { recursive: true });
let n = readdirSync(out).filter((f) => f.startsWith('req-')).length;

const reply = { role: 'assistant', content: 'OK.' };

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'gpt-4o', object: 'model', owned_by: 'golden' }] });
    if (!path.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
    const body = (await req.json()) as { stream?: boolean };
    n += 1;
    await Bun.write(join(out, `req-${String(n).padStart(3, '0')}.json`), `${JSON.stringify(body, null, 2)}\n`);
    console.log(`captured req-${String(n).padStart(3, '0')}.json`);
    if (!body.stream) {
      return Response.json({
        id: 'golden',
        object: 'chat.completion',
        model: 'gpt-4o',
        choices: [{ index: 0, message: reply, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
    const sse =
      chunk({ id: 'golden', object: 'chat.completion.chunk', choices: [{ index: 0, delta: reply, finish_reason: null }] }) +
      chunk({ id: 'golden', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      'data: [DONE]\n\n';
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  },
});
console.log(`recorder on http://127.0.0.1:${port}/v1 → ${out}`);
