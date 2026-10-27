// Ported from Bunraku:src/core/director/prompts.test.ts@702d81201120a6b90eb29a783a77c60ffdebc374 (Coneja-Chibi:
// 0a4580d3, 38c29819), the system, user prompt, self-audit, conversation and budget tests.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Director's full prompts (D-64, D-110, A.3). Changed from Bunraku, each marked where it happens: the
// field names lose their `commit_planning_round.` prefix (A.3); ages are derived from createdAtTurn /
// plantedAtTurn (D-61); a name-only persona gets the rules (D-110); the history budget is in tokens through
// an injected counter (D-64); soft-removed items do not exist (rp-core evicts). The personality tests
// live in personalities.test.ts; the lite profile in prompt-lite.test.ts.
import { describe, expect, test } from 'bun:test';
import {
  HOW_TO_ANSWER,
  PLAN_RULES,
  historyLines,
  instructionsSection,
  LITE_SHOW_LIMITS,
  selfAuditSection,
  systemPrompt,
  userPrompt,
  type HistoryMessage,
  type SystemPromptInput,
  type UserPromptInput,
} from '../../src/agents/director/prompt.ts';
import { getPersonality } from '../../src/agents/director/personalities/index.ts';
import {
  DIRECTOR_CALL,
  DIRECTOR_PERSONALITIES,
  PROMPT_LIMITS,
  type DirectorArc,
  type DirectorInvisibleArc,
  type DirectorSeed,
  type DirectorState,
} from '../../src/agents/director/types.ts';

const STALE =
  /batch_update|set_directive|update_analysis|read_compendium_entry|update_relationship|add_arc\b|plant_seed|surface_invisible_arc|SINGLE JSON|Your Output Format|Game State Updates|dossier|commit_planning_round/;

// ---- builders (Bunraku fixtures.ts, cut down to the D-61 shape) --------------------------------------

const stateOf = (over: Partial<DirectorState> = {}): DirectorState => ({
  turn: 0,
  nextId: 1,
  chapters: [],
  arcs: [],
  seeds: [],
  invisibleArcs: [],
  notes: [],
  pacing: { currentMood: 'ambient', turnsAtCurrentMood: 0, rhythm: { lastActionSequence: 0, lastQuietMoment: 0 } },
  nextIntentions: [],
  ...over,
});
const arcOf = (over: Partial<DirectorArc> = {}): DirectorArc => ({
  id: 'arc-1',
  title: 'The Locked Room',
  description: 'A door nobody opens.',
  status: 'building',
  priority: 'active',
  arcType: 'side',
  horizon: 'medium',
  stages: [],
  createdAtTurn: 1,
  ...over,
});
const seedOf = (over: Partial<DirectorSeed> = {}): DirectorSeed => ({
  id: 'seed-1',
  hint: 'A cracked bell',
  payoff: 'It rings at the finale.',
  scope: 'world',
  plantedAtTurn: 1,
  payoffHorizon: 'long',
  payoffDelivered: false,
  reinforcements: [],
  ...over,
});
const hiddenOf = (over: Partial<DirectorInvisibleArc> = {}): DirectorInvisibleArc => ({
  id: 'hid-1',
  title: 'The Ledger Conspiracy',
  description: 'Someone is cooking the books.',
  arcType: 'conspiracy',
  horizon: 'medium',
  scope: 'world',
  status: 'building',
  stages: [],
  playerClues: [],
  createdAtTurn: 1,
  ...over,
});

/** A fake token counter: 4 chars a token, rounded up. */
const count = (s: string): number => Math.ceil(s.length / 4);

/** No lone surrogate half (a cut inside an emoji). */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

// ---- the system prompt ----------------------------------------------------------------------------

