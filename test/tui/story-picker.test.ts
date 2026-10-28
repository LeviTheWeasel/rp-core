import { afterEach, expect, test } from 'bun:test';
import { tuiRig, type TuiRig, MIRA, LEVI } from './kit.ts';
import { storyRows, branchRows } from '../../src/cli/tui/story-picker.ts';

let rig: TuiRig | null = null;
afterEach(async () => { if (rig) await rig.close(); rig = null; });

test('F5 searches stories, opens one, and preserves the input draft', async () => {
  rig = await tuiRig([]);
  await rig.until('Hello, Levi');
  const other = rig.engine.createSession({ character: MIRA, persona: LEVI, title: 'Moon garden' });
  const otherId = other.id;
  other.send({ text: 'north wind', expectedVersion: other.version() });
  await other.close();
  await rig.type('draft');
  await rig.setup.mockInput.pressKeys(['F5']);
  await rig.until('Stories and branches');
  await rig.type('Moon garden');
  const found = await rig.until('Moon garden');
  expect(found).toContain(otherId);
  expect(found).toContain('search: moon garden');
  rig.setup.mockInput.pressArrow('right');
  await rig.until('north wind');
  rig.setup.mockInput.pressEnter();
  await rig.gone('Stories and branches');
  await rig.until('north wind');
  expect(rig.input()).toBe('draft');
});

test('browser exposes the current leaf and alternative branch leaves', async () => {
  rig = await tuiRig([]);
  await rig.until('Hello, Levi');
  const s = rig.session;
  const greeting = s.view().path[0]!.id;
  const first = s.send({ text: 'first path', expectedVersion: s.version() });
  s.select({ messageId: greeting, expectedVersion: s.version(), exact: true });
  const second = s.send({ text: 'new path', expectedVersion: s.version() });
  const rows = branchRows(rig.home, s.id);
  expect(rows.find((r) => r.id === second.messageId)?.active).toBe(true);
  expect(rows.find((r) => r.id === first.messageId)?.active).toBe(false);
  expect(storyRows(rig.home).some((r) => r.id === s.id)).toBe(true);
  const forkId = s.fork({ at: first.messageId });
  const allStories = storyRows(rig.home);
  expect(allStories.find((r) => r.id === forkId)?.depth).toBe(1);
  expect(allStories.findIndex((r) => r.id === forkId)).toBe(allStories.findIndex((r) => r.id === s.id) + 1);
  await rig.setup.mockInput.pressKeys(['F5']);
  await rig.until('Stories and branches');
  rig.setup.mockInput.pressArrow('right');
  const frame = await rig.until('new path');
  expect(frame).toContain('first path');
  const targetIndex = rows.findIndex((r) => r.id === first.messageId);
  for (let i = 0; i < targetIndex; i++) rig.setup.mockInput.pressArrow('down');
  rig.setup.mockInput.pressEnter();
  await rig.gone('Stories and branches');
  for (let i = 0; i < 100 && s.view().head !== first.messageId; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(s.view().head, await rig.frame()).toBe(first.messageId);
});
