// Shared helpers for the openai-chat adapter tests (not a test file itself).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Block } from '../../src/session/entries.ts';
import type { ModelCaps, ModelRequest, PromptMsg, StreamEv } from '../../src/providers/types.ts';
import { resolveCaps, type CapsInput } from '../../src/providers/caps.ts';
import { createChatReader } from '../../src/providers/openai-chat.ts';
import { sseEvents } from '../../src/providers/sse.ts';

export const enc = new TextEncoder();
export const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'sse', 'openai-chat');

/** A golden SSE fixture, verbatim. */
export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** A message of text blocks. */
export function msg(role: PromptMsg['role'], ...texts: string[]): PromptMsg {
  return { role, blocks: texts.map((text): Block => ({ k: 'text', text })), src: 'test' };
}

/** A message of arbitrary blocks. */
export function blocks(role: PromptMsg['role'], ...bs: Block[]): PromptMsg {
  return { role, blocks: bs, src: 'test' };
}

/** Caps from the shipped host/model rows, for an origin and a model. */
export function capsAt(origin: string, model: string, extra: Partial<CapsInput> = {}): ModelCaps {
  const local = /^http:\/\/(127\.|10\.|localhost)/.test(origin);
  return resolveCaps({ dialect: 'openai-chat', origin, local, model, ...extra });
}

/** A ModelRequest with sensible defaults; `caps` defaults to the llama.cpp preset. */
export function request(over: Partial<ModelRequest> = {}): ModelRequest {
  const model = over.model ?? { connection: 'local', model: 'm' };
  return {
    model,
    caps: over.caps ?? capsAt('http://127.0.0.1:8080', model.model),
    messages: over.messages ?? [msg('user', 'hi')],
    maxTokens: over.maxTokens ?? 256,
    samplers: over.samplers ?? {},
    signal: over.signal ?? new AbortController().signal,
    callKey: over.callKey ?? 'T1:narrator:0',
    agent: over.agent ?? 'narrator',
    ...over,
  };
}

/** Bytes of `text` cut into pieces of `size` bytes (1 = byte by byte, splitting UTF-8 sequences). */
export async function* bytesIn(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = enc.encode(text);
  if (size <= 0) {
    yield bytes;
    return;
  }
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

/** SSE text → events through the real sseEvents + parser, as the provider runs them (no fetch). */
export async function parseSse(req: ModelRequest, text: string, size = 0): Promise<{ events: StreamEv[]; reader: ReturnType<typeof createChatReader> }> {
  const reader = createChatReader(req);
  const events: StreamEv[] = [];
  for await (const ev of sseEvents(bytesIn(text, size))) {
    events.push(...reader.line(ev.data));
    if (reader.done) break;
  }
  events.push(...reader.end());
  return { events, reader };
}

/** Adjacent text / reasoning deltas joined, so chunking does not change what a test compares. */
export function coalesce(events: readonly StreamEv[]): StreamEv[] {
  const out: StreamEv[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (last && (ev.t === 'text' || ev.t === 'reasoning' || ev.t === 'tool_args') && last.t === ev.t && last.i === ev.i) {
      out[out.length - 1] = { ...last, d: last.d + ev.d } as StreamEv;
    } else out.push(ev.t === 'error' ? ev : { ...ev });
  }
  return out;
}

/** The text and reasoning a stream carried. */
export function textsOf(events: readonly StreamEv[]): { text: string; reasoning: string } {
  let text = '';
  let reasoning = '';
  for (const ev of events) {
    if (ev.t === 'text') text += ev.d;
    else if (ev.t === 'reasoning') reasoning += ev.d;
  }
  return { text, reasoning };
}

/** One SSE line for an OpenAI chunk with one choice. */
export function chunk(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
}

/** Everything an async iterable yields. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