describe('the system prompt', () => {
  const base: SystemPromptInput = { profile: 'full', transport: 'structured', style: 'the-balanced', creativity: 'moderate', charName: 'Vera' };

  test('it is the same text every turn for the same settings (so it can be cached) and carries no story state', () => {
    expect(systemPrompt(base)).toBe(systemPrompt(base));
    expect(systemPrompt(base)).not.toContain('Current Story State');
    expect(systemPrompt(base)).not.toMatch(STALE);
  });

  test('it keeps the self-audit and the directive example, and the creativity setting changes its level block', () => {
    const dramatic = systemPrompt({ ...base, creativity: 'dramatic' });
    const subtle = systemPrompt({ ...base, creativity: 'subtle' });
    expect(dramatic).toContain('SELF-AUDIT PROTOCOL');
    expect(dramatic).toContain('DIRECTIVE EXAMPLE (ALWAYS FILL OUT FULLY)');
    expect(dramatic).toContain('## Creativity Level: DRAMATIC');
    expect(subtle).toContain('## Creativity Level: SUBTLE');
    expect(dramatic.replace('DRAMATIC', '')).not.toBe(subtle.replace('SUBTLE', ''));
  });

  // Changed (D-110): a name-only persona gets the rules too; Bunraku needed a description.
  test('the player-character rules appear only with a persona, named when it has a name', () => {
    expect(systemPrompt(base)).not.toContain('INTERIORITY vs STAGING');
    const text = systemPrompt({ ...base, persona: { name: 'Merlin', description: 'He is a tired wizard (he/him).' } });
    expect(text).toContain('## Player Character - "Merlin"\nHe is a tired wizard (he/him).');
    expect(text).toContain('INTERIORITY vs STAGING (Merlin)');
    expect(text).toContain('it cannot puppet Merlin');
    expect(text).not.toContain('${');
    expect(systemPrompt({ ...base, persona: { name: '', description: 'A wizard.' } })).toContain('claim what the player thinks/feels');
    const nameOnly = systemPrompt({ ...base, persona: { name: 'Merlin' } });
    expect(nameOnly).toContain('## Player Character - "Merlin"\nCRITICAL RULE:');
    expect(nameOnly).toContain('INTERIORITY vs STAGING (Merlin)');
    expect(nameOnly).toContain('"Does this entry try to claim what Merlin THINKS, FEELS, NOTICES, REMEMBERS, REALIZES, or DECIDES?"');
  });

  test("the chosen personality's block is in it, and Sage when none was chosen", () => {
    expect(systemPrompt({ ...base, style: 'the-jester' })).toContain(getPersonality('the-jester').name);
    expect(systemPrompt({ ...base, style: 'no-such-style' })).toContain('## Your Storytelling Personality: Sage "The Balanced"');
  });

  test('{{user}} becomes the persona name or "the player", {{char}} the card\'s name, in any case; nothing else is expanded', () => {
    const none = systemPrompt(base);
    expect(none).toContain("drama over the player's texts or social posts");
    expect(none).not.toContain('{{');
    const text = systemPrompt({
      ...base,
      persona: { name: 'Мира', description: 'Мира служит {{char}} и зовёт себя {{USER}}; {{random::a,b}} stays.' },
      charName: 'Вера',
    });
    expect(text).toContain('Мира служит Вера и зовёт себя Мира; {{random::a,b}} stays.');
    expect(text).toContain("drama over Мира's texts or social posts");
    expect(text).not.toMatch(/\{\{(user|char)\}\}/i);
    // A `$` in a name is not a replacement pattern.
    expect(systemPrompt({ ...base, persona: { name: '$& Co' } })).toContain("drama over $& Co's texts");
  });

  test('the plan rules are in it for both transports; tagged adds "How to answer" and the schema text at the end', () => {
    const structured = systemPrompt(base);
    expect(structured).toContain(PLAN_RULES);
    expect(structured.endsWith(PLAN_RULES)).toBe(true);
    expect(structured).not.toContain('## How to answer');
    expect(structured).not.toContain('<plan>');
    const schemaText = '{"type":"object","required":["directive"]}';
    const tagged = systemPrompt({ ...base, transport: 'tagged', schemaText });
    expect(tagged.startsWith(structured)).toBe(true);
    expect(tagged.endsWith(`${HOW_TO_ANSWER(false)}\n${schemaText}`)).toBe(true);
    expect(tagged).toContain('exactly one <plan>…</plan> block');
    expect(tagged).toContain('The directive must set at least one field.');
    expect(tagged).toContain('invisibleArcUpdates, analysis and chapterUpdate');
  });

  test('the full Sage prompt without a persona is within 10 % of the measured 19.5k chars (Bunraku 19 531 + the plan rules)', () => {
    const n = systemPrompt(base).length;
    expect(n).toBeGreaterThan(19_531 * 0.9);
    expect(n).toBeLessThan(19_531 * 1.1);
  });

  test('no prompt names commit_planning_round, for any personality, profile or transport', () => {
    for (const style of DIRECTOR_PERSONALITIES) {
      for (const profile of ['full', 'lite'] as const) {
        for (const transport of ['structured', 'tagged'] as const) {
          const text = systemPrompt({ ...base, style, profile, transport, schemaText: '{}', persona: { name: 'Merlin', description: 'A wizard.' } });
          expect(text).not.toContain('commit_planning_round');
          expect(text).not.toMatch(STALE);
        }
      }
    }
  });
});

