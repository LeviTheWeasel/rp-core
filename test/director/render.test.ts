// Ported from Bunraku:src/core/assembly/assemble-director.test.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (Coneja-Chibi: what the narrator reads, and the text half of the placement tests); the render
// cases of RoleCall:apps/rc/src/lib/ai/dm-stream/DirectiveBuilder.ts@fb8dc623e buildNarratorInjection
// kept by m4-decisions (rolecall.md §9.3, §13 items 13–14).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// src/agents/director/render.ts: the directive text, the contract, the preview stub and the event
// summary. Where the blocks go (the contract in the core block, the directive at depth 1, D-106) is
// prompt/assemble.ts's and is tested by the integrate unit; here only the text is.
import { describe, expect, test } from 'bun:test';
import {
  DIRECTOR_FOOTER,
  DIRECTOR_HEADER,
  LANGUAGE_LINE,
  NARRATOR_AUTHORITY,
  STUB_DIRECTIVE,
  contractText,
  renderDirective,
  summaryOf,
} from '../../src/agents/director/render.ts';
import type { DirectorArc, DirectorChapter, DirectorInvisibleArc, DirectorSeed, DirectorState, NarratorDirective } from '../../src/agents/director/types.ts';

const DIRECTIVE: NarratorDirective = {
  mood: 'uneasy',
  pacing: 'slow',
  narrativeGoal: 'Let the keeper slip once.',
  endingHook: 'A bell, far off.',
  arcDirections: [{ arcName: 'The Locked Room', instruction: 'Someone avoids the corridor.', urgency: 'moderate' }],
  characterBeats: [{ character: 'Vera', beat: 'Counts the lamps twice', motivation: 'old habit' }],
  include: { themes: ['debt'] },
  avoid: { revelations: ['who has the key'] },
  sceneGuidance: { setting: 'the lamp room', tension_level: 7 },
};

/** The body between the preamble and the footer. */
const body = (text: string): string => {
  expect(text.startsWith(`${DIRECTOR_HEADER}\n`)).toBe(true);
  expect(text.endsWith(`\n${DIRECTOR_FOOTER}`)).toBe(true);
  const at = text.indexOf('\n\n');
  return text.slice(at + 2, text.length - DIRECTOR_FOOTER.length - 1);
};

describe('placement', () => {
  // Bunraku's "the directive is one system message immediately above the last user message, and the
  // contract is the first message of the request": the placement moved to prompt/assemble.ts (D-106:
  // depth 1, the contract in the core block); what stays here is the text half of it.
  test('the directive is one block headed by the header and closed by the footer', () => {
    const text = renderDirective(DIRECTIVE);
    expect(text.startsWith(DIRECTOR_HEADER)).toBe(true);
    expect(text.endsWith(DIRECTOR_FOOTER)).toBe(true);
    expect(text.split(DIRECTOR_HEADER)).toHaveLength(2);
    expect(text.split(DIRECTOR_FOOTER)).toHaveLength(2);
  });

  // Bunraku's "no directive, or one that renders to nothing, places nothing - not even the contract":
  // changed by D-106 — the contract stays on every turn while the Director is on (assemble.ts); the
  // render half stands.
  test('a directive that says nothing renders to nothing', () => {
    expect(renderDirective({ mood: '', pacing: 'medium' })).toBe('');
  });

  test('the contract names the very header the injection uses', () => {
    expect(NARRATOR_AUTHORITY).toContain(`A block labeled ${DIRECTOR_HEADER}`);
    expect(contractText('Vera')).toContain(`A block labeled ${DIRECTOR_HEADER}`);
  });
});

