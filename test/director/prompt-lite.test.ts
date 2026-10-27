// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The Director's lite profile (D-102, D-110): a new condensed system text (the job, THE TEST, the plan
// sections, the directive's fields, brevity) with the personality digest instead of the full block, the
// lite plan rules, and a user prompt without the Shadow World. Nothing in lite asks for hidden arcs:
// PLAN_SCHEMA_LITE has no invisibleArcUpdates.
import { describe, expect, test } from 'bun:test';
import { HOW_TO_ANSWER, PLAN_RULES, PLAN_RULES_LITE, systemPrompt, userPrompt, type SystemPromptInput, type UserPromptInput } from '../../src/agents/director/prompt.ts';
import { getPersonality, personalityDigest } from '../../src/agents/director/personalities/index.ts';
import { DIRECTOR_PERSONALITIES, type DirectorState } from '../../src/agents/director/types.ts';

const base: SystemPromptInput = { profile: 'lite', transport: 'structured', style: 'the-balanced', creativity: 'moderate', charName: 'Vera' };

/** The new rules text: everything before the creativity line. */
const rulesOf = (text: string): string => text.slice(0, text.indexOf('## Creativity Level'));

describe('the lite system prompt', () => {
  test('it is ≈ 7–9k chars for every personality, and the same text for the same settings', () => {
    for (const style of DIRECTOR_PERSONALITIES) {
      const n = systemPrompt({ ...base, style }).length;
      expect(n).toBeGreaterThan(7_000);
      expect(n).toBeLessThan(9_000);
    }
    expect(systemPrompt(base)).toBe(systemPrompt(base));
  });

  test('the new rules are about 60 lines with the lite plan rules, well under the full text', () => {
    const rules = rulesOf(systemPrompt(base));
    const lines = rules.trim().split('\n').length + PLAN_RULES_LITE.split('\n').length;
    expect(lines).toBeGreaterThan(45);
    expect(lines).toBeLessThan(80);
    expect(rules.length + PLAN_RULES_LITE.length).toBeGreaterThan(5_000);
    expect(rules.length + PLAN_RULES_LITE.length).toBeLessThan(8_000);
    expect(systemPrompt(base).length * 2).toBeLessThan(systemPrompt({ ...base, profile: 'full' }).length);
  });

  test("it carries the job, THE TEST, the directive's fields, brevity, the creativity line, the digest and the lite plan rules", () => {
    const text = systemPrompt({ ...base, creativity: 'dramatic', style: 'the-oracle' });
    for (const s of ['## Your Job', '## Information Asymmetry', '## The Player Character', 'THE TEST:', "## The Directive's Fields", '## Brevity', '## Creativity Level: DRAMATIC'])
      expect(text).toContain(s);
    for (const field of ['mood:', 'pacing:', 'narrativeGoal:', 'sceneGuidance:', 'arcDirections (up to 3):', 'characterBeats (up to 3):', 'callbacks (up to 2):', 'endingHook:'])
      expect(text).toContain(`- ${field}`);
    expect(text).toContain(personalityDigest(getPersonality('the-oracle')));
    expect(text.endsWith(PLAN_RULES_LITE)).toBe(true);
    expect(text.indexOf('## Creativity Level')).toBeLessThan(text.indexOf('## Your Storytelling Personality'));
  });

  test('none of the full text: no personality block, no full plan rules, no directive example', () => {
    const text = systemPrompt(base);
    expect(text).not.toContain('## STAGE');
    expect(text).not.toContain('SELF-AUDIT PROTOCOL');
    expect(text).not.toContain('DIRECTIVE EXAMPLE');
    expect(text).not.toContain('Vary Within Your Lane');
    expect(text).not.toContain(PLAN_RULES);
  });

  test('nothing in lite asks for hidden arcs, in either transport', () => {
    for (const transport of ['structured', 'tagged'] as const) {
      const text = systemPrompt({ ...base, transport, schemaText: '{"type":"object"}' });
      expect(text).not.toContain('invisibleArcUpdates');
      expect(text).not.toMatch(/shadow world|hidden arcs?\b/i);
      expect(text).not.toContain('commit_planning_round');
    }
  });

  test('tagged lite ends with the lite "How to answer" and the schema; structured has neither', () => {
    const schemaText = '{"type":"object","required":["directive","arcUpdates","seedUpdates","analysis","chapterUpdate"]}';
    const tagged = systemPrompt({ ...base, transport: 'tagged', schemaText });
    expect(tagged.endsWith(`\n\n${HOW_TO_ANSWER(true)}\n${schemaText}`)).toBe(true);
    expect(HOW_TO_ANSWER(true)).toContain('directive, arcUpdates, seedUpdates, analysis and chapterUpdate');
    expect(HOW_TO_ANSWER(true)).toContain('exactly one <plan>…</plan> block');
    expect(tagged.startsWith(systemPrompt(base))).toBe(true);
    expect(systemPrompt(base)).not.toContain('## How to answer');
  });

  test('without a persona THE TEST still holds, for "the player"; no persona heading', () => {
    const text = systemPrompt(base);
    expect(text).toContain('## The Player Character\nOnly the player writes the player\'s inner life.');
    expect(text).toContain('"Does this claim what the player THINKS, FEELS, NOTICES, REMEMBERS, REALIZES or DECIDES?"');
    expect(text).not.toContain('{{');
  });

  test('a name-only persona gets the rules by name (D-110); a description adds its text and the pronoun rule', () => {
    const named = systemPrompt({ ...base, persona: { name: 'Мира' } });
    expect(named).toContain('## The Player Character - "Мира"\nOnly the player writes Мира\'s inner life.');
    expect(named).toContain('"Does this claim what Мира THINKS, FEELS, NOTICES, REMEMBERS, REALIZES or DECIDES?"');
    expect(named).not.toContain('pronouns and gender');
    const described = systemPrompt({ ...base, persona: { name: 'Мира', description: 'Мира, ученица {{char}} (она/её). {{user}} не любит шум.' }, charName: 'Вера' });
    expect(described).toContain(
      '## The Player Character - "Мира"\nМира, ученица Вера (она/её). Мира не любит шум.\nUse the pronouns and gender this persona gives everywhere you write about Мира.\n',
    );
  });
});

