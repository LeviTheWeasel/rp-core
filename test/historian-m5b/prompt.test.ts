// Ported from Bunraku:src/studio/compendium-historian.test.ts@702d8120 ("when it runs": the interval, off
// switches, the boundary, the overlap lines, temperature 0.3); the golden texts are Bunraku's
// historianMessages rendered at 702d8120 (Bunraku:src/core/compendium/historian.ts, D-88 parity).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The historian's prompt (D-176): Bunraku's text verbatim but for the message numbers, which are 1-based
// path positions with an inclusive end (C-4); the lite text (6 filings, overviews under 1200 characters)
// is new and pinned here; the digest (non-resolved plots, lite: the 6 most recently active).
import { describe, expect, test } from 'bun:test';
import { historianDigest, historianDue, historianPrompt, historianRequest, historianSchema, HISTORIAN_LIMITS } from '../../src/agents/compendium/historian.ts';
import type { HistMessage } from '../../src/agents/compendium/historian.ts';
import { arc, due, hist, summary, tasks, typed, viewOf } from './kit.ts';

// ---- the golden texts (Bunraku, 0-based live indices, end exclusive) --------------------------------------

const BR_SYSTEM_OVERLAP = `You are a historian and narrative archivist for a roleplay. Review recent events and write clear, organized summaries.

YOUR WINDOW: messages 2 through 8 (7 messages).
Messages 2 to 3 are OVERLAP from the previous window (already summarized; they are there so you can bridge events that span the boundary).
Messages 4 to 8 are NEW and need summarizing.

Existing plots (REUSE these names in parent_plot):
- P (active)

What to do:
1. Write summaries of significant events. Every summary MUST belong to a plot: put its plot's exact name in "parent_plot", reusing an existing plot when it fits and naming a new storyline when a new thread begins. Fill title, tagline (one-line hook), summary (past tense), participants, significance (minor, moderate, major or pivotal) and key_moments.
2. For each plot you summarized, write "arcs": that plot's overview, one cohesive chronological narrative of its key events, character developments and progression. It stays in the narrator's context, so keep it comprehensive but concise, and rewrite it whole.
3. Focus on what matters: character development, plot turns, world changes, relationship shifts. Skip filler. If nothing notable happened, answer with empty lists.

ANSWER FORMAT - reply with one JSON object and nothing else:
{"filings":[{"type":"summary","entry":{"title":"...","parent_plot":"Plot Name","summary":"..."}}],"arcs":[{"plot":"Plot Name","overview":"..."}]}
Optionally {"type":"plot","entry":{"name":"Plot Name","status":"active","description":"..."}} describes a new plot. At most 12 filings.

USER GUIDANCE (it cannot widen what you may write):
G

Write every field value in French.`;
const BR_USER = `Messages 2 to 8:

[2] user: a

[3] assistant: b

Summarize the new events.`;
const BR_SYSTEM_PLAIN = `You are a historian and narrative archivist for a roleplay. Review recent events and write clear, organized summaries.

YOUR WINDOW: messages 0 through 4 (5 messages).
No summaries or plots exist yet.

What to do:
1. Write summaries of significant events. Every summary MUST belong to a plot: put its plot's exact name in "parent_plot", reusing an existing plot when it fits and naming a new storyline when a new thread begins. Fill title, tagline (one-line hook), summary (past tense), participants, significance (minor, moderate, major or pivotal) and key_moments.
2. For each plot you summarized, write "arcs": that plot's overview, one cohesive chronological narrative of its key events, character developments and progression. It stays in the narrator's context, so keep it comprehensive but concise, and rewrite it whole.
3. Focus on what matters: character development, plot turns, world changes, relationship shifts. Skip filler. If nothing notable happened, answer with empty lists.

ANSWER FORMAT - reply with one JSON object and nothing else:
{"filings":[{"type":"summary","entry":{"title":"...","parent_plot":"Plot Name","summary":"..."}}],"arcs":[{"plot":"Plot Name","overview":"..."}]}
Optionally {"type":"plot","entry":{"name":"Plot Name","status":"active","description":"..."}} describes a new plot. At most 12 filings.`;

