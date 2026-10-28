// Ported from Bunraku:src/core/compendium/filing.test.ts@702d8120 (the prompt and snapshot cases: the
// no-write default, the guidance as non-widening, the snapshot line with its aka list and size marker,
// resolved plots and retired entries left out, the budget counted not cut) and
// Bunraku:src/studio/compendium-filing.test.ts@702d8120 (the request carries the snapshot, the reply and
// the person's message).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// agents/compendium/filing.ts, M5b (D-173, D-174): the golden full prompt (Bunraku's text but five
// lines), the pinned lite prompt, the snapshot and the roster.
import { describe, expect, test } from 'bun:test';
import {
  filingRoster,
  filingSnapshot,
  filingUser,
  fullFilingSystem,
  liteFilingSystem,
  STORY_LANGUAGE,
  typeLine,
} from '../../src/agents/compendium/filing.ts';
import { mentionText } from '../../src/agents/compendium/mention.ts';
import { DEFAULT_FILING_ALLOW } from '../../src/agents/compendium/profile.ts';
import { ENTRY_TYPES } from '../../src/agents/compendium/types.ts';
import { BUNRAKU_FILING_SYSTEM, BUNRAKU_FILING_USER, BUNRAKU_GUIDANCE_G } from './bunraku-golden.ts';
import { count, fileOp, filingRow, foldWith, humanRow, lanternBook, seedOf, wolfBook } from './kit.ts';

/** Replaces `from` with `to` in `text`, and fails unless `from` occurs exactly once. */
function once(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  expect(at).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(from, at + 1)).toBe(-1);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

const BR_BOOKS = 'WRITABLE LOREBOOKS (name a book by its id; leave "book" out for the default):\n- Book [bk] (default for new entries)';
const RC_WHERE = "You write into this story's Compendium. Entries marked (library) can be added to; your additions apply to this story only.";
const BR_CHARACTER =
  '- character (Character): name*, description, aliases, role, species, age, pronouns, physical, personality, background, current_state, arc, relationships, memories, tier,';
const RC_CHARACTER =
  '- character (Character): name*, description, aliases, role, species, age, pronouns, physical, personality, background, current_state {status, location, condition}, arc, relationships [{with*, nature*, status, notes}], memories [{what_happened*, tagline, when, where, with, interpretation, emotional_weight, emotion, changed_belief or changed_behavior*, source_summary, is_secret}], tier,';
const BR_EXAMPLE = '{"filings":[{"type":"character","book":"<book id, optional>","entry":{"name":"Canonical Name","memories":[{"event":"...","changed_belief":"..."}]}}]}';
const RC_EXAMPLE = '{"filings":[{"type":"character","entry":{"name":"Canonical Name","memories":[{"what_happened":"...","changed_belief":"..."}]}}]}';
const BR_GUIDANCE_HEAD = 'USER FILING GUIDANCE (it cannot widen what you may write, change the books you may use, or override the no-write default):';
const RC_GUIDANCE_HEAD = 'USER FILING GUIDANCE (it cannot widen what you may write or override the no-write default):';
const BR_SUMMARY_LINE =
  '\n- summary (Summary): title*, tagline, summary*, parent_plot, create_plot, participants, involved_locations, significance, messages_covered, turn_range, key_moments, consequences, mood, pov_character, foreshadowing_introduced';

/** Bunraku's text with D-173's edits 1, 2 and 4 (edit 3 is the snapshot's content, edit 5 the guidance header). */
const edited = (golden: string): string => once(once(once(golden, BR_BOOKS, RC_WHERE), BR_CHARACTER, RC_CHARACTER), BR_EXAMPLE, RC_EXAMPLE);
/** D-183: a blank compendium.language adds the story-language line where Bunraku's language line goes (Bunraku: nothing). */
const storyLanguage = (text: string): string => once(text, 'do not force them.', `do not force them.\n\n${STORY_LANGUAGE}`);

