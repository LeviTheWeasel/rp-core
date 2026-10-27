// session/fork.ts: copy the path up to `at` into a new locked session.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SESSION_CONFIG } from '../../src/session/entries.ts';
import type { EntryInput } from '../../src/session/entries.ts';
import { foldView } from '../../src/session/fold.ts';
import { forkSession, planFork } from '../../src/session/fork.ts';
import { createSessionLog, openSessionLog, readSessionFile, SessionLockedError, sessionsDir } from '../../src/session/log.ts';
import { tmpHome } from '../helpers.ts';
import { edit, head, hide, makeHeader, msg, text, TS, withVars } from './fixtures.ts';

const SRC = 's_0000a001';
const NEW = 's_0000f001';
const NOW = '2026-10-27T09:00:00.000Z';

/** g → u1 → a1 → u2 → a2, with a swipe a1b under u1, config patches, mem rows and turn noise. */
function seedSource(home: string) {
  const log = createSessionLog(home, makeHeader(SRC, { vars0: { day: 1 } }));
  const add = (e: EntryInput) => log.append(e);
  add(msg('g0000001', null, 'assistant', 'Hello.', { gen: { kind: 'greeting' } }));
  add({ t: 'config', ts: TS, patch: { preset: 'p2', director: { enabled: true } } } as EntryInput);
  add(msg('u0000001', 'g0000001', 'user', 'Hi'));
  add({ t: 'turn', ts: TS, turn: 't_1', kind: 'reply', parent: 'u0000001', msgId: 'a0000001', seed: 1, now: TS, base: 3 } as EntryInput);
  add({ t: 'chk', turn: 't_1', text: 'firs' } as EntryInput);
  add(msg('a0000001', 'u0000001', 'assistant', 'first', { ...withVars({ hp: 10 }), turn: 't_1' }));
  add(msg('a000001b', 'u0000001', 'assistant', 'swiped', withVars({ hp: 1 })));
  add(head('a0000001'));
  add({ t: 'mem', ts: TS, key: 'file:a0000001', on: 'a0000001', by: 'filing', ops: [], row: 1 });
  add({ t: 'mem', ts: TS, key: 'file:a000001b', on: 'a000001b', by: 'filing', ops: [], row: 2 });
  add({ t: 'mem', ts: TS, key: null, on: null, by: 'user', ops: [{ op: 'note', title: 'Lamp', keys: ['lamp'], content: 'It flickers.' }], row: 3 });
  add(edit('a0000001', 'first (edited)', { vars: { mood: 'ok' } }));
  add(hide('u0000001'));
  add(msg('u0000002', 'a0000001', 'user', 'More'));
  add(msg('a0000002', 'u0000002', 'assistant', 'second', withVars({ hp: 7 })));
  add({ t: 'config', ts: TS, patch: { lorebooks: ['world'] } } as EntryInput);
  add({ t: 'end', ts: TS, turn: 't_9', outcome: 'abandoned' } as EntryInput);
  add(hide('a000001b')); // off-path hide: not copied
  log.close();
  return readSessionFile(home, SRC);
}

