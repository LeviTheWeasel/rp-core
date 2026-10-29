// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

/** The first M6 wire methods. The server rejects unknown methods with JSON-RPC -32601. */
export const RPC_METHODS = [
  'initialize', 'session/list', 'session/new', 'session/open', 'session/close',
  'session/configure', 'session/fork', 'session/preview',
  'message/send', 'message/edit', 'message/hide',
  'history/select', 'history/tails', 'history/search',
  'turn/run', 'turn/submit', 'turn/stop', 'shutdown',
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];
export type RpcId = string | number | null;
export interface RpcRequest { jsonrpc: '2.0'; id?: RpcId; method: string; params: unknown }

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