describe('what the narrator reads', () => {
  test("the binding preamble, then the sections in RoleCall's order, then the ending hook", () => {
    const text = renderDirective(DIRECTIVE);
    const order = [
      'Mood: uneasy',
      'Pacing: Take your time.',
      'Scene Guidance:',
      'Tension: high (7/10)',
      'Include in this response:',
      'Avoid in this response:',
      'Narrative Goal:',
      'Story Arc Directions:',
      'Character Beats:',
      '[Ending: A bell, far off.]',
    ];
    const at = order.map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain('Do NOT second-guess');
    expect(text).toContain('  - "The Locked Room" (moderate): Someone avoids the corridor.');
    expect(text).toContain('  - Vera: Counts the lamps twice (old habit)');
  });

  test('a medium pace says nothing about pace', () => {
    expect(renderDirective({ ...DIRECTIVE, pacing: 'medium' })).not.toContain('Pacing:');
  });

  test('every section, every line format, exactly', () => {
    const full: NarratorDirective = {
      mood: 'tense',
      pacing: 'breakneck',
      sceneGuidance: { setting: 'the pier', atmosphere: 'fog', tension_level: 9 },
      include: { characters: ['Vera', 'Oskar'], themes: ['debt', 'salt'], sensoryDetails: ['tar', 'gulls'], foreshadowing: ['a loose plank', 'a red rope'] },
      avoid: { topics: ['the will'], characters: ['the mayor'], revelations: ['the key', 'the name'] },
      narrativeGoal: 'Oskar lies.',
      arcDirections: [{ arcName: 'Debts', instruction: 'Collect one.', urgency: 'forceful' }],
      callbacks: [{ reference: 'the bell', instruction: 'It rings once.' }],
      characterBeats: [{ character: 'Oskar', beat: 'Smiles too wide' }],
      dialogueGuidance: [
        { character: 'Oskar', tone: 'smooth', hints: ['short', 'no names'] },
        { character: 'Vera', tone: 'flat' },
      ],
      endingHook: 'A splash.',
    };
    expect(renderDirective(full)).toBe(
      [
        DIRECTOR_HEADER,
        'The following are non-negotiable scene constraints decided by the Story Director.',
        'They take precedence over any internal planning, director framework, or evaluation',
        'protocol you may otherwise apply to arc/callback/character-beat decisions.',
        'Your job is to render these constraints as excellent prose. Do NOT second-guess',
        'which arc to advance, which callback to weave in, or which character beat to hit -',
        'the Director has already made those decisions. Execute them.',
        '',
        'Mood: tense',
        'Pacing: Rapid fire. No pause. Urgent, breathless energy.',
        '',
        'Scene Guidance:',
        '  Setting: the pier',
        '  Atmosphere: fog',
        '  Tension: critical (9/10)',
        '',
        'Include in this response:',
        '  Characters: Vera, Oskar',
        '  Themes to touch on: debt, salt',
        '  Sensory emphasis: tar, gulls',
        '  Subtle details to weave in: a loose plank; a red rope',
        '',
        'Avoid in this response:',
        '  Topics: the will',
        '  Keep offscreen: the mayor',
        "  Don't reveal: the key, the name",
        '',
        'Narrative Goal: Oskar lies.',
        '',
        'Story Arc Directions:',
        '  - "Debts" (forceful): Collect one.',
        '',
        'Callbacks to weave in:',
        '  - Reference "the bell": It rings once.',
        '',
        'Character Beats:',
        '  - Oskar: Smiles too wide',
        '',
        'Dialogue guidance:',
        '  Oskar: smooth (short, no names)',
        '  Vera: flat',
        '',
        '[Ending: A splash.]',
        DIRECTOR_FOOTER,
      ].join('\n'),
    );
  });

  test('the pace lines are RoleCall’s', () => {
    expect(body(renderDirective({ pacing: 'slow' }))).toBe('Pacing: Take your time. Let moments breathe. Descriptive, contemplative.');
    expect(body(renderDirective({ pacing: 'fast' }))).toBe('Pacing: Keep things moving. Punchy sentences. Action-oriented.');
    expect(body(renderDirective({ pacing: 'breakneck' }))).toBe('Pacing: Rapid fire. No pause. Urgent, breathless energy.');
  });

  test('an empty mood section is not rendered: no blank line in front of the next section (RoleCall pushed one)', () => {
    expect(body(renderDirective({ mood: '', pacing: 'medium', endingHook: 'x' }))).toBe('[Ending: x]');
    expect(body(renderDirective({ mood: '', pacing: 'slow', endingHook: 'x' }))).toBe(
      'Pacing: Take your time. Let moments breathe. Descriptive, contemplative.\n\n[Ending: x]',
    );
    expect(body(renderDirective({ mood: 'grim', pacing: 'medium' }))).toBe('Mood: grim');
  });

  test("'Scene Guidance:' is not printed without a field (RoleCall printed it for {})", () => {
    expect(renderDirective({ pacing: 'medium', sceneGuidance: {} })).toBe('');
    expect(renderDirective({ pacing: 'medium', sceneGuidance: { setting: '  ' } })).toBe('');
    expect(body(renderDirective({ pacing: 'medium', sceneGuidance: { atmosphere: 'fog' } }))).toBe('Scene Guidance:\n  Atmosphere: fog');
  });

  test('tension: the word of the rounded level, the number rounded and kept in 0..10', () => {
    const line = (t: number) => body(renderDirective({ pacing: 'medium', sceneGuidance: { tension_level: t } })).split('\n')[1];
    expect(line(0)).toBe('  Tension: calm (0/10)');
    expect(line(1)).toBe('  Tension: calm (1/10)');
    expect(line(2)).toBe('  Tension: relaxed (2/10)');
    expect(line(7)).toBe('  Tension: high (7/10)');
    expect(line(10)).toBe('  Tension: explosive (10/10)');
    // RoleCall gave "unknown (5.5/10)"; Bunraku rounded the word only (rolecall.md §13 item 14).
    expect(line(5.5)).toBe('  Tension: building (6/10)');
    expect(line(12)).toBe('  Tension: explosive (10/10)');
    expect(line(-3)).toBe('  Tension: calm (0/10)');
    expect(renderDirective({ pacing: 'medium', sceneGuidance: { tension_level: Number.NaN } })).toBe('');
  });

  test('empty lists, whitespace-only texts and a medium pace are nothing: the directive renders to ""', () => {
    const nothing: NarratorDirective = {
      mood: '  ',
      pacing: 'medium',
      include: { characters: [], themes: [] },
      avoid: { topics: [] },
      arcDirections: [],
      callbacks: [],
      characterBeats: [],
      dialogueGuidance: [],
      narrativeGoal: '',
      endingHook: ' ',
      sceneGuidance: {},
    };
    expect(renderDirective(nothing)).toBe('');
    expect(renderDirective({ pacing: 'medium' })).toBe('');
  });

  test('a beat without motivation and a line without hints get no parentheses', () => {
    const text = renderDirective({ pacing: 'medium', characterBeats: [{ character: 'Vera', beat: 'Waits', motivation: '' }], dialogueGuidance: [{ character: 'Vera', tone: 'dry', hints: [] }] });
    expect(text).toContain('  - Vera: Waits\n');
    expect(text).toContain('  Vera: dry\n');
  });

  test('Russian text passes through as is', () => {
    const text = renderDirective({ mood: 'тревожно', pacing: 'medium', characterBeats: [{ character: 'Мира', beat: 'прячет письмо', motivation: 'страх' }] });
    expect(body(text)).toBe('Mood: тревожно\n\nCharacter Beats:\n  - Мира: прячет письмо (страх)');
  });

  test('an unknown pacing value from an old record renders no pace line', () => {
    expect(renderDirective({ pacing: 'glacial' as NarratorDirective['pacing'] })).toBe('');
  });
});

