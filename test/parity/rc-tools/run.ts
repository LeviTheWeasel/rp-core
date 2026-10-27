// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Test-only harness for the RoleCall tool-call parity corpus (docs/PARITY-RC.md, "Tool calls (M3)"):
// each corpus row's input run through rp-core and reduced to the same plain shape RoleCall's output
// was recorded in, so the two compare with toEqual.

import { parseToolArgs } from '../../../src/tools/args.ts';
import { recoverLeaks, stripToolCallLeaks } from '../../../src/tools/leaks.ts';
import { createPromptedStripper, frameResults, parsePromptedCalls, renderCoreBlock, stripPromptedCalls } from '../../../src/tools/prompted.ts';
import { runTools } from '../../../src/tools/run.ts';
import type { Tool, ToolCtx } from '../../../src/tools/types.ts';
import { HandleTable } from '../../../src/tools/handles.ts';
import type { ToolSpec } from '../../../src/providers/types.ts';

type Schema = Record<string, unknown>;

/** One corpus row. `rc`: RoleCall's output in the row's shape; `core`: rp-core's; equal unless `deviation` names why. */
export interface CorpusRow {
  id: string;
  /** The RoleCall test case the input comes from (`file:line@fb8dc623e`), or 'added' for inputs the rp-core suite adds. */
  source: string;
  kind: 'parse' | 'strip' | 'stream' | 'args' | 'dsml' | 'salvage' | 'salvage-text' | 'frame' | 'catalog' | 'executor';
  input: unknown;
  rc: unknown;
  core: unknown;
  /** A TD-n of docs/PARITY-RC.md "Tool calls (M3)" when rc and core differ on purpose. */
  deviation?: string;
}

export interface ParseInput {
  content: string;
  schemas: Record<string, Schema>;
}
export interface StreamInput {
  text: string;
  /** 'chars': one character per push; 'whole': one push. */
  feed: 'chars' | 'whole';
}
export interface ArgsInput {
  raw: string;
  schema?: Schema;
}
export interface LeakInput {
  content: string;
  offered: string[];
  native: number;
  /** RoleCall gated DSML on the response's model name; rp-core ignores it. */
  model: string;
}
export interface ExecutorInput {
  tool: { name: string; schema: Schema; throws?: string };
  call: { name: string; args: string };
}

/** A parsed call as both sides report it: name, the arguments object ({} on failure), failure flag. */
export interface CallView {
  name: string;
  args: unknown;
  error: boolean;
}

function parseView(input: ParseInput): CallView[] {
  return parsePromptedCalls(input.content).map((b) => {
    const name = b.name ?? '';
    const checked = parseToolArgs(b.args, input.schemas[name] ?? { type: 'object' }, name || 'tool');
    const failed = b.error !== undefined || !checked.ok;
    return { name, args: failed ? {} : (checked as { value: unknown }).value, error: failed };
  });
}

function streamView(input: StreamInput): string {
  const s = createPromptedStripper();
  let out = '';
  for (const part of input.feed === 'chars' ? [...input.text] : [input.text]) out += s.push(part);
  return out + s.end();
}

function argsView(input: ArgsInput): { ok: boolean; args?: unknown } {
  const r = parseToolArgs(input.raw, input.schema ?? { type: 'object' }, 'tool');
  return r.ok ? { ok: true, args: r.value } : { ok: false };
}

function leakView(input: LeakInput): { content: string; calls: { name: string; args: unknown }[] } {
  const r = recoverLeaks(input.content, { offered: input.offered, nativeCalls: input.native });
  return {
    content: stripToolCallLeaks(r.text).text,
    calls: r.calls.map((c) => ({ name: c.name, args: JSON.parse(c.args) as unknown })),
  };
}

function salvageView(input: LeakInput): { name: string; args: unknown }[] {
  return leakView(input).calls;
}

async function executorView(input: ExecutorInput): Promise<{ ran: boolean; args?: unknown; message?: string }> {
  const seen: unknown[] = [];
  const tool: Tool = {
    name: input.tool.name,
    description: 'test',
    schema: input.tool.schema,
    effect: 'read',
    run: async (args) => {
      seen.push(args);
      if (input.tool.throws !== undefined) throw new Error(input.tool.throws);
      return { text: 'ok', summary: '' };
    },
  };
  const ctx = {
    view: {},
    upTo: 'm',
    names: { char: 'c', user: 'u' },
    lore: [],
    compendium: {},
    handles: new HandleTable(),
    inContext: () => false,
    pageChars: 6000,
    signal: new AbortController().signal,
    now: '2026-10-26T12:00:00.000Z',
    rng: () => 0,
  } as unknown as ToolCtx;
  const [o] = await runTools(
    { calls: [{ id: 'call-1', name: input.call.name, args: input.call.args, round: 0, via: 'native' }], tools: new Map([[tool.name, tool]]), ctx, roomChars: 1_000_000 },
    () => new Date(0),
  );
  return { ran: seen.length > 0, ...(seen.length > 0 ? { args: seen[0] } : {}), ...(o!.ok ? {} : { message: o!.text }) };
}

/** rp-core's output for a row's input, in the row's shape. */
export async function coreOutput(kind: CorpusRow['kind'], input: unknown): Promise<unknown> {
  switch (kind) {
    case 'parse':
      return parseView(input as ParseInput);
    case 'strip':
      return stripPromptedCalls(input as string);
    case 'stream':
      return streamView(input as StreamInput);
    case 'args':
      return argsView(input as ArgsInput);
    case 'dsml':
      return leakView(input as LeakInput);
    case 'salvage':
      return salvageView(input as LeakInput);
    case 'salvage-text':
      return recoverLeaks((input as LeakInput).content, { offered: (input as LeakInput).offered, nativeCalls: 0 }).text;
    case 'frame':
      return frameResults(input as { name: string; id: string; text: string }[]);
    case 'catalog':
      return renderCoreBlock(input as ToolSpec[], 'prompted');
    case 'executor':
      return executorView(input as ExecutorInput);
  }
}