// ---- the user prompt --------------------------------------------------------------------------------

describe('the user prompt', () => {
  const state = stateOf({
    chapters: [
      { id: 'chapter-1', number: 1, title: 'Arrival', premise: 'p', status: 'active', themes: ['debt'], tone: 'dark', majorGoal: 'Find Vera', createdAtTurn: 1 },
    ],
    currentChapterId: 'chapter-1',
    arcs: [
      arcOf({ lastProgressTurn: 1 }),
      arcOf({ id: 'arc-3', title: 'Beat Arc', nextBeat: { description: 'A knock', plannedAtTurn: 2, targetTurn: 9, status: 'pending' } }),
    ],
    // Changed: Bunraku's turnsActive: 12 is an age now — planted on turn 0, shown on turn 12.
    seeds: [seedOf({ plantedAtTurn: 0 })],
    invisibleArcs: [hiddenOf({ userAuthored: true })],
    notes: [{ id: 'n1', content: 'Keep Vera kind.', createdAtTurn: 1 }],
    nextIntentions: [{ type: 'advance_arc', description: 'Open the door', priority: 'must', targetTurn: 'next' }],
  });
  const history: HistoryMessage[] = [
    { role: 'assistant', name: 'Vera', text: 'Evening.' },
    { role: 'user', name: 'Merlin', text: 'Hi' },
  ];
  const input = (over: Partial<UserPromptInput> = {}): UserPromptInput => ({
    profile: 'full',
    state,
    turn: 12,
    momentumText: '[MOMENTUM REPORT]\nPacing is healthy. Continue the current rhythm.\nAll storylines progressing normally - no forced escalation needed.',
    worldText: '',
    userMessage: 'I knock.',
    instructions: '',
    history: historyLines(history, 10_000, count),
    historyCount: history.length,
    ...over,
  });

  // Changed (A.3): the fields are named bare, where Bunraku named commit_planning_round.X; "a" → "an arcUpdates entry".
  test('it names plan fields where RoleCall named tools, and nothing else the planner lacks', () => {
    const text = userPrompt(input());
    expect(text).not.toMatch(STALE);
    expect(text).toContain('(MANDATORY: send an arcUpdates entry');
    expect(text).toContain('send seedUpdates every turn');
    expect(text).toContain('NEXT BEAT: NONE SET - you MUST set one this turn via arcUpdates.nextBeat');
    expect(text).toContain('-> NEXT BEAT [set on turn 2] (target: turn 9): A knock');
    expect(text.trimEnd().endsWith("Don't spoil your plans!")).toBe(true);
    expect(userPrompt(input({ state: stateOf() }))).toContain('use invisibleArcUpdates in your plan to track hidden storylines');
  });

  // Changed: no soft-removed items in rp-core, so only the first half of Bunraku's test applies; ages are derived.
  test("the story state leads it, the user's action is in it", () => {
    const text = userPrompt(input());
    expect(text.indexOf('## Current Story State')).toBeLessThan(text.indexOf('### Chapters'));
    expect(text).toContain("### User's Action\nI knock.");
    expect(text).toContain('Current: Chapter 1: "Arrival" (active) - 11/50 turns');
    expect(text).toContain('[n1] Keep Vera kind.');
    expect(text).toContain('PLAYER-PLANTED');
    expect(text).toContain('OVERDUE (12/10 turns) - MUST resolve or advance this seed NOW');
  });

  test('a first chapter is demanded when there is none, a young chapter may not be closed, an old one is pressed', () => {
    expect(userPrompt(input({ state: stateOf() }))).toContain('chapterUpdate MUST use action "start_new" to create Chapter 1.');
    expect(userPrompt(input({ turn: 5 }))).toContain('must use action "none" or "update", never "start_new"');
    const old = stateOf({ ...state, chapters: [{ ...state.chapters[0]!, createdAtTurn: -200 }] });
    expect(userPrompt(input({ state: old, turn: 12 }))).toContain('OVERDUE: This chapter has EXCEEDED its maximum length');
    const ripe = stateOf({ ...state, chapters: [{ ...state.chapters[0]!, createdAtTurn: 0 }] });
    expect(userPrompt(input({ state: ripe, turn: 50 }))).toContain('This chapter has reached its target length.');
    expect(userPrompt(input({ state: ripe, turn: 40 }))).toContain('This chapter is approaching its target length.');
  });

  test('the person\'s instructions are in it, bounded, and only when there are some', () => {
    expect(userPrompt(input())).not.toContain('Custom Instructions');
    expect(userPrompt(input({ instructions: 'No sudden villains.' }))).toContain(
      "HIGH-PRIORITY STANDING DIRECTIVE)\nThese are the player's standing instructions for you, applied every turn. Honor them in your planning (arcs, seeds, beats, pacing, tone) unless doing so would violate safety, the character card, or the player-character POV rule.\nNo sudden villains.",
    );
    expect(instructionsSection('  ')).toBe('');
    expect(instructionsSection('x'.repeat(5_000)).length).toBeLessThan(2_400);
    expect(instructionsSection('x'.repeat(5_000))).toContain('x'.repeat(DIRECTOR_CALL.instructionsMax));
    expect(instructionsSection('x'.repeat(5_000))).not.toContain('x'.repeat(DIRECTOR_CALL.instructionsMax + 1));
    // Verbatim: macros are not expanded.
    expect(userPrompt(input({ instructions: 'Be kind to {{user}}.' }))).toContain('Be kind to {{user}}.');
  });

  // Changed: the momentum report and the self-audit come in as text (m4-decisions F seams).
  test('the momentum report is in it, and the self-audit is when the story has a directive and the narrator has written', () => {
    const audit = selfAuditSection({ mood: 'm', pacing: 'slow', narrativeGoal: 'Let her slip.' }, 'Evening.');
    const text = userPrompt(input({ selfAudit: audit }));
    expect(text).toContain('[MOMENTUM REPORT]');
    expect(text).toContain('[SELF-AUDIT] Your Directive From last turn');
    expect(text).toContain('Goal: Let her slip.');
    expect(userPrompt(input())).not.toContain('[SELF-AUDIT]');
  });

  test("the sections come in Bunraku's order, the world snapshot after the momentum report", () => {
    const text = userPrompt(
      input({
        worldText: '[COMPENDIUM CONTEXT]\nCharacters:\n- Vera',
        selfAudit: selfAuditSection({ pacing: 'slow', narrativeGoal: 'g' }, 'prose'),
        instructions: 'Keep it slow.',
      }),
    );
    const order = [
      '## Turn 12',
      '## Current Story State',
      '[MOMENTUM REPORT]',
      '[COMPENDIUM CONTEXT]',
      '[SELF-AUDIT]',
      '### Chapters',
      "### User's Action",
      '### Custom Instructions for DM',
      '### Conversation History (2 total turns)',
      '### Active Story Arcs',
      '### Pacing Status',
      '### Your Current Intentions',
      '### Pending Seeds',
      '### Shadow World (Your Private Tracking)',
      'Remember: The "directive" section',
    ];
    const at = order.map((s) => text.indexOf(s));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(userPrompt(input())).not.toContain('[COMPENDIUM CONTEXT]');
    expect(userPrompt(input({ worldText: '   ' }))).toBe(userPrompt(input()));
  });

  test('a guided re-roll adds one line to the player\'s turn (D-104)', () => {
    const text = userPrompt(input({ guidance: '  less talking, more action ' }));
    expect(text).toContain("### User's Action\nI knock.\nThe player asked for a new version of the last answer: less talking, more action\n");
    expect(userPrompt(input({ guidance: '  ' }))).toBe(userPrompt(input()));
  });

  test('the conversation section holds the history text and its count', () => {
    const text = userPrompt(input());
    expect(text).toContain('### Conversation History (2 total turns)\n[Turn 1] assistant: Evening.\n\n[Turn 2] user: Hi\n');
  });

  test('pacing status: the mood from the state, the phase from the chapter, the rhythm lines only when the caller says so', () => {
    const quiet = userPrompt(input());
    expect(quiet).toContain('### Pacing Status\nCurrent mood: ambient (0 turns)\nChapter phase: development\n\n');
    expect(quiet).not.toContain('Consider slowing down');
    const loud = userPrompt(input({ rhythm: { needsQuietMoment: true, needsTension: true } }));
    expect(loud).toContain('Consider slowing down - too much action recently\nConsider adding tension - too quiet for too long');
    const concluding = stateOf({ ...state, chapters: [{ ...state.chapters[0]!, status: 'concluding' }] });
    expect(userPrompt(input({ state: concluding }))).toContain('Chapter phase: concluding');
  });

  test('ages are derived from the turn: arcs from createdAtTurn, hidden arcs OVERDUE by their horizon', () => {
    const s = stateOf({
      arcs: [arcOf({ createdAtTurn: 4 })],
      invisibleArcs: [hiddenOf({ horizon: 'short', createdAtTurn: 7 }), hiddenOf({ id: 'hid-2', horizon: 'long', createdAtTurn: 10 })],
    });
    const text = userPrompt(input({ state: s, turn: 12 }));
    expect(text).toContain('- [arc-1] The Locked Room (building, medium horizon, 8 turns)');
    expect(text).toContain('(OVERDUE 5/3 - MUST advance/surface/resolve NOW)');
    expect(text).toContain('[hid-2] "The Ledger Conspiracy" [building, conspiracy, long] (2/10 turns)');
    // A future createdAtTurn (bad data) never gives a negative age.
    expect(userPrompt(input({ state: stateOf({ arcs: [arcOf({ createdAtTurn: 99 })] }), turn: 12 }))).toContain('medium horizon, 0 turns)');
  });

  test('Russian story text passes through intact', () => {
    const s = stateOf({
      arcs: [arcOf({ title: 'Долг Миры', description: 'Ёлка во дворе помнит всё. «Кто открыл дверь?»' })],
      seeds: [seedOf({ hint: 'Треснувший колокол', payoff: 'Зазвонит в финале.' })],
    });
    const text = userPrompt(input({ state: s, userMessage: 'Я стучу в дверь — тихо.' }));
    expect(text).toContain('- [arc-1] Долг Миры (building, medium horizon, 11 turns): Ёлка во дворе помнит всё. «Кто открыл дверь?»');
    expect(text).toContain('- [long] "Треснувший колокол" (id: seed-1, OVERDUE (11/10 turns) - MUST resolve or advance this seed NOW, 0 reinforcements): Зазвонит в финале.');
    expect(text).toContain("### User's Action\nЯ стучу в дверь — тихо.");
  });
});

