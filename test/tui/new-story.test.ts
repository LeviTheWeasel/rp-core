import { afterEach, expect, test } from 'bun:test';
import { createLibraryStory } from '../../src/cli/tui/new-story.ts';
import { loadRuntime } from '../../src/cli/runtime.ts';
import { saveToLibrary } from '../../src/formats/library.ts';
import { BUILTIN_PRESET } from '../../src/formats/native.ts';
import { readSessionFile } from '../../src/session/log.ts';
import { tmpHome } from '../helpers.ts';
import { MIRA, LEVI, tuiRig, type TuiRig } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => { if (rig) await rig.close(); rig = null; });

test('new TUI story uses library card, persona, preset and multiple lorebooks', async () => {
  const home = tmpHome('rp-core-tui-new-');
  const card = saveToLibrary(home, 'characters', 'Mira', MIRA).id;
  const persona = saveToLibrary(home, 'personas', 'Levi', LEVI).id;
  const preset = saveToLibrary(home, 'presets', 'Lighthouse', { ...BUILTIN_PRESET, name: 'Lighthouse' }).id;
  const lore = saveToLibrary(home, 'lorebooks', 'Harbor', { name: 'Harbor', entries: [] }).id;
  const id = await createLibraryStory(loadRuntime(home, {}), { card, persona, preset, lore: [lore] });
  const { header } = readSessionFile(home, id);
  expect(header.cast.character.name).toBe('Mira');
  expect(header.cast.persona?.name).toBe('Levi');
  expect(header.config.preset).toBe(preset);
  expect(header.config.lorebooks).toEqual([lore]);
});

test('F6 inside the chat creates and opens a library story without losing the draft', async () => {
  rig = await tuiRig([]);
  await rig.until('Hello, Levi');
  saveToLibrary(rig.home, 'characters', 'New Mira', { ...MIRA, name: 'New Mira' });
  await rig.type('unsent draft');
  await rig.setup.mockInput.pressKeys(['F6']);
  await rig.until('New story · 1/4 Card');
  rig.setup.mockInput.pressEnter();
  await rig.until('2/4 Persona');
  rig.setup.mockInput.pressEnter();
  await rig.until('3/4 Preset');
  rig.setup.mockInput.pressEnter();
  await rig.until('4/4 Lorebooks');
  rig.setup.mockInput.pressEnter();
  await rig.gone('New story · 4/4');
  await rig.until('New Mira');
  expect(rig.input()).toBe('unsent draft');
});
