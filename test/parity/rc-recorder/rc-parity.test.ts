// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Parity with RoleCall's assembler (ARCHITECTURE.md §14 "Паритет с RoleCall", docs/PARITY-RC.md).
// Each rc-recorder fixture (RoleCall's input, recorded at VAUDEVILLE 68afe385) runs through the core
// (convert.ts → assemble → shape) and is compared with what RoleCall sent. Parity is asserted where
// the core does not diverge on purpose; every other difference is a named deviation in
// docs/PARITY-RC.md, and each test below says which one it normalises and how.

import { describe, expect, test } from 'bun:test';
import { BUILTIN_PRESET } from '../../../src/formats/native.ts';
import { HISTORY_SRC } from '../../../src/prompt/assemble.ts';
import { fromRcDepth } from '../../../src/prompt/depth.ts';
import { estimateMessages, CHARS_COUNTER, O200K_COUNTER } from '../../../src/prompt/tokens.ts';
import type { PromptMsg } from '../../../src/providers/types.ts';
import { DEFAULT_TRIM_CHUNK } from '../../../src/prompt/budget.ts';
import { fixturePreset, loadFixture, loadRecorded, rcPersona, RC_PIN, type RcRecorded } from './convert.ts';
import { okRun, pathRows, runFixture, textOf, UNBOUNDED_WINDOW, type ParityRun, type Row } from './run.ts';

const ALL = [
  '01-no-preset-first-turn',
  '02-no-preset-persona-history',
  '03-no-preset-long-history-trimmed',
  '04-no-preset-pre-trim',
  '05-no-preset-overfull',
  '06-st-default-markers',
  '07-in-chat-depths',
  '08-append-and-pins',
  '09-no-history-marker',
  '10-toggle-macros',
  '11-budget-and-prefill',
] as const;
const WITH_PRESET = ALL.filter((n) => loadFixture(n).input.presetId !== undefined);
const WITH_PERSONA = ALL.filter((n) => loadFixture(n).input.personaId !== undefined);

/** RoleCall's rows, as {role, content}. */
const rcRows = (r: RcRecorded): Row[] => r.conversationHistory.map((m) => ({ role: m.role, content: m.content }));

/** `rows` with `row` inserted at `at`. */
const insertAt = (rows: Row[], at: number, row: Row): Row[] => [...rows.slice(0, at), row, ...rows.slice(at)];

/** Chat messages (the path's own messages) after the message whose text is `text`. */
function chatAfter(msgs: readonly PromptMsg[], text: string): number {
  const at = msgs.findIndex((m) => textOf(m) === text);
  if (at < 0) throw new Error(`no message with text ${JSON.stringify(text)}`);
  return msgs.slice(at + 1).filter((m) => m.src === HISTORY_SRC).length;
}

// ---- the copied fixtures and the converter ----------------------------------------------------------

describe('rc-recorder fixtures and the converter', () => {
  test('all eleven recordings come from the pinned RoleCall commit', () => {
    for (const name of ALL) {
      const r = loadRecorded(name);
      expect(r.rolecall).toBe(RC_PIN);
      expect(r.fixture).toBe(name);
      expect(loadFixture(name).name).toBe(name);
    }
  });

  test('a persona row renders to the XML RoleCall sent (personaXml)', () => {
    for (const name of WITH_PERSONA) {
      const f = loadFixture(name);
      const row = f.db.tables.personas!.find((p) => p.id === f.input.personaId)!;
      expect(rcPersona(row).description).toBe(loadRecorded(name).personaXml!);
    }
  });

  test('preset rows reach the core as a RoleCall export: samplers, reply cap and post-processing carry over', () => {
    for (const name of WITH_PRESET) {
      const f = loadFixture(name);
      const { preset, warnings } = fixturePreset(f, 'rc');
      expect(warnings.map((w) => w.code)).toContain('rc_export');
      const s = loadRecorded(name).samplerSettings!;
      const { prompt_post_processing: pp, ...samplers } = s as Record<string, unknown>;
      expect(preset.samplers).toEqual(samplers);
      expect(preset.postProcessing ?? 'none').toBe(pp as 'none');
    }
  });

  test('no preset: the reply cap RoleCall carries is the converted set\'s', () => {
    for (const name of ALL.filter((n) => !WITH_PRESET.includes(n))) {
      expect(fixturePreset(loadFixture(name), 'rc').preset.samplers).toEqual(loadRecorded(name).samplerSettings as object);
    }
  });

  test('like RoleCall, the core writes no macro state on any fixture', () => {
    for (const name of ALL) {
      expect(loadRecorded(name).writes).toEqual([]);
      const run = runFixture(name, { window: UNBOUNDED_WINDOW });
      expect(okRun(run).result.varsDiff).toEqual({});
    }
  });
});