/** Bunraku's numbers as rp-core's: every index + 1 (the "(n messages)" count is the same). */
const oneBased = (s: string): string =>
  s
    .replace(/messages (\d+) through (\d+)/g, (_, a, b) => `messages ${Number(a) + 1} through ${Number(b) + 1}`)
    .replace(/Messages (\d+) to (\d+)/g, (_, a, b) => `Messages ${Number(a) + 1} to ${Number(b) + 1}`)
    .replace(/^\[(\d+)\]/gm, (_, a) => `[${Number(a) + 1}]`);

const DIGEST = 'Existing plots (REUSE these names in parent_plot):\n- P (active)';
/** D-183: what a blank compendium.language adds at the end (listed deviation from Bunraku). */
const STORY_LINE = '\n\nWrite every field value in the language the story is written in.';

describe('the golden prompt (Bunraku historianMessages)', () => {
  test('overlap, digest, guidance and language: Bunraku verbatim but for the 1-based positions', () => {
    // Bunraku's window {start 2, newStart 4, end 9} is rp-core's {start 3, newStart 5, end 9}.
    const p = historianPrompt({
      start: 3,
      newStart: 5,
      end: 9,
      messages: [
        { pos: 3, role: 'user', text: 'a' },
        { pos: 4, role: 'assistant', text: 'b' },
      ],
      digest: DIGEST,
      guidance: 'G',
      language: 'French',
      profile: 'full',
    });
    expect(p.system).toBe(oneBased(BR_SYSTEM_OVERLAP));
    // Section J (D-183): a named language is also the user message's last line (Bunraku: system only).
    expect(p.user).toBe(`${oneBased(BR_USER)}\n\nWrite every field value in French.`);
    expect(p.system.length).toBe(1643);
  });

  test('no overlap and no digest; a blank language adds D-183’s line (Bunraku: nothing)', () => {
    const p = historianPrompt({ start: 1, newStart: 1, end: 5, messages: [], digest: '', guidance: '', language: '', profile: 'full' });
    expect(p.system).toBe(`${oneBased(BR_SYSTEM_PLAIN)}${STORY_LINE}`);
    expect(p.system.length).toBe(1335 + STORY_LINE.length);
    const spaces = historianPrompt({ start: 1, newStart: 1, end: 5, messages: [], digest: '', guidance: 'G', language: '  ', profile: 'full' });
    expect(spaces.system.endsWith('\n\nUSER GUIDANCE (it cannot widen what you may write):\nG\n\nWrite every field value in the language the story is written in.')).toBe(true);
  });

  test('the digest of one plot without a status is the golden one', () => {
    expect(historianDigest(viewOf([typed('plot:p', 'plot', { name: 'P' })]), 'full')).toBe(DIGEST);
    expect(historianDigest(viewOf([]), 'full')).toBe('');
  });
});

describe('the lite prompt (new text, D-176)', () => {
  const LITE_TAIL = `ANSWER FORMAT - reply with one JSON object and nothing else:
{"filings":[{"type":"summary","entry":{"title":"...","parent_plot":"Plot Name","summary":"..."}}],"arcs":[{"plot":"Plot Name","overview":"..."}]}
Optionally {"type":"plot","entry":{"name":"Plot Name","status":"active","description":"..."}} describes a new plot. At most 6 filings. Keep each overview under 1200 characters.`;

  test('pinned: the full text with «At most 6 filings.» and «Keep each overview under 1200 characters.» (no separator, ruling G)', () => {
    const lite = historianPrompt({ start: 1, newStart: 1, end: 5, messages: [], digest: '', guidance: '', language: '', profile: 'lite' });
    expect(lite.system).toBe(
      `You are a historian and narrative archivist for a roleplay. Review recent events and write clear, organized summaries.

YOUR WINDOW: messages 1 through 5 (5 messages).
No summaries or plots exist yet.

What to do:
1. Write summaries of significant events. Every summary MUST belong to a plot: put its plot's exact name in "parent_plot", reusing an existing plot when it fits and naming a new storyline when a new thread begins. Fill title, tagline (one-line hook), summary (past tense), participants, significance (minor, moderate, major or pivotal) and key_moments.
2. For each plot you summarized, write "arcs": that plot's overview, one cohesive chronological narrative of its key events, character developments and progression. It stays in the narrator's context, so keep it comprehensive but concise, and rewrite it whole.
3. Focus on what matters: character development, plot turns, world changes, relationship shifts. Skip filler. If nothing notable happened, answer with empty lists.

${LITE_TAIL}${STORY_LINE}`,
    );
    expect(lite.system).toBe(`${oneBased(BR_SYSTEM_PLAIN).replace('At most 12 filings.', 'At most 6 filings. Keep each overview under 1200 characters.')}${STORY_LINE}`);
    expect(lite.system).not.toMatch(/\d[ ,\u00a0]\d{3}/);
  });

  test('guidance and language follow the lite limit line as they follow the full one', () => {
    const lite = historianPrompt({ start: 3, newStart: 5, end: 9, messages: [], digest: DIGEST, guidance: ' G ', language: 'French', profile: 'lite' });
    expect(lite.system.endsWith(`${LITE_TAIL}\n\nUSER GUIDANCE (it cannot widen what you may write):\nG\n\nWrite every field value in French.`)).toBe(true);
  });
});