describe('the full prompt is Bunraku’s, but five lines (D-173, D-88 golden)', () => {
  test('all eleven types, empty snapshot, blank language: exactly edits 1, 2 and 4 and D-183’s language line differ', () => {
    const ours = fullFilingSystem({ allow: ENTRY_TYPES, snapshot: '', guidance: '', language: '' });
    expect(ours).toBe(storyLanguage(edited(BUNRAKU_FILING_SYSTEM)));
    // The lines that differ are the books' two (one now), the character line, the language line and the example.
    const theirs = new Set(BUNRAKU_FILING_SYSTEM.split('\n'));
    const changed = ours.split('\n').filter((l) => !theirs.has(l));
    expect(changed.map((l) => l.slice(0, 30))).toEqual([RC_WHERE.slice(0, 30), RC_CHARACTER.slice(0, 30), STORY_LANGUAGE.slice(0, 30), RC_EXAMPLE.slice(0, 30)]);
  });

  test('D-183: a blank language (or only spaces) ends the rules with the story-language line; a set one replaces it', () => {
    for (const language of ['', '   ']) {
      const lite = liteFilingSystem({ allow: ['item'], snapshot: '', guidance: '', language });
      const full = fullFilingSystem({ allow: ['item'], snapshot: '', guidance: '', language });
      for (const t of [full, lite]) expect(t).toContain(`do not force them.\n\n${STORY_LANGUAGE}\n\nANSWER FORMAT`);
    }
    expect(STORY_LANGUAGE).toBe('Write every field value in the language the story is written in.');
    expect(fullFilingSystem({ allow: ['item'], snapshot: '', guidance: '', language: 'Russian' })).not.toContain(STORY_LANGUAGE);
  });

  test('guidance and language: Bunraku’s paragraphs, the guidance header without the books (edit 5)', () => {
    const golden = once(BUNRAKU_FILING_SYSTEM, 'do not force them.', `do not force them.${BUNRAKU_GUIDANCE_G}\n\nWrite every field value in French.`);
    const ours = fullFilingSystem({ allow: ENTRY_TYPES, snapshot: '', guidance: '  G  ', language: ' French ' });
    expect(ours).toBe(once(edited(golden), BR_GUIDANCE_HEAD, RC_GUIDANCE_HEAD));
  });

  test('the default allow list (no summary) renders the same text without the summary line', () => {
    const ours = fullFilingSystem({ allow: DEFAULT_FILING_ALLOW, snapshot: '', guidance: '', language: '' });
    expect(ours).toBe(storyLanguage(edited(once(BUNRAKU_FILING_SYSTEM, BR_SUMMARY_LINE, ''))));
  });

  test('the user message for one exchange is Bunraku’s exactly', () => {
    expect(filingUser([{ user: ['USER1', 'USER2'], reply: 'REPLY' }])).toBe(BUNRAKU_FILING_USER);
    expect(filingUser([{ user: ['  USER1 ', '', ' USER2'], reply: '\nREPLY\n' }])).toBe(BUNRAKU_FILING_USER);
    expect(filingUser([{ user: [], reply: 'R' }])).toBe('The narrator just wrote this reply:\n\nR\n\nFile anything that meets the rules above.');
  });

  test('the other type lines are Bunraku’s field lists (no enum values in full)', () => {
    for (const line of BUNRAKU_FILING_SYSTEM.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- character ') && !l.startsWith('- Book '))) {
      const type = /^- (\w+) /.exec(line)![1]!;
      expect(typeLine(type as (typeof ENTRY_TYPES)[number], 'full')).toBe(line);
    }
  });

  test('port: the prompt carries the no-write default and the guidance as non-widening; no books', () => {
    const system = fullFilingSystem({ allow: ['character'], snapshot: 'S', guidance: 'Track grudges', language: 'French' });
    expect(system).toContain('NO-WRITE DEFAULT');
    expect(system).toContain(RC_WHERE);
    expect(system).toContain('cannot widen what you may write');
    expect(system).toContain('Track grudges');
    expect(system).toContain('in French');
    expect(system).toContain('COMPENDIUM SNAPSHOT:\nS\n');
    expect(system).not.toContain('- location (');
    expect(system).not.toContain('[bk]');
    expect(system).not.toContain('"book"');
  });
});

