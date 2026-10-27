// M5a D-164 (--keep-requests): with EngineOptions.keepRequests every provider request of a turn (the
// Director's and the narrator's) is kept as JSON under <home>/sessions/<id>.requests/; previews keep
// nothing, and nothing is kept while the option is off.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestFileName, requestsDir } from '../../src/engine/turn.ts';
import { scriptConn } from '../engine/kit.ts';
import { reply, rig as m3rig, session as m3session } from '../engine-m3/kit.ts';
import { bookSession, calls, dirCall, dirConfig, drain, fullCaps, LANTERN, ok, putBook, rig, turnOf } from './kit.ts';

describe('--keep-requests', () => {
  test('a call key as a file name; the n-th request under one key gets -n', () => {
    expect(requestFileName('t1:narrator:0')).toBe('t1_narrator_0.json');
    expect(requestFileName('a b/c\\d.e-f_g')).toBe('a_b_c_d.e-f_g.json');
    expect(requestFileName('t1:narrator:0', 1)).toBe('t1_narrator_0.json');
    expect(requestFileName('t1:narrator:0', 2)).toBe('t1_narrator_0-2.json');
    expect(requestFileName('t1:narrator:0', 3)).toBe('t1_narrator_0-3.json');
  });

  test('a call key that comes again (a retry, then a fallback) never overwrites: -2, -3 in the order sent', async () => {
    const backup = scriptConn('backup', calls([{ text: 'Мира кивает.' }]));
    const r = await rig(calls([{ error: { code: 'overloaded', status: 503 } }], [{ error: { code: 'overloaded', status: 503 } }]), {
      caps: fullCaps(),
      connections: { backup: backup.conn },
      extra: { keepRequests: true },
    });
    const s = bookSession(r.engine, []);
    const turn = s.runTurn({ kind: 'reply', expectedVersion: s.version(), fallback: 'backup:big' });
    await drain(turn);
    expect((await turn.result).type).toBe('done');
    const dir = requestsDir(r.home, s.id);
    const t = turn.turnId;
    expect(readdirSync(dir).sort()).toEqual([`${t}_narrator_0-2.json`, `${t}_narrator_0-3.json`, `${t}_narrator_0.json`]);
    const kept = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as { callKey: string; model: unknown };
    for (const name of readdirSync(dir)) expect(kept(name).callKey).toBe(`${t}:narrator:0`);
    // The first two went to the binding (the attempt and its retry), the third to the fallback.
    expect(kept(`${t}_narrator_0.json`).model).toEqual({ connection: 'script', model: 'default' });
    expect(kept(`${t}_narrator_0-2.json`).model).toEqual({ connection: 'script', model: 'default' });
    expect(kept(`${t}_narrator_0-3.json`).model).toEqual({ connection: 'backup', model: 'big' });
    await r.engine.close();
  });

  test('on: the Director and the narrator requests of a turn, as JSON, without the signal', async () => {
    const r = await rig(calls(dirCall(), [{ text: 'Мира кивает.' }]), { caps: fullCaps(), extra: { keepRequests: true } });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id], { config: dirConfig() });
    ok(s.preview());
    const dir = requestsDir(r.home, s.id);
    expect(dir).toBe(join(r.home, 'sessions', `${s.id}.requests`));
    expect(existsSync(dir)).toBe(false);
    const t = await turnOf(s);
    const turnId = t.turn.turnId;
    expect(readdirSync(dir).sort()).toEqual([`${turnId}_director_0.json`, `${turnId}_narrator_0.json`]);

    const narrator = JSON.parse(readFileSync(join(dir, `${turnId}_narrator_0.json`), 'utf8')) as Record<string, unknown>;
    const sent = r.provider.requests.find((q) => q.callKey === `${turnId}:narrator:0`)!;
    expect(narrator.signal).toBeUndefined();
    expect(narrator.callKey).toBe(`${turnId}:narrator:0`);
    expect(narrator.agent).toBe('narrator');
    expect(narrator.model).toEqual({ connection: 'script', model: 'default' });
    expect(narrator.messages).toEqual(JSON.parse(JSON.stringify(sent.messages)));
    expect(JSON.stringify(narrator.messages)).toContain('[Retrieved World Knowledge]');

    const director = readFileSync(join(dir, `${turnId}_director_0.json`), 'utf8');
    expect(director).toContain('[COMPENDIUM CONTEXT]');
    expect(JSON.parse(director).agent).toBe('director');
    // The session list is unaffected by the folder.
    expect(r.engine.listSessions().map((x) => x.id)).toEqual([s.id]);
    await r.engine.close();
  });

  test('off (the default): nothing is kept', async () => {
    const r = await rig(calls([{ text: 'Мира кивает.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id]);
    await turnOf(s);
    expect(existsSync(requestsDir(r.home, s.id))).toBe(false);
    await r.engine.close();
  });
});

describe('--keep-requests: what a kept file holds (review engine#6)', () => {
  test('the provider-level request without the messages\' replay payloads (kept in memory only)', async () => {
    const r = await m3rig(
      calls([{ replay: { kind: 'reasoning_details', payload: [{ type: 'reasoning.encrypted', data: 'secret-ish' }] } }, { tool: { name: 'lookup', args: { q: 'a' } } }], [{ text: 'ok' }]),
      { extra: { keepRequests: true } },
    );
    const s = m3session(r.engine);
    const { turn } = await reply(s);
    // The provider got the payload back in round 1…
    expect(r.provider.requests[1]!.messages.some((m) => m.replay !== undefined)).toBe(true);
    // …the kept file has the same messages without it.
    const dir = requestsDir(r.home, s.id);
    const kept = readFileSync(join(dir, `${turn.turnId}_narrator_1.json`), 'utf8');
    expect(kept).not.toContain('replay');
    expect(kept).not.toContain('secret-ish');
    const body = JSON.parse(kept) as { messages: unknown[]; callKey: string; signal?: unknown };
    expect(body.callKey).toBe(`${turn.turnId}:narrator:1`);
    expect(body.signal).toBeUndefined();
    expect(body.messages).toEqual(JSON.parse(JSON.stringify(r.provider.requests[1]!.messages.map(({ replay: _r, ...m }) => m))));
    await r.engine.close();
  });
});