describe('the contract and the stub (D-106)', () => {
  test('one header with a hyphen for the contract, the directive and the stub', () => {
    expect(DIRECTOR_HEADER).toBe('[DIRECTOR CONSTRAINTS - BINDING THIS TURN]');
    expect(DIRECTOR_FOOTER).toBe('[/DIRECTOR CONSTRAINTS]');
    expect(STUB_DIRECTIVE).toBe('[DIRECTOR CONSTRAINTS - BINDING THIS TURN]\n(the Director plans this when the turn runs)\n[/DIRECTOR CONSTRAINTS]');
    // RoleCall's em dash never appears: the contract and the block must name the same header.
    expect(`${NARRATOR_AUTHORITY}${renderDirective(DIRECTIVE)}${STUB_DIRECTIVE}`).not.toContain('—');
  });

  // Changed (D-120): the language line follows the persona line.
  test('the contract is NARRATOR_AUTHORITY plus one line for the persona and one for the language', () => {
    expect(NARRATOR_AUTHORITY.startsWith('## Story Director Authority - CONTRACTUAL\n')).toBe(true);
    expect(NARRATOR_AUTHORITY.endsWith('You render clean prose that honors every constraint listed.')).toBe(true);
    expect(contractText('Елисей')).toBe(
      `${NARRATOR_AUTHORITY}\n\nNEVER act, speak or decide for Елисей.\nWrite the story in the language it is already written in; these constraints are in English only for you.`,
    );
  });

  test('D-120: the language line is the exact text of the note, the last line, right after the persona line', () => {
    expect(LANGUAGE_LINE).toBe('Write the story in the language it is already written in; these constraints are in English only for you.');
    for (const name of ['', 'Vera', 'Анна Мария']) {
      const lines = contractText(name).split('\n');
      expect(lines.at(-1)).toBe(LANGUAGE_LINE);
      expect(lines.at(-2)).toStartWith('NEVER act, speak or decide for ');
    }
    // One line, once: no blank line between them and no second copy.
    expect(contractText('Vera').split(LANGUAGE_LINE)).toHaveLength(2);
  });

  test('no persona name reads "the player"; a name is one line', () => {
    expect(contractText('')).toBe(`${NARRATOR_AUTHORITY}\n\nNEVER act, speak or decide for the player.\n${LANGUAGE_LINE}`);
    expect(contractText('   ')).toBe(contractText(''));
    expect(contractText(' Анна\nМария ').endsWith(`\nNEVER act, speak or decide for Анна Мария.\n${LANGUAGE_LINE}`)).toBe(true);
  });

  test('the contract does not depend on the directive: the head of the request stays cache-stable', () => {
    expect(contractText('Vera')).toBe(contractText('Vera'));
    expect(contractText('Vera').startsWith(NARRATOR_AUTHORITY)).toBe(true);
  });
});