// ---- the self-audit -----------------------------------------------------------------------------------

describe('the self-audit', () => {
  // Changed: the directive is always given (the caller runs the audit only when there is one, D-110), so
  // Bunraku's "no directive" assertion is gone; `ago` is optional and 1 by default.
  test('nothing without a directive or without prose; the prose is cut to its head and tail at 2,400 characters', () => {
    expect(selfAuditSection({ mood: 'm', pacing: 'slow', narrativeGoal: 'g' }, '')).toBe('');
    expect(selfAuditSection({ mood: 'm', pacing: 'slow', narrativeGoal: 'g' }, '  \n ')).toBe('');
    expect(selfAuditSection({ mood: '', pacing: '' as never }, 'prose')).toBe('');
    const long = `${'a'.repeat(2_000)}${'b'.repeat(2_000)}`;
    const block = selfAuditSection({ mood: 'm', pacing: 'slow' }, long, 4);
    expect(block).toContain('4 turns ago');
    expect(block).toContain('[... 1600 chars truncated ...]');
    expect(block).toContain('a'.repeat(DIRECTOR_CALL.selfAuditChars / 2));
    expect(block).not.toContain('a'.repeat(DIRECTOR_CALL.selfAuditChars / 2 + 1));
    expect(selfAuditSection({ mood: 'm', pacing: 'slow' }, 'prose')).toContain('Your Directive From last turn');
  });

  test('every planned part of the directive is listed', () => {
    const block = selfAuditSection(
      {
        mood: 'тревожный',
        pacing: 'slow',
        narrativeGoal: 'Пусть Вера проговорится.',
        arcDirections: [{ arcName: 'Долг', instruction: 'Кредитор стучит.', urgency: 'forceful' }],
        callbacks: [{ reference: 'колокол', instruction: 'Звон вдалеке.' }],
        characterBeats: [{ character: 'Вера', beat: 'Прячет письмо.' }],
        endingHook: 'Стук в дверь.',
      },
      'Вера молчит.',
    );
    expect(block).toContain(
      'YOUR DIRECTIVE WAS:\nMood/Pacing: тревожный / slow\nGoal: Пусть Вера проговорится.\nArc Directions:\n  - [forceful] "Долг": Кредитор стучит.\nCallbacks:\n  - "колокол": Звон вдалеке.\nCharacter Beats:\n  - Вера: Прячет письмо.\nEnding Hook: Стук в дверь.\n\nNARRATOR\'S ACTUAL PROSE:\nВера молчит.\n',
    );
  });

  test('a cut never splits an emoji', () => {
    const prose = '😀'.repeat(2_000);
    const block = selfAuditSection({ mood: 'm', pacing: 'slow' }, prose);
    expect(wellFormed(block)).toBe(true);
  });
});