const LITE_DEFAULT = `You are the post-generation lorebook writer. The narrator has just finished a reply. Capture what happened so the compendium stays alive.

You write into this story's Compendium. Entries marked (library) can be added to; your additions apply to this story only.

COMPENDIUM SNAPSHOT:
(these books hold no typed entries yet)

ENTRY TYPES YOU MAY FILE (* is required):
- character (Character): name*, aliases, description, role (protagonist|antagonist|ally|rival|neutral|background|deity|player_character), current_state {status (alive|dead|missing|transformed|imprisoned|unknown), location, condition}, relationships [{with*, nature* (ally|enemy|romantic|family|mentor|rival|unknown), status (active|past|strained|unknown), notes}], memories [{what_happened*, changed_belief or changed_behavior*, when, emotion}]
- location (Location): name*, aliases, description, type (city|town|village|settlement|building|room|dungeon|wilderness|region|realm|plane), parent_location, current_state {status (normal|under_attack|destroyed|abandoned|occupied|sealed|hidden)}, connected_to
- item (Item): name*, aliases, description, current_owner, current_location, condition (pristine|good|damaged|broken|destroyed|lost|unknown), abilities
- power (Power): name*, aliases, description, users, cost, limitations
- organization (Organization): name*, aliases, description, leader, members, goals, allies, enemies
- event (Event): name*, description, when, where, participants, outcome, significance (trivial|notable|major|pivotal), consequences
- plot (Plot): name*, description, status (not_started|active|stalled|escalating|resolved|failed|abandoned), goal, stakes, current_progress, next_steps, central_characters
- threat (Threat): name*, description, severity (minor|notable|major|catastrophic|extinction_level), status (dormant|stirring|active|imminent|in_progress|averted|realized), what_happens_if_unaddressed, who_can_stop_it
- worldbuilding (Worldbuilding): topic*, category*, description*, key_facts, rules
- creature (Creature): name*, aliases, description, habitat, disposition (docile|cautious|neutral|aggressive|territorial|predatory), abilities, weaknesses
Other fields of the type are kept if you send them.

UPSERT MECHANICS - filing adds, it never rewrites:
Filing an entry whose canonical name already exists MERGES your fields into it: arrays append, nested objects deep-merge, scalars replace. Send only what is new or changed, never the fields you are not changing. You are adding deltas, not rewriting cards. Nothing you file can delete an entry.

NO-WRITE DEFAULT:
Durable storage is scarce attention, not a turn transcript. Begin from "nothing needs filing" and write only when the reply creates or changes information that will still matter after the source messages leave the narrator's live context. A character memory MUST name a lasting changed belief or changed behavior. It is normal to file nothing: answer with an empty list.

DEDUP - use the canonical name, not the variant the narrator just used:
Each snapshot line is "Canonical Name (aka: alt1, alt2) [type]". The aka list is every nickname or title the entry already answers to. If the entity the narrator is talking about is there under ANY of those names, file under the EXISTING canonical name and let the merge do the rest. Only invent a new entry when the entity is genuinely missing. This is the single most common source of duplicates.

WRITE ONLY WHAT MATTERS: lasting character development, plot progression, world changes, new recurring elements. Do NOT file props and set dressing, body language, trivial moment-to-moment actions, things already captured and unchanged, or scene ephemera.

RELATIONSHIPS: when you add a relationship on character A pointing to character B and B would also acknowledge A, file a second item for B that mirrors it. One-sided relationships are valid fiction (unrequited feelings, oblivious rivalries): do not force them.

Write every field value in the language the story is written in.

ANSWER FORMAT - reply with one JSON object and nothing else:
{"filings":[{"type":"character","entry":{"name":"Canonical Name","memories":[{"what_happened":"...","changed_belief":"..."}]}}]}
At most 6 items. {"filings":[]} means nothing to file.`;