// ---- summaryOf (D-105) --------------------------------------------------------------------------------

const stateOf = (over: Partial<DirectorState> = {}): DirectorState => ({
  turn: 3,
  nextId: 10,
  chapters: [],
  arcs: [],
  seeds: [],
  invisibleArcs: [],
  notes: [],
  pacing: { currentMood: 'ambient', turnsAtCurrentMood: 0, rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } },
  nextIntentions: [],
  ...over,
});
const arcOf = (id: string, over: Partial<DirectorArc> = {}): DirectorArc => ({
  id,
  title: `Arc ${id}`,
  description: 'd',
  status: 'building',
  priority: 'active',
  arcType: 'side',
  horizon: 'medium',
  stages: [{ title: 'opening', turn: 1 }],
  createdAtTurn: 1,
  ...over,
});
const seedOf = (id: string, over: Partial<DirectorSeed> = {}): DirectorSeed => ({
  id,
  hint: `hint ${id}`,
  payoff: 'p',
  scope: 'world',
  plantedAtTurn: 1,
  payoffHorizon: 'long',
  payoffDelivered: false,
  reinforcements: [],
  ...over,
});
const hiddenOf = (id: string): DirectorInvisibleArc => ({
  id,
  title: `Hidden ${id}`,
  description: 'd',
  arcType: 'conspiracy',
  horizon: 'medium',
  scope: 'world',
  status: 'building',
  stages: [],
  playerClues: [],
  createdAtTurn: 1,
});
const chapterOf = (n: number, over: Partial<DirectorChapter> = {}): DirectorChapter => ({
  id: `chapter-${n}`,
  number: n,
  title: `Chapter ${n}`,
  premise: '',
  status: 'active',
  themes: [],
  tone: '',
  majorGoal: '',
  createdAtTurn: 1,
  ...over,
});

