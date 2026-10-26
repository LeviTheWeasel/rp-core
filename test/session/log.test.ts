// session/log.ts: create/append/open, torn tails, bad lines, locks (exclusive, stale, renew), listing.
import { describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  createSessionLog,
  createSessionLogWith,
  FileSessionLog,
  listSessions,
  openSessionLog,
  readLock as readSessionLock,
  readSessionFile,
  SessionCorruptError,
  SessionLockedError,
  SessionNotFoundError,
  sessionsDir,
} from '../../src/session/log.ts';
import type { EntryInput } from '../../src/session/entries.ts';
import type { LockInfo } from '../../src/session/log.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { makeHeader, msg, TS } from './fixtures.ts';

const ID = 's_0000a001';
const fileOf = (home: string, id = ID) => join(sessionsDir(home), `${id}.jsonl`);
const lockOf = (home: string, id = ID) => join(sessionsDir(home), `${id}.lock`);
const tornOf = (home: string, id = ID) => join(sessionsDir(home), `${id}.torn`);
const readLock = (home: string, id = ID): LockInfo => JSON.parse(readFileSync(lockOf(home, id), 'utf8'));

/** A session with a greeting, a user message and a reply, closed. */
function seeded(home: string, id = ID): void {
  const log = createSessionLog(home, makeHeader(id));
  log.append(msg('aaaa0001', null, 'assistant', 'Hello.'));
  log.append(msg('aaaa0002', 'aaaa0001', 'user', 'Hi!'));
  log.append(msg('aaaa0003', 'aaaa0002', 'assistant', 'How can I help?'));
  log.close();
}

/** A pid that is certainly dead: a child that has already exited. */
function deadPid(): number {
  const p = Bun.spawnSync(['true']);
  return p.pid;
}

describe('create / append / reopen', () => {
  test('header line without seq, entries with seq from 1, lock taken and released', () => {
    const home = tmpHome();
    const log = createSessionLog(home, makeHeader());
    expect(log.file).toBe(fileOf(home));
    expect(existsSync(lockOf(home))).toBe(true);
    const lock = readLock(home);
    expect(lock.pid).toBe(process.pid);
    expect(lock.host).toBe(hostname());
    expect(typeof lock.started).toBe('string');
    expect(typeof lock.renewed).toBe('string');

    expect(log.lastSeq()).toBe(0);
    const a = log.append(msg('aaaa0001', null));
    const b = log.append({ t: 'chk', turn: 't_1', text: 'delta' }, { durable: false });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(log.lastSeq()).toBe(2);
    log.datasync();
    log.close();
    log.close(); // idempotent
    expect(existsSync(lockOf(home))).toBe(false);

    const lines = readFileSync(fileOf(home), 'utf8').split('\n');
    expect(lines.length).toBe(4); // header, 2 entries, trailing ''
    expect(JSON.parse(lines[0]!).seq).toBeUndefined();
    expect(lines[1]!.startsWith('{"t":"msg","seq":1,')).toBe(true);

    const { log: again, notices } = openSessionLog(home, ID);
    expect(notices).toEqual([]);
    expect(again.header).toEqual(makeHeader());
    expect(again.entries().map((e) => e.seq)).toEqual([1, 2]);
    expect(again.entries()[0]).toEqual(a as never);
    expect(again.append(msg('aaaa0002', 'aaaa0001', 'user')).seq).toBe(3);
    again.close();
  });

  test('append returns the stored copy and ignores a stray seq in the input', () => {
    const home = tmpHome();
    const log = createSessionLog(home, makeHeader());
    const input = { ...msg('aaaa0001', null), seq: 99 } as EntryInput;
    const e = log.append(input);
    expect(e.seq).toBe(1);
    expect(e).not.toBe(input);
    log.close();
  });

  test('create fails if the session exists; invalid header or id is refused before writing', () => {
    const home = tmpHome();
    seeded(home);
    expect(() => createSessionLog(home, makeHeader())).toThrow(/already exists/);
    expect(() => createSessionLog(home, makeHeader('../evil'))).toThrow(/invalid session id/);
    const bad = { ...makeHeader('s_bad00001'), config: { roles: {} } } as never;
    expect(() => createSessionLog(home, bad)).toThrow(/refusing/);
    expect(existsSync(fileOf(home, 's_bad00001'))).toBe(false);
  });

  test('an invalid entry is refused and nothing is written', () => {
    const home = tmpHome();
    const log = createSessionLog(home, makeHeader());
    log.append(msg('aaaa0001', null));
    const size = statSync(fileOf(home)).size;
    expect(() => log.append({ t: 'msg', ts: TS, id: 'x', parent: null, role: 'narrator' } as never)).toThrow(/invalid msg/);
    expect(() => log.append({ t: 'nope' } as never)).toThrow();
    expect(statSync(fileOf(home)).size).toBe(size);
    expect(log.lastSeq()).toBe(1);
    log.close();
    expect(() => log.append(msg('aaaa0002', null))).toThrow(/closed/);
  });

  test('not found, invalid id, corrupt header', () => {
    const home = tmpHome();
    expect(() => openSessionLog(home, 's_nope0000')).toThrow(SessionNotFoundError);
    expect(() => openSessionLog(home, '../../etc/passwd')).toThrow(SessionNotFoundError);
    expect(() => readSessionFile(home, 's_nope0000')).toThrow(SessionNotFoundError);
    seeded(home);
    writeFileSync(fileOf(home), '{"t":"session","v":2}\n');
    expect(() => openSessionLog(home, ID)).toThrow(SessionCorruptError);
    expect(existsSync(lockOf(home))).toBe(false); // the lock is released on failure
    writeFileSync(fileOf(home), '{"t":"sess');
    expect(() => readSessionFile(home, ID)).toThrow(/torn/);
  });
});

