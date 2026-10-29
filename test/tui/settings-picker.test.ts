import { afterEach, expect, test } from 'bun:test';
import { saveToLibrary } from '../../src/formats/library.ts';
import { BUILTIN_PRESET } from '../../src/formats/native.ts';
import { storySettings } from '../../src/cli/tui/settings-picker.ts';
import { tuiRig, type TuiRig } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => { if (rig) await rig.close(); rig = null; });

async function untilSettings(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

test('F8 changes the preset and multiple lorebooks, keeping the chat draft', async () => {
  rig = await tuiRig([]);
  await rig.until('Hello, Levi');
  const preset = saveToLibrary(rig.home, 'presets', 'Lighthouse', { ...BUILTIN_PRESET, name: 'Lighthouse' }).id;
  const a = saveToLibrary(rig.home, 'lorebooks', 'Alpha', { name: 'Alpha', entries: [] }).id;
  const b = saveToLibrary(rig.home, 'lorebooks', 'Beta', { name: 'Beta', entries: [] }).id;
  await rig.type('unsent draft');

  await rig.setup.mockInput.pressKeys(['F8']);
  const opened = await rig.until('Preset: builtin');
  expect(opened).toContain('Preset: builtin');
  rig.setup.mockInput.pressArrow('down');
  rig.setup.mockInput.pressEnter();
  await untilSettings(() => storySettings(rig!.home, rig!.session.id).preset === preset);
  expect(rig.input()).toBe('unsent draft');

  await rig.setup.mockInput.pressKeys(['F8']);
  await rig.until('Story settings');
  rig.setup.mockInput.pressArrow('right');
  await rig.until('Books with the same name');
  await rig.setup.mockInput.pressKeys([' ']);
  rig.setup.mockInput.pressArrow('down');
  await rig.setup.mockInput.pressKeys([' ']);
  rig.setup.mockInput.pressEnter();
  await untilSettings(() => storySettings(rig!.home, rig!.session.id).lorebooks.length === 2);
  expect(storySettings(rig.home, rig.session.id).lorebooks).toEqual([a, b]);
  expect(rig.input()).toBe('unsent draft');
});

test('Esc cancels pending lorebook changes', async () => {
  rig = await tuiRig([]);
  await rig.until('Hello, Levi');
  saveToLibrary(rig.home, 'lorebooks', 'Alpha', { name: 'Alpha', entries: [] });
  await rig.setup.mockInput.pressKeys(['F8']);
  await rig.until('Story settings');
  rig.setup.mockInput.pressArrow('right');
  await rig.setup.mockInput.pressKeys([' ']);
  rig.setup.mockInput.pressEscape();
  await rig.gone('Story settings');
  expect(storySettings(rig.home, rig.session.id).lorebooks).toEqual([]);
});
