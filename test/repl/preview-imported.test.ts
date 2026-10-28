// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// /preview n on an answer rp-core did not generate (.notes/rcimport-decisions.md, ux#11): an answer
// imported from RoleCall (D-188: gen.kind 'model', no trace) has no request to rebuild, and the REPL
// says so in words, as it does for a greeting. Before the fix it printed the engine's raw refusal,
// `preview refused [invalid_params]: invalid request (message … is not a model answer with a trace)`.
import { afterEach, describe, expect, test } from 'bun:test';
import type { EntryInput } from '../../src/session/entries.ts';
import { createSessionLogWith, readSessionFile } from '../../src/session/log.ts';
import { calls, replRig, writeRaw, type ReplRig } from './kit.ts';

const rigs: ReplRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close().catch(() => undefined);
});

const USER = 'a1b2c3d4';
const ANSWER = 'e5f6a7b8';
const TS = '2026-10-01T10:00:00.000Z';

/** A user message and an answer without a trace (what the importer writes), under the first greeting. */
function untraced(greeting: string): EntryInput[] {
  return [
    { t: 'msg', ts: TS, id: USER, parent: greeting, role: 'user', blocks: [{ k: 'text', text: 'I knock twice.' }] },
    { t: 'msg', ts: TS, id: ANSWER, parent: USER, role: 'assistant', blocks: [{ k: 'text', text: 'The abacus rattles.' }], gen: { kind: 'model', model: 'm', finish: 'end' } },
  ] as EntryInput[];
}

/** A new session's journal (written by a closed REPL rig) copied as an imported one: header.imported, the answer above. */
async function importedHome(): Promise<{ home: string; id: string }> {
  const base = await replRig([]);
  await base.close();
  const { header, entries } = readSessionFile(base.home, base.session.id);
  const greeting = entries.find((e) => e.t === 'msg')!;
  const kept = entries.map(({ seq: _seq, ...rest }) => rest as EntryInput);
  const id = 's_0c0ffee1';
  createSessionLogWith(base.home, { ...header, id, imported: { from: 'rolecall', chat: 'chat-1', exportedAt: TS } }, [...kept, ...untraced((greeting as { id: string }).id)]).close();
  return { home: base.home, id };
}

describe('/preview n on an answer without a trace (ux#11)', () => {
  test('an imported answer, by number and by id: refused in words; /preview alone still works', async () => {
    const { home, id } = await importedHome();
    const r = await replRig(calls(), { home, sessionId: id });
    rigs.push(r);
    r.type('/preview 3', `/preview ${ANSWER}`, '/preview');
    r.end();
    expect(await r.done).toBe(0);
    const out = r.out();
    expect(out).toContain('/preview: message 3 was imported from RoleCall; rp-core did not build its request, so there is none to rebuild (/preview alone shows the next request)');
    expect(out).toContain(`/preview: ${ANSWER} was imported from RoleCall`);
    expect(out).not.toContain('invalid_params');
    expect(out).toContain(`preview of a swipe`);
    expect(r.provider.requests).toHaveLength(0);
  });

  test('an untraced answer in a session that was not imported: "has no trace"', async () => {
    const base = await replRig([]);
    await base.close();
    const greeting = readSessionFile(base.home, base.session.id).entries.find((e) => e.t === 'msg') as { id: string };
    writeRaw(base.home, base.session.id, (log) => {
      for (const e of untraced(greeting.id)) log.append(e);
    });
    const r = await replRig(calls(), { home: base.home, sessionId: base.session.id });
    rigs.push(r);
    r.type('/preview 3');
    r.end();
    expect(await r.done).toBe(0);
    expect(r.out()).toContain('/preview: message 3 has no trace; its request was not kept, so there is none to rebuild');
    expect(r.out()).not.toContain('invalid_params');
  });
});