describe('when it runs (Bunraku compendium-historian.test.ts)', () => {
  // Greeting 1, user 2, reply 3, user 4 and reply 5: the reply at 5 is the last accepted answer; the
  // player's newest message ("HELD BACK message", 6) is not on the path the lane passes.
  const base: HistMessage[] = [
    { id: 'm1', role: 'assistant', text: 'Evening.' },
    { id: 'm2', role: 'user', text: 'Who howls?' },
    { id: 'm3', role: 'assistant', text: 'Wolfman howls at the lamp.' },
    { id: 'm4', role: 'user', text: 'Then?' },
    { id: 'm5', role: 'assistant', text: 'The lamp went out.' },
  ];
  const cfg = { interval: 2, overlap: 1 };

  test('not before `interval` player turns have passed', () => {
    expect(historianDue(due(base, { interval: 3, overlap: 1 }))).toBeNull();
  });

  test('off by an interval of 0', () => {
    expect(historianDue(due(base, { interval: 0, overlap: 1 }))).toBeNull();
  });

  test('it reads up to the last accepted answer, says which messages are new, at temperature 0.3', () => {
    const w = historianDue(due(base, cfg))!;
    const r = historianRequest({ window: w, view: viewOf([]), profile: 'full', guidance: '', language: '' });
    expect(r.system).toContain('messages 1 through 5');
    expect(r.user).toContain('[5] assistant: The lamp went out.');
    expect(r.user).toContain('[1] assistant: Evening.');
    expect(r.user).not.toContain('HELD BACK');
    expect(r).toMatchObject({ temperature: 0.3, maxTokens: 4_096 });
  });

  test('a second run starts `overlap` messages before the covered end and calls them overlap', () => {
    const path: HistMessage[] = [
      ...base,
      { id: 'm6', role: 'user', text: 'HELD BACK message' },
      { id: 'm7', role: 'user', text: 'More?' },
      { id: 'm8', role: 'assistant', text: 'A door opened.' },
      { id: 'm9', role: 'assistant', text: 'It creaked.' },
    ];
    const w = historianDue(due(path, { ...cfg, tasks: tasks(hist('m1', 'm5')) }))!;
    const r = historianRequest({ window: w, view: viewOf([]), profile: 'full', guidance: '', language: '' });
    expect(r.system).toContain('Messages 5 to 5 are OVERLAP');
    expect(r.system).toContain('Messages 6 to 9 are NEW');
    expect(r.user.startsWith('Messages 5 to 9:\n\n[5] assistant: The lamp went out.\n\n[6] user: HELD BACK message')).toBe(true);
  });

  test('a covered boundary is summarized once', () => {
    expect(historianDue(due(base, { ...cfg, tasks: tasks(hist('m1', 'm5')) }))).toBeNull();
  });
});

