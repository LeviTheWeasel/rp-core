// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

/** The first M6 wire methods. The server rejects unknown methods with JSON-RPC -32601. */
import type { Character, Persona } from '../formats/native.ts';
import type { Event } from './events.ts';

export const RPC_METHODS = [
  'initialize', 'session/list', 'session/new', 'session/open', 'session/close',
  'session/configure', 'session/fork', 'session/preview',
  'message/send', 'message/edit', 'message/hide',
  'history/select', 'history/tails', 'history/search',
  'memory/list', 'memory/get', 'memory/tree', 'memory/status', 'memory/wait', 'memory/recall',
  'memory/file', 'memory/add', 'memory/edit', 'memory/retire', 'memory/restore',
  'memory/undo', 'memory/refile', 'memory/retry', 'memory/export',
  'lore/test', 'director/show',
  'models/list', 'caps/get', 'caps/probe',
  'turn/run', 'turn/submit', 'turn/stop', 'turn/commitAnyway', 'turn/discard', 'shutdown',
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];
export type RpcId = string | number | null;
export interface RpcRequest { jsonrpc: '2.0'; id?: RpcId; method: string; params: unknown }

/** Wire shapes used to generate protocol.schema.json. Runtime checks live with the dispatcher. */
export interface RpcCommandParams {
  initialize: { protocol: 1; client: { name: string; version: string }; capabilities?: { gates?: ('review' | 'transform')[]; approvals?: boolean } };
  'session/list': {};
  'session/new': { character: string | Character; persona?: string | Persona; config?: Record<string, unknown>; title?: string };
  'session/open': { sessionId: string };
  'session/close': { sessionId: string };
  'session/configure': { sessionId: string; patch: Record<string, unknown> };
  'session/fork': { sessionId: string; at: string };
  'session/preview': { sessionId: string; draft?: string; turnId?: string };
  'message/send': { sessionId: string; text: string; expectedVersion: number; greetingIndex?: number };
  'message/edit': { sessionId: string; messageId: string; text: string; expectedVersion: number };
  'message/hide': { sessionId: string; messageId: string; hidden: boolean; expectedVersion: number };
  'history/select': { sessionId: string; messageId: string; expectedVersion: number; exact?: boolean };
  'history/tails': { sessionId: string };
  'history/search': { sessionId: string; query: string; before?: number; limit?: number };
  'memory/list': { sessionId: string; at?: string; type?: string; includeRetired?: boolean };
  'memory/get': { sessionId: string; ref: string; at?: string };
  'memory/tree': { sessionId: string; at?: string; book?: string };
  'memory/status': { sessionId: string };
  'memory/wait': { sessionId: string; timeoutMs?: number };
  'memory/recall': { sessionId: string; turnId?: string };
  'memory/file': { sessionId: string; type: string; data: Record<string, unknown> };
  'memory/add': { sessionId: string; title: string; content: string; keys?: string[] };
  'memory/edit': { sessionId: string; ref: string; title?: string; content?: string; keys?: string[]; set?: Record<string, unknown>; unset?: string[]; featured?: boolean };
  'memory/retire': { sessionId: string; ref: string; reason?: string };
  'memory/restore': { sessionId: string; ref: string };
  'memory/undo': { sessionId: string; messageId: string; task?: 'file' | 'hist' };
  'memory/refile': { sessionId: string; messageId: string; task?: 'file' | 'hist' };
  'memory/retry': { sessionId: string; messageId?: string };
  'memory/export': { sessionId: string; name: string; format: 'core' | 'compendium'; force?: boolean };
  'lore/test': { sessionId: string; text: string };
  'director/show': { sessionId: string; at?: string };
  'models/list': { conn: string };
  'caps/get': { conn: string; model: string };
  'caps/probe': { conn: string; model: string; active?: boolean };
  'turn/run': { sessionId: string; kind: 'reply' | 'swipe' | 'continue'; expectedVersion: number; guidance?: string; fallback?: string; onError?: 'drop' | 'keep'; emptyReply?: 'fail' | 'keep' };
  'turn/submit': { sessionId: string; text: string; expectedVersion: number };
  'turn/stop': { sessionId: string; turnId: string };
  'turn/commitAnyway': { sessionId: string; turnId: string };
  'turn/discard': { sessionId: string; turnId: string };
  shutdown: {};
}

export type RpcCommand = {
  [Method in keyof RpcCommandParams]: { jsonrpc: '2.0'; id?: RpcId; method: Method } &
    (keyof RpcCommandParams[Method] extends never ? { params?: RpcCommandParams[Method] } : { params: RpcCommandParams[Method] })
}[keyof RpcCommandParams];
export type RpcEventNotification = { jsonrpc: '2.0'; method: 'event'; params: Event };
export type RpcResponse = { jsonrpc: '2.0'; id: RpcId; result: unknown } | { jsonrpc: '2.0'; id: RpcId; error: { code: number; message: string; data?: Record<string, unknown> } };

type AssertNever<T extends never> = T;
export type RpcMethodCoverage = AssertNever<Exclude<RpcMethod, keyof RpcCommandParams> | Exclude<keyof RpcCommandParams, RpcMethod>>;

export class InvalidParams extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidParams'; }
}

export function paramsOf(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidParams('params must be an object');
  return value as Record<string, unknown>;
}

export function stringParam(p: Record<string, unknown>, key: string, optional = false): string | undefined {
  const value = p[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || (!optional && value === '')) throw new InvalidParams(`${key} must be a non-empty string`);
  return value;
}

export function numberParam(p: Record<string, unknown>, key: string): number {
  const value = p[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new InvalidParams(`${key} must be a non-negative integer`);
  return value as number;
}

export function booleanParam(p: Record<string, unknown>, key: string, optional = false): boolean | undefined {
  const value = p[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'boolean') throw new InvalidParams(`${key} must be a boolean`);
  return value;
}

export function objectParam(p: Record<string, unknown>, key: string, optional = false): Record<string, unknown> | undefined {
  const value = p[key];
  if (value === undefined && optional) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidParams(`${key} must be an object`);
  return value as Record<string, unknown>;
}

export function stringArrayParam(p: Record<string, unknown>, key: string, optional = false): string[] | undefined {
  const value = p[key];
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new InvalidParams(`${key} must be an array of strings`);
  return value;
}