// ---- no preset: RoleCall's synthesised default set --------------------------------------------------

describe('RoleCall parity: no preset', () => {
  test('02, a persona and a few turns of history: exact', () => {
    const run = okRun(runFixture('02-no-preset-persona-history'));
    expect(run.rows).toEqual(rcRows(run.recorded));
    expect(run.shaped.prefill).toBeUndefined();
    expect(run.recorded.assistantPrefill).toBeNull();
    expect(run.result.trace.trimmed).toBeNull();
  });

  test('01, a first turn: exact once the example dialogue RoleCall dropped is put back [RC-1]', () => {
    const run = okRun(runFixture('01-no-preset-first-turn'));
    // RoleCall stripped {{mes_example}} as an unknown macro; the core sends the examples after the scenario.
    const examples = { role: 'system' as const, content: "<START>\nUser: Hello?\nVera: *She squints.* Who's asking?" };
    expect(run.rows).toEqual(insertAt(rcRows(run.recorded), 3, examples));
  });

  test("the core's own no-preset (BUILTIN_PRESET) is RoleCall's set plus its main prompt [RC-2]", () => {
    for (const name of ['01-no-preset-first-turn', '02-no-preset-persona-history']) {
      const rc = okRun(runFixture(name));
      const builtin = okRun(runFixture(name, { preset: BUILTIN_PRESET }));
      const user = rc.input.cast.persona?.name ?? 'User';
      const main = BUILTIN_PRESET.blocks[0]!.content.replaceAll('{{char}}', 'Vera').replaceAll('{{user}}', user);
      expect(builtin.rows).toEqual([{ role: 'system', content: main }, ...rc.rows]);
    }
  });
});

// ---- the budget: RoleCall's three passes against the core's one cut [RC-3] ---------------------------

/** Path indices of the chat rows (user/assistant) of a request, by text. */
function chatIndices(run: ParityRun, rows: Row[]): number[] {
  const texts = pathRows(run.input.view).map((r) => r.content);
  return rows.filter((r) => r.role !== 'system').map((r) => texts.indexOf(r.content));
}

/** The greeting, then a contiguous run that ends with the current message; returns where the run starts. */
function keptFrom(run: ParityRun, rows: Row[]): number {
  const idx = chatIndices(run, rows);
  const last = run.input.view.path.length - 1;
  expect(idx[0]).toBe(0);
  const from = idx[1]!;
  expect(idx.slice(1)).toEqual(Array.from({ length: last - from + 1 }, (_, i) => from + i));
  return from;
}

/**
 * A budget fixture: the frame (every system message) is RoleCall's; both sides keep the greeting and a
 * contiguous tail; the core cuts on its 8-message grid anchored at the oldest message [D-49] and fits
 * its window; with the window opened up, the core sends RoleCall's frame and the whole chat. The
 * start points are pinned under CHARS_COUNTER; under o200k (the default counter) only the rules are
 * checked.
 */
function budgetCase(name: string, pinned: { rcFrom: number; coreFrom: number }): void {
  const rec = rcRows(loadRecorded(name));
  const system = (rows: Row[]) => rows.filter((r) => r.role === 'system');
  for (const counter of [CHARS_COUNTER, O200K_COUNTER]) {
    const run = okRun(runFixture(name, { counter }));
    expect(system(run.rows)).toEqual(system(rec));
    expect(keptFrom(run, rec)).toBe(pinned.rcFrom);
    const from = keptFrom(run, run.rows);
    if (counter === CHARS_COUNTER) expect(from).toBe(pinned.coreFrom);
    const current = run.input.view.path.length - 1;
    expect((from - 1) % DEFAULT_TRIM_CHUNK === 0 || from === current).toBe(true);
    const prefill = run.shaped.prefill === undefined ? 0 : counter.count(run.shaped.prefill) + 4;
    expect(estimateMessages(run.result.messages, counter) + prefill).toBeLessThanOrEqual(run.input.window - run.input.reserve);
  }

  const open = okRun(runFixture(name, { window: UNBOUNDED_WINDOW, reserve: 8192 }));
  expect(open.rows).toEqual([...system(rec), ...pathRows(open.input.view)]);
}