// ---- the conversation --------------------------------------------------------------------------------

describe('the conversation', () => {
  const msgs = (n: number, text = (i: number) => `m${i}`): HistoryMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', name: i % 2 ? 'Vera' : 'Merlin', text: text(i) }));

  test('only the newest 30 messages are shown, labeled by turn, with a note of the rest', () => {
    const text = historyLines(msgs(40), 100_000, count);
    expect(text.startsWith('[10 earlier messages omitted')).toBe(true);
    expect(text).toContain('[Turn 11] user: m10');
    expect(text).not.toContain('m9\n');
    expect(text.endsWith('[Turn 40] assistant: m39')).toBe(true);
    expect(historyLines(msgs(DIRECTOR_CALL.historyMessages), 100_000, count).startsWith('[Turn 1] user: m0')).toBe(true);
  });

  // Changed (D-64): the budget is in tokens (25 % / 10 % of the Director's window), counted by the caller's counter.
  test('the whole fits the budget: a huge reply is clipped from its middle and older messages are left out', () => {
    const budget = 6_000;
    const history: HistoryMessage[] = [
      { role: 'user', name: 'Merlin', text: 'old' },
      { role: 'assistant', name: 'Vera', text: `${'x'.repeat(budget * 4)}${'y'.repeat(budget * 4)}` },
    ];
    const text = historyLines(history, budget, count);
    expect(count(text)).toBeLessThanOrEqual(budget);
    expect(count(text)).toBeGreaterThan(budget * 0.9);
    expect(text).toContain('characters omitted from the middle of this message');
    expect(text).toContain('[1 earlier messages omitted');
    expect(text).toMatch(/^\[1 earlier messages omitted[^\n]*\n\n\[Turn 2\] assistant: x+\n\[\d+ characters omitted from the middle of this message\]\ny+$/);
    expect(historyLines([], budget, count)).toBe('');
  });

  test('the budget holds for any mix of sizes, and the newest message is never dropped while it fits', () => {
    for (const budget of [80, 200, 1_000, 5_000]) {
      for (const size of [10, 300, 2_000, 9_000]) {
        const history = msgs(35, (i) => `${i}:${'z'.repeat(size + i * 7)}`);
        const text = historyLines(history, budget, count);
        expect(count(text)).toBeLessThanOrEqual(budget);
        const newest = history[34]!;
        if (count(`[Turn 35] ${newest.role}: ${newest.text}`) + 40 <= budget) expect(text).toContain(`[Turn 35] ${newest.role}: 34:`);
        else if (budget >= 200) expect(text).toContain(`[Turn 35] ${newest.role}: 34:`); // cut, not dropped
      }
    }
    // Too small for even the note: nothing.
    expect(historyLines(msgs(3), 5, count)).toBe('');
  });

  test('a message is cut only when at least 64 tokens of it fit; otherwise it is left out', () => {
    const history: HistoryMessage[] = [
      { role: 'user', name: 'Merlin', text: 'q'.repeat(4_000) },
      { role: 'assistant', name: 'Vera', text: 'short answer' },
    ];
    const tight = historyLines(history, 70, count);
    expect(tight).toBe('[1 earlier messages omitted from Director history due to the recent-history budget]\n\n[Turn 2] assistant: short answer');
    const roomy = historyLines(history, 200, count);
    expect(roomy).toContain('[Turn 1] user: qqq');
    expect(count(roomy)).toBeLessThanOrEqual(200);
  });

  test('Russian text is kept intact, and a cut keeps its head and tail whole (with a real tokenizer-like counter too)', () => {
    const ru = 'Ёлка во дворе помнит всё; «Мира, открой!» — крикнула Вера. ';
    const history: HistoryMessage[] = [
      { role: 'assistant', name: 'Вера', text: 'Добрый вечер, путник.' },
      { role: 'user', name: 'Мира', text: 'Привет! Я стучу в дверь.' },
      { role: 'assistant', name: 'Вера', text: `НАЧАЛО ${ru.repeat(400)}😀 КОНЕЦ` },
    ];
    const whole = historyLines(history.slice(0, 2), 1_000, count);
    expect(whole).toBe('[Turn 1] assistant: Добрый вечер, путник.\n\n[Turn 2] user: Привет! Я стучу в дверь.');
    // Cyrillic is denser in tokens: 2.5 chars a token.
    const cyr = (s: string): number => Math.ceil(s.length / 2.5);
    for (const counter of [count, cyr]) {
      const text = historyLines(history, 2_000, counter);
      expect(counter(text)).toBeLessThanOrEqual(2_000);
      expect(text).toContain('[Turn 3] assistant: НАЧАЛО Ёлка во дворе помнит всё; «Мира, открой!»');
      expect(text).toContain('😀 КОНЕЦ');
      expect(text).toContain('characters omitted from the middle of this message');
      expect(wellFormed(text)).toBe(true);
    }
  });
});

// ---- the stated budget ---------------------------------------------------------------------------

describe('the planner prompt has a stated budget', () => {
  const huge = (n: number) => 'd'.repeat(n);
  // Changed: the state is bigger than the D-61 caps on purpose (the prompt must cap anyway); ages come from
  // plantedAtTurn / createdAtTurn at turn 500 instead of Bunraku's turnsActive.
  const state = stateOf({
    arcs: Array.from({ length: 300 }, (_, i) =>
      arcOf({
        id: `arc-${i}`,
        title: `Arc ${i}`,
        description: huge(1_200),
        lastProgressTurn: i,
        nextBeat: { description: huge(1_200), plannedAtTurn: 1, status: 'pending' },
      }),
    ),
    seeds: Array.from({ length: 400 }, (_, i) => seedOf({ id: `seed-${i}`, hint: `Seed ${i}`, payoff: huge(1_200), plantedAtTurn: 500 - (i % 30) })),
    invisibleArcs: [
      ...Array.from({ length: 200 }, (_, i) => hiddenOf({ id: `hid-${i}`, title: `Hidden ${i}`, description: huge(1_200), createdAtTurn: 500 - i })),
      hiddenOf({ id: 'mine', title: 'Mine', userAuthored: true, createdAtTurn: 500 }),
    ],
    notes: Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, content: `note ${i}`, createdAtTurn: i })),
  });
  const text = userPrompt({
    profile: 'full',
    state,
    turn: 500,
    momentumText: '[MOMENTUM REPORT]',
    worldText: '',
    userMessage: 'go',
    instructions: '',
    history: '',
    historyCount: 0,
  });

  test('lists are capped, the rest are counted, long texts are clipped, and the whole stays within a stated size', () => {
    expect(text.split('\n').filter((l) => l.startsWith('- [arc-')).length).toBe(PROMPT_LIMITS.arcs);
    expect(text).toContain(`(+${300 - PROMPT_LIMITS.arcs} more active arcs not shown)`);
    expect(text).toContain(`(+${400 - PROMPT_LIMITS.seeds} more pending seeds not shown)`);
    expect(text).toContain('more hidden arcs not shown');
    expect(text).toContain('(+170 more older notes not shown)');
    expect(text).not.toContain(huge(PROMPT_LIMITS.text + 1));
    expect(text.length).toBeLessThan(70_000);
  });

  test("what needs action is never the part cut: the arcs longest without progress come first, the most overdue seeds come first, and the person's own hidden arc is always sent", () => {
    expect(text).toContain('[arc-0]');
    expect(text).not.toContain('[arc-299]');
    expect(text).toContain('[hid-199]');
    expect(text).toContain('PLAYER-PLANTED');
    expect(text).toContain('[n199]');
    expect(text).not.toContain('[n0]');
    expect(text).toContain('(id: seed-29, OVERDUE (29/10 turns)');
  });

  test('an arc that never progressed is as stale as its age (sorted by lastProgressTurn ?? createdAtTurn)', () => {
    const s = stateOf({
      arcs: [
        ...Array.from({ length: 30 }, (_, i) => arcOf({ id: `arc-${i}`, createdAtTurn: 50, lastProgressTurn: 60 + i })),
        arcOf({ id: 'arc-old', createdAtTurn: 2 }),
      ],
    });
    const t = userPrompt({ profile: 'full', state: s, turn: 100, momentumText: '', worldText: '', userMessage: 'go', instructions: '', history: '', historyCount: 0 });
    expect(t).toContain('[arc-old]');
    expect(t.indexOf('[arc-old]')).toBeLessThan(t.indexOf('[arc-0]'));
  });
});

