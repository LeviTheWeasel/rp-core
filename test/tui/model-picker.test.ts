import { afterEach, expect, test } from 'bun:test';
import { tuiRig, type TuiRig } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => { if (rig) await rig.close(); rig = null; });

test('F4 lists connection models and Enter changes the narrator in this session', async () => {
  const fetcher = (async () => new Response(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] }), {
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  rig = await tuiRig([], { catalog: { baseUrl: 'https://models.example/v1', fetch: fetcher } });
  await rig.until('Hello, Levi');
  await rig.type('draft');
  await rig.setup.mockInput.pressKeys(['F4']);
  const picker = await rig.until('beta');
  expect(picker).toContain('Choose narrator model');
  expect(picker).toContain('alt');
  expect(picker).toContain('script');
  rig.setup.mockInput.pressArrow('down');
  rig.setup.mockInput.pressEnter();
  const changed = await rig.gone('Choose narrator model');
  expect(changed).toContain('alt:beta');
  expect(rig.input()).toBe('draft');
  await rig.setup.mockInput.pressKeys(['F4']);
  await rig.until('Choose narrator model');
  rig.setup.mockInput.pressEscape();
  await rig.gone('Choose narrator model');
});

test('closing the picker keeps an unsent draft; connections without catalogs are explained', async () => {
  rig = await tuiRig([]);
  await rig.until('Hello, Levi');
  await rig.type('unsent draft');
  await rig.setup.mockInput.pressKeys(['F4']);
  const picker = await rig.until('no model catalog');
  expect(picker).toContain('alt');
  expect(picker).toContain('script');
  rig.setup.mockInput.pressEscape();
  await rig.gone('Choose narrator model');
  expect(rig.input()).toBe('unsent draft');
});