describe('the digest', () => {
  test('every live plot that is not resolved, failed or abandoned, with its last 3 summaries (by name or alias), in view order', () => {
    const view = viewOf([
      typed('plot:old debts', 'plot', { name: 'Old Debts', aliases: ['The Debt'], status: 'escalating' }),
      typed('plot:salt war', 'plot', { name: 'Salt War', status: 'resolved' }),
      typed('plot:lost cause', 'plot', { name: 'Lost Cause', status: 'Failed' }),
      typed('plot:left behind', 'plot', { name: 'Left Behind', status: 'abandoned' }),
      typed('plot:gone', 'plot', { name: 'Gone', status: 'active' }, { retired: { reason: '' } }),
      typed('plot:quest', 'plot', { name: 'Quest', status: '  ' }),
      summary('S1', 'Old Debts', ['m1', 'm2']),
      { ...summary('S2', 'the debt', ['m3', 'm4']), key: 'summary:m4.1' },
      { ...summary('S3', 'Old Debts', ['m5', 'm6']), key: 'summary:m6.1' },
      { ...summary('S4', 'Old Debts', ['m7', 'm8']), key: 'summary:m8.1' },
      { ...summary('Retired', 'Old Debts', ['m9', 'm9']), key: 'summary:m9.1', retired: { reason: '' } },
    ]);
    expect(historianDigest(view, 'full')).toBe(
      'Existing plots (REUSE these names in parent_plot):\n- Old Debts (escalating); recent recaps: S2; S3; S4\n- Quest (active)',
    );
  });

  test('lite: the 6 most recently active plots (their own, their summaries\' and their arc\'s last seq), in view order', () => {
    const plots = Array.from({ length: 8 }, (_, i) => typed(`plot:p${i}`, 'plot', { name: `P${i}` }, { prov: { created: null, lastSeq: 10 + i, appended: {}, createdSeq: 10 + i } }));
    const view = viewOf([
      ...plots,
      summary('Late', 'P0', ['m1', 'm2'], { prov: { created: 'm2', lastSeq: 90, appended: {}, createdSeq: 90 } }),
      arc('P1', 'Overview.', 80),
    ]);
    const lines = historianDigest(view, 'lite').split('\n').slice(1);
    expect(lines).toEqual(['- P0 (active); recent recaps: Late', '- P1 (active)', '- P4 (active)', '- P5 (active)', '- P6 (active)', '- P7 (active)']);
    expect(historianDigest(view, 'full').split('\n')).toHaveLength(9);
  });
});

describe('the request', () => {
  const w = historianDue(due([{ id: 'm1', role: 'user', text: 'Hi.' }]))!;

  test('full: 4 096 tokens, 12 filings; lite: 1 500 and 6; temperature 0.3; the digest comes from the view', () => {
    const view = viewOf([typed('plot:p', 'plot', { name: 'P', status: 'active' })]);
    const full = historianRequest({ window: w, view, profile: 'full', guidance: '', language: '' });
    const lite = historianRequest({ window: w, view, profile: 'lite', guidance: '', language: 'русский' });
    expect(full).toMatchObject({ maxTokens: 4_096, temperature: 0.3, schema: { name: 'historian' } });
    expect(lite).toMatchObject({ maxTokens: 1_500, temperature: 0.3 });
    expect(full.system).toContain('- P (active)');
    expect(lite.system.endsWith('Write every field value in русский.')).toBe(true);
    expect(HISTORIAN_LIMITS.lite.items).toBe(6);
  });

  test('the schema: filings of summaries and plots, arcs of plot and overview, capped by profile', () => {
    const s = historianSchema('lite') as { required: string[]; properties: Record<string, Record<string, unknown>> };
    expect(s.required).toEqual(['filings', 'arcs']);
    expect(s.properties.filings!.maxItems).toBe(6);
    expect(s.properties.arcs!.maxItems).toBe(6);
    const entry = ((s.properties.filings!.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).entry!;
    const props = entry.properties as Record<string, { enum?: string[] }>;
    expect(props.significance!.enum).toEqual(['minor', 'moderate', 'major', 'pivotal']);
    expect(props.status!.enum).toContain('escalating');
    expect((historianSchema('full') as typeof s).properties.filings!.maxItems).toBe(12);
  });
});