// ---- D-121: shorter lists for a prompt that must fit a small window ----------------------------------

describe('LITE_SHOW_LIMITS: the shrunk lists of a lite prompt (D-121)', () => {
  const state = stateOf({
    arcs: Array.from({ length: 20 }, (_, i) =>
      arcOf({
        id: `arc-${i}`,
        title: `Arc ${i}`,
        createdAtTurn: 1,
        lastProgressTurn: 100 - i, // arc-0 progressed last, arc-19 longest ago
        stages: Array.from({ length: 5 }, (_, k) => ({ title: `Stage ${i}.${k}`, description: '', turn: k + 1 })),
      }),
    ),
    seeds: Array.from({ length: 30 }, (_, i) =>
      seedOf({ id: `seed-${i}`, hint: `Seed ${i}`, plantedAtTurn: 10 + i, reinforcements: i === 0 ? [{ turn: 99 }] : [] }),
    ),
  });
  const input: UserPromptInput = { profile: 'lite', state, turn: 101, momentumText: '', worldText: '', userMessage: 'go', instructions: '', history: '', historyCount: 0 };
  const shrunk = userPrompt({ ...input, limits: LITE_SHOW_LIMITS });
  const normal = userPrompt(input);
  const section = (text: string, head: string): string => {
    const at = text.indexOf(head);
    return text.slice(at, text.indexOf('\n### ', at + head.length));
  };

  test('8 arcs, 10 seeds, 2 stages an arc; the rest counted', () => {
    expect(LITE_SHOW_LIMITS).toEqual({ arcs: 8, seeds: 10, hidden: 0, arcStages: 2 });
    const arcs = section(shrunk, '### Active Story Arcs');
    expect(arcs.split('\n').filter((l) => l.startsWith('- [arc-')).length).toBe(8);
    expect(arcs).toContain('(+12 more active arcs not shown)');
    expect(arcs).toContain(' · (+3 earlier)');
    expect(arcs.split('\n').filter((l) => l.startsWith(' · Stage')).length).toBe(16);
    const seeds = section(shrunk, '### Pending Seeds');
    expect(seeds.split('\n').filter((l) => l.startsWith('- [')).length).toBe(10);
    expect(seeds).toContain('(+20 more pending seeds not shown)');
    const story = section(shrunk, '## Current Story State');
    expect(story.split('\n').filter((l) => l.startsWith('- "Arc')).length).toBe(8);
    expect(story).toContain('(+12 more arcs not shown)');
  });

  test('the items left out are the ones whose last progress is oldest', () => {
    const arcs = section(shrunk, '### Active Story Arcs');
    for (let i = 0; i < 8; i++) expect(arcs).toContain(`[arc-${i}] Arc ${i}`);
    expect(arcs).not.toContain('[arc-8]');
    const seeds = section(shrunk, '### Pending Seeds');
    // seed-0 was planted first but reinforced last; then the newest plantings.
    expect(seeds).toContain('(id: seed-0,');
    for (let i = 21; i < 30; i++) expect(seeds).toContain(`(id: seed-${i},`);
    expect(seeds).not.toContain('(id: seed-20,');
    const story = section(shrunk, '## Current Story State');
    expect(story).toContain('"Arc 0"');
    expect(story).not.toContain('"Arc 8"');
  });

  test('without limits the prompt is as before: PROMPT_LIMITS, the stalest arcs first, no extra lines', () => {
    expect(normal.split('\n').filter((l) => l.startsWith('- [arc-')).length).toBe(20);
    expect(normal).not.toContain('more arcs not shown');
    expect(normal).toContain(' · Stage 0.0');
    expect(normal.indexOf('[arc-19]')).toBeLessThan(normal.indexOf('[arc-0]'));
    expect(shrunk.length).toBeLessThan(normal.length);
  });

  test('the full profile keeps the player-planted hidden arcs under hidden: 0', () => {
    const s = stateOf({ invisibleArcs: [hiddenOf({ id: 'hid-a' }), hiddenOf({ id: 'hid-mine', userAuthored: true })] });
    const text = userPrompt({ ...input, profile: 'full', state: s, limits: LITE_SHOW_LIMITS });
    expect(text).toContain('[hid-mine]');
    expect(text).not.toContain('[hid-a]');
    expect(text).toContain('(+1 more hidden arcs not shown)');
  });
});
