// agents/director/call.ts helpers: the tagged schema text without descriptions (D-117), the record's
// skipped cap (D-117), the swipe reuse copy with the persona filter run again (D-104), the depth-1
// inserts (D-106), and a session without a persona.
import { describe, expect, test } from 'bun:test';
import { capSkipped, directiveInsert, reusedRecord, stubInsert, swipeReuses, withoutDescriptions } from '../../src/agents/director/call.ts';
import { PLAN_SCHEMA_LITE } from '../../src/agents/director/plan.ts';
import { contractText, renderDirective, STUB_DIRECTIVE } from '../../src/agents/director/render.ts';
import { emptyState } from '../../src/agents/director/state.ts';
import { DEFAULT_SESSION_CONFIG, type MsgEntry } from '../../src/session/entries.ts';
import type { DirectorRecord, Skip } from '../../src/agents/director/types.ts';
import type { TreeIndex } from '../../src/session/tree.ts';
import { byAgent, calls, dirCall, dirSession, msgBySrc, rig, textOfMsg, turnOf } from './kit.ts';

describe('withoutDescriptions', () => {
  test('drops the description keyword, keeps properties named description', () => {
    const schema = {
      type: 'object',
      description: 'A plan.',
      properties: {
        description: { type: 'string', description: 'The arc description.' },
        list: { type: 'array', items: { type: 'object', description: 'One item.', properties: { description: { type: 'string' } } } },
      },
      required: ['description'],
    };
    expect(withoutDescriptions(schema)).toEqual({
      type: 'object',
      properties: { description: { type: 'string' }, list: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' } } } } },
      required: ['description'],
    });
    expect(schema.description).toBe('A plan.'); // the input is not changed
  });

  test('the lite schema text has no description keyword and is about a third of the schema', () => {
    const text = JSON.stringify(withoutDescriptions(PLAN_SCHEMA_LITE));
    expect(text).not.toMatch(/"description":"/);
    expect(text.length).toBeLessThan(JSON.stringify(PLAN_SCHEMA_LITE).length / 2);
  });
});

describe('capSkipped', () => {
  const skip = (n: number, path = 'p'): Skip[] => Array.from({ length: n }, (_, i) => ({ path: `${path}[${i}]`, why: 'unknown key' }));
  test('one cap over the merged lists, in order; an earlier "+N more" is folded in', () => {
    const reader = [...skip(20, 'reader'), { path: 'skipped', why: '+3 more' }];
    const out = capSkipped([reader, skip(2, 'reducer'), skip(1, 'filter'), []]);
    expect(out).toHaveLength(21);
    expect(out[19]!.path).toBe('reader[19]');
    expect(out[20]).toEqual({ path: 'skipped', why: '+6 more' });
    expect(capSkipped([skip(2), skip(3)])).toHaveLength(5);
  });
});

describe('inserts and reuse', () => {
  test('directiveInsert: depth 1, system, src director; nothing for no or an empty directive; the stub', () => {
    expect(directiveInsert(undefined)).toEqual([]);
    expect(directiveInsert({ pacing: 'medium' })).toEqual([]);
    expect(directiveInsert({ pacing: 'fast', mood: 'grim' })).toEqual([{ depth: 1, role: 'system', src: 'director', text: renderDirective({ pacing: 'fast', mood: 'grim' }) }]);
    expect(stubInsert()).toEqual([{ depth: 1, role: 'system', src: 'director', text: STUB_DIRECTIVE }]);
  });

  test('reusedRecord: only an ok record; no attempts; reusedFrom kept along a chain; the filter runs with today’s names', () => {
    const rec: DirectorRecord = {
      turn: 3,
      ok: true,
      directive: { pacing: 'slow', mood: 'grim', characterBeats: [{ character: 'Ann', beat: 'Ann realizes the truth' }, { character: 'Bo', beat: 'Bo laughs' }] },
      skipped: [{ path: 'x', why: 'y' }],
      attempts: [{ transport: 'tagged', outcome: 'ok', ms: 5 }],
      state: { ...emptyState(), turn: 3 },
      reducer: 1,
    };
    const tree = (dir: unknown): TreeIndex => ({ msgs: new Map([['a1', { dir } as MsgEntry]]) }) as unknown as TreeIndex;
    const copy = reusedRecord(tree(rec), 'a1', { name: 'Ann' })!;
    expect(copy).toMatchObject({ turn: 3, ok: true, attempts: [], reusedFrom: 'a1', state: rec.state });
    expect(copy.directive!.characterBeats).toEqual([{ character: 'Bo', beat: 'Bo laughs' }]);
    expect(copy.skipped).toEqual([expect.objectContaining({ why: 'persona' })]);
    expect(reusedRecord(tree({ ...rec, reusedFrom: 'a0' }), 'a1', undefined)!.reusedFrom).toBe('a0');
    expect(reusedRecord(tree({ ...rec, reusedFrom: 'a0' }), 'a1', undefined)!.skipped).toEqual([]);
    expect(reusedRecord(tree({ ...rec, ok: false, code: 'timeout' }), 'a1', undefined)).toBeNull();
    expect(reusedRecord(tree({ junk: true }), 'a1', undefined)).toBeNull();
    expect(reusedRecord(tree(undefined), 'a1', undefined)).toBeNull();
  });

  test('swipeReuses: onSwipe reuse without guidance', () => {
    const cfg = structuredClone(DEFAULT_SESSION_CONFIG);
    expect(swipeReuses(cfg, undefined)).toBe(true);
    expect(swipeReuses(cfg, '  ')).toBe(true);
    expect(swipeReuses(cfg, 'Be terse.')).toBe(false);
    cfg.director.onSwipe = 'replan';
    expect(swipeReuses(cfg, undefined)).toBe(false);
  });
});

describe('a session without a persona', () => {
  test('the contract says "the player"; the Director prompt has no persona name', async () => {
    const r = await rig(calls(dirCall(), [{ text: 'Hm.' }]));
    const s = dirSession(r.engine, { persona: null });
    const { out } = await turnOf(s);
    expect(out.type).toBe('done');
    const n = byAgent(r.provider.requests, 'narrator')[0]!;
    expect(textOfMsg(msgBySrc(n, 'core:director')!)).toBe(contractText(''));
    expect(contractText('')).toContain('NEVER act, speak or decide for the player.');
    const d = byAgent(r.provider.requests, 'director')[0]!;
    expect(JSON.stringify(d.messages)).not.toContain('Levi');
    await r.engine.close();
  });
});
