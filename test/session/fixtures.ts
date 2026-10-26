// Fixtures shared by the session tests (not a test file itself).
import { DEFAULT_SESSION_CONFIG } from '../../src/session/entries.ts';
import type { Block, Entry, EntryInput, MsgEntry, SessionHeader, VarsDiff } from '../../src/session/entries.ts';

export const TS = '2026-10-26T12:00:00.000Z';

export function makeHeader(id = 's_0000a001', extra: Partial<SessionHeader> = {}): SessionHeader {
  return {
    t: 'session',
    v: 1,
    id,
    created: TS,
    title: 'Test session',
    cast: {
      character: { name: 'Mira', description: 'A cartographer.', greetings: ['Hello, traveller.', 'Oh. You again.'] },
      persona: { name: 'Levi', description: 'A traveller.', aliases: ['L', 'Levi'] },
    },
    config: structuredClone(DEFAULT_SESSION_CONFIG),
    ...extra,
  };
}

export const text = (t: string): Block[] => [{ k: 'text', text: t }];

/** A msg input (no seq) for SessionLog.append. */
export function msg(
  id: string,
  parent: string | null,
  role: 'user' | 'assistant' = 'assistant',
  body = `text of ${id}`,
  extra: Partial<MsgEntry> = {},
): EntryInput {
  return { t: 'msg', ts: TS, id, parent, role, blocks: text(body), ...extra } as EntryInput;
}

export const head = (leaf: string): EntryInput => ({ t: 'head', ts: TS, leaf });
export const hide = (target: string, hidden = true): EntryInput => ({ t: 'hide', ts: TS, target, hidden });
export const edit = (target: string, body: string, extra: Record<string, unknown> = {}): EntryInput =>
  ({ t: 'edit', ts: TS, target, reason: 'user', blocks: text(body), ...extra }) as EntryInput;
export const withVars = (vars: VarsDiff): Partial<MsgEntry> => ({ vars });

/** Assign seq 1..n, as the log would. */
export function seqd(inputs: EntryInput[], from = 1): Entry[] {
  return inputs.map((e, i) => ({ ...e, seq: from + i }) as Entry);
}

/** A minimal valid trace with the given lore fires. */
export function traceWith(fired: { book: string; id: string; why: string }[] = []): Record<string, unknown> {
  return {
    seed: 7,
    now: TS,
    window: 8192,
    reserve: 512,
    tokens: { estimated: 100 },
    blocks: [],
    lore: { fired, cut: [], budget: 0 },
    recap: { ids: [], arcs: [], boundary: null },
    prefill: null,
    macros: { unknown: [] },
    trimmed: null,
    calls: [],
    agents: {},
    presetHash: 'h',
    loreHashes: {},
  };
}