describe('torn tails and bad lines', () => {
  test('a final segment without LF goes to .torn, the file is truncated, reopen is clean', () => {
    const home = tmpHome();
    seeded(home);
    const good = readFileSync(fileOf(home));
    const tornBytes = '{"t":"chk","seq":4,"turn":"t_1","text":"ha';
    appendFileSync(fileOf(home), tornBytes);

    // readSessionFile reports but never modifies.
    const peek = readSessionFile(home, ID);
    expect(peek.entries.length).toBe(3);
    expect(peek.notices.map((n) => n.code)).toEqual(['torn_tail']);
    expect(existsSync(tornOf(home))).toBe(false);
    expect(readFileSync(fileOf(home)).length).toBe(good.length + tornBytes.length);

    const { log, notices } = openSessionLog(home, ID);
    expect(notices).toEqual([expect.objectContaining({ code: 'torn_tail', line: 5 })]);
    expect(log.entries().length).toBe(3);
    expect(readFileSync(tornOf(home), 'utf8')).toBe(tornBytes + '\n');
    expect(Buffer.compare(readFileSync(fileOf(home)), good)).toBe(0);
    expect(log.append(msg('aaaa0004', 'aaaa0003', 'user')).seq).toBe(4);
    log.close();

    const again = openSessionLog(home, ID);
    expect(again.notices).toEqual([]);
    expect(again.log.entries().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    again.log.close();
  });

  test('an invalid final complete line is dropped the same way', () => {
    const home = tmpHome();
    seeded(home);
    const good = readFileSync(fileOf(home));
    const badLine = '{"t":"msg","seq":4,"ts":"x","id":"aaaa0004"}\n'; // complete but invalid (no parent/role)
    appendFileSync(fileOf(home), badLine);
    const { log, notices } = openSessionLog(home, ID);
    expect(notices).toEqual([expect.objectContaining({ code: 'torn_tail', line: 5 })]);
    expect(readFileSync(tornOf(home), 'utf8')).toBe(badLine);
    expect(Buffer.compare(readFileSync(fileOf(home)), good)).toBe(0);
    log.close();
    const again = openSessionLog(home, ID);
    expect(again.notices).toEqual([]);
    again.log.close();
    // A second torn event appends to the same .torn file.
    appendFileSync(fileOf(home), 'garbage');
    openSessionLog(home, ID).log.close();
    expect(readFileSync(tornOf(home), 'utf8')).toBe(badLine + 'garbage\n');
  });

  test('bad lines between the last good line and a torn tail go to .torn too (reopen stays clean)', () => {
    const home = tmpHome();
    seeded(home);
    const good = readFileSync(fileOf(home));
    appendFileSync(fileOf(home), '{"t":"chk", nope\n\n{"t":"chk","seq":9,"turn":"t","te');
    const { log, notices } = openSessionLog(home, ID);
    expect(notices.map((n) => [n.code, n.line])).toEqual([
      ['bad_line', 5],
      ['torn_tail', 7],
    ]);
    expect(Buffer.compare(readFileSync(fileOf(home)), good)).toBe(0);
    expect(readFileSync(tornOf(home), 'utf8')).toBe('{"t":"chk", nope\n\n{"t":"chk","seq":9,"turn":"t","te\n');
    log.close();
    expect(readSessionFile(home, ID).notices).toEqual([]);
  });

  test('a bad middle line is skipped with a notice and left in place', () => {
    const home = tmpHome();
    seeded(home);
    const lines = readFileSync(fileOf(home), 'utf8').split('\n');
    lines.splice(2, 0, '{"t":"msg", broken json');
    writeFileSync(fileOf(home), lines.join('\n'));
    const before = readFileSync(fileOf(home));
    const { log, notices } = openSessionLog(home, ID);
    expect(notices).toEqual([expect.objectContaining({ code: 'bad_line', line: 3 })]);
    expect(log.entries().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(Buffer.compare(readFileSync(fileOf(home)), before)).toBe(0);
    log.close();
  });

  test('seq must increase: a repeated or lower seq is a bad line', () => {
    const home = tmpHome();
    seeded(home);
    const lines = readFileSync(fileOf(home), 'utf8').trimEnd().split('\n');
    const dup = lines[2]!; // seq 2 again, after seq 3
    writeFileSync(fileOf(home), [...lines, dup, '{"t":"chk","seq":4,"turn":"t","text":"x"}', ''].join('\n'));
    const { entries, notices } = readSessionFile(home, ID);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(notices).toEqual([expect.objectContaining({ code: 'bad_line', line: 5 })]);
  });

  test('fuzz: corrupting entry lines never makes open throw', () => {
    const rnd = fakeRandom(11);
    const home = tmpHome();
    const log = createSessionLog(home, makeHeader());
    let parent: string | null = null;
    for (let i = 0; i < 30; i++) {
      const id = `bbbb${String(i).padStart(4, '0')}`;
      log.append(msg(id, parent, i % 2 ? 'user' : 'assistant', `line ${i}   ж`));
      parent = id;
    }
    log.close();
    const pristine = readFileSync(fileOf(home));
    const headerEnd = pristine.indexOf(0x0a) + 1;
    for (let round = 0; round < 150; round++) {
      const bytes = Buffer.from(pristine);
      const r = rnd(8);
      const flips = 1 + (r[0]! % 6);
      for (let k = 0; k < flips; k++) {
        const at = headerEnd + (((r[k + 1]! << 8) | r[(k + 2) % 8]!) % (bytes.length - headerEnd));
        bytes[at] = r[(k + 3) % 8]!;
      }
      const cutAt = r[7]! % 3 === 0 ? bytes.length - (r[6]! % 40) : bytes.length;
      writeFileSync(fileOf(home), bytes.subarray(0, Math.max(headerEnd, cutAt)));
      let opened: ReturnType<typeof openSessionLog> | undefined;
      expect(() => (opened = openSessionLog(home, ID))).not.toThrow();
      const seqs = opened!.log.entries().map((e) => e.seq);
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
      opened!.log.close();
      // After the repair the file never has a torn tail again.
      expect(readSessionFile(home, ID).notices.some((n) => n.code === 'torn_tail')).toBe(false);
    }
  });
});

describe('framing round-trips', () => {
  test('U+2028/U+2029 in text survive append → reopen', () => {
    const home = tmpHome();
    const log = createSessionLog(home, makeHeader());
    const body = 'para graph end\r\nwith CRLF inside the string';
    log.append(msg('aaaa0001', null, 'assistant', body));
    log.close();
    const { entries, notices } = readSessionFile(home, ID);
    expect(notices).toEqual([]);
    expect(entries[0]).toMatchObject({ blocks: [{ k: 'text', text: body }] });
  });

  test('a journal with CRLF line endings reads cleanly and can be appended to', () => {
    const home = tmpHome();
    seeded(home);
    const crlf = readFileSync(fileOf(home), 'utf8').replace(/\n/g, '\r\n');
    writeFileSync(fileOf(home), crlf);
    expect(readSessionFile(home, ID).notices).toEqual([]);
    const { log, notices } = openSessionLog(home, ID);
    expect(notices).toEqual([]);
    expect(log.entries().length).toBe(3);
    log.append(msg('aaaa0004', 'aaaa0003', 'user'));
    log.close();
    expect(readSessionFile(home, ID).entries.length).toBe(4);
  });
});

describe('locks', () => {
  test('exclusive: a second open (or create-then-open) throws SessionLockedError', () => {
    const home = tmpHome();
    const first = createSessionLog(home, makeHeader());
    let err: unknown;
    try {
      openSessionLog(home, ID);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SessionLockedError);
    expect((err as SessionLockedError).info.pid).toBe(process.pid);
    first.close();
    const second = openSessionLog(home, ID);
    expect(() => openSessionLog(home, ID)).toThrow(SessionLockedError);
    second.log.close();
  });

  test('readLock reports the holder without taking the lock; null when free, broken or invalid', () => {
    const home = tmpHome();
    expect(readSessionLock(home, ID)).toBeNull();
    const log = createSessionLog(home, makeHeader());
    const held = readSessionLock(home, ID);
    expect(held).toEqual(readLock(home));
    expect(held!.pid).toBe(process.pid);
    log.close();
    expect(readSessionLock(home, ID)).toBeNull();
    writeFileSync(lockOf(home), '{"pid":');
    expect(readSessionLock(home, ID)).toBeNull();
    expect(readSessionLock(home, '../escape')).toBeNull();
  });

  test('stale: a dead pid on this host is replaced', () => {
    const home = tmpHome();
    seeded(home);
    const clock = fakeClock();
    const now = clock().toISOString();
    writeFileSync(lockOf(home), JSON.stringify({ pid: deadPid(), host: 'here', started: now, renewed: now }));
    const { log } = openSessionLog(home, ID, { clock, host: 'here' });
    expect(readLock(home).pid).toBe(process.pid);
    log.close();
    expect(existsSync(lockOf(home))).toBe(false);
  });

  test('a live pid on another host is respected until its renewal is older than the TTL', () => {
    const home = tmpHome();
    seeded(home);
    const clock = fakeClock('2026-10-26T12:00:00.000Z', 0);
    const fresh = { pid: deadPid(), host: 'elsewhere', started: TS, renewed: '2026-10-26T11:59:50.000Z' };
    writeFileSync(lockOf(home), JSON.stringify(fresh));
    // Another host's pid cannot be probed: only the TTL decides.
    expect(() => openSessionLog(home, ID, { clock, host: 'here', lockTtlMs: 30_000 })).toThrow(SessionLockedError);
    writeFileSync(lockOf(home), JSON.stringify({ ...fresh, renewed: '2026-10-26T11:59:00.000Z' }));
    const { log } = openSessionLog(home, ID, { clock, host: 'here', lockTtlMs: 30_000 });
    expect(readLock(home).host).toBe('here');
    log.close();
  });

  test('a live pid on this host is respected even with an old renewal only within the TTL', () => {
    const home = tmpHome();
    seeded(home);
    const clock = fakeClock('2026-10-26T12:00:00.000Z', 0);
    // process.pid is alive; same host → locked while fresh.
    writeFileSync(lockOf(home), JSON.stringify({ pid: process.pid, host: 'here', started: TS, renewed: TS }));
    expect(() => openSessionLog(home, ID, { clock, host: 'here' })).toThrow(SessionLockedError);
  });

  test('an unreadable lock is trusted while fresh (a writer may be mid-create), stale after the TTL', () => {
    const home = tmpHome();
    seeded(home);
    writeFileSync(lockOf(home), '');
    const mtime = statSync(lockOf(home)).mtimeMs;
    const near = () => new Date(mtime + 1000);
    const far = () => new Date(mtime + 60_000);
    expect(() => openSessionLog(home, ID, { clock: near })).toThrow(SessionLockedError);
    const { log } = openSessionLog(home, ID, { clock: far });
    log.close();
  });

  test('close removes the lock only if it is still ours', () => {
    const home = tmpHome();
    seeded(home);
    const { log } = openSessionLog(home, ID);
    const foreign = { pid: 1, host: 'other', started: TS, renewed: TS };
    writeFileSync(lockOf(home), JSON.stringify(foreign));
    log.close();
    expect(readLock(home)).toEqual(foreign);
  });

  test('renewLock rewrites renewed while ours, and detects a lost lock (appends then refuse)', () => {
    const home = tmpHome();
    seeded(home);
    const clock = fakeClock();
    const { log } = openSessionLog(home, ID, { clock, lockRenewMs: 0 });
    const file = log as FileSessionLog;
    const before = readLock(home);
    expect(file.renewLock()).toBe(true);
    const after = readLock(home);
    expect(after.started).toBe(before.started);
    expect(Date.parse(after.renewed)).toBeGreaterThan(Date.parse(before.renewed));
    expect(existsSync(`${lockOf(home)}.${process.pid}.tmp`)).toBe(false);

    const thief = { pid: 4242, host: 'other', started: TS, renewed: TS };
    writeFileSync(lockOf(home), JSON.stringify(thief));
    expect(file.renewLock()).toBe(false);
    expect(file.lockLost).toEqual(thief);
    expect(() => log.append(msg('aaaa0009', 'aaaa0003', 'user'))).toThrow(SessionLockedError);
    log.close();
    expect(readLock(home)).toEqual(thief);
  });

  test('renewLock takes back a deleted lock with a fresh stamp', () => {
    const home = tmpHome();
    seeded(home);
    const clock = fakeClock();
    const { log } = openSessionLog(home, ID, { clock, lockRenewMs: 0 });
    const before = readLock(home);
    rmSync(lockOf(home));
    expect((log as FileSessionLog).renewLock()).toBe(true);
    const after = readLock(home);
    expect(after.started).toBe(before.started);
    expect(Date.parse(after.renewed)).toBeGreaterThan(Date.parse(before.renewed));
    log.close();
    expect(existsSync(lockOf(home))).toBe(false);
  });

  test('the renew timer runs on its own', async () => {
    const home = tmpHome();
    seeded(home);
    const clock = fakeClock();
    const { log } = openSessionLog(home, ID, { clock, lockRenewMs: 15 });
    const first = readLock(home).renewed;
    await Bun.sleep(80);
    expect(readLock(home).renewed).not.toBe(first);
    log.close();
    expect(existsSync(lockOf(home))).toBe(false);
  });
});

describe('lock ownership is a precondition of every write', () => {
  test('stolen while suspended, written to and released: the next append and renewal refuse', () => {
    const home = tmpHome();
    seeded(home);
    // Writer A (a one-shot send suspended with Ctrl+Z): no renew timer.
    const a = openSessionLog(home, ID, { lockRenewMs: 0 }).log as FileSessionLog;
    // Writer B opens 31 s later by its clock: A's lock looks stale and is stolen.
    const later = new Date(Date.now() + 31_000);
    const b = openSessionLog(home, ID, { lockRenewMs: 0, clock: () => later }).log;
    const bLine = b.append(msg('bbbb0001', 'aaaa0003', 'user', 'B was here.'));
    b.close(); // B releases: the lock file is gone.

    expect(a.renewLock()).toBe(false); // missing lock + a journal that grew: lost, not re-taken
    expect(a.lockLost).not.toBeNull();
    expect(() => a.append(msg('aaaa0009', 'aaaa0003', 'user', 'A resumes.'))).toThrow(SessionLockedError);
    a.close();
    expect(existsSync(lockOf(home))).toBe(false);

    const after = readSessionFile(home, ID);
    expect(after.notices).toEqual([]);
    expect(after.entries.at(-1)).toMatchObject({ seq: bLine.seq, id: 'bbbb0001' });
  });

  test('the size check alone catches a writer that came and went between two appends', () => {
    const home = tmpHome();
    seeded(home);
    const { log } = openSessionLog(home, ID, { lockRenewMs: 0 });
    const seq = log.lastSeq() + 1;
    appendFileSync(fileOf(home), `${JSON.stringify(msg('cccc0001', 'aaaa0003', 'user', 'foreign'))}\n`.replace('"t":"msg"', `"t":"msg","seq":${seq}`));
    expect(() => log.append(msg('aaaa0009', 'aaaa0003', 'user', 'mine'))).toThrow(SessionLockedError);
    log.close();
    expect(readSessionFile(home, ID).notices).toEqual([]);
  });

  test('a journal replaced under an open log (rename) is detected: appends refuse', () => {
    const home = tmpHome();
    seeded(home);
    const { log } = openSessionLog(home, ID, { lockRenewMs: 0 });
    const copy = `${fileOf(home)}.copy`;
    writeFileSync(copy, readFileSync(fileOf(home)));
    renameSync(copy, fileOf(home)); // same bytes, another inode (what a compaction would do)
    expect(() => log.append(msg('aaaa0009', 'aaaa0003', 'user', 'lost write'))).toThrow(SessionLockedError);
    log.close();
  });

  test('an append long after the last confirmation re-checks the lock file first', () => {
    const home = tmpHome();
    seeded(home);
    let now = Date.parse('2026-10-26T12:00:00.000Z');
    const clock = () => new Date(now);
    const { log } = openSessionLog(home, ID, { clock, lockRenewMs: 10_000 });
    const thief = { pid: 4242, host: 'other', started: TS, renewed: TS };
    writeFileSync(lockOf(home), JSON.stringify(thief));
    // Within the renew period the lock is trusted (the timer checks it)…
    now += 5_000;
    log.append(msg('aaaa0004', 'aaaa0003', 'user', 'fine'));
    // …past it (timers did not run: a suspended process), the write checks first and refuses.
    now += 40_000;
    expect(() => log.append(msg('aaaa0005', 'aaaa0004', 'user', 'refused'))).toThrow(SessionLockedError);
    expect((log as FileSessionLog).lockLost).toEqual(thief);
    log.close();
    expect(readLock(home)).toEqual(thief);
  });
});

describe('createSessionLogWith', () => {
  test('header and first entries in one file, seq 1..n, readable at once; no temp file left', () => {
    const home = tmpHome();
    const log = createSessionLogWith(home, makeHeader(ID), [
      msg('aaaa0001', null, 'assistant', 'One.'),
      msg('aaaa0002', null, 'assistant', 'Two.'),
      { t: 'head', ts: TS, leaf: 'aaaa0001' } as EntryInput,
    ]);
    expect(log.entries().map((e) => [e.seq, e.t])).toEqual([
      [1, 'msg'],
      [2, 'msg'],
      [3, 'head'],
    ]);
    expect(readSessionFile(home, ID).entries).toEqual([...log.entries()]);
    expect(existsSync(lockOf(home))).toBe(true);
    log.append(msg('aaaa0003', 'aaaa0001', 'user', 'Hi.'));
    log.close();
    expect(readdirSync(sessionsDir(home)).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  test('an invalid first entry is refused before anything is written; an existing id is refused', () => {
    const home = tmpHome();
    expect(() => createSessionLogWith(home, makeHeader(ID), [{ t: 'msg', ts: TS } as unknown as EntryInput])).toThrow(/invalid/);
    expect(existsSync(fileOf(home))).toBe(false);
    seeded(home);
    expect(() => createSessionLogWith(home, makeHeader(ID), [])).toThrow(/session already exists/);
    expect(readdirSync(sessionsDir(home)).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});

describe('listSessions', () => {
  test('newest first by mtime, with titles; unreadable files skipped', () => {
    const home = tmpHome();
    expect(listSessions(home)).toEqual([]);
    for (const [id, title] of [['s_00000001', 'One'], ['s_00000002', 'Two'], ['s_00000003', undefined]] as const) {
      const h = makeHeader(id);
      if (title === undefined) delete h.title;
      else h.title = title;
      createSessionLog(home, h).close();
    }
    utimesSync(fileOf(home, 's_00000001'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-03T00:00:00Z'));
    utimesSync(fileOf(home, 's_00000002'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
    utimesSync(fileOf(home, 's_00000003'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z'));
    writeFileSync(fileOf(home, 's_broken01'), '{"t":"session"');
    writeFileSync(join(sessionsDir(home), 'notes.txt'), 'x');
    expect(listSessions(home)).toEqual([
      { id: 's_00000001', title: 'One', updated: '2026-10-03T00:00:00.000Z' },
      { id: 's_00000003', updated: '2026-10-02T00:00:00.000Z' },
      { id: 's_00000002', title: 'Two', updated: '2026-10-01T00:00:00.000Z' },
    ]);
  });

  test('a header larger than one read chunk is still read', () => {
    const home = tmpHome();
    const h = makeHeader();
    h.cast.character.description = 'x'.repeat(200_000);
    createSessionLog(home, h).close();
    expect(listSessions(home).map((r) => r.id)).toEqual([ID]);
  });
});
