import { afterEach, expect, test } from 'bun:test';
import { saveToLibrary } from '../../src/formats/library.ts';
import { tuiRig, type TuiRig } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => { if (rig) await rig.close(); rig = null; });

test('F7 switches to a library persona and offers editing its fields', async () => {
  rig = await tuiRig([]);
  await rig.until('Hello, Levi');
  saveToLibrary(rig.home, 'personas', 'Alex', { name: 'Alex', description: 'Maps the night sky.' });
  await rig.setup.mockInput.pressKeys(['F7']);
  const picker = await rig.until('Edit description');
  expect(picker).toContain('Alex');
  rig.setup.mockInput.pressArrow('down');
  rig.setup.mockInput.pressArrow('down');
  rig.setup.mockInput.pressEnter();
  await rig.gone('Edit description');
  const changed = await rig.until('persona → Alex');
  expect(changed).toContain('you: Alex');
  expect(rig.session.header().cast.persona).toEqual({ name: 'Alex', description: 'Maps the night sky.' });

  await rig.setup.mockInput.pressKeys(['F7']);
  await rig.until('Edit name');
  rig.setup.mockInput.pressEnter();
  expect(rig.input()).toBe('/persona name Alex');
  const input = rig.setup.renderer.root.findDescendantById('input') as unknown as { setText(value: string): void };
  input.setText('/persona name Sasha');
  rig.setup.mockInput.pressEnter();
  await rig.until('persona → Sasha');
  expect(rig.session.header().cast.persona).toEqual({ name: 'Sasha', description: 'Maps the night sky.' });

  await rig.setup.mockInput.pressKeys(['F7']);
  await rig.until('Edit description');
  rig.setup.mockInput.pressArrow('down');
  rig.setup.mockInput.pressEnter();
  expect(rig.input()).toBe('/persona description Maps the night sky.');
  input.setText('/persona description A careful observer.');
  rig.setup.mockInput.pressEnter();
  for (let i = 0; i < 100 && rig.session.header().cast.persona?.description !== 'A careful observer.'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(rig.session.header().cast.persona?.description).toBe('A careful observer.');
});
