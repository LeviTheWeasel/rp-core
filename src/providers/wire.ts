// Ported from Bunraku:src/stage/provider/openai-compatible-request.ts@702d8120 (validateToolProtocol,
// lines 72-115, itself RoleCall's validateDirectToolProtocol), Bunraku:src/stage/provider/transport-core.ts@702d8120
// (normalizeFinishReason), Bunraku:src/stage/provider/request-overrides.ts@702d8120 (case-insensitive header
// replacement) and Bunraku:src/stage/params/custom.ts@702d8120 (protected body keys and headers).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers shared by adapters (ARCHITECTURE.md §8.3, D-52, D-53).
// CONTRACT FILE (M1b): signatures are fixed; the transport agent implements the bodies.
//
// Changes from Bunraku: the protocol check runs over PromptMsg blocks (tool_call / tool_result) instead
// of string messages with OpenAI tool_calls, returns a verdict instead of throwing, and also requires
// results in call order; finish reasons map onto the core's FinishReason instead of lower-cased strings;
// overrides are already parsed (config load owns JSON parsing, D-53), deep-merged instead of
// Object.assign, applied last, and protected names are skipped and reported instead of thrown.

import type { Block } from '../session/entries.ts';
import type { FinishReason, ModelRequest, PromptMsg } from './types.ts';

// ---- tool protocol (§8.3 "Проверка протокола перед каждой отправкой") -------------------------------

/** A tool name every dialect accepts (OpenAI function names; Bunraku/RoleCall rule). */
export const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/**
 * A tool call id that is safe to echo into JSON and into prompted `<tool_result id="…">` markup:
 * 1-128 of letters, digits, '_', '-', '.', ':'. Kimi's "functions.name:0" passes; anything with
 * spaces, quotes, angle brackets or control characters does not. A dialect with a narrower rule
 * (Mistral's 9 alphanumerics) remaps first (remapToolIds).
 */
export const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every tool_call has exactly one later tool_result, in order, ids unique and safe, args JSON objects.
 *
 * The rules, over PromptMsg blocks:
 * - tool_call blocks only in assistant messages; tool_result blocks only in tool or user messages
 *   (OpenAI sends one 'tool' message per result, Anthropic one user turn with all of them).
 * - Call ids are unique across the request and SAFE_ID; names are SAFE_NAME; args parse to a JSON
 *   object ('' counts as {}).
 * - Once an assistant message makes calls, the following messages must answer them, in the order the
 *   calls were made (the first unanswered call first), each by id and with the same name, before any
 *   message that carries no result. A result for an unknown, already answered or out-of-order call
 *   fails, and so does a batch still open at the end of the request ("no dangling batches").
 */
export function validateToolProtocol(messages: readonly PromptMsg[]): { ok: true } | { ok: false; why: string } {
  const seen = new Set<string>();
  /** Calls of the open batch not answered yet, in call order. */
  let pending: { id: string; name: string }[] = [];
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index]!;
    const calls = msg.blocks.filter((b): b is Extract<Block, { k: 'tool_call' }> => b.k === 'tool_call');
    const results = msg.blocks.filter((b): b is Extract<Block, { k: 'tool_result' }> => b.k === 'tool_result');
    if (pending.length > 0 && results.length === 0) {
      return { ok: false, why: `tool call batch is incomplete before message ${index} (${pending[0]!.id} has no result)` };
    }
    if (results.length > 0) {
      if (msg.role !== 'tool' && msg.role !== 'user') {
        return { ok: false, why: `tool results at message ${index} must be in a tool or user message, not ${msg.role}` };
      }
      for (const r of results) {
        const expected = pending[0];
        if (!expected) {
          return { ok: false, why: `tool result at message ${index} answers ${seen.has(r.callId) ? 'an already answered' : 'an unknown'} call ${r.callId || '(missing id)'}` };
        }
        if (r.callId !== expected.id) {
          const known = pending.some((p) => p.id === r.callId);
          return {
            ok: false,
            why: known
              ? `tool result ${r.callId} at message ${index} is out of order: ${expected.id} must be answered first`
              : `tool result at message ${index} answers ${seen.has(r.callId) ? 'an already answered' : 'an unknown'} call ${r.callId || '(missing id)'}`,
          };
        }
        if (r.name !== expected.name) {
          return { ok: false, why: `tool result ${r.callId} names ${r.name} but the assistant called ${expected.name}` };
        }
        pending = pending.slice(1);
      }
    }
    if (calls.length > 0) {
      if (msg.role !== 'assistant') {
        return { ok: false, why: `tool calls at message ${index} require an assistant message, not ${msg.role}` };
      }
      for (const c of calls) {
        if (!SAFE_ID.test(c.id) || !SAFE_NAME.test(c.name) || seen.has(c.id)) {
          return { ok: false, why: `tool call at message ${index} has a missing, unsafe or duplicate id or name` };
        }
        let args: unknown;
        try {
          args = JSON.parse(c.args.trim() === '' ? '{}' : c.args);
        } catch {
          return { ok: false, why: `tool call ${c.id} has invalid JSON arguments` };
        }
        if (!isRecord(args)) return { ok: false, why: `tool call ${c.id} arguments must be a JSON object` };
        seen.add(c.id);
        pending.push({ id: c.id, name: c.name });
      }
    }
  }
  if (pending.length > 0) return { ok: false, why: `tool call batch is incomplete at the end of the request (${pending[0]!.id} has no result)` };
  return { ok: true };
}