describe('RoleCall parity: the budget [RC-3]', () => {
  test('03, a long history on a small window: same frame, the core drops whole chunks', () => {
    // RoleCall kept turns 7-16; under chars/3 not even one chunk of 8 fits, so the core keeps none.
    budgetCase('03-no-preset-long-history-trimmed', { rcFrom: 7, coreFrom: 17 });
  });

  test("04, a large window with a small reply cap: RoleCall's pre-trim binds, the core cuts 3 chunks", () => {
    budgetCase('04-no-preset-pre-trim', { rcFrom: 22, coreFrom: 25 });
  });

  test('11, a preset turn on a small window: same frame, the core cuts one chunk', () => {
    budgetCase('11-budget-and-prefill', { rcFrom: 5, coreFrom: 9 });
  });

  test('05, a depth note larger than the window: RoleCall sends over the cap, the core refuses [RC-4]', () => {
    const run = runFixture('05-no-preset-overfull');
    expect(run.result.ok).toBe(false);
    if (!run.result.ok) expect(run.result.code).toBe('context_length_exceeded');
    // RoleCall dropped all history and the greeting and still sent more than the window minus the
    // reply allows (its own report: 100 % used); only the frame, the note and the current message are left.
    expect(run.recorded.budgetReport?.usagePercent).toBe(100);
    expect(rcRows(run.recorded).map((r) => r.role)).toEqual(['system', 'system', 'system', 'system', 'user']);

    // With room, the frame is RoleCall's and its depth-2 note lands at core depth 3 (fromRcDepth).
    const open = okRun(runFixture('05-no-preset-overfull', { window: UNBOUNDED_WINDOW }));
    const note = rcRows(run.recorded)[3]!.content;
    expect(open.rows.slice(0, 3)).toEqual(rcRows(run.recorded).slice(0, 3));
    expect(chatAfter(open.result.messages, note)).toBe(fromRcDepth(2));
  });
});

// ---- presets ------------------------------------------------------------------------------------------