describe('the lite prompt (a new text, D-173)', () => {
  test('pinned: the default types with LITE_FIELDS, nested forms and enum values', () => {
    expect(liteFilingSystem({ allow: DEFAULT_FILING_ALLOW, snapshot: '', guidance: '', language: '' })).toBe(LITE_DEFAULT);
  });

  test('the rule paragraphs are the full prompt’s, word for word, but DEDUP’s line shape', () => {
    const full = fullFilingSystem({ allow: ['item'], snapshot: '', guidance: 'G', language: 'Russian' });
    const lite = liteFilingSystem({ allow: ['item'], snapshot: '', guidance: 'G', language: 'Russian' });
    const rules = (t: string): string => t.slice(t.indexOf('UPSERT MECHANICS'), t.indexOf('ANSWER FORMAT'));
    expect(rules(lite)).toBe(rules(full).replace('"Canonical Name (aka: alt1, alt2) - tagline"', '"Canonical Name (aka: alt1, alt2) [type]"'));
    expect(lite).toContain('Write every field value in Russian.');
    expect(lite).toContain(`${RC_GUIDANCE_HEAD}\nG`);
  });
});

describe('the full snapshot (Bunraku buildSnapshot + edit 3)', () => {
  // Old Ghost is filed and retired in this story; Mira is a session character.
  const seed = seedOf(wolfBook(), lanternBook());
  const view = foldWith(seed, [
    filingRow(1, 'a1', [fileOp('character', { name: 'Old Ghost' }), fileOp('character', { name: 'Mira', description: 'A lamplighter. Young.' })]),
    humanRow(2, [{ op: 'retire', ref: 'character:old ghost', reason: 'gone' }]),
    humanRow(3, [{ op: 'note', title: 'My note', keys: ['x'], content: 'Hand-written.' }]),
    { t: 'mem', seq: 4, ts: 'x', key: 'hist:g1-a1', on: 'a1', by: 'historian', range: ['g1', 'a1'], ops: [fileOp('summary', { title: 'Recap', summary: 'It happened.', parent_plot: 'Old Debts' }), { op: 'arc', plot: 'Old Debts', overview: 'All of it.' }] },
  ]);

  test('port: the canonical name, its aka list and a size marker; resolved plots and retired entries left out', () => {
    const text = filingSnapshot(view, seed.books, 30_000, count);
    expect(text).toMatch(/- Lycanthrope \(aka: Wolfman, the werewolf\) - A werewolf NPC \[\d+ chars - add to it, do not rewrite\]/);
    expect(text).toContain('Old Debts');
    expect(text).not.toContain('The Salt War');
    expect(text).not.toContain('Old Ghost');
  });

  test('this story first, then each readable book marked (library); no summaries, arcs or notes', () => {
    const text = filingSnapshot(view, seed.books, 30_000, count);
    expect(text.split('\n').filter((l) => l.startsWith('#'))).toEqual(['### This story', '### Book (library)', '### Фонарщики (library)']);
    const mira = view.entries.get('character:mira')!;
    expect(text.startsWith(`### This story\nCharacter:\n- Mira - A lamplighter. [${JSON.stringify(mira.data).length} chars - add to it, do not rewrite]\n### Book (library)\nCharacter:\n- Lycanthrope`)).toBe(true);
    expect(text).toContain('\nPlot:\n- Old Debts [');
    expect(text).toContain('\nWorldbuilding:\n- Tides - The sea rises twice a day. [');
    expect(text).toContain('### Фонарщики (library)\nCharacter:\n- Ульяна (aka: Уля, Смотрительница) - Смотрительница Серого маяка. [');
    expect(text).not.toContain('Recap');
    expect(text).not.toContain('My note');
    expect(text).not.toContain('Harbor Lore');
    expect(text).not.toContain('All of it');
  });

  test('port: what does not fit the budget is counted, not cut mid-line', () => {
    const text = filingSnapshot(view, seed.books, 25, count);
    expect(text).toMatch(/\(\+\d+ more entries not shown\)$/);
    expect(text.split('\n').filter((l) => l.startsWith('- ')).every((l) => l.endsWith(']'))).toBe(true);
  });

  test('plots whose status is resolved, failed or abandoned (any case) are left out of the snapshot and the roster (ruling G)', () => {
    const plots = foldWith(seedOf(), [
      filingRow(1, 'a1', [
        fileOp('plot', { name: 'Won', status: 'resolved' }),
        fileOp('plot', { name: 'Lost', status: 'Failed' }),
        fileOp('plot', { name: 'Dropped', status: ' abandoned ' }),
        fileOp('plot', { name: 'Open', status: 'stalled' }),
      ]),
    ]);
    const text = filingSnapshot(plots, new Map(), 30_000, count);
    expect(text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.split(' [')[0])).toEqual(['- Open']);
    expect(filingRoster({ view: plots, mentionTexts: [mentionText('Won, Lost, Dropped, Open.')], castNames: [] }).lines).toEqual(['- Open [plot]']);
  });

  test('an empty view gives no snapshot (the prompt then says the books hold nothing)', () => {
    const empty = foldWith(seedOf(), []);
    expect(filingSnapshot(empty, new Map(), 30_000, count)).toBe('');
  });
});