describe('summaryOf', () => {
  test('the example of D-105: arcs +1 ~2 · seeds +1 -1 · hidden +1 · chapter 2', () => {
    const prev = stateOf({
      chapters: [chapterOf(1)],
      currentChapterId: 'chapter-1',
      arcs: [arcOf('arc-1'), arcOf('arc-2'), arcOf('arc-3')],
      seeds: [seedOf('seed-4'), seedOf('seed-5')],
      invisibleArcs: [hiddenOf('hidden-6')],
    });
    const next = stateOf({
      chapters: [chapterOf(1, { status: 'complete' }), chapterOf(2)],
      currentChapterId: 'chapter-2',
      arcs: [
        arcOf('arc-1', { stages: [{ title: 'opening', turn: 1 }, { title: 'the door opens', turn: 4 }] }),
        arcOf('arc-2', { status: 'climax' }),
        arcOf('arc-3', { description: 'a new description', priority: 'urgent' }),
        arcOf('arc-10'),
      ],
      seeds: [seedOf('seed-4', { payoffDelivered: true, payoffTurn: 4 }), seedOf('seed-5'), seedOf('seed-11')],
      invisibleArcs: [hiddenOf('hidden-6'), hiddenOf('hidden-12')],
    });
    expect(summaryOf(prev, next)).toBe('arcs +1 ~2 · seeds +1 -1 · hidden +1 · chapter 2');
  });

  test('nothing changed → "no changes"; a turn counter, a mood or an intention is not a change', () => {
    const s = stateOf({ arcs: [arcOf('arc-1')], seeds: [seedOf('seed-2')], currentChapterId: 'chapter-1', chapters: [chapterOf(1)] });
    expect(summaryOf(s, s)).toBe('no changes');
    expect(
      summaryOf(
        s,
        stateOf({
          ...s,
          turn: 4,
          pacing: { currentMood: 'tense', turnsAtCurrentMood: 1, rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } },
          nextIntentions: [{ type: 'twist', description: 'x', priority: 'must', targetTurn: 'next' }],
        }),
      ),
    ).toBe('no changes');
    expect(summaryOf(stateOf(), stateOf())).toBe('no changes');
  });

  test('only the non-zero parts are shown, each part on its own', () => {
    const prev = stateOf({ arcs: [arcOf('arc-1')], seeds: [seedOf('seed-2')] });
    expect(summaryOf(prev, stateOf({ ...prev, arcs: [arcOf('arc-1', { nextBeat: { description: 'b', plannedAtTurn: 3, status: 'pending' } })] }))).toBe('arcs ~1');
    expect(summaryOf(prev, stateOf({ ...prev, seeds: [] }))).toBe('seeds -1');
    expect(summaryOf(prev, stateOf({ ...prev, seeds: [seedOf('seed-2'), seedOf('seed-3')] }))).toBe('seeds +1');
    expect(summaryOf(prev, stateOf({ ...prev, invisibleArcs: [hiddenOf('hidden-3')] }))).toBe('hidden +1');
    expect(summaryOf(prev, stateOf({ ...prev, arcs: [arcOf('arc-1'), arcOf('arc-3'), arcOf('arc-4')] }))).toBe('arcs +2');
  });

  test('an arc that left the list is not a change; a paid seed that left it is not a removal', () => {
    const prev = stateOf({ arcs: [arcOf('arc-1', { status: 'complete' })], seeds: [seedOf('seed-2', { payoffDelivered: true })] });
    expect(summaryOf(prev, stateOf())).toBe('no changes');
  });

  test('the same arc written with its keys in another order is not a change', () => {
    const beat = { description: 'b', plannedAtTurn: 3, status: 'pending' as const };
    const prev = stateOf({ arcs: [arcOf('arc-1', { nextBeat: beat })] });
    const reordered = { status: 'pending' as const, plannedAtTurn: 3, description: 'b' };
    expect(summaryOf(prev, stateOf({ arcs: [arcOf('arc-1', { nextBeat: reordered })] }))).toBe('no changes');
  });

  test('D-123: a reinforced seed is seeds ~N; a plan that only reinforced does not read "no changes"', () => {
    const prev = stateOf({ seeds: [seedOf('seed-2', { reinforcements: [{ turn: 2 }] }), seedOf('seed-3')] });
    const reinforced = stateOf({ seeds: [seedOf('seed-2', { reinforcements: [{ turn: 2 }, { turn: 4 }] }), seedOf('seed-3', { reinforcements: [{ turn: 4 }] })] });
    expect(summaryOf(prev, reinforced)).toBe('seeds ~2');
    // + then ~ then -, as arcs; a seed reinforced and paid off this turn is a payoff only.
    const mixed = stateOf({
      seeds: [seedOf('seed-2', { reinforcements: [{ turn: 2 }, { turn: 4 }], payoffDelivered: true, payoffTurn: 4 }), seedOf('seed-3', { reinforcements: [{ turn: 4 }] }), seedOf('seed-9')],
    });
    expect(summaryOf(prev, mixed)).toBe('seeds +1 ~1 -1');
  });

  test('D-123: reinforcements fitState only shortened are not a change; an older newest one is not either', () => {
    const prev = stateOf({ seeds: [seedOf('seed-2', { reinforcements: [{ turn: 2 }, { turn: 3 }, { turn: 4 }, { turn: 5 }] })] });
    expect(summaryOf(prev, stateOf({ seeds: [seedOf('seed-2', { reinforcements: [{ turn: 4 }, { turn: 5 }] })] }))).toBe('no changes');
    // The capped list shifts when a fifth comes in: still one reinforcement.
    expect(summaryOf(prev, stateOf({ seeds: [seedOf('seed-2', { reinforcements: [{ turn: 3 }, { turn: 4 }, { turn: 5 }, { turn: 6 }] })] }))).toBe('seeds ~1');
  });

  test('D-123: a hidden arc with a new clue, a new stage or another status is hidden ~N', () => {
    const base = { ...hiddenOf('hidden-3'), playerClues: [{ turn: 1, clue: 'ink' }], stages: [{ title: 'met', turn: 1 }] };
    const prev = stateOf({ invisibleArcs: [base, hiddenOf('hidden-4'), hiddenOf('hidden-5'), hiddenOf('hidden-6')] });
    const next = stateOf({
      invisibleArcs: [
        { ...base, playerClues: [...base.playerClues, { turn: 4, clue: 'a coin' }] },
        { ...hiddenOf('hidden-4'), stages: [{ title: 'the guild moves', turn: 4 }] },
        { ...hiddenOf('hidden-5'), status: 'visible' },
        hiddenOf('hidden-6'),
        hiddenOf('hidden-7'),
      ],
    });
    expect(summaryOf(prev, next)).toBe('hidden +1 ~3');
    // A clue list fitState cut down to its newest entry is not a change, nor is a rewritten description.
    const cut = stateOf({ invisibleArcs: [{ ...base, playerClues: [{ turn: 1, clue: 'ink' }], description: 'other' }] });
    expect(summaryOf(stateOf({ invisibleArcs: [{ ...base, playerClues: [{ turn: 0, clue: 'old' }, { turn: 1, clue: 'ink' }] }] }), cut)).toBe('no changes');
  });

  test('chapter N when another chapter became current, from the list or else from its id', () => {
    const prev = stateOf({ chapters: [chapterOf(1)], currentChapterId: 'chapter-1' });
    expect(summaryOf(stateOf(), prev)).toBe('chapter 1');
    expect(summaryOf(prev, stateOf({ chapters: [chapterOf(1), chapterOf(2)], currentChapterId: 'chapter-2' }))).toBe('chapter 2');
    expect(summaryOf(prev, stateOf({ chapters: [], currentChapterId: 'chapter-7' }))).toBe('chapter 7');
    expect(summaryOf(prev, stateOf({ chapters: [chapterOf(1, { status: 'complete' })] }))).toBe('no changes');
  });
});