// ---- tool id remapping -----------------------------------------------------------------------------

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MISTRAL9 = /^[A-Za-z0-9]{9}$/;

/** FNV-1a over UTF-8 with a 32-bit seed; two lanes give enough bits for 9 base-62 digits. */
function fnv1a(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A deterministic 9-alphanumeric id for `id` (salt bumps on a collision). */
function mistralId(id: string, salt: number): string {
  let a = fnv1a(id, salt * 2 + 1);
  let b = fnv1a(id, salt * 2 + 2);
  let out = '';
  for (let i = 0; i < 9; i++) {
    // Alternate lanes so all 9 digits draw on fresh bits.
    if (i % 2 === 0) {
      out += ALNUM[a % 62];
      a = Math.floor(a / 62);
    } else {
      out += ALNUM[b % 62];
      b = Math.floor(b / 62);
    }
  }
  return out;
}

/**
 * Remap tool ids for a dialect (mistral9: 9 alphanumerics), consistently across calls and results.
 *
 * Without a format the messages come back as a copy, ids untouched. With 'mistral9' an id that
 * already has the shape is kept (Mistral's own ids round-trip); any other id gets a deterministic
 * 9-character id derived from it, so the same id maps the same way in every request of a tool loop,
 * and a tool_result's callId follows its call. Distinct ids never share a new id. Never mutates input.
 */
export function remapToolIds(messages: readonly PromptMsg[], format?: 'mistral9'): PromptMsg[] {
  const copy = (m: PromptMsg, mapId: (id: string) => string): PromptMsg => ({
    ...m,
    blocks: m.blocks.map((b): Block => {
      if (b.k === 'tool_call') return { ...b, id: mapId(b.id) };
      if (b.k === 'tool_result') return { ...b, callId: mapId(b.callId) };
      return { ...b };
    }),
  });
  if (format !== 'mistral9') return messages.map((m) => copy(m, (id) => id));

  // Every id in the request, in first-seen order.
  const ids: string[] = [];
  const seenIds = new Set<string>();
  for (const m of messages) {
    for (const b of m.blocks) {
      const id = b.k === 'tool_call' ? b.id : b.k === 'tool_result' ? b.callId : null;
      if (id !== null && !seenIds.has(id)) {
        seenIds.add(id);
        ids.push(id);
      }
    }
  }
  // Ids already in shape are reserved first, so a generated id can never collide with one.
  const map = new Map<string, string>();
  const taken = new Set<string>();
  for (const id of ids) {
    if (MISTRAL9.test(id)) {
      map.set(id, id);
      taken.add(id);
    }
  }
  for (const id of ids) {
    if (map.has(id)) continue;
    let salt = 0;
    let next = mistralId(id, salt);
    while (taken.has(next)) next = mistralId(id, ++salt);
    map.set(id, next);
    taken.add(next);
  }
  return messages.map((m) => copy(m, (id) => map.get(id) ?? id));
}

// ---- the reasoning echo (§8.4, D-94 revised) --------------------------------------------------------

/** The raw reasoning of a message's blocks (summaries and redactions are not the model's own text). */
export function rawReasoningOf(blocks: readonly Block[]): string {
  return blocks
    .filter((b): b is Extract<Block, { k: 'reasoning' }> => b.k === 'reasoning' && (b.kind === undefined || b.kind === 'raw'))
    .map((b) => b.text)
    .filter((t) => t !== '')
    .join('\n\n');
}

/** What of a request the echo rule reads. */
export type EchoFields = Pick<ModelRequest, 'caps' | 'reasoning' | 'messages' | 'tools' | 'toolChoice'>;

/**
 * D-94 (revised): the request echoes reasoning on EVERY assistant message — its own raw reasoning,
 * else a placeholder — when the model's caps.reasoning.echo is 'all-with-tools', thinking is on for
 * the call (not `reasoning 'none'` on a model that can turn it off) and the request has tool traffic:
 * native tools that go out (not dropped on a final round whose tool_choice the server ignores) or a
 * tool_call block on the path. The one rule the openai-chat adapter and the engine's 400 notice share.
 */
export function echoesReasoning(req: EchoFields): boolean {
  const caps = req.caps;
  if (caps.reasoning.echo !== 'all-with-tools') return false;
  if (req.reasoning === 'none' && caps.reasoning.canDisable) return false;
  const toolsSent = caps.tools === 'native' && (req.tools?.length ?? 0) > 0 && !(req.toolChoice === 'none' && !caps.toolChoiceHonored);
  return toolsSent || req.messages.some((m) => m.blocks.some((b) => b.k === 'tool_call'));
}

/** How many assistant messages of the request go out with the echo placeholder (0 when nothing is echoed). */
export function echoPlaceholders(req: EchoFields): number {
  if (!echoesReasoning(req)) return 0;
  return req.messages.filter((m) => m.role === 'assistant' && rawReasoningOf(m.blocks) === '').length;
}

// ---- merging ------------------------------------------------------------------------------------------

/** Messages that are never merged: tool traffic, replay payloads and reasoning (echoed or signed parts, D-52). */
function mergeable(m: PromptMsg): boolean {
  if (m.replay && m.replay.length > 0) return false;
  return m.blocks.every((b) => b.k === 'text');
}

/** Text parts joined with a blank line; blank parts drop out (a blank message adds nothing but a gap). */
function joinText(a: string, b: string): string {
  if (a.trim() === '') return b.trim() === '' ? a + b : b;
  if (b.trim() === '') return a;
  return `${a}\n\n${b}`;
}

/**
 * Merge neighbouring messages of the same role (text blocks joined with '\n\n'). Never merges messages
 * that carry tool blocks or replay payloads, nor ones with different placement.
 *
 * Only all-text messages merge: a message with any tool_call, tool_result or reasoning block, or with
 * replay, stays as it is (D-52: signed and echoed parts are never glued to anything). Placement must
 * be equal (an absent placement equals only another absent one). The merged message keeps the
 * first one's fields, its text blocks become one, and `src` lists both ("a+b"). Never mutates input.
 */
export function mergeAdjacent(messages: readonly PromptMsg[]): PromptMsg[] {
  const out: PromptMsg[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && last.placement === m.placement && mergeable(last) && mergeable(m)) {
      const text = [...last.blocks, ...m.blocks].reduce((acc, b) => joinText(acc, b.k === 'text' ? b.text : ''), '');
      out[out.length - 1] = { ...last, blocks: [{ k: 'text', text }], src: `${last.src}+${m.src}` };
    } else {
      out.push({ ...m, blocks: m.blocks.map((b) => ({ ...b })) });
    }
  }
  return out;
}