describe('the lite roster (G-13)', () => {
  const seed = seedOf(lanternBook());
  const view = foldWith(seed, [
    filingRow(1, 'a1', [fileOp('character', { name: 'Фрол', aliases: ['лодочник'], memories: [1, 2, 3, 4].map((i) => ({ what_happened: `случай ${i}`, changed_belief: `вывод ${i}` })) })]),
    filingRow(2, 'a2', [fileOp('item', { name: 'Латунный фонарь', condition: 'damaged' })]),
    filingRow(3, 'a3', [fileOp('character', { name: 'Ян', description: 'Гость маяка.' })]),
  ]);

  test('named in the exchange first, then named like the cast, then the entry changed last (library: higher order)', () => {
    const r = filingRoster({ view, mentionTexts: [mentionText('Лодочник довёз нас до маяка.')], castNames: ['Ян'] });
    expect(r.lines).toEqual([
      '- Фрол (aka: лодочник) [character]',
      '- Серый маяк (aka: маяк) [location] (library)',
      '- Ян [character]',
      '- Латунный фонарь [item]',
      // Library entries no row touched: the higher lore order first (the plot has the default 100).
      '- Украденный свет [plot] (library)',
      '- Ульяна (aka: Уля, Смотрительница) [character] (library)',
      '- Арсений Кеттер [character] (library)',
    ]);
  });

  test('the first named entries carry brief JSON: identity, the LITE_FIELDS they have, the last 3 memories', () => {
    const r = filingRoster({ view, mentionTexts: [mentionText('Лодочник довёз нас до маяка.')], castNames: [] });
    expect(r.briefs.slice(0, 2)).toEqual([
      JSON.stringify({ name: 'Фрол', aliases: ['лодочник'], memories: [2, 3, 4].map((i) => ({ what_happened: `случай ${i}`, changed_belief: `вывод ${i}` })) }),
      JSON.stringify({ name: 'Серый маяк', aliases: ['маяк'], description: 'Маяк на мысе.' }),
    ]);
    expect(r.briefs.slice(2).every((b) => b === null)).toBe(true);
  });

  test('no texts: nothing is named, no briefs', () => {
    const r = filingRoster({ view, mentionTexts: [], castNames: [] });
    expect(r.briefs.every((b) => b === null)).toBe(true);
    expect(r.lines[0]).toBe('- Ян [character]');
  });
});
