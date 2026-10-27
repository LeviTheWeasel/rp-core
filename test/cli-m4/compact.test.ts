// `rp-core compact <session> [--json]` (D-114, D-35): open (recovery runs), close, then rewrite the
// journal under the lock without the chk and prep rows of closed turns; every other line byte for
// byte, seq numbers and versions kept, the fold unchanged, later turns fine; refusals (turn_open,
// session_locked) exit 5. The library half (session/log.ts compactSessionLog) is tested directly too.
import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, copyFileSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { directorAt } from '../../src/agents/director/state.ts';
import { main } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/io.ts';
import { Engine } from '../../src/engine/engine.ts';
import type { Connection, EngineHandle } from '../../src/engine/api.ts';
import { createScriptedProvider, SCRIPT_CAPS, type ScriptCall } from '../../src/providers/scripted.ts';
import type { Entry, Trace } from '../../src/session/entries.ts';
import { currentConfig, foldView } from '../../src/session/fold.ts';
import { compactSessionLog, listSessions, openSessionLog, readLock, readSessionFile, SessionLockedError, TurnOpenError, type SessionLog } from '../../src/session/log.ts';
import { buildTree } from '../../src/session/tree.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { calls, LEVI, MIRA, writeRaw } from '../repl/kit.ts';
import { run } from '../cli/kit.ts';
import { msgInput, recordFor, richState, traceWith } from './fixtures.ts';

const engines: EngineHandle[] = [];
afterAll(async () => {
  for (const e of engines) await e.close().catch(() => {});
});

function memIo(): Io & { stdout(): string; stderr(): string } {
  let out = '';
  let err = '';
  return {
    out: { write: (t) => void (out += t), flush: async () => {} },
    err: { write: (t) => void (err += t), flush: async () => {} },
    stdout: () => out,
    stderr: () => err,
  };
}