// ---- finish reasons ----------------------------------------------------------------------------------

/**
 * Provider finish string → FinishReason: stop/end_turn → end; length/max_tokens → length; content_filter; tool_calls → end.
 *
 * Case-insensitive. Also: Gemini STOP / MAX_TOKENS / SAFETY, PROHIBITED_CONTENT, BLOCKLIST, SPII,
 * RECITATION (content_filter), Anthropic stop_sequence / tool_use / pause_turn (end) / refusal /
 * model_context_window_exceeded (length), Cohere COMPLETE, legacy function_call, koboldcpp eos.
 * Absent or unknown → 'end': the adapter keeps the raw string beside it, and failures such as
 * OpenRouter's finish_reason "error" are the adapter's to raise before it gets here (§8.1).
 */
export function normalizeFinish(raw: string | null | undefined): FinishReason {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'content_filter':
    case 'safety':
    case 'prohibited_content':
    case 'blocklist':
    case 'spii':
    case 'recitation':
      return 'content_filter';
    case 'refusal':
      return 'refusal';
    default:
      // stop, end_turn, stop_sequence, tool_calls, tool_use, function_call, complete, eos, pause_turn, ''.
      return 'end';
  }
}

// ---- connection overrides [D-53] ---------------------------------------------------------------------

/** [D-53] the connection's escape hatch, already resolved (header VALUES come from env at config load). */
export interface ConnectionOverrides {
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  excludeBody?: string[];
}

