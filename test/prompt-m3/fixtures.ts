// Fixtures for the M3 prompt tests (not a test file itself): tool specs in the builtins' shape and
// small helpers over assemble results.
import { createHash } from 'node:crypto';
import { assemble, CORE_TOOLS_SRC, type AssembleInput, type AssembleResult } from '../../src/prompt/assemble.ts';
import type { PromptMsg, ToolSpec } from '../../src/providers/types.ts';
import { base, m2Json } from './m2-scenarios.ts';

export * from './m2-scenarios.ts';

/** Two specs shaped like the M3 history tools (sorted by name, as the request builder sends them). */
export const SPECS: ToolSpec[] = [
  {
    name: 'read_history',
    description: 'Read messages #from..#to of this chat, whole.',
    schema: {
      type: 'object',
      properties: { from: { type: 'integer', minimum: 1, description: 'First message number.' }, to: { type: 'integer', minimum: 1 } },
      required: ['from'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_history',
    description: 'Search the earlier chat for words; newest hits first.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: 'One or two key words.' },
        before: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

export type Ok = Extract<AssembleResult, { ok: true }>;

/** Narrow to the ok branch or fail loudly. */
export function okOf(r: AssembleResult): Ok {
  if (!r.ok) throw new Error(`assemble failed: ${r.code}: ${r.message}`);
  return r;
}

/** assemble over base() with `over`. */
export const run = (over: Partial<AssembleInput> = {}): AssembleResult => assemble(base(over));
export const runOk = (over: Partial<AssembleInput> = {}): Ok => okOf(run(over));

/** sha-256 of the M2 part of a result (m2Json). */
export const digest = (r: AssembleResult): string => createHash('sha256').update(m2Json(r)).digest('hex');

/** The text of a message (its text blocks joined). */
export const textOf = (msg: PromptMsg): string => msg.blocks.map((b) => (b.k === 'text' ? b.text : '')).join('');

/** Index of the core block, -1 when there is none. */
export const coreAt = (msgs: readonly PromptMsg[]): number => msgs.findIndex((m) => m.src === CORE_TOOLS_SRC);

/** `src` of every message, in order. */
export const srcs = (msgs: readonly PromptMsg[]): string[] => msgs.map((m) => m.src);

/** The count a context_length_exceeded message names ("needs about N tokens"). */
export const tokensIn = (message: string): number => Number(/needs about (\d+) tokens/.exec(message)?.[1] ?? NaN);