describe('RoleCall parity: presets', () => {
  test('06, ST marker slots: exact once the examples RoleCall dropped are put back [RC-5]', () => {
    const run = okRun(runFixture('06-st-default-markers'));
    // RoleCall had no fill for dialogueExamples under a preset; the core fills the slot with the raw
    // example text, as RoleCall's later {{mesExamples}} fill does: an RC export's
    // new_example_chat_prompt rides extras unapplied (RoleCall never applies it).
    const examples = {
      role: 'system' as const,
      content: "<START>\nWren: Hello?\nVera: *She squints.* Who's asking? This line proves whether example dialogue survives a preset.",
    };
    expect(run.rows).toEqual(insertAt(rcRows(run.recorded), 5, examples));
  });

  test("07, in-chat depths through RoleCall's export: exact but for the overflow above the greeting [RC-6]", () => {
    const run = okRun(runFixture('07-in-chat-depths'));
    const rec = rcRows(run.recorded);
    // RoleCall injects into the history after the greeting, so depth 10 lands below it; ST and the
    // core put any depth >= the chat length before the first chat message, the greeting (§10.1).
    const overflow = rec.findIndex((r) => r.content === 'DEPTH10-OVERFLOW-CONTENT');
    expect(overflow).toBe(2);
    const moved = insertAt(rec.toSpliced(overflow, 1), 1, rec[overflow]!);
    expect(run.rows).toEqual(moved);
    // The export's RoleCall depths arrive +1 (D-47): depth 0 sits above the current message.
    expect(chatAfter(run.result.messages, 'DEPTH0-ORDER10-CONTENT')).toBe(fromRcDepth(0));
    expect(chatAfter(run.result.messages, 'DEPTH2-USER-CONTENT')).toBe(fromRcDepth(2));
  });

  test('07, the same preset as the ST file: ST depths 1:1, one chat message lower than RoleCall [RC-7]', () => {
    const rc = okRun(runFixture('07-in-chat-depths'));
    const st = okRun(runFixture('07-in-chat-depths', { reading: 'st' }));
    const chat = st.input.view.path.length;
    for (const [text, depth] of [
      ['DEPTH0-ORDER10-CONTENT', 0],
      ['DEPTH0-ORDER20-CONTENT', 0],
      ['DEPTH2-USER-CONTENT', 2],
      ['DEPTH10-OVERFLOW-CONTENT', 10],
    ] as const) {
      expect(chatAfter(st.result.messages, text)).toBe(Math.min(depth, chat));
      if (depth < chat) expect(chatAfter(st.result.messages, text)).toBe(chatAfter(rc.result.messages, text) - 1);
    }
    // Nothing else moves: without the in-chat blocks both readings send the same request.
    const inChat = (r: Row) => !r.content.startsWith('DEPTH');
    expect(st.rows.filter(inChat)).toEqual(rc.rows.filter(inChat));
  });

  test('08, appends and pins: the chat, the persona, the pins and the prefill match once appends are set aside [RC-8]', () => {
    const run = okRun(runFixture('08-append-and-pins'));
    const rec = rcRows(run.recorded);
    // RoleCall glues append blocks onto chat messages; the core has no append placement.
    const unglued = rec.map((r) => ({ ...r, content: r.content.replace(/\nAPPEND-[A-Z0-9-]+$/, '') }));
    const isAppend = (r: Row) => r.content.startsWith('APPEND-');
    const isPin = (r: Row) => /^(TOP|BOTTOM)-PIN-/.test(r.content);
    expect(run.rows.filter((r) => !isAppend(r) && !isPin(r))).toEqual(unglued.filter((r) => !isPin(r)));
    expect(run.rows.filter(isPin).map((r) => r.content).sort()).toEqual(rec.filter(isPin).map((r) => r.content).sort());
    // The preset prefill goes out as the prefill, as RoleCall returned it.
    expect(run.shaped.prefill).toBe(run.recorded.assistantPrefill!);
  });

  // An RC export's injection_position 4/3 are RoleCall's top/bottom pins: core.preset/1 'top'/'bottom',
  // each group in injection_order (.notes/m2-contract-rc-parity.md §1). Appends are imported disabled.
  test('08, pins: RoleCall export pins import as top/bottom pins in injection_order', () => {
    const run = okRun(runFixture('08-append-and-pins'));
    const unglued = rcRows(run.recorded).map((r) => ({ ...r, content: r.content.replace(/\nAPPEND-[A-Z0-9-]+$/, '') }));
    expect(run.rows.filter((r) => !r.content.startsWith('APPEND-'))).toEqual(unglued);
  });

  test('09, a preset with only main: exact (RoleCall fills persona and the chat, D-71)', () => {
    const run = okRun(runFixture('09-no-history-marker'));
    expect(run.rows).toEqual(rcRows(run.recorded));
  });

  test('09, the same preset as the ST file: no persona, as in ST [RC-9]', () => {
    const rc = okRun(runFixture('09-no-history-marker'));
    const st = okRun(runFixture('09-no-history-marker', { reading: 'st' }));
    const persona = rc.input.cast.persona!.description;
    expect(st.rows).toEqual(rc.rows.filter((r) => r.content !== persona));
  });

  test("10, RoleCall's toggle macros stay literal; the toggles themselves match [RC-10]", () => {
    const run = okRun(runFixture('10-toggle-macros'));
    const rec = rcRows(run.recorded);
    const main = loadFixture('10-toggle-macros').db.tables.preset_prompts!.find((p) => p.identifier === 'main')!.content as string;
    // {{enabled::x}} and {{when_enabled::x::y}} are RoleCall's own; unknown macros stay as written (§10.4).
    expect(run.rows).toEqual([{ role: 'system', content: main }, ...rec.slice(1)]);
    expect(run.result.trace.macros.unknown).toEqual(expect.arrayContaining(['enabled', 'when_enabled']));
  });

  test("11, the prefill: the core expands it once, as RoleCall's worker does before sending", () => {
    const run = okRun(runFixture('11-budget-and-prefill'));
    expect(run.recorded.assistantPrefill).toBe('{{char}} looks at {{user}}:');
    expect(run.shaped.prefill).toBe('Vera looks at Wren:');
  });
});