/** Body keys and header names an override may never touch [D-53]. */
export const PROTECTED_BODY_KEYS: readonly string[] = [
  'model', 'messages', 'stream', 'tools', 'tool_choice',
  'contents', 'systemInstruction', 'generationConfig', 'toolConfig', 'safetySettings',
];
/**
 * Compared lower-case and trimmed. The architect's four, plus the rest of Bunraku's list
 * (params/custom.ts PROTECTED_HEADER_KEYS): other credential headers and the framing the fetch sets.
 */
export const PROTECTED_HEADERS: readonly string[] = [
  'authorization', 'x-api-key', 'anthropic-version', 'content-type',
  'proxy-authorization', 'api-key', 'x-goog-api-key', 'host', 'content-length', 'cookie',
];

/** Keys that would reach Object.prototype through a merge. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A deep copy of a JSON-ish value (plain objects and arrays), dropping prototype-polluting keys. */
function cloneJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cloneJson);
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!UNSAFE_KEYS.has(k)) out[k] = cloneJson(x);
    return out;
  }
  return v;
}

/** Deep merge of `src` into `dst` (both owned copies): objects merge key by key; arrays, scalars and null replace. */
function deepMerge(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const cur = dst[k];
    if (isRecord(cur) && isRecord(v)) deepMerge(cur, v);
    else dst[k] = cloneJson(v);
  }
}

/**
 * Apply overrides last: exclude, then deep-merge extraBody, then headers; protected keys untouched (reported).
 *
 * - excludeBody names top-level body keys (no paths).
 * - extraBody merges recursively into plain objects; an array, scalar or null replaces. A top-level
 *   protected key is skipped (nested keys are free: `provider.allow_fallbacks` is fine).
 * - headers replace a header of the same name in any letter case, so each name is sent once
 *   (Bunraku applyRequestHeaders). A protected name is skipped.
 * - `ignored` lists every skipped entry as "exclude_body.<key>", "extra_body.<key>" or
 *   "headers.<Name>", for a notice. Inputs are never mutated; the body is a deep copy.
 */
export function applyOverrides(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  o: ConnectionOverrides | undefined,
): { body: Record<string, unknown>; headers: Record<string, string>; ignored: string[] } {
  const outBody = cloneJson(body) as Record<string, unknown>;
  const outHeaders: Record<string, string> = { ...headers };
  const ignored: string[] = [];
  if (!o) return { body: outBody, headers: outHeaders, ignored };

  for (const key of o.excludeBody ?? []) {
    if (PROTECTED_BODY_KEYS.includes(key)) ignored.push(`exclude_body.${key}`);
    else delete outBody[key];
  }

  if (o.extraBody) {
    const allowed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(o.extraBody)) {
      if (PROTECTED_BODY_KEYS.includes(key)) ignored.push(`extra_body.${key}`);
      else allowed[key] = value;
    }
    deepMerge(outBody, allowed);
  }

  for (const [name, value] of Object.entries(o.headers ?? {})) {
    const lower = name.trim().toLowerCase();
    if (lower === '' || PROTECTED_HEADERS.includes(lower)) {
      ignored.push(`headers.${name}`);
      continue;
    }
    for (const existing of Object.keys(outHeaders)) if (existing.trim().toLowerCase() === lower) delete outHeaders[existing];
    outHeaders[name] = String(value);
  }
  return { body: outBody, headers: outHeaders, ignored };
}