describe('forkSession', () => {
  test('copies the path up to `at`, renumbers seq, keeps ids, folds config and vars into the header', () => {
    const home = tmpHome();
    const source = seedSource(home);
    const forked = forkSession(home, source, 'a0000001', { newId: NEW, now: NOW });

    const h = forked.header;
    expect(h.id).toBe(NEW);
    expect(h.created).toBe(NOW);
    expect(h.fork).toEqual({ from: SRC, at: 'a0000001' });
    expect(h.cast).toEqual(source.header.cast);
    expect(h.title).toBe(source.header.title!);
    expect(h.config.preset).toBe('p2');
    expect(h.config.lorebooks).toEqual(['world']);
    expect(h.config.director).toEqual({ ...DEFAULT_SESSION_CONFIG.director, enabled: true });
    // vars0 is the source's; the copied path diffs (hp, mood) re-apply on top of it.
    expect(h.vars0).toEqual({ day: 1 });

    const es = forked.entries();
    expect(es.map((e) => e.seq)).toEqual(es.map((_, i) => i + 1));
    expect(es.map((e) => [e.t, 'id' in e ? e.id : 'target' in e ? e.target : 'on' in e ? e.on : null])).toEqual([
      ['msg', 'g0000001'],
      ['msg', 'u0000001'],
      ['msg', 'a0000001'],
      ['mem', 'a0000001'],
      ['mem', null],
      ['edit', 'a0000001'],
      ['hide', 'u0000001'],
    ]);
    // The last copied msg is `at`, so no head entry is needed.
    expect(es.some((e) => e.t === 'head')).toBe(false);

    // The fork's view equals the source's view at `at` (and vars agree thanks to idempotent diffs).
    const srcAtAt = foldView(source.header, [...source.entries, { t: 'head', seq: 1000, ts: TS, leaf: 'a0000001' }]);
    const forkView = foldView(forked.header, forked.entries());
    expect(forkView.path).toEqual(srcAtAt.path.map((m) => ({ ...m, swipe: { index: 0, count: 1 } })));
    expect(forkView.vars).toEqual(srcAtAt.vars);
    expect(forkView.head).toBe('a0000001');
    expect(forkView.path[2]!.blocks).toEqual(text('first (edited)'));
    // The global note row came along: the fork folds the same notes as the source at `at`.
    expect([...forkView.compendium.entries.keys()]).toEqual(['note:lamp']);
    expect([...forkView.compendium.entries.values()]).toEqual([...srcAtAt.compendium.entries.values()].map((e) => ({ ...e, prov: { ...e.prov, lastSeq: expect.any(Number), createdSeq: expect.any(Number) } })));

    // The new log is locked and appendable; the temp file is gone.
    expect(() => openSessionLog(home, NEW)).toThrow(SessionLockedError);
    expect(forked.append(msg('u0000009', 'a0000001', 'user')).seq).toBe(es.length + 1);
    forked.close();
    expect(readdirSync(sessionsDir(home)).filter((n) => n.includes('tmp'))).toEqual([]);
    expect(readFileSync(join(sessionsDir(home), `${NEW}.jsonl`), 'utf8').split('\n')[0]).toContain('"fork":{"from":"s_0000a001","at":"a0000001"}');
  });

  test('forking at an earlier message: the newer siblings and the continuation stay behind', () => {
    const home = tmpHome();
    const source = seedSource(home);
    const plan = planFork(source, 'u0000001', { newId: NEW, now: NOW });
    expect(plan.entries.filter((e) => e.t === 'msg').map((e) => (e as { id: string }).id)).toEqual(['g0000001', 'u0000001']);
    expect(plan.header.vars0).toEqual({ day: 1 });
    expect(plan.entries.some((e) => e.t === 'edit')).toBe(false);
  });

  test('a fork of a fork: lineage in the header, vars0 and config carried along', () => {
    const home = tmpHome();
    const source = seedSource(home);
    forkSession(home, source, 'a0000002', { newId: NEW, now: NOW }).close();
    const first = readSessionFile(home, NEW);
    const second = forkSession(home, first, 'u0000002', { newId: 's_0000f002', now: NOW });
    expect(second.header.fork).toEqual({ from: NEW, at: 'u0000002' });
    expect(second.header.config.lorebooks).toEqual(['world']);
    expect(second.header.vars0).toEqual({ day: 1 });
    expect(foldView(second.header, second.entries()).vars).toEqual({ day: 1, hp: 10, mood: 'ok' });
    expect(foldView(second.header, second.entries()).path.map((m) => m.id)).toEqual([
      'g0000001',
      'u0000001',
      'a0000001',
      'u0000002',
    ]);
    second.close();
  });

  test('a rewind inside the fork sees only the vars set up to that message', () => {
    const home = tmpHome();
    const source = seedSource(home);
    const forked = forkSession(home, source, 'a0000002', { newId: NEW, now: NOW });
    expect(foldView(forked.header, forked.entries()).vars).toEqual({ day: 1, hp: 7, mood: 'ok' });
    // Back to u0000001: hp and mood were first set later on the path, so they must not show.
    forked.append(head('u0000001'));
    expect(foldView(forked.header, forked.entries()).vars).toEqual({ day: 1 });
    forked.close();
  });

  test('a tail commit on the forked path loses its tail flag: the fork head is `at`', () => {
    const home = tmpHome();
    const log = createSessionLog(home, makeHeader(SRC));
    log.append(msg('g0000001', null, 'assistant', 'Hello.', { gen: { kind: 'greeting' } }));
    log.append(msg('g0000002', null, 'assistant', 'Other.', { gen: { kind: 'greeting' } }));
    log.append(head('g0000001'));
    log.append(msg('u0000001', 'g0000001', 'user', 'Hi'));
    log.append(head('g0000002'));
    log.append(msg('a0000001', 'u0000001', 'assistant', 'late', { tail: true }));
    log.close();
    const plan = planFork(readSessionFile(home, SRC), 'a0000001', { newId: NEW, now: NOW });
    const copied = plan.entries.find((e) => e.t === 'msg' && e.id === 'a0000001')!;
    expect('tail' in copied).toBe(false);
    const fork = forkSession(home, readSessionFile(home, SRC), 'a0000001', { newId: NEW, now: NOW });
    expect(foldView(fork.header, fork.entries()).head).toBe('a0000001');
    fork.close();
    expect(readdirSync(sessionsDir(home)).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  test('refuses an unknown `at`, an existing id and an invalid id', () => {
    const home = tmpHome();
    const source = seedSource(home);
    expect(() => forkSession(home, source, 'nope0000', { newId: NEW, now: NOW })).toThrow(/not a message/);
    expect(() => forkSession(home, source, 'a0000001', { newId: SRC, now: NOW })).toThrow(/already exists/);
    expect(() => forkSession(home, source, 'a0000001', { newId: '../x', now: NOW })).toThrow(/invalid session id/);
    expect(existsSync(join(sessionsDir(home), `${NEW}.jsonl`))).toBe(false);
  });
});