/** rp-core in this process: exit code and both channels. */
async function cli(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const io = memIo();
  const code = await main([...args, '--home', home], { io, env: {}, exit: () => {}, clock: fakeClock() });
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

async function engineWith(home: string, script: ScriptCall[]): Promise<EngineHandle> {
  const provider = createScriptedProvider(script);
  const conn: Connection = { id: 'script', provider, caps: SCRIPT_CAPS, origin: 'script:script', local: true };
  const e = await Engine.open({ home, connections: { script: conn }, clock: fakeClock(), random: fakeRandom(5), timeZone: 'UTC', checkpoint: { chars: 8, ms: 5, datasyncMs: 5 } });
  engines.push(e);
  return e;
}

const LONG = 'The lamp flickers while the rain keeps drumming on the shutters of the old lighthouse.';

/** A session with closed turns that left chk and prep rows: two replies, a swipe, a continue. */
async function playedSession(): Promise<{ home: string; id: string }> {
  const home = tmpHome('rp-core-compact-');
  const e = await engineWith(home, calls([{ text: LONG }], [{ text: `${LONG} Again.` }], [{ text: ` ${LONG}` }], [{ text: `Yes. ${LONG}` }]));
  const s = e.createSession({ character: MIRA, persona: LEVI });
  for (const t of [
    () => s.submit({ text: 'Tell me about the lighthouse.', expectedVersion: s.version() }),
    () => s.runTurn({ kind: 'swipe', expectedVersion: s.version() }),
    () => s.runTurn({ kind: 'continue', expectedVersion: s.version() }),
    () => s.submit({ text: 'And the keeper?', expectedVersion: s.version() }),
  ]) {
    const h = t();
    for await (const _ of h.events) void _;
    expect((await h.result).type).toBe('done');
  }
  const id = s.id;
  await s.close();
  return { home, id };
}

const file = (home: string, id: string): string => join(home, 'sessions', `${id}.jsonl`);
const bytes = (home: string, id: string): Buffer => readFileSync(file(home, id));
const lines = (home: string, id: string): string[] => bytes(home, id).toString('utf8').split('\n').filter((l) => l !== '');
const kindOf = (line: string): string => (JSON.parse(line) as { t: string }).t;
/** The fold a session opens to: the view, its version, the config. */
function foldOf(home: string, id: string): { view: unknown; version: number; config: unknown; entries: number } {
  const { header, entries } = readSessionFile(home, id);
  const view = foldView(header, entries);
  return { view, version: view.version, config: currentConfig(header, entries), entries: entries.length };
}

describe('rp-core compact', () => {
  test('drops the chk and prep rows of closed turns; every other line byte for byte; the fold is the same', async () => {
    const { home, id } = await playedSession();
    const before = lines(home, id);
    const size = bytes(home, id).length;
    const dropped = before.filter((l, i) => i > 0 && (kindOf(l) === 'chk' || kindOf(l) === 'prep'));
    expect(dropped.filter((l) => kindOf(l) === 'prep')).toHaveLength(4);
    expect(dropped.filter((l) => kindOf(l) === 'chk').length).toBeGreaterThanOrEqual(4);
    const foldBefore = foldOf(home, id);

    const r = await cli(['compact', id], home);
    expect(r.code).toBe(0);
    const after = bytes(home, id).length;
    expect(r.stdout).toBe(`compacted ${id}: ${size} → ${after} bytes (${dropped.length} lines removed)\n`);
    expect(after).toBeLessThan(size);
    // Exactly the other lines, in order and unchanged (seq numbers included).
    expect(lines(home, id)).toEqual(before.filter((l) => !dropped.includes(l)));
    const foldAfter = foldOf(home, id);
    expect(foldAfter.view).toEqual(foldBefore.view);
    expect(foldAfter.version).toBe(foldBefore.version);
    expect(foldAfter.config).toEqual(foldBefore.config);
    expect(foldAfter.entries).toBe(foldBefore.entries - dropped.length);
    // No temp file is left behind; the lock is released.
    expect(readdirSync(join(home, 'sessions')).sort()).toEqual([`${id}.jsonl`]);
  });

  test('idempotent: a second run removes nothing and leaves the file untouched', async () => {
    const { home, id } = await playedSession();
    expect((await cli(['compact', id], home)).code).toBe(0);
    const once = bytes(home, id);
    const mtime = statSync(file(home, id)).mtimeMs;
    const again = await cli(['compact', id, '--json'], home);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual({ sessionId: id, before: once.length, after: once.length, removed: 0 });
    expect(bytes(home, id).equals(once)).toBe(true);
    expect(statSync(file(home, id)).mtimeMs).toBe(mtime);
  });

  test('--json: {sessionId, before, after, removed}', async () => {
    const { home, id } = await playedSession();
    const size = bytes(home, id).length;
    const r = await cli(['compact', id, '--json'], home);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { sessionId: string; before: number; after: number; removed: number };
    expect(out).toEqual({ sessionId: id, before: size, after: bytes(home, id).length, removed: out.removed });
    expect(out.removed).toBeGreaterThan(0);
  });

  test('a compacted session opens and a later turn works (versions go on from the same number)', async () => {
    const { home, id } = await playedSession();
    const v = foldOf(home, id).version;
    expect((await cli(['compact', id], home)).code).toBe(0);
    const e = await engineWith(home, calls([{ text: 'Later on, the keeper speaks at last.' }]));
    const s = e.session(id);
    expect(s.openEvents()).toEqual([]);
    expect(s.version()).toBe(v);
    const h = s.submit({ text: 'Go on.', expectedVersion: s.version() });
    for await (const _ of h.events) void _;
    const out = await h.result;
    expect(out.type).toBe('done');
    expect(s.version()).toBeGreaterThan(v);
    await s.close();
    // The new turn's rows go the next time.
    const r = await cli(['compact', id, '--json'], home);
    expect((JSON.parse(r.stdout) as { removed: number }).removed).toBeGreaterThanOrEqual(2);
    expect(lines(home, id).some((l) => kindOf(l) === 'chk' || kindOf(l) === 'prep')).toBe(false);
  });

  test('a session with no chk or prep rows (only its greetings) is left as it is', async () => {
    const home = tmpHome('rp-core-compact-');
    const e = await engineWith(home, calls());
    const s = e.createSession({ character: MIRA, persona: LEVI });
    const id = s.id;
    await s.close();
    const b = bytes(home, id);
    const r = await cli(['compact', id], home);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`compacted ${id}: ${b.length} → ${b.length} bytes (nothing to remove)\n`);
    expect(bytes(home, id).equals(b)).toBe(true);
  });

  test('recovery runs first: an interrupted turn is committed, then its chk and prep rows go; msg.dir stays', async () => {
    const home = tmpHome('rp-core-compact-');
    const e = await engineWith(home, calls());
    const s = e.createSession({ character: MIRA, persona: LEVI });
    const sent = s.send({ text: 'Tell me.', expectedVersion: s.version() });
    const id = s.id;
    await s.close();
    const state = richState();
    const ts = '2026-10-26T12:00:00.000Z';
    writeRaw(home, id, (log) => {
      log.append({ t: 'turn', ts, turn: 't_crash01', kind: 'reply', parent: sent.messageId, msgId: 'abcdef01', seed: 1, now: ts, base: sent.version });
      log.append({ t: 'prep', turn: 't_crash01', trace: traceWith([]), dir: recordFor(state) as unknown as Record<string, unknown> });
      log.append({ t: 'chk', turn: 't_crash01', text: 'She begins to ' }, { durable: false });
    });
    const r = await cli(['compact', id], home);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('rp-core: recovered an interrupted turn (t_crash01): its partial answer was saved, marked [interrupted]');
    expect(r.stdout).toContain('(2 lines removed)');
    const { entries } = readSessionFile(home, id);
    expect(entries.some((x) => x.t === 'prep' || x.t === 'chk')).toBe(false);
    const committed = entries.find((x): x is Extract<Entry, { t: 'msg' }> => x.t === 'msg' && x.id === 'abcdef01');
    expect(committed?.dir).toBeDefined();
    // The Director's state at the head is the recovered reply's, as before the rewrite.
    const at = directorAt(buildTree(entries), 'abcdef01');
    expect(at.state.turn).toBe(40);
    expect(at.from).toBe('abcdef01');
  });

  test('turn_open: an answer held by a conflict is left open by recovery, so compact refuses (exit 5) and writes nothing', async () => {
    const home = tmpHome('rp-core-compact-');
    const e = await engineWith(home, calls());
    const s = e.createSession({ character: MIRA, persona: LEVI });
    const sent = s.send({ text: 'Tell me.', expectedVersion: s.version() });
    const id = s.id;
    await s.close();
    const ts = '2026-10-26T12:00:00.000Z';
    writeRaw(home, id, (log) => {
      log.append({ t: 'turn', ts, turn: 't_held001', kind: 'reply', parent: sent.messageId, msgId: 'abcdef02', seed: 1, now: ts, base: sent.version });
      log.append({ t: 'prep', turn: 't_held001', trace: traceWith([]) });
      log.append({ t: 'held', turn: 't_held001', body: { blocks: [{ k: 'text', text: 'Held answer.' }] } });
    });
    const b = bytes(home, id);
    const r = await cli(['compact', id], home);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('rp-core: refused (turn_open): session');
    expect(r.stderr).toContain('t_held001');
    const last = r.stderr.trimEnd().split('\n').at(-1)!;
    expect(JSON.parse(last)).toMatchObject({ type: 'refusal', code: 'turn_open' });
    expect(bytes(home, id).equals(b)).toBe(true);
    // --json: only the machine line.
    const j = await cli(['compact', id, '--json'], home);
    expect(j.code).toBe(5);
    expect(j.stdout).toBe('');
    expect(JSON.parse(j.stderr.trim())).toMatchObject({ type: 'refusal', code: 'turn_open' });
  });

  test('session_locked: another holder of the lock → exit 5; an unknown session → session_not_found', async () => {
    const { home, id } = await playedSession();
    const e = await engineWith(home, calls());
    const s = e.session(id);
    const b = bytes(home, id);
    const r = await cli(['compact', id], home);
    expect(r.code).toBe(5);
    expect(JSON.parse(r.stderr.trimEnd().split('\n').at(-1)!)).toMatchObject({ type: 'refusal', code: 'session_locked' });
    expect(r.stderr).toContain('rp-core: hint: another rp-core process has this session open');
    expect(bytes(home, id).equals(b)).toBe(true);
    await s.close();
    const missing = await cli(['compact', 's_00000000'], home);
    expect(missing.code).toBe(5);
    expect(JSON.parse(missing.stderr.trimEnd().split('\n').at(-1)!)).toMatchObject({ type: 'refusal', code: 'session_not_found' });
  });

  test('as a process: exit 0 and the line on stdout', async () => {
    const { home, id } = await playedSession();
    const r = await run(['compact', id, '--home', home]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^compacted ${id}: \\d+ → \\d+ bytes \\(\\d+ lines removed\\)\\n$`));
    expect(r.stderr).toBe('');
  }, 30_000);

  test('usage: the session is required; help names the command', async () => {
    const home = tmpHome('rp-core-compact-');
    const r = await cli(['compact'], home);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('usage: rp-core compact <session> [--json]');
    const h = await cli(['help', 'compact'], home);
    expect(h.stdout).toContain('Usage: rp-core compact <session> [--json]');
    expect(h.stdout).toContain('turn_open');
    expect((await cli(['--help'], home)).stdout).toMatch(/\n {2}compact +shrink a session's journal/);
  });
});

describe('compactSessionLog (session/log.ts)', () => {
  const ts = '2026-10-26T12:00:00.000Z';
  const trace: Trace = traceWith([]);

  /** A greeting-only session written by the engine, then raw rows. */
  async function raw(fn: Parameters<typeof writeRaw>[2]): Promise<{ home: string; id: string; parent: string }> {
    const home = tmpHome('rp-core-compact-');
    const e = await engineWith(home, calls());
    const s = e.createSession({ character: MIRA, persona: LEVI });
    const parent = s.view().head!;
    const id = s.id;
    await s.close();
    writeRaw(home, id, fn);
    return { home, id, parent };
  }

  test('a turn closed by `end` (failed) loses its prep and chk; turn and end stay', async () => {
    const { home, id } = await raw((log) => {
      log.append({ t: 'turn', ts, turn: 't_1', kind: 'continue', parent: 'x', target: 'y', msgId: 'y', seed: 1, now: ts, base: 1 });
      log.append({ t: 'prep', turn: 't_1', trace });
      log.append({ t: 'chk', turn: 't_1', text: 'abc' }, { durable: false });
      log.append({ t: 'end', ts, turn: 't_1', outcome: 'failed', code: 'server' });
    });
    const r = compactSessionLog(home, id);
    expect(r.removed).toBe(2);
    expect(lines(home, id).slice(1).map(kindOf).filter((k) => k !== 'msg' && k !== 'head')).toEqual(['turn', 'end']);
    expect(r.after).toBe(bytes(home, id).length);
  });

  test('an open turn (no closing row) refuses with TurnOpenError; nothing is written; the lock is released', async () => {
    const { home, id } = await raw((log) => {
      log.append({ t: 'turn', ts, turn: 't_open', kind: 'reply', parent: 'x', msgId: 'z', seed: 1, now: ts, base: 1 });
      log.append({ t: 'chk', turn: 't_open', text: 'abc' }, { durable: false });
    });
    const b = bytes(home, id);
    expect(() => compactSessionLog(home, id)).toThrow(TurnOpenError);
    expect(bytes(home, id).equals(b)).toBe(true);
    // Released: the engine can open (and recover) it now.
    const e = await engineWith(home, calls());
    const s = e.session(id);
    await s.close();
    expect(compactSessionLog(home, id).removed).toBe(1);
  });

  test('chk/prep rows whose turn has no turn row, and lines the reader skips, are kept byte for byte', async () => {
    const { home, id } = await raw((log) => {
      log.append({ t: 'chk', turn: 't_orphan', text: 'orphan' }, { durable: false });
      log.append({ t: 'turn', ts, turn: 't_2', kind: 'reply', parent: 'x', msgId: 'q', seed: 1, now: ts, base: 1 });
      log.append({ t: 'prep', turn: 't_2', trace });
    });
    // A damaged middle line (the reader skips it with bad_line), then the closing row (seq 7).
    appendFileSync(file(home, id), `{"t":"chk","oops"\n${JSON.stringify({ t: 'end', seq: 7, ts, turn: 't_2', outcome: 'abandoned' })}\n`);
    const before = lines(home, id);
    const r = compactSessionLog(home, id);
    expect(r.removed).toBe(1);
    expect(lines(home, id)).toEqual(before.filter((l) => !(l.includes('"t":"prep"') && l.includes('t_2'))));
    expect(lines(home, id)).toContain('{"t":"chk","oops"');
  });

  test('a torn last line is refused (an open repairs it first)', async () => {
    const { home, id } = await raw((log) => {
      log.append({ t: 'turn', ts, turn: 't_3', kind: 'reply', parent: 'x', msgId: 'q', seed: 1, now: ts, base: 1 });
      log.append({ t: 'end', ts, turn: 't_3', outcome: 'abandoned' });
    });
    appendFileSync(file(home, id), '{"t":"chk","turn":"t_3"');
    expect(() => compactSessionLog(home, id)).toThrow(/torn or invalid line/);
  });

  test('a live lock elsewhere: SessionLockedError', async () => {
    const { home, id } = await raw(() => {});
    const e = await engineWith(home, calls());
    const s = e.session(id);
    expect(() => compactSessionLog(home, id)).toThrow(SessionLockedError);
    await s.close();
  });
});

// ---- D-124 hardening ----------------------------------------------------------------------------------

describe('compact hardening (D-124)', () => {
  const ts = '2026-10-26T12:00:00.000Z';
  const tmpName = (id: string): string => `.${id}.${process.pid}.compact.tmp`;
  const sessionFiles = (home: string): string[] => readdirSync(join(home, 'sessions')).sort();

  /** The answer in three chunks, a pause between them: three checkpoints (chk rows). */
  const STREAMED = [{ text: 'The lamp flickers. ' }, { delay: 10 }, { text: 'The rain keeps drumming. ' }, { delay: 10 }, { text: 'The keeper sleeps.' }];

  /** Sessions in one home, one reply each (turn, prep, chk… and the commit); the last one is the newest. */
  async function replies(n: number): Promise<{ home: string; ids: string[]; heads: string[] }> {
    const home = tmpHome('rp-core-compact-');
    const e = await engineWith(home, Array.from({ length: n }, () => ({ steps: STREAMED })));
    const ids: string[] = [];
    const heads: string[] = [];
    for (let i = 0; i < n; i++) {
      const s = e.createSession({ character: MIRA, persona: LEVI });
      const h = s.submit({ text: 'Tell me about the lighthouse.', expectedVersion: s.version() });
      for await (const _ of h.events) void _;
      expect((await h.result).type).toBe('done');
      ids.push(s.id);
      heads.push(s.view().head!);
      await s.close();
    }
    return { home, ids, heads };
  }

  async function oneReply(): Promise<{ home: string; id: string; head: string }> {
    const { home, ids, heads } = await replies(1);
    return { home, id: ids[0]!, head: heads[0]! };
  }

  /** Another process steals the stale lock: lockTtlMs 0 judges compact's lock stale once 1 ms has passed. */
  function thief(home: string, id: string): SessionLog {
    Bun.sleepSync(5);
    return openSessionLog(home, id, { lockTtlMs: 0, lockRenewMs: 0, pid: 4242 }).log;
  }

  describe('re-check before the rename', () => {
    test('another process appends between the read and the rename → session_locked; its line survives; no temp file', async () => {
      const { home, id, head } = await oneReply();
      const r = (() => {
        try {
          return compactSessionLog(home, id, undefined, {
            beforeRename: () => {
              const log = thief(home, id);
              log.append(msgInput('deadbeef', head, 'user', 'Written by the other process.'));
              log.close();
            },
          });
        } catch (e) {
          return e;
        }
      })();
      expect(r).toBeInstanceOf(SessionLockedError);
      expect((r as Error).message).toContain('changed while it was being compacted');
      const { entries } = readSessionFile(home, id);
      expect(entries.some((x) => x.t === 'msg' && x.id === 'deadbeef')).toBe(true);
      // Nothing was compacted: the rows are all still there; no temp file, no lock left behind.
      expect(entries.some((x) => x.t === 'chk')).toBe(true);
      expect(sessionFiles(home)).toEqual([`${id}.jsonl`]);
    });

    test('the lock was taken (the taker still holds it) → session_locked naming it; the journal and its lock stay', async () => {
      const { home, id } = await oneReply();
      const b = bytes(home, id);
      let other: SessionLog | null = null;
      expect(() =>
        compactSessionLog(home, id, undefined, {
          beforeRename: () => {
            other = thief(home, id);
          },
        }),
      ).toThrow(/taken over while it was being compacted \(locked by pid 4242 on /);
      expect(bytes(home, id).equals(b)).toBe(true);
      // compact did not release the other process's lock.
      expect(readLock(home, id)?.pid).toBe(4242);
      expect(sessionFiles(home)).toEqual([`${id}.jsonl`, `${id}.lock`]);
      (other as SessionLog | null)?.close();
    });

    test('the lock was taken and given back without a write → still refused (the lock is not ours any more)', async () => {
      const { home, id } = await oneReply();
      const b = bytes(home, id);
      expect(() => compactSessionLog(home, id, undefined, { beforeRename: () => thief(home, id).close() })).toThrow(/lost its lock while it was being compacted/);
      expect(bytes(home, id).equals(b)).toBe(true);
      expect(sessionFiles(home)).toEqual([`${id}.jsonl`]);
    });

    test('the journal was replaced by another file with the same bytes (new inode) → refused', async () => {
      const { home, id } = await oneReply();
      const b = bytes(home, id);
      let ino = 0;
      expect(() =>
        compactSessionLog(home, id, undefined, {
          beforeRename: () => {
            const copy = join(home, 'sessions', 'copy.tmp');
            copyFileSync(file(home, id), copy);
            renameSync(copy, file(home, id));
            ino = statSync(file(home, id)).ino;
          },
        }),
      ).toThrow(SessionLockedError);
      expect(statSync(file(home, id)).ino).toBe(ino);
      expect(bytes(home, id).equals(b)).toBe(true);
    });

    test('nothing interferes → the rewrite goes through (the seam runs once, before the rename)', async () => {
      const { home, id } = await oneReply();
      let seen = 0;
      const r = compactSessionLog(home, id, undefined, { beforeRename: () => void seen++ });
      expect(seen).toBe(1);
      expect(r.removed).toBeGreaterThanOrEqual(2);
      expect(r.kept).toBeUndefined();
    });
  });

  describe('the reader accepts the same lines after the rewrite', () => {
    /** Insert a parsed line with a non-increasing seq right after the last chk row (a sync conflict, a merge). */
    function strayAfterLastChk(home: string, id: string, seqOf: (rows: { t: string; seq: number }[]) => number): string {
      const all = bytes(home, id).toString('utf8').split('\n');
      const rows = all.map((l) => (l ? (JSON.parse(l) as { t: string; seq: number; role?: string; id?: string }) : null));
      const iChk = rows.findLastIndex((x) => x?.t === 'chk');
      const user = rows.find((x) => x?.t === 'msg' && x.role === 'user')!;
      const stray = JSON.stringify({ t: 'hide', seq: seqOf(rows.slice(1).filter((x) => x !== null) as { t: string; seq: number }[]), ts, target: user.id, hidden: true });
      all.splice(iChk + 1, 0, stray);
      writeFileSync(file(home, id), all.join('\n'));
      return stray;
    }

    test('a skipped line (seq not increasing) right after the dropped chk rows stays skipped: the newest of them is kept', async () => {
      const { home, id } = await oneReply();
      const stray = strayAfterLastChk(home, id, (rows) => rows.findLast((x) => x.t === 'chk')!.seq);
      const before = readSessionFile(home, id);
      expect(before.notices.some((n) => n.code === 'bad_line' && n.message.includes('does not follow'))).toBe(true);
      const droppable = lines(home, id).filter((l) => kindOf(l) === 'chk' || kindOf(l) === 'prep');
      const foldBefore = foldOf(home, id);
      const lastChk = lines(home, id).findLast((l) => kindOf(l) === 'chk')!;

      const r = await cli(['compact', id, '--json'], home);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { removed: number; kept?: number };
      expect(out.kept).toBe(1);
      expect(out.removed).toBe(droppable.length - 1);
      // The fold (the user message is NOT hidden) and the skipped line are unchanged.
      const foldAfter = foldOf(home, id);
      expect(foldAfter.view).toEqual(foldBefore.view);
      expect(foldAfter.version).toBe(foldBefore.version);
      expect(lines(home, id)).toContain(stray);
      expect(lines(home, id)).toContain(lastChk);
      expect(readSessionFile(home, id).notices.filter((n) => n.code === 'bad_line')).toHaveLength(1);
      // Text mode says so; a second run keeps the row again and writes nothing.
      const b = bytes(home, id);
      const again = await cli(['compact', id], home);
      expect(again.stdout).toBe(`compacted ${id}: ${b.length} → ${b.length} bytes (nothing to remove; 1 kept: removing it would change the lines the reader accepts)\n`);
      expect(bytes(home, id).equals(b)).toBe(true);
    });

    test('a skipped line shielded by an older chk row: only the newest dropped row before it stays', async () => {
      const { home, id } = await oneReply();
      const chks = lines(home, id).filter((l) => kindOf(l) === 'chk');
      expect(chks.length).toBeGreaterThanOrEqual(2);
      strayAfterLastChk(home, id, (rows) => rows.find((x) => x.t === 'chk')!.seq);
      const foldBefore = foldOf(home, id);
      const r = compactSessionLog(home, id);
      expect(r.kept).toBe(1);
      expect(foldOf(home, id).view).toEqual(foldBefore.view);
      expect(lines(home, id).filter((l) => kindOf(l) === 'chk')).toEqual([chks.at(-1)!]);
    });

    test('a skipped line already shielded by a row that stays (the turn row) costs nothing', async () => {
      const { home, id } = await oneReply();
      strayAfterLastChk(home, id, (rows) => rows.find((x) => x.t === 'turn')!.seq);
      const foldBefore = foldOf(home, id);
      const r = compactSessionLog(home, id);
      expect(r.kept).toBeUndefined();
      expect(foldOf(home, id).view).toEqual(foldBefore.view);
      expect(lines(home, id).some((l) => kindOf(l) === 'chk' || kindOf(l) === 'prep')).toBe(false);
    });

    test('the file never ends in a broken line: a dropped last row after one stays', async () => {
      const home = tmpHome('rp-core-compact-');
      const e = await engineWith(home, calls());
      const s = e.createSession({ character: MIRA, persona: LEVI });
      const id = s.id;
      await s.close();
      writeRaw(home, id, (log) => {
        log.append({ t: 'turn', ts, turn: 't_9', kind: 'reply', parent: 'x', msgId: 'q', seed: 1, now: ts, base: 1 });
        log.append({ t: 'prep', turn: 't_9', trace: traceWith([]) });
        log.append({ t: 'end', ts, turn: 't_9', outcome: 'abandoned' });
      });
      const seq = readSessionFile(home, id).entries.at(-1)!.seq + 1;
      appendFileSync(file(home, id), `{"t":"chk","oops"\n${JSON.stringify({ t: 'chk', seq, turn: 't_9', text: 'late' })}\n`);
      const r = compactSessionLog(home, id);
      expect(r).toMatchObject({ removed: 1, kept: 1 });
      const after = readSessionFile(home, id);
      expect(after.notices.map((n) => n.code)).toEqual(['bad_line']);
      expect(after.entries.at(-1)).toMatchObject({ t: 'chk', seq });
    });
  });

  describe('the new file keeps the journal\'s mode and times', () => {
    test('a journal restricted to 0600 stays 0600; the temp file has the mode before the rename', async () => {
      const { home, id } = await oneReply();
      chmodSync(file(home, id), 0o600);
      let tmpMode = -1;
      const r = compactSessionLog(home, id, undefined, { beforeRename: () => void (tmpMode = statSync(join(home, 'sessions', tmpName(id))).mode & 0o7777) });
      expect(r.removed).toBeGreaterThan(0);
      expect(tmpMode).toBe(0o600);
      expect(statSync(file(home, id)).mode & 0o7777).toBe(0o600);
    });

    test('a 0640 journal stays 0640 (not what the umask would give a new file), also through the CLI', async () => {
      const { home, id } = await oneReply();
      chmodSync(file(home, id), 0o640);
      const r = await cli(['compact', id], home);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('lines removed');
      expect(statSync(file(home, id)).mode & 0o7777).toBe(0o640);
    });

    test('the journal keeps its mtime: `sessions` keeps its order and its "updated" time', async () => {
      const { home, ids } = await replies(2);
      const [id, other] = ids as [string, string];
      const old = new Date('2026-01-01T00:00:00.000Z');
      utimesSync(file(home, id), old, old);
      const listBefore = listSessions(home);
      expect(listBefore.map((x) => x.id)).toEqual([other, id]);
      const r = await cli(['compact', id], home);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('lines removed');
      expect(statSync(file(home, id)).mtimeMs).toBe(old.getTime());
      expect(listSessions(home)).toEqual(listBefore);
    });
  });

  describe('recovery output and a draft set aside', () => {
    /** An interrupted reply whose message was hidden meanwhile: recovery ends it `dropped` with the draft. */
    async function droppedDraft(): Promise<{ home: string; id: string }> {
      const home = tmpHome('rp-core-compact-');
      const e = await engineWith(home, calls());
      const s = e.createSession({ character: MIRA, persona: LEVI });
      const sent = s.send({ text: 'Tell me.', expectedVersion: s.version() });
      const id = s.id;
      await s.close();
      writeRaw(home, id, (log) => {
        log.append({ t: 'turn', ts, turn: 't_draft01', kind: 'reply', parent: sent.messageId, msgId: 'abcdef03', seed: 1, now: ts, base: sent.version });
        log.append({ t: 'prep', turn: 't_draft01', trace: traceWith([]) });
        log.append({ t: 'chk', turn: 't_draft01', text: 'The only copy of this draft.' }, { durable: false });
        log.append({ t: 'hide', ts, target: sent.messageId, hidden: true });
      });
      return { home, id };
    }

    test('a recovery that set a draft aside stops compact before the rewrite (exit 5, draft_recovered); the draft comes first; the next run compacts', async () => {
      const { home, id } = await droppedDraft();
      const r = await cli(['compact', id], home);
      expect(r.code).toBe(5);
      expect(r.stdout).toBe('');
      const err = r.stderr;
      const draftAt = err.indexOf('rp-core: recovered an interrupted turn (t_draft01): the message it answered is hidden, so its partial answer was not saved:\nThe only copy of this draft.\n');
      const refusalAt = err.indexOf('rp-core: refused (draft_recovered): recovery set aside the partial answer of an interrupted turn (t_draft01)');
      expect(draftAt).toBeGreaterThanOrEqual(0);
      expect(refusalAt).toBeGreaterThan(draftAt);
      expect(err).toContain('rp-core: hint: save the draft above');
      expect(JSON.parse(err.trimEnd().split('\n').at(-1)!)).toMatchObject({ type: 'refusal', code: 'draft_recovered' });
      // The rows that hold the draft are still there; recovery closed the turn.
      const { entries } = readSessionFile(home, id);
      expect(entries.some((x) => x.t === 'chk' && x.text === 'The only copy of this draft.')).toBe(true);
      expect(entries.some((x) => x.t === 'end' && x.turn === 't_draft01' && x.outcome === 'dropped')).toBe(true);
      // Now the turn is closed and nothing is recovered: the next run removes the rows.
      const again = await cli(['compact', id], home);
      expect(again.code).toBe(0);
      expect(again.stderr).toBe('');
      expect(again.stdout).toContain('(2 lines removed)');
      expect(readSessionFile(home, id).entries.some((x) => x.t === 'chk' || x.t === 'prep')).toBe(false);
    });

    test('--json: the recovery events are JSON lines on stderr (the draft included), then the refusal; stdout stays empty', async () => {
      const { home, id } = await droppedDraft();
      const r = await cli(['compact', id, '--json'], home);
      expect(r.code).toBe(5);
      expect(r.stdout).toBe('');
      const rows = r.stderr.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ type: 'recovered', sessionId: id, turnId: 't_draft01', outcome: 'dropped', draft: 'The only copy of this draft.' });
      expect(rows[1]).toMatchObject({ type: 'refusal', code: 'draft_recovered' });
      expect(rows[1]!.message).toContain('t_draft01');
    });

    test('--json with a recovery that saved the answer: events (and a torn-tail notice) on stderr as JSON lines, one JSON object on stdout', async () => {
      const home = tmpHome('rp-core-compact-');
      const e = await engineWith(home, calls());
      const s = e.createSession({ character: MIRA, persona: LEVI });
      const sent = s.send({ text: 'Tell me.', expectedVersion: s.version() });
      const id = s.id;
      await s.close();
      writeRaw(home, id, (log) => {
        log.append({ t: 'turn', ts, turn: 't_crash02', kind: 'reply', parent: sent.messageId, msgId: 'abcdef04', seed: 1, now: ts, base: sent.version });
        log.append({ t: 'prep', turn: 't_crash02', trace: traceWith([]) });
        log.append({ t: 'chk', turn: 't_crash02', text: 'She begins to ' }, { durable: false });
      });
      appendFileSync(file(home, id), '{"t":"chk","seq":99,"turn":"t_crash02","text":"torn');
      const r = await cli(['compact', id, '--json'], home);
      expect(r.code).toBe(0);
      const out = r.stdout.split('\n').filter((l) => l !== '');
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0]!)).toMatchObject({ sessionId: id, removed: 2 });
      const events = r.stderr.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events.map((x) => x.type)).toEqual(['notice', 'recovered']);
      expect(events[0]).toMatchObject({ type: 'notice', code: 'torn_tail' });
      expect(events[1]).toMatchObject({ type: 'recovered', sessionId: id, turnId: 't_crash02', outcome: 'interrupted' });
      expect(events[1]!.draft).toBeUndefined();
    });
  });
});
