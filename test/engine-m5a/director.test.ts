// M5a D-157: the Director's prompt carries the Compendium's world snapshot ([COMPENDIUM CONTEXT]) while
// the Compendium is on, read from the same seeded view the narrator's request uses.
import { describe, expect, test } from 'bun:test';
import { bookSession, byAgent, calls, dirCall, dirConfig, directorUser, fullCaps, LANTERN, putBook, rig, turnOf } from './kit.ts';

describe('the Director and the Compendium', () => {
  test('enabled: [COMPENDIUM CONTEXT] with the library character, the session entry too', async () => {
    const r = await rig(calls(dirCall(), [{ text: 'Мира кивает.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id], { config: dirConfig() });
    s.memoryFile({ type: 'character', data: { name: 'Арсений Кеттер', description: 'Старый мастер фонарей.' } });
    const t = await turnOf(s);
    expect(t.out.type).toBe('done');
    const user = directorUser(byAgent(r.provider.requests, 'director')[0]!);
    expect(user).toContain('[COMPENDIUM CONTEXT]');
    expect(user).toContain('Мира');
    expect(user).toContain('Серый маяк');
    expect(user).toContain('Арсений Кеттер');
    await r.engine.close();
  });

  test('disabled: no snapshot (and no seed)', async () => {
    const r = await rig(calls(dirCall(), [{ text: 'Мира кивает.' }]), { caps: fullCaps() });
    const id = putBook(r.home, LANTERN);
    const s = bookSession(r.engine, [id], { config: dirConfig({}, { compendium: { enabled: false } }) });
    s.memoryFile({ type: 'character', data: { name: 'Арсений Кеттер', description: 'Старый мастер фонарей.' } });
    await turnOf(s);
    const user = directorUser(byAgent(r.provider.requests, 'director')[0]!);
    expect(user).not.toContain('[COMPENDIUM CONTEXT]');
    expect(user).not.toContain('Арсений Кеттер');
    await r.engine.close();
  });
});
