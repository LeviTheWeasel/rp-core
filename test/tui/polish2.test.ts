// Levi's third look at the TUI (polish2): /director show (Ctrl+D) prints the last directive in full,
// the block the narrator got, not a one-line summary with every field cut to ~40 characters. (The
// asterisks of *italic* in the chat: polish-chat.test.ts, stream.test.ts.)
import { afterEach, expect, test } from 'bun:test';
import { TextAttributes } from '@opentui/core';
import { DIRECTOR_FOOTER, DIRECTOR_HEADER } from '../../src/agents/director/render.ts';
import { dirConfig, fullCaps, planOf, tagged } from '../engine-m4/kit.ts';
import { calls, tuiRig, type TuiRig } from './kit.ts';

let rig: TuiRig | null = null;
afterEach(async () => {
  if (rig && !rig.setup.renderer.isDestroyed) await rig.close();
  rig = null;
});

test('Ctrl+D (/director show): the last directive in full, as sent, dim, under its heading', async () => {
  const hook = 'Daigorou looks at you with a mix of excitement and dread, the samurai armour creaking behind him as the lamp gutters out';
  const setting = 'Your bedroom, with the samurai armour standing in the corner under a sheet';
  const plan = planOf({ directive: { mood: 'tense', pacing: 'slow', narrativeGoal: 'The lamp shows a door that was not there.', endingHook: hook, sceneGuidance: { setting } } });
  rig = await tuiRig(calls([{ text: tagged(plan) }], [{ text: 'Фонарь гаснет.' }]), { width: 130, height: 60, caps: fullCaps(), config: dirConfig() });
  await rig.until('Hello, Levi');
  await rig.send('I look around.');
  await rig.until('turn 1 · full · tagged');
  rig.setup.mockInput.pressKey('d', { ctrl: true });
  await rig.until(DIRECTOR_FOOTER);
  // The transcript's own text (the frame wraps long lines at the chat column's width).
  const transcript = rig.setup.renderer.root.findDescendantById('transcript') as unknown as { content: { getChildren(): { plainText?: string }[] } };
  const text = transcript.content.getChildren().map((c) => c.plainText ?? '').join('\n');
  expect(text).toContain(`last directive (turn 1, as sent):\n${DIRECTOR_HEADER}\n`);
  expect(text).toContain(`Scene Guidance:\n  Setting: ${setting}\n`);
  expect(text).toContain(`Narrative Goal: The lamp shows a door that was not there.\n`);
  expect(text).toContain(`[Ending: ${hook}]\n${DIRECTOR_FOOTER}`);
  expect(text).not.toContain('hook "');
  // Side information: the heading and the block dim.
  for (const line of rig.setup.captureSpans().lines) {
    for (const sp of line.spans) {
      if (sp.text.includes(DIRECTOR_FOOTER) || sp.text.includes('last directive (turn 1')) expect(sp.attributes & TextAttributes.DIM).toBeTruthy();
    }
  }
}, 30_000);