describe('the lite user prompt', () => {
  const state: DirectorState = {
    turn: 4,
    nextId: 4,
    chapters: [],
    arcs: [{ id: 'arc-1', title: 'Долг Миры', description: 'Кредитор ждёт.', status: 'building', priority: 'active', arcType: 'main', horizon: 'short', stages: [], createdAtTurn: 1 }],
    seeds: [],
    invisibleArcs: [
      { id: 'hidden-2', title: 'Тайная бухгалтерия', description: 'Кто-то подделывает книги.', arcType: 'conspiracy', horizon: 'medium', scope: 'world', status: 'building', stages: [], playerClues: [], createdAtTurn: 1 },
    ],
    notes: [],
    pacing: { currentMood: 'тревожный', turnsAtCurrentMood: 1, rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } },
    nextIntentions: [],
  };
  const input = (over: Partial<UserPromptInput> = {}): UserPromptInput => ({
    profile: 'lite',
    state,
    turn: 5,
    momentumText: '[MOMENTUM REPORT]\nPacing is healthy.',
    worldText: '',
    userMessage: 'Я стучу.',
    instructions: '',
    history: '[Turn 1] user: Привет',
    historyCount: 1,
    ...over,
  });

  test('it has no Shadow World and never names invisibleArcUpdates, even with hidden arcs in the state', () => {
    const text = userPrompt(input());
    expect(text).not.toContain('Shadow World');
    expect(text).not.toContain('invisibleArcUpdates');
    expect(text).not.toContain('Тайная бухгалтерия');
    expect(userPrompt(input({ profile: 'full' }))).toContain('### Shadow World (Your Private Tracking)\nInvisible Arcs:\n- [hidden-2] "Тайная бухгалтерия"');
  });

  test('everything else is the full prompt, in the same order', () => {
    const lite = userPrompt(input());
    const full = userPrompt(input({ profile: 'full' }));
    const shadow = full.slice(full.indexOf('\n### Shadow World'), full.indexOf('\n---\n'));
    expect(full.replace(shadow, '')).toBe(lite);
    expect(lite).toContain('- [arc-1] Долг Миры (building, short horizon, 4 turns): Кредитор ждёт.');
    expect(lite.trimEnd().endsWith("Don't spoil your plans!")).toBe(true);
  });
});
