// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The RoleCall story converters (src/formats/rolecall-story.ts; .notes/rcimport-decisions.md D-187,
// D-188) on a small synthetic story built here as plain objects: parseStory over the zip's members,
// chatMessages (swipes, the active swipe, ids, the greeting, timestamps, inline reasoning),
// personaFromRow (RoleCall's persona XML), presetFromRow (the preset export rebuilt from the rows and
// read by the D-71 path) and booksFromRows (the Compendium wrapper, dedupe, renames, consumed rows).
// Every name and text below is invented for the test.
import { describe, expect, test } from 'bun:test';
import { buildTree, pathTo, swipeSiblings } from '../../src/session/tree.ts';
import type { Entry } from '../../src/session/entries.ts';
import { parseEntry } from '../../src/session/entries.ts';
import { readCompendium } from '../../src/formats/compendium-v1.ts';
import { validateLoreBook, validatePersona, validatePreset } from '../../src/formats/native.ts';
import { planStoryImport, rcIsoTime } from '../../src/formats/rolecall-import.ts';
import {
  booksFromRows,
  chatMessages,
  compendiumFileOf,
  generatePersonaXml,
  keepsInlineThinking,
  parseStory,
  personaFromRow,
  presetFromRow,
  RC_TIME_MAX,
  rcMsgId,
  rcNames,
  rcPresetExport,
  type StoryBundle,
  type StoryChat,
} from '../../src/formats/rolecall-story.ts';
import { splitThinkingFromContent } from '../../src/formats/rolecall-think.ts';
import { fromRcDepth } from '../../src/prompt/depth.ts';

type Rec = Record<string, unknown>;

const MAIN = '11111111-aaaa-4aaa-8aaa-000000000001';
const BRANCH = '22222222-bbbb-4bbb-8bbb-000000000002';
const COPY = '33333333-cccc-4ccc-8ccc-000000000003';
const T0 = Date.parse('2026-05-01T10:00:00.000Z');
const at = (min: number): number => T0 + min * 60_000;

const swipe = (content: string, min: number, extra: Rec = {}): Rec => ({ content, timestamp: at(min), ...extra });
const line = (index: number, id: string, role: string, content: string, swipes: Rec[], min = index): Rec => ({
  index,
  message_id: id,
  role,
  is_user: role === 'user',
  content,
  timestamp: at(min),
  swipes,
});

/** The main chat: a greeting with an older active swipe, closed / unclosed / swallowing reasoning, a system line, user→user, an edited last answer. */
function mainLines(): Rec[] {
  return [
    line(0, 'm0', 'assistant', 'The harbor bell rings.', [swipe('The harbor bell rings.', 0, { id: 'm0' }), swipe('Fog rolls in.', 1)]),
    line(1, 'm1', 'user', 'I wave.', [swipe('I wave.', 2)], 2),
    line(2, 'm2', 'assistant', '<think>plan the reply</think>She waves back.', [
      swipe('<think>plan the reply</think>She waves back.', 3, { model: 'model-a', generationTimeMs: 1200, finishReason: 'stop' }),
      swipe('A second answer.', 4, { model: 'model-b' }),
    ], 3),
    line(3, 'm3', 'user', 'I smile.', [swipe('I smile.', 5)], 5),
    line(4, 'm4', 'assistant', '<think>She should smile\n*She smiles warmly at you.*', [swipe('<think>She should smile\n*She smiles warmly at you.*', 6)], 6),
    line(5, 'm5', 'user', 'Go on.', [swipe('Go on.', 7)], 7),
    line(6, 'm6', 'assistant', '<think>the user wants more and we need to think', [swipe('<think>the user wants more and we need to think', 8)], 8),
    line(7, 'm7', 'system', 'A system note.', [swipe('A system note.', 9)], 9),
    line(8, 'm8', 'user', 'Again.', [swipe('Again.', 10)], 10),
    line(9, 'm9', 'user', 'And again.', [swipe('And again.', 11)], 11),
    line(10, 'm10', 'assistant', 'Edited text.', [swipe('First try.', 12), swipe('Second try.', 13), swipe('Third try.', 14)], 12),
  ];
}

/** A branch that copied the first two messages (same ids, same content) and went on. */
function branchLines(): Rec[] {
  const [m0, m1] = mainLines();
  return [m0!, m1!, line(2, 'b2', 'assistant', 'A different path.', [swipe('A different path.', 20), swipe('Another path.', 21)], 20)];
}

const chatJson = (id: string, extra: Rec = {}): Rec => ({
  id,
  parent_chat_id: null,
  is_main_timeline: false,
  branch_name: null,
  branch_point_index: null,
  title: null,
  summary: null,
  active_persona_id: 'persona-1',
  active_lorebooks: [],
  config: {},
  message_count: 0,
  total_tokens: 0,
  created_at: '2026-05-01T09:00:00.000Z',
  updated_at: '2026-05-01T11:00:00.000Z',
  last_message_at: '2026-05-01T11:00:00.000Z',
  ...extra,
});

const CARD = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: 'Mira',
    description: 'A lamplighter of the old harbor.',
    personality: 'Calm.',
    scenario: 'Evening at the docks.',
    first_mes: 'Hello there.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '1.0',
    extensions: { rolecall: { id: 'char-1', source_export: 'rolecall-story-zip-v1' } },
  },
};

const PERSONA_ROW = {
  id: 'persona-1',
  name: 'Tam',
  description: 'A traveller.',
  content: '',
  section_order: ['history', 'personality', 'appearance'],
  details: {
    pronouns: 'she/her',
    title: 'Lamplighter & Guide',
    colors: [
      { label: 'Hair Color', name: 'Copper', hex: '#b87333' },
      { label: 'Eyes', name: 'Grey' },
      { label: '', name: 'Ignored' },
    ],
    appearance: 'Tall.\n\n\nFreckled.',
    personality: 'Patient <b>but</b> stubborn, "always" <3',
    traits: ['Calm', "Wry & it's fine"],
    quirks: 'Hums.',
    history: 'Grew up by the harbor.',
    injection_prefix: '[User persona]',
    section_order: ['quirks'],
    emoji: '*',
  },
};

function presetRow(): Rec {
  return {
    id: 'preset-1',
    name: 'Lantern Preset',
    edition_kind: 'standard',
    temperature: 0.9,
    top_p: null,
    max_context: 32000,
    max_tokens: 900,
    prompt_post_processing: null,
    system_prompts: { assistantPrefill: 'camel prefill', impersonation_prompt: 'Write as {{user}}.' },
    template_formats: { wi_format: '{0}' },
    behavior: { names_behavior: 0 },
    api_options: { squash_system_messages: false },
    raw_settings: { extensions: {} },
    settings: { prompts: [] },
    categories: [
      { id: 'cat-a', name: 'Core', content: '', parent_id: null, sort_order: 0 },
      { id: 'cat-b', name: 'Style', content: '', parent_id: 'cat-a', sort_order: 1 },
    ],
    prompts: [
      { identifier: 'chatHistory', name: 'Chat History', marker: true, system_prompt: true, enabled: true, sort_order: 30, content: '', injection_position: '0', role: 'system' },
      { identifier: 'main', name: 'Main', content: 'You narrate {{char}}.', role: 'system', enabled: true, sort_order: 10, injection_position: '0', category_id: 'cat-a' },
      { identifier: 'style', name: 'Style', content: 'Be vivid. {{if::x}}maybe{{/if}}', role: 'system', enabled: false, sort_order: 20, injection_position: '0', category_id: 'cat-b' },
      { identifier: 'depthNote', name: 'Depth note', content: 'Remember the lamp.', role: 'system', enabled: true, sort_order: 40, injection_position: '1', injection_depth: 2, injection_order: 50 },
      { identifier: 'dup', name: 'Dup off', content: 'first copy', role: 'system', enabled: false, sort_order: 50, injection_position: '0' },
      { identifier: 'dup', name: 'Dup on', content: 'second copy', role: 'system', enabled: true, sort_order: 60, injection_position: '0' },
      { identifier: 'worldInfoBefore', name: 'World Info (before)', marker: true, system_prompt: true, enabled: true, sort_order: 5, content: '', injection_position: '0' },
    ],
  };
}

const CHAT_CONFIG: Rec = {
  preset_id: 'preset-1',
  preset_prompt_overrides: { 'preset-1': { style: true, main: true, gone: false }, 'other-preset': { depthNote: false } },
  sampler_overrides: {
    enabled: { min_p: true, logit_bias: true, top_a: false },
    values: { min_p: 0.05, logit_bias: [{ text: 'x', value: -100 }], top_a: 0.3 },
    prefill: '',
  },
  preset_sampler_overrides: { temperature: 1.1, topK: 40.4 },
};

/** A Compendium-flavoured book row: an untyped row, an [Arc] overview, a typed row and the row its split consumed. */
function bookRow(id: string, name: string, opts: { wipe?: boolean; reverse?: boolean; rowIds?: string } = {}): Rec {
  const p = opts.rowIds ?? 'e';
  const meta = (m: Rec): Rec => (opts.wipe ? {} : m);
  const entries: Rec[] = [
    { id: `${p}1`, lorebook_id: id, title: 'Lighthouse', content: 'A tall white tower.', enabled: true, constant: false, triggers: [{ keyword: 'lighthouse', isRegex: false }], position: 'character', sort_order: 2, metadata: meta({ source: 'tv_ingest' }) },
    { id: `${p}2`, lorebook_id: id, title: '[Arc] The Storm', content: 'The storm arc so far.', enabled: true, constant: true, triggers: [], position: 'character', sort_order: 1, metadata: meta({ source: 'tv_arc_overview' }) },
    {
      id: `${p}3`,
      lorebook_id: id,
      title: 'Keeper Ona',
      content: 'Ona keeps the lamp.',
      enabled: true,
      constant: false,
      triggers: [{ keyword: 'Ona' }],
      position: 'character',
      sort_order: 3,
      metadata: { source: 'tv_compendium', entry_type: 'character', structured_data: { name: 'Keeper Ona', role: 'keeper' }, standardization_state: 'standardized' },
    },
    {
      id: `${p}4`,
      lorebook_id: id,
      title: 'Old keeper note',
      content: 'Ona keeps the lamp at night.',
      enabled: true,
      constant: false,
      triggers: [{ keyword: 'keeper' }],
      position: 'character',
      sort_order: 4,
      metadata: { source: 'tv_compendium', standardization_state: 'consumed_by_split', consumed_by_entry_id: `${p}3` },
    },
  ];
  return {
    id,
    name,
    description: 'Harbor lore.',
    creator_id: 'someone',
    status: 'private',
    global_scan_depth: 50,
    global_recursion: false,
    global_case_sensitive: false,
    global_match_whole_words: false,
    token_budget: 2048,
    lorebook_type: 'world',
    has_tree: true,
    entries: opts.reverse ? [...entries].reverse() : entries,
  };
}

const jsonl = (lines: Rec[]): string => lines.map((l) => JSON.stringify(l)).join('\n');

function members(over: (m: Map<string, string>) => void = () => {}): Map<string, string> {
  const m = new Map<string, string>();
  m.set(
    'manifest.json',
    JSON.stringify({
      format: 'rolecall-story-zip',
      version: 1,
      exported_at: '2026-05-02T08:00:00.000Z',
      root_chat_id: MAIN,
      main_chat_id: MAIN,
      app_version: null,
      character_id: 'char-1',
      persona_id: 'persona-1',
      preset_id: 'preset-1',
      lorebook_ids: ['book-a'],
      chat_ids: [MAIN, BRANCH, COPY],
      failed_chunks: [],
      stats: { branches: 3 },
    }),
  );
  m.set('story.jsonl', '{"kind":"manifest","format":"rolecall-story"}');
  m.set('characters/Mira.json', JSON.stringify(CARD));
  m.set('characters/Mira.raw.json', JSON.stringify({ id: 'char-1', name: 'Mira', details: {} }));
  m.set('personas/Tam.json', JSON.stringify(PERSONA_ROW));
  m.set('presets/Lantern_Preset.json', JSON.stringify(presetRow()));
  m.set('lorebooks/Harbor-book-a.json', JSON.stringify(bookRow('book-a', 'Harbor')));
  // Folders sort before the main chat on purpose: the manifest's order wins.
  m.set(`chats/Take_3-${COPY.slice(0, 8)}/chat.json`, JSON.stringify(chatJson(COPY, { parent_chat_id: BRANCH, branch_name: 'Take 3', branch_point_index: 2 })));
  m.set(`chats/Take_3-${COPY.slice(0, 8)}/messages.jsonl`, jsonl(branchLines()));
  m.set(`chats/Take_3-${BRANCH.slice(0, 8)}/chat.json`, JSON.stringify(chatJson(BRANCH, { parent_chat_id: MAIN, branch_name: 'Take 3', branch_point_index: 2, active_lorebooks: ['book-a'] })));
  m.set(`chats/Take_3-${BRANCH.slice(0, 8)}/messages.jsonl`, jsonl(branchLines()));
  const main = `chats/Harbor_walk-${MAIN.slice(0, 8)}`;
  m.set(`${main}/chat.json`, JSON.stringify(chatJson(MAIN, { is_main_timeline: true, title: 'Harbor walk', summary: 'They met.', active_lorebooks: [{ id: 'book-a', enabled: true }, { id: 'book-b', enabled: false }], config: CHAT_CONFIG })));
  // Lines out of index order and one broken line: put back in order, the broken one said.
  const lines = mainLines();
  m.set(`${main}/messages.jsonl`, [jsonl(lines.slice(3)), jsonl(lines.slice(0, 3)), '{broken'].join('\n'));
  m.set(`${main}/tracker.json`, JSON.stringify({ capturedAt: 1, relationships: [] }));
  m.set(`${main}/storyboard.json`, JSON.stringify([{ id: 'ev-1' }]));
  m.set(`${main}/dm-context.json`, JSON.stringify({ chapters: [], activeArcs: [], lastDirectiveTurn: 4 }));
  m.set('chat-images/stray.png', 'x');
  over(m);
  return m;
}

function story(over?: (m: Map<string, string>) => void): StoryBundle {
  const r = parseStory(members(over));
  if (!r.ok) throw new Error(r.why);
  return r.value;
}

const codes = (ws: readonly { code: string }[]): string[] => ws.map((w) => w.code);
const chatOf = (s: StoryBundle, id: string): StoryChat => s.chats.find((c) => c.id === id)!;
const textOf = (e: { blocks?: readonly { k: string; text?: string }[] }): string => e.blocks?.find((b) => b.k === 'text')?.text ?? '';
const reasoningOf = (e: { blocks?: readonly { k: string; text?: string }[] }): string[] => (e.blocks ?? []).filter((b) => b.k === 'reasoning').map((b) => b.text ?? '');

describe('parseStory', () => {
  test('reads the manifest, the dependencies and the chats in the manifest order', () => {
    const s = story();
    expect(s.manifest).toMatchObject({ version: 1, exportedAt: '2026-05-02T08:00:00.000Z', mainChatId: MAIN, presetId: 'preset-1', lorebookIds: ['book-a'] });
    expect(s.chats.map((c) => c.id)).toEqual([MAIN, BRANCH, COPY]);
    expect(s.mainChatId).toBe(MAIN);
    expect(s.character?.path).toBe('characters/Mira.json');
    expect(s.character?.card?.value.name).toBe('Mira');
    expect(s.character?.card?.value.greetings).toEqual(['Hello there.']);
    expect(s.character?.raw).toEqual({ id: 'char-1', name: 'Mira', details: {} });
    expect(s.persona?.id).toBe('persona-1');
    expect(s.preset?.id).toBe('preset-1');
    expect(s.books.map((b) => b.id)).toEqual(['book-a']);
  });

  test('a chat: its fields, both lorebook shapes, messages back in index order, the raw extras', () => {
    const s = story();
    const main = chatOf(s, MAIN);
    expect(main).toMatchObject({ isMain: true, parentId: null, title: 'Harbor walk', summary: 'They met.', personaId: 'persona-1', createdAt: '2026-05-01T09:00:00.000Z' });
    expect(main.lorebooks).toEqual([
      { id: 'book-a', enabled: true },
      { id: 'book-b', enabled: false },
    ]);
    expect(main.messages.map((m) => m.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(main.tracker).toEqual({ capturedAt: 1, relationships: [] });
    expect(main.storyboard).toEqual([{ id: 'ev-1' }]);
    expect(main.dmContext).toMatchObject({ lastDirectiveTurn: 4 });
    const branch = chatOf(s, BRANCH);
    expect(branch).toMatchObject({ parentId: MAIN, isMain: false, branchName: 'Take 3', branchPointIndex: 2 });
    expect(branch.lorebooks).toEqual([{ id: 'book-a', enabled: true }]);
    expect(branch.tracker).toBeUndefined();
  });

  test('warnings: a broken line, an unknown member, hidden flags and images (said once each); story.jsonl is not read', () => {
    const s = story();
    const c = codes(s.warnings);
    expect(c.filter((x) => x === 'rc_bad_line')).toHaveLength(1);
    expect(c.filter((x) => x === 'rc_unknown_member')).toHaveLength(1);
    expect(c.filter((x) => x === 'rc_hidden_unavailable')).toHaveLength(1);
    expect(c.filter((x) => x === 'rc_images_unavailable')).toHaveLength(1);
    expect(s.warnings.find((w) => w.code === 'rc_unknown_member')?.path).toBe('chat-images/stray.png');
    expect(s.warnings.some((w) => w.path.startsWith('story.jsonl'))).toBe(false);
  });

  test('members as a list of byte arrays read the same as a map of strings', () => {
    const enc = new TextEncoder();
    const list = [...members()].map(([name, data]) => ({ name, data: enc.encode(data) }));
    const r = parseStory(list);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.stringify(r.value.chats)).toBe(JSON.stringify(story().chats));
  });

  test('refuses what is not a story export', () => {
    expect(parseStory(new Map([['story.jsonl', '{}']]))).toEqual({ ok: false, why: 'no manifest.json: not a RoleCall story export' });
    const backup = parseStory(members((m) => m.set('manifest.json', JSON.stringify({ format: 'rolecall-backup', version: 1 }))));
    expect(backup.ok).toBe(false);
    if (!backup.ok) expect(backup.why).toContain('"rolecall-backup"');
    expect(parseStory(new Map([['manifest.json', '{nope']]))).toEqual({ ok: false, why: 'manifest.json is not valid JSON' });
    const noChats = parseStory(new Map([['manifest.json', JSON.stringify({ format: 'rolecall-story-zip', version: 1 })]]));
    expect(noChats).toEqual({ ok: false, why: 'the export holds no chat' });
  });

  test('failed chunks and a newer version are said; without a main-timeline flag the manifest names the main chat', () => {
    const s = story((m) => {
      const mf = JSON.parse(m.get('manifest.json')!) as Rec;
      m.set('manifest.json', JSON.stringify({ ...mf, version: 2, failed_chunks: [{ chat_id: MAIN, chunk_number: 3, reason: 'x' }] }));
      const dir = `chats/Harbor_walk-${MAIN.slice(0, 8)}`;
      const c = JSON.parse(m.get(`${dir}/chat.json`)!) as Rec;
      m.set(`${dir}/chat.json`, JSON.stringify({ ...c, is_main_timeline: false }));
    });
    expect(codes(s.warnings)).toEqual(expect.arrayContaining(['rc_version', 'rc_failed_chunks']));
    expect(codes(s.warnings)).not.toContain('rc_main_chat');
    expect(s.mainChatId).toBe(MAIN);
    expect(s.manifest.failedChunks).toHaveLength(1);
  });

  test('a PNG card is preferred, a second persona is said, and a chat folder without chat.json is skipped', () => {
    const s = story((m) => {
      m.set('characters/Mira.png', 'not really a png');
      m.set('personas/Other.json', JSON.stringify({ id: 'persona-2', name: 'Other' }));
      m.set('chats/orphan/messages.jsonl', '');
    });
    expect(s.character?.path).toBe('characters/Mira.png');
    expect(s.character?.card).toBeUndefined();
    expect(codes(s.warnings)).toEqual(expect.arrayContaining(['rc_character_unreadable', 'rc_extra_member', 'rc_missing_member']));
    expect(s.persona?.id).toBe('persona-1');
    expect(s.chats).toHaveLength(3);
  });
});

describe('chatMessages', () => {
  const s = story();
  const main = chatOf(s, MAIN);
  const plan = chatMessages(main);
  const byId = new Map(plan.entries.map((e) => [e.id, e]));
  const msg = (i: number) => plan.messages[i]!;
  const active = (i: number) => byId.get(msg(i).active)!;

  test('every entry parses as a journal msg line and the tree is the RoleCall line', () => {
    const entries = plan.entries.map((e, i) => ({ ...e, seq: i + 1 }) as Entry);
    for (const e of entries) expect(parseEntry(JSON.stringify(e))).toEqual({ ok: true, value: e });
    const idx = buildTree(entries);
    expect(idx.head).toBe(plan.head);
    expect(plan.headMove).toBe(false);
    expect(pathTo(idx, plan.head)).toEqual(plan.messages.map((m) => m.active));
  });

  test('swipes are sibling versions in swipe order; the active one is found by content and is the parent of the next message', () => {
    expect(plan.counts).toMatchObject({ messages: 10, versions: 14, users: 5 });
    expect(msg(0).versions).toHaveLength(2);
    expect(msg(0).active).toBe(msg(0).versions[0]!); // not the last swipe
    expect(msg(2).active).toBe(msg(2).versions[0]!);
    expect(byId.get(msg(1).active)!.parent).toBe(msg(0).active);
    expect(byId.get(msg(2).versions[1]!)!.parent).toBe(msg(1).active);
    const idx = buildTree(plan.entries.map((e, i) => ({ ...e, seq: i + 1 }) as Entry));
    expect(swipeSiblings(idx, msg(0).active)).toEqual(msg(0).versions);
    expect(swipeSiblings(idx, msg(2).active)).toEqual(msg(2).versions);
  });

  test('ids are 8 hex from (chat, message, swipe), stable across runs, unique in the chat', () => {
    expect(plan.entries.every((e) => /^[0-9a-f]{8}$/.test(e.id))).toBe(true);
    expect(new Set(plan.entries.map((e) => e.id)).size).toBe(plan.entries.length);
    expect(msg(0).versions[1]).toBe(rcMsgId(MAIN, 'm0', 1));
    expect(chatMessages(main).entries).toEqual(plan.entries);
    expect(msg(0).rcId).toBe('m0');
  });

  test('the first answer is the greeting; later answers carry the swipe model, time and finish; user lines carry none', () => {
    expect(byId.get(msg(0).versions[0]!)!.gen).toEqual({ kind: 'greeting' });
    expect(byId.get(msg(0).versions[1]!)!.gen).toEqual({ kind: 'greeting' });
    expect(active(2).gen).toEqual({ kind: 'model', model: 'model-a', ms: 1200, finish: 'end' });
    expect(byId.get(msg(2).versions[1]!)!.gen).toEqual({ kind: 'model', model: 'model-b' });
    expect(active(1).gen).toBeUndefined();
    expect(active(1).role).toBe('user');
  });

  test('timestamps are the swipes\' own', () => {
    expect(active(0).ts).toBe(new Date(at(0)).toISOString());
    expect(byId.get(msg(0).versions[1]!)!.ts).toBe(new Date(at(1)).toISOString());
    expect(active(2).ts).toBe(new Date(at(3)).toISOString());
  });

  test("inline reasoning is split as RoleCall splits history: closed, unclosed by RoleCall's rule, swallowed", () => {
    expect(reasoningOf(active(2))).toEqual(['plan the reply']);
    expect(textOf(active(2))).toBe('She waves back.');
    expect(active(2).blocks!.map((b) => b.k)).toEqual(['reasoning', 'text']);
    expect(reasoningOf(active(4))).toEqual(['She should smile']);
    expect(textOf(active(4))).toBe('*She smiles warmly at you.*');
    expect(reasoningOf(active(6))).toEqual(['the user wants more and we need to think']);
    expect(textOf(active(6))).toBe('');
    expect(plan.counts).toMatchObject({ reasoning: 3, unclosed: 2, emptied: 1, cleaned: 0 });
    expect(codes(plan.warnings)).toContain('rc_reasoning_split');
    // User lines are kept verbatim.
    expect(active(1).blocks).toEqual([{ k: 'text', text: 'I wave.' }]);
  });

  test('a system line is skipped (said); two user lines in a row stay; an unmatched content takes the last swipe (said)', () => {
    expect(codes(plan.warnings)).toEqual(expect.arrayContaining(['rc_system_message', 'rc_active_swipe_missing']));
    expect(plan.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'user', 'assistant']);
    expect(active(7).parent).toBe(msg(6).active); // after the skipped system line
    expect(active(8).parent).toBe(msg(7).active);
    expect(msg(9).active).toBe(msg(9).versions[2]!);
    expect(textOf(active(9))).toBe('Third try.');
    expect(plan.head).toBe(msg(9).active);
    expect(msg(9).users).toBe(5);
    expect(msg(2).users).toBe(1);
  });

  test("the head needs moving when the last message's active swipe is not its last one", () => {
    const chat = { ...main, messages: main.messages.slice(0, 3) };
    const p = chatMessages(chat);
    expect(p.head).toBe(p.messages[2]!.active);
    expect(p.headMove).toBe(true);
    const idx = buildTree([...p.entries.map((e, i) => ({ ...e, seq: i + 1 }) as Entry), { t: 'head', seq: p.entries.length + 1, ts: 'x', leaf: p.head! }]);
    expect(idx.head).toBe(p.head);
  });

  test('a branch can take its copied prefix ids from the parent; equal chats have equal fingerprints', () => {
    const branch = chatOf(s, BRANCH);
    const copy = chatOf(s, COPY);
    const own = chatMessages(branch);
    const forked = chatMessages(branch, { prefixFrom: { chatId: MAIN, count: 2 } });
    expect(forked.messages.slice(0, 2).map((m) => m.versions)).toEqual(plan.messages.slice(0, 2).map((m) => m.versions));
    expect(forked.messages[2]!.versions).toEqual(own.messages[2]!.versions);
    expect(own.messages[0]!.active).not.toBe(plan.messages[0]!.active);
    expect(chatMessages(copy).fingerprint).toBe(own.fingerprint);
    expect(own.fingerprint).not.toBe(plan.fingerprint);
    expect(own.messages.slice(0, 2).map((m) => m.contentHash)).toEqual(plan.messages.slice(0, 2).map((m) => m.contentHash));
  });

  test("a chat that keeps inline thinking in RoleCall's history is imported verbatim", () => {
    const config = { sampler_overrides: { enabled: { keep_inline_thinking_tags: true }, values: { keep_inline_thinking_tags: true } } };
    expect(keepsInlineThinking(config)).toBe(true);
    expect(keepsInlineThinking({ sampler_overrides: { enabled: { keep_inline_thinking_tags: false }, values: { keep_inline_thinking_tags: true } } })).toBe(false);
    expect(keepsInlineThinking({ sampler_overrides: { enabled: { send_thinking_to_llm: true }, values: { send_thinking_to_llm: true } } })).toBe(true);
    const p = chatMessages({ ...main, config });
    expect(textOf(byId.get(msg(2).active)!)).toBe('She waves back.');
    expect(textOf(p.entries.find((e) => e.id === p.messages[2]!.active)!)).toBe('<think>plan the reply</think>She waves back.');
    expect(p.counts.reasoning).toBe(0);
    expect(codes(p.warnings)).toContain('rc_reasoning_kept');
  });

  test("the chat's Start Reply With tag is a reasoning tag too; stored reasoning comes first", () => {
    const lines = [
      line(0, 'g', 'assistant', 'Hi.', [swipe('Hi.', 0)]),
      line(1, 'u', 'user', 'Yo.', [swipe('Yo.', 1)]),
      { ...line(2, 'a', 'assistant', '<musing>quiet</musing>Visible.', [swipe('<musing>quiet</musing>Visible.', 2, { reasoning: 'stored' })]), thinking: 'from the message' },
    ];
    const chat: StoryChat = { ...main, messages: lines, config: { sampler_overrides: { prefill: '<musing>' } } };
    const p = chatMessages(chat);
    const e = p.entries.find((x) => x.id === p.messages[2]!.active)!;
    expect(reasoningOf(e)).toEqual(['from the message', 'stored', 'quiet']);
    expect(textOf(e)).toBe('Visible.');
    expect(textOf(chatMessages({ ...chat, config: {} }).entries.at(-1)!)).toBe('<musing>quiet</musing>Visible.');
  });

  test('a stray closer is dropped from an answer and counted', () => {
    const chat: StoryChat = { ...main, messages: [line(0, 'g', 'assistant', 'Hi.', [swipe('Hi.', 0)]), line(1, 'a', 'assistant', 'Done.</think> Next.', [swipe('Done.</think> Next.', 1)])] };
    const p = chatMessages(chat);
    expect(textOf(p.entries[1]!)).toBe('Done. Next.');
    expect(p.counts.cleaned).toBe(1);
    expect(codes(p.warnings)).toEqual(['rc_reasoning_tag']);
  });

  test('a message without swipes is its own single version; one without text is skipped', () => {
    const chat: StoryChat = { ...main, messages: [{ index: 0, message_id: 'x', role: 'assistant', content: 'Only text.', timestamp: at(0) }, { index: 1, message_id: 'y', role: 'user' }] };
    const p = chatMessages(chat);
    expect(p.messages).toHaveLength(1);
    expect(p.entries[0]!.blocks).toEqual([{ k: 'text', text: 'Only text.' }]);
    expect(codes(p.warnings)).toContain('rc_bad_message');
  });
});

describe('splitThinkingFromContent (the port)', () => {
  test("RoleCall's rules: closed, look-alike, a tag in code, a stray closer, a heading pair", () => {
    expect(splitThinkingFromContent('<thinking>a</thinking>Text.').visibleContent).toBe('Text.');
    expect(splitThinkingFromContent('<thinkingprocess>a</thinkingprocess>Text.').blocks[0]!.capture.via).toBe('lookalike');
    expect(splitThinkingFromContent('It has a `<think>` tag and more.').visibleContent).toBe('It has a `<think>` tag and more.');
    expect(splitThinkingFromContent('</think>Hello.').visibleContent).toBe('Hello.');
    const heading = splitThinkingFromContent('Thinking:\nweigh the options here\n\nResponse:\nThe door opens.');
    expect(heading).toMatchObject({ reasoning: 'weigh the options here', visibleContent: 'The door opens.' });
    expect(splitThinkingFromContent('<think>plan</thi The rest.').visibleContent).toBe('The rest.');
  });
});

describe('personaFromRow', () => {
  test("RoleCall's persona XML: identity first, sections in the row's order, colors with hex, escaping around user tags, the prefix", () => {
    const p = personaFromRow(PERSONA_ROW);
    expect(p.warnings).toEqual([]);
    expect(p.value.name).toBe('Tam');
    expect(p.value.description).toBe(
      [
        '[User persona]',
        '<persona name="Tam">',
        '  <identity>',
        '    <pronouns>she/her</pronouns>',
        '    <title>Lamplighter &amp; Guide</title>',
        '  </identity>',
        '  <history>Grew up by the harbor.</history>',
        '  <personality>Patient <b>but</b> stubborn, &quot;always&quot; &lt;3</personality>',
        '  <traits>Calm, Wry &amp; it&apos;s fine</traits>',
        '  <hair_color>Copper (#b87333)</hair_color>',
        '  <eyes>Grey</eyes>',
        '  <appearance>Tall.\nFreckled.</appearance>',
        '</persona>',
      ].join('\n'),
    );
    expect(validatePersona(p.value).ok).toBe(true);
  });

  test("details' own section order and RoleCall's default order", () => {
    const xml = generatePersonaXml('A', { quirks: 'q', history: 'h', section_order: ['quirks'] });
    expect(xml).toBe('<persona name="A">\n  <quirks>q</quirks>\n</persona>');
    expect(generatePersonaXml('A', { quirks: 'q', history: 'h', appearance: 'a' })).toBe('<persona name="A">\n  <appearance>a</appearance>\n  <quirks>q</quirks>\n  <history>h</history>\n</persona>');
    expect(generatePersonaXml('A &amp; B', {})).toBe('<persona name="A &amp; B">\n</persona>');
  });

  test('details that render nothing fall back to the description; no name is "User"', () => {
    const p = personaFromRow({ name: 'Tam', description: 'A traveller.', details: { emoji: '*' } });
    expect(p.value).toEqual({ name: 'Tam', description: 'A traveller.' });
    expect(codes(p.warnings)).toEqual(['rc_persona_description']);
    expect(personaFromRow({ description: 'x', details: null }).value).toEqual({ name: 'User', description: 'x' });
    expect(personaFromRow({ name: 'Tam', content: 'plain', details: {} }).value.description).toBe('plain');
  });
});

describe('presetFromRow', () => {
  const ids = (p: { blocks: { id: string }[] }) => p.blocks.map((b) => b.id).filter((id) => ['worldInfoBefore', 'main', 'style', 'chatHistory', 'depthNote', 'dup'].includes(id));
  const block = (p: { blocks: { id: string }[] }, id: string) => p.blocks.find((b) => b.id === id) as { id: string; enabled: boolean; content: string; at: unknown };

  test("the export: rows in sort_order, the 100001 order with the rows' flags, sparse structural markers, extensions.rolecall", () => {
    const { json, overridden } = rcPresetExport(presetRow());
    expect(overridden).toBe(false);
    const prompts = json.prompts as Rec[];
    expect(prompts.map((p) => p.identifier)).toEqual(['worldInfoBefore', 'main', 'style', 'chatHistory', 'depthNote', 'dup']);
    expect(prompts[0]).toEqual({ identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true });
    expect(prompts[4]).toMatchObject({ injection_position: 1, injection_depth: 2, injection_order: 50 });
    expect(prompts[5]).toMatchObject({ content: 'second copy' });
    const order = (json.prompt_order as Rec[])[0]!;
    expect(order.character_id).toBe(100001);
    expect(order.order).toEqual([
      { identifier: 'worldInfoBefore', enabled: true },
      { identifier: 'main', enabled: true },
      { identifier: 'style', enabled: false },
      { identifier: 'chatHistory', enabled: true },
      { identifier: 'depthNote', enabled: true },
      { identifier: 'dup', enabled: true },
    ]);
    const rc = (json.extensions as Rec).rolecall as Rec;
    expect(rc).toMatchObject({ schema_version: 1, edition_kind: 'standard', category_header_identifiers: [] });
    expect(rc.category_hierarchy).toEqual([{ name: 'Core', content: '', prompt_identifiers: ['main'], children: [{ name: 'Style', content: '', prompt_identifiers: ['style'], children: [] }] }]);
    expect(json).toMatchObject({ name: 'Lantern Preset', temperature: 0.9, openai_max_context: 32000, openai_max_tokens: 900, assistant_prefill: 'camel prefill', wi_format: '{0}', squash_system_messages: false });
    expect('top_p' in json).toBe(false);
    expect('settings' in json).toBe(false);
  });

  test("read by the D-71 path: RoleCall's depth +1, lore and persona on, one macro warning, duplicates as RoleCall keeps them", () => {
    const p = presetFromRow(presetRow());
    expect(validatePreset(p.value).ok).toBe(true);
    expect(ids(p.value)).toEqual(['worldInfoBefore', 'main', 'style', 'chatHistory', 'depthNote', 'dup']);
    expect(block(p.value, 'depthNote').at).toEqual({ depth: fromRcDepth(2), order: 50 });
    expect(block(p.value, 'style').enabled).toBe(false);
    expect(block(p.value, 'dup').content).toBe('second copy');
    expect(p.value.blocks.some((b) => b.enabled && b.content.includes('{{persona}}'))).toBe(true);
    expect(p.value.prefill).toBe('camel prefill');
    expect(p.value.impersonation).toEqual({ prompt: 'Write as {{user}}.' });
    expect(p.value.samplers).toEqual({ temperature: 0.9, max_tokens: 900 });
    expect(p.value.context).toEqual({ maxContext: 32000 });
    const c = codes(p.warnings);
    expect(c).toEqual(expect.arrayContaining(['rc_export', 'rc_duplicate_prompt', 'rc_preset_settings']));
    expect(c.filter((x) => x === 'unknown_macro')).toHaveLength(1);
    expect(p.warnings.find((w) => w.code === 'unknown_macro')!.message).toContain('{{if}}');
    expect(p.overridden).toBe(false);
  });

  test("the chat's overrides: this preset's toggles only, enabled panel samplers, then the chat's preset samplers", () => {
    const p = presetFromRow(presetRow(), { config: CHAT_CONFIG, name: 'Lantern Preset (Harbor walk)' });
    expect(p.value.name).toBe('Lantern Preset (Harbor walk)');
    expect(p.overridden).toBe(true);
    expect(block(p.value, 'style').enabled).toBe(true);
    expect(block(p.value, 'depthNote').enabled).toBe(true); // another preset's toggle
    expect(p.value.samplers).toEqual({ temperature: 1.1, top_k: 40, min_p: 0.05, max_tokens: 900 });
    const over = p.warnings.filter((w) => w.code === 'rc_preset_overrides').map((w) => w.message);
    expect(over.some((m) => m.includes('1 prompt toggle(s) of the chat name prompts the preset does not have'))).toBe(true);
    expect(over.some((m) => m.includes('1 prompt toggle(s)') && m.includes('min_p') && m.includes('temperature') && m.includes('topK'))).toBe(true);
    const nh = p.warnings.find((w) => w.code === 'not_honoured' && w.path === 'sampler_overrides')!;
    expect(nh.message).toContain('logit_bias');
    expect(nh.message).not.toContain('top_a');
  });

  test("the chat's Start Reply With wins over the preset's prefill; a messages-bounded context becomes the preset's message limit (N + 1)", () => {
    const p = presetFromRow(presetRow(), { config: { sampler_overrides: { prefill: '<plan>' }, preset_sampler_overrides: { contextMode: 'messages', maxMessages: 40 } } });
    expect(p.value.prefill).toBe('<plan>');
    expect(p.overridden).toBe(true);
    // RoleCall keeps the user's message and the 40 before it.
    expect(p.value.context?.maxMessages).toBe(41);
    expect(p.warnings.some((w) => w.code === 'rc_context_messages' && w.message.includes('41'))).toBe(true);
    expect(p.warnings.some((w) => w.code === 'not_honoured' && w.path === 'context_mode')).toBe(false);
  });

  test("the preset's own messages mode (system_prompts.context_mode / max_messages) maps alone; the chat's token mode turns it off", () => {
    const row = { ...presetRow(), system_prompts: { context_mode: 'messages', max_messages: 12 } };
    const own = presetFromRow(row);
    expect(own.value.context?.maxMessages).toBe(13);
    expect(own.overridden).toBe(false);
    const tokens = presetFromRow(row, { config: { preset_sampler_overrides: { contextMode: 'tokens' } } });
    expect(tokens.value.context?.maxMessages).toBeUndefined();
    expect(tokens.overridden).toBe(true);
    // RoleCall's loader ignores max_messages 0 for the preset; the chat's 0 keeps only the user's message.
    expect(presetFromRow({ ...row, system_prompts: { context_mode: 'messages', max_messages: 0 } }).value.context?.maxMessages).toBeUndefined();
    expect(presetFromRow(row, { config: { preset_sampler_overrides: { maxMessages: 0 } } }).value.context?.maxMessages).toBe(1);
    expect(presetFromRow(presetRow()).value.context?.maxMessages).toBeUndefined();
  });

  test('a row that is not an object gives a valid preset with a warning', () => {
    const p = presetFromRow('nope');
    expect(validatePreset(p.value).ok).toBe(true);
    expect(codes(p.warnings)).toContain('invalid_value');
  });
});

describe('booksFromRows', () => {
  test('a book row is read as a Compendium export: rows in sort_order, typed rows, arc overviews, consumed rows disabled', () => {
    const { books, warnings } = booksFromRows([bookRow('book-a', 'Harbor')]);
    // The book's own token budget: one line for all the books (fidelity#6), not one per book.
    expect(warnings).toEqual([
      {
        code: 'not_honoured',
        path: 'lorebooks[*].token_budget',
        message: 'RoleCall capped these lorebooks at their own token budgets, which rp-core does not honour (its lorebooks share one budget): "Harbor" 2048',
      },
    ]);
    const [b] = books;
    expect(validateLoreBook(b!.book).ok).toBe(true);
    expect(b!.rcIds).toEqual(['book-a']);
    expect(b!.book).toMatchObject({ name: 'Harbor', scanDepth: 50, recursive: false });
    expect(b!.book.entries.map((e) => e.id)).toEqual(['e2', 'e1', 'e3', 'e4']);
    expect(b!.book.entries[0]!.meta).toEqual({ arc: 'The Storm' });
    expect(b!.book.entries[2]!.meta).toMatchObject({ type: 'character', data: { name: 'Keeper Ona', role: 'keeper' } });
    expect(b!.book.entries[1]!.keys).toEqual(['lighthouse']);
    expect(b!.book.entries[3]!.enabled).toBe(false);
    expect(b!.book.entries[2]!.enabled).toBe(true);
    expect(b!.consumed).toBe(1);
    expect(codes(b!.warnings)).toContain('rc_book_consumed');
    expect(b!.book.extras).toMatchObject({ description: 'Harbor lore.', lorebook_type: 'world', token_budget: 2048 });
  });

  test('identical books are one (the copy with the metadata is read); a different book with a taken name is renamed', () => {
    const copy = bookRow('book-c-0000', 'Harbor (copy)', { wipe: true, reverse: true, rowIds: 'c' });
    const other = { ...bookRow('bbbbbbbb-0000', 'Harbor'), entries: [{ id: 'o1', title: 'Pier', content: 'Wooden.', enabled: true, triggers: [{ keyword: 'pier' }], sort_order: 0 }] };
    const { books, warnings } = booksFromRows([copy, bookRow('book-a', 'Harbor'), other]);
    expect(books).toHaveLength(2);
    expect(books[0]!.rcIds).toEqual(['book-a', 'book-c-0000']);
    expect(books[0]!.book.name).toBe('Harbor');
    expect(books[0]!.book.entries[1]!.extras).toMatchObject({ metadata: { source: 'tv_ingest' } });
    expect(books[1]!.book.name).toBe('Harbor (bbbbbbbb)');
    expect(books[1]!.renamedFrom).toBe('Harbor');
    expect(books[1]!.rcIds).toEqual(['bbbbbbbb-0000']);
    expect(codes(warnings)).toEqual(['rc_book_renamed', 'rc_book_duplicate', 'not_honoured']);
    // The copy is named by the library book it merged into, not by RoleCall ids (ux#10).
    expect(warnings[1]).toEqual({ code: 'rc_book_duplicate', path: 'lorebooks[0]', message: 'a copy of lorebook "Harbor" with the same rows is imported once' });
    expect(warnings[2]!.message).toEndWith('"Harbor" 2048, "Harbor (bbbbbbbb)" 2048');
  });

  test('the hash ignores row order and ids and changes with the rows', () => {
    const a = booksFromRows([bookRow('x', 'Harbor')]).books[0]!;
    const b = booksFromRows([bookRow('y', 'Harbor', { reverse: true, rowIds: 'z' })]).books[0]!;
    const changed = bookRow('x', 'Harbor');
    (changed.entries as Rec[])[0]!.content = 'A short white tower.';
    expect(a.hash).toBe(b.hash);
    expect(booksFromRows([changed]).books[0]!.hash).not.toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rows that are not books are skipped with a warning', () => {
    const { books, warnings } = booksFromRows([null, bookRow('book-a', 'Harbor')]);
    expect(books).toHaveLength(1);
    expect(codes(warnings)).toEqual(['invalid_value', 'not_honoured']);
  });
});

// ---- the review's findings (.notes/rcimport-decisions.md, "Rulings after the review") ---------------

const MAIN_DIR = `chats/Harbor_walk-${MAIN.slice(0, 8)}`;
/** The story with the main chat's lines and config replaced. */
const storyWith = (lines: Rec[], config: Rec = CHAT_CONFIG, extra: Rec = {}, over?: (m: Map<string, string>) => void): StoryBundle =>
  story((m) => {
    m.set(`${MAIN_DIR}/chat.json`, JSON.stringify(chatJson(MAIN, { is_main_timeline: true, title: 'Harbor walk', summary: 'They met.', active_lorebooks: ['book-a'], config, ...extra })));
    m.set(`${MAIN_DIR}/messages.jsonl`, jsonl(lines));
    over?.(m);
  });
const sessionOf = (plan: ReturnType<typeof planStoryImport>, id = MAIN) => plan.sessions.find((x) => x.chatId === id)!;
type PlanMsg = { t: string; id?: string; blocks?: { k: string; text?: string }[]; dir?: unknown };
const planMsgs = (plan: ReturnType<typeof planStoryImport>, id = MAIN): PlanMsg[] => (sessionOf(plan, id).entries as PlanMsg[]).filter((e) => e.t === 'msg');

describe('review fixes: messages', () => {
  const main = chatOf(story(), MAIN);

  test("fidelity#1: the preset's own assistant prefill opens no reasoning tag; the chat's Start Reply With still does", () => {
    const answer = '<scene>Wind at the pier.</scene>\nShe smiles.';
    const lines = [line(0, 'g', 'assistant', 'Hi.', [swipe('Hi.', 0)]), line(1, 'u', 'user', 'Yo.', [swipe('Yo.', 1)]), line(2, 'a', 'assistant', answer, [swipe(answer, 2)])];
    const prefilled = (m: Map<string, string>) => m.set('presets/Lantern_Preset.json', JSON.stringify({ ...presetRow(), system_prompts: { assistant_prefill: '<scene>' } }));
    const plain = planMsgs(planStoryImport(storyWith(lines, { preset_id: 'preset-1' }, {}, prefilled))).at(-1)!;
    expect(reasoningOf(plain)).toEqual([]);
    expect(textOf(plain)).toBe(answer);
    const chatTag = planMsgs(planStoryImport(storyWith(lines, { preset_id: 'preset-1', sampler_overrides: { prefill: '<scene>' } }, {}, prefilled))).at(-1)!;
    expect(reasoningOf(chatTag)).toEqual(['Wind at the pier.']);
    expect(textOf(chatTag)).toBe('She smiles.');
  });

  test("fidelity#2: RoleCall's name macros are written out with the persona's and the character's names", () => {
    expect(rcNames('{{user}} waves at {{Char}}; <BOT> nods to {{ player }} and {{CHARACTER}}. \\{{user}} stays, {{users}} too.', { user: 'Tam', char: 'Mira' })).toBe(
      'Tam waves at Mira; Mira nods to Tam and Mira. \\{{user}} stays, {{users}} too.',
    );
    const greeting = 'The gate swings as {{user}} arrives; {{char}} looks up.';
    const lines = [line(0, 'g', 'assistant', greeting, [swipe(greeting, 0)]), line(1, 'u', 'user', 'I nod to <char>.', [swipe('I nod to <char>.', 1)])];
    const p = chatMessages({ ...main, messages: lines }, { names: { user: 'Tam', char: 'Mira' } });
    expect(p.entries.map(textOf)).toEqual(['The gate swings as Tam arrives; Mira looks up.', 'I nod to Mira.']);
    // The content hash (prefix matching) still reads RoleCall's stored text.
    expect(p.fingerprint).toBe(chatMessages({ ...main, messages: lines }).fingerprint);
    const planned = planMsgs(planStoryImport(storyWith(lines)));
    expect(textOf(planned[0]!)).toBe('The gate swings as Tam arrives; Mira looks up.');
  });

  test('fidelity#7: a reasoning RoleCall caught inline (kept as the swipe\'s reasoning and as the <think> block) is one block', () => {
    const content = '<think>She weighs the offer.</think>\n\nShe nods.';
    const lines = (extra: Rec) => [line(0, 'g', 'assistant', 'Hi.', [swipe('Hi.', 0)]), line(1, 'u', 'user', 'Yo.', [swipe('Yo.', 1)]), line(2, 'a', 'assistant', content, [swipe(content, 2, extra)])];
    const last = (extra: Rec) => chatMessages({ ...main, messages: lines(extra) }).entries.at(-1)!;
    expect(reasoningOf(last({ reasoning: 'She weighs the offer.', reasoning_provider: 'inline-tags' }))).toEqual(['She weighs the offer.']);
    expect(reasoningOf(last({ reasoning: 'She weighs it', reasoning_provider: 'inline-tags' }))).toEqual(['She weighs the offer.']);
    expect(reasoningOf(last({ reasoning: ' She weighs the offer. ' }))).toEqual(['She weighs the offer.']);
    expect(reasoningOf(last({ reasoning: 'Native thoughts.' }))).toEqual(['Native thoughts.', 'She weighs the offer.']);
    expect(textOf(last({ reasoning: 'She weighs the offer.', reasoning_provider: 'inline-tags' }))).toBe('She nods.');
  });

  test('robust#4: a time past 9999 or before 1970 is not used (said once); the next version without a time does not throw', () => {
    const lines = [
      line(0, 'g', 'assistant', 'Hi.', [swipe('Hi.', 0, { timestamp: 8.64e15 })]),
      { index: 1, message_id: 'u', role: 'user', content: 'Yo.', swipes: [{ content: 'Yo.' }] },
      line(2, 'a', 'assistant', 'Ok.', [swipe('Ok.', 0, { timestamp: RC_TIME_MAX })], 2),
      { index: 3, message_id: 'v', role: 'user', content: 'Again.', timestamp: -5e14, swipes: [{ content: 'Again.' }] },
    ];
    const p = chatMessages({ ...main, messages: lines });
    expect(p.entries.map((e) => e.ts)).toEqual([new Date(at(0)).toISOString(), new Date(at(0) + 1).toISOString(), '9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z']);
    expect(p.warnings.filter((w) => w.code === 'rc_bad_time').map((w) => w.message)).toEqual([expect.stringMatching(/^2 timestamp\(s\) /)]);
    expect(rcIsoTime(8.64e15)).toBeUndefined();
    expect(rcIsoTime(-1)).toBeUndefined();
    expect(rcIsoTime(RC_TIME_MAX)).toBe('9999-12-31T23:59:59.999Z');
    expect(rcIsoTime('2026-05-01 10:00:00.123456+00')).toBe('2026-05-01T10:00:00.123Z');
  });

  test("robust#7: a finish reason named like Object.prototype's keys is no finish; the entry stays valid", () => {
    for (const reason of ['__proto__', 'constructor', 'toString']) {
      const lines = [line(0, 'g', 'assistant', 'Hi.', [swipe('Hi.', 0)]), line(1, 'u', 'user', 'Yo.', [swipe('Yo.', 1)]), line(2, 'a', 'assistant', 'Ok.', [JSON.parse(`{"content":"Ok.","finishReason":${JSON.stringify(reason)}}`) as Rec])];
      const e = chatMessages({ ...main, messages: lines }).entries.at(-1)!;
      expect(e.gen).toEqual({ kind: 'model' });
      expect(parseEntry(JSON.stringify({ ...e, seq: 3 })).ok).toBe(true);
    }
  });
});

describe('review fixes: branches, books, not carried', () => {
  test("fidelity#5: a branch of a branch whose copy goes past the branch's own copied prefix is a fork of the branch", () => {
    const [m0, m1] = mainLines();
    const b2 = line(2, 'b2', 'assistant', 'A different path.', [swipe('A different path.', 20), swipe('Another path.', 21)], 20);
    const grandchild = [m0!, m1!, b2, line(3, 'c3', 'user', 'Only this one goes here.', [swipe('Only this one goes here.', 30)], 30)];
    const s = story((m) => {
      m.set(`chats/Take_3-${COPY.slice(0, 8)}/chat.json`, JSON.stringify(chatJson(COPY, { parent_chat_id: BRANCH, branch_name: 'Take 4', branch_point_index: 3 })));
      m.set(`chats/Take_3-${COPY.slice(0, 8)}/messages.jsonl`, jsonl(grandchild));
    });
    const plan = planStoryImport(s, { chat: 'all' });
    const branch = sessionOf(plan, BRANCH);
    const copy = sessionOf(plan, COPY);
    // The copied prefix (two messages of main's, one of the branch's: five versions) has the branch's ids.
    expect(copy.fork).toEqual({ chatId: BRANCH, at: branch.head });
    expect(planMsgs(plan, COPY).slice(0, 5).map((e) => e.id)).toEqual(planMsgs(plan, BRANCH).map((e) => e.id));
    expect(plan.warnings.filter((w) => w.code === 'rc_branch_detached')).toEqual([]);
  });

  test('robust#5: two different books with one RoleCall id are two items; the chats get the first, the other is said', () => {
    const other = { ...bookRow('book-a', 'Pier notes'), entries: [{ id: 'o1', title: 'Pier', content: 'Wooden.', enabled: true, triggers: [{ keyword: 'pier' }], sort_order: 0 }] };
    const plan = planStoryImport(story((m) => m.set('lorebooks/Pier-book-a.json', JSON.stringify(other))));
    const books = plan.items.filter((i) => i.kind === 'lorebook');
    expect(books.map((b) => b.name)).toEqual(['Harbor', 'Pier notes']);
    expect(new Set(plan.items.map((i) => i.key)).size).toBe(plan.items.length);
    expect(sessionOf(plan).bookKeys).toEqual([books[0]!.key]);
    expect(plan.warnings.filter((w) => w.code === 'rc_duplicate_book_id').map((w) => w.message)).toEqual([
      'two different lorebooks carry the RoleCall id book-a: the chats get "Harbor"; "Pier notes" is imported to the library but attached to no session',
    ]);
  });

  test('fidelity#6: readCompendium says a book\'s own token budget; a budget of 0 is none', () => {
    const said = (budget: unknown) => readCompendium(compendiumFileOf({ ...bookRow('book-a', 'Harbor'), token_budget: budget }).file, { fallbackName: 'x' }).warnings.filter((w) => w.path === 'lorebook.token_budget');
    expect(said(2048).map((w) => w.code)).toEqual(['not_honoured']);
    expect(said(2048)[0]!.message).toContain('(2048)');
    expect(said(0)).toEqual([]);
    expect(said(null)).toEqual([]);
  });

  test('fidelity#10: the books TunnelVision kept out of keyword lore are named, with the rows that fire here', () => {
    const tv = { ...CHAT_CONFIG, tv_enabled: true, tv_managed_lorebooks: [{ lorebook_id: 'book-a', tv_managed: true, suppress_keywords: true }] };
    const consumedConstant = (m: Map<string, string>) => {
      const row = bookRow('book-a', 'Harbor');
      (row.entries as Rec[])[3]!.constant = true;
      m.set('lorebooks/Harbor-book-a.json', JSON.stringify(row));
    };
    const ws = planStoryImport(storyWith(mainLines(), tv, {}, consumedConstant)).warnings.filter((w) => w.code === 'rc_tunnelvision');
    expect(ws).toEqual([
      {
        code: 'rc_tunnelvision',
        path: `${MAIN_DIR}/chat.json`,
        message: `TunnelVision managed the lorebooks "Harbor" in chat ${MAIN.slice(0, 8)}: RoleCall injected only their constant rows (its tools fetched the rest); their 1 other enabled row that are no Compendium entries fire by keyword here; 1 constant row a Compendium split consumed, which RoleCall still injected, are imported disabled`,
      },
    ]);
    // Not managed, not suppressed, or TunnelVision off: nothing to say.
    for (const managed of [{ tv_managed: false, suppress_keywords: true }, { tv_managed: true, suppress_keywords: false }]) {
      const config = { ...tv, tv_managed_lorebooks: [{ lorebook_id: 'book-a', ...managed }] };
      expect(planStoryImport(storyWith(mainLines(), config)).warnings.some((w) => w.code === 'rc_tunnelvision')).toBe(false);
    }
    expect(planStoryImport(storyWith(mainLines(), { ...tv, tv_enabled: false })).warnings.some((w) => w.code === 'rc_tunnelvision')).toBe(false);
  });

  test('ux#9: features switched off are not "not carried"; a summary is said lost when no lorebook keeps the past', () => {
    const off = { ...CHAT_CONFIG, tv_enabled: false, tv_managed_lorebooks: [{ lorebook_id: 'book-a', tv_managed: true }], tv_summary_interval: 10, immersionModules: { quests: { enabled: false }, bonds: { enabled: false, subFeatures: { x: true } } }, mind_enabled: false };
    expect(planStoryImport(storyWith(mainLines(), off)).warnings.some((w) => w.code === 'rc_modules')).toBe(false);
    const on = { ...off, immersionModules: { quests: { enabled: true } } };
    expect(planStoryImport(storyWith(mainLines(), on)).warnings.find((w) => w.code === 'rc_modules')!.message).toBe('RoleCall features rp-core does not have are not carried: immersion modules');
    const summary = (plan: ReturnType<typeof planStoryImport>) => plan.warnings.find((w) => w.code === 'rc_chat_summary')!.message;
    expect(summary(planStoryImport(storyWith(mainLines())))).toBe("RoleCall's chat summary (1 chat, 9 chars) not carried; the lorebooks keep the story's past");
    expect(summary(planStoryImport(storyWith(mainLines(), CHAT_CONFIG, { active_lorebooks: [] })))).toBe("RoleCall's chat summary (1 chat, 9 chars) not carried; its text is not imported anywhere");
  });
});

describe('review fixes: the preset', () => {
  const rowWith = (prompts: Rec[]): Rec => ({ ...presetRow(), prompts: [...(presetRow().prompts as Rec[]).filter((p) => !prompts.some((q) => q.identifier === p.identifier)), ...prompts] });
  const enabledBlocks = (row: Rec) => presetFromRow(row).value.blocks.filter((b) => b.enabled);

  test("fidelity#8: a slot marker's own text is sent as RoleCall's loader sends it", () => {
    const row = rowWith([
      { identifier: 'chatHistory', name: 'Chat History', marker: true, enabled: true, sort_order: 30, content: 'Recap of events:', role: 'system' },
      { identifier: 'personaDescription', name: 'Persona', marker: true, enabled: true, sort_order: 15, content: 'About the user:', role: 'system' },
      { identifier: 'charDescription', name: 'Char', marker: true, enabled: true, sort_order: 12, content: 'Be brief here.', role: 'system' },
      { identifier: 'worldInfoBefore', name: 'World Info (before)', marker: true, enabled: true, sort_order: 5, content: 'Lore follows.', role: 'system' },
    ]);
    const blocks = enabledBlocks(row);
    expect(blocks.filter((b) => b.content.includes('{{history}}')).map((b) => b.content)).toEqual(['Recap of events:\n\n{{history}}']);
    expect(blocks.filter((b) => b.content.includes('{{persona}}')).map((b) => b.content)).toEqual(['About the user:\n\n{{persona}}']);
    expect(blocks.some((b) => b.content === 'Be brief here.')).toBe(true);
    expect(blocks.some((b) => b.content.includes('{{description}}'))).toBe(false);
    const lore = blocks.findIndex((b) => b.content === '{{lore::before}}');
    expect(blocks[lore - 1]!.content).toBe('Lore follows.');
    // A prompt that holds the history already: the marker's text is sent alone.
    const held = enabledBlocks(rowWith([
      { identifier: 'chatHistory', name: 'Chat History', marker: true, enabled: true, sort_order: 30, content: 'Recap of events:', role: 'system' },
      { identifier: 'hist', name: 'History', enabled: true, sort_order: 35, content: 'Log:\n{{message_history}}', role: 'system' },
    ]));
    expect(held.filter((b) => b.content.includes('Recap of events:')).map((b) => b.content)).toEqual(['Recap of events:']);
    // A disabled marker with text sends nothing, as before.
    const off = presetFromRow(rowWith([{ identifier: 'charDescription', name: 'Char', marker: true, enabled: false, sort_order: 12, content: 'Be brief here.' }])).value.blocks;
    expect(off.some((b) => b.enabled && b.content === 'Be brief here.')).toBe(false);
  });

  test("fidelity#9: a repeated identifier sends the first row RoleCall's loader would send (enabled, with text or a marker)", () => {
    const row = rowWith([
      { identifier: 'twice', name: 'Empty', content: '   ', role: 'system', enabled: true, sort_order: 50, injection_position: '0' },
      { identifier: 'twice', name: 'Full', content: 'second text', role: 'system', enabled: true, sort_order: 60, injection_position: '0' },
    ]);
    expect(presetFromRow(row).value.blocks.find((b) => b.id === 'twice')).toMatchObject({ content: 'second text', enabled: true });
    expect(presetFromRow(row).warnings.find((w) => w.code === 'rc_duplicate_prompt')!.message).toContain('first enabled one with text (or a marker)');
  });

  test('robust#7: sampler ids and preset keys named like Object.prototype\'s keys are plain unknown names', () => {
    const config = { sampler_overrides: JSON.parse('{"enabled":{"constructor":true,"toString":true,"__proto__":true},"values":{"constructor":1,"toString":2,"__proto__":3}}') as Rec };
    const built = rcPresetExport(presetRow(), { config });
    expect(Object.keys(built.json).filter((k) => k.includes('native code'))).toEqual([]);
    expect(built.overridden).toBe(false);
    expect(built.warnings.find((w) => w.code === 'not_honoured')!.message).toContain('constructor, toString, __proto__');
    const raw = rcPresetExport({ ...presetRow(), raw_settings: JSON.parse('{"__proto__":{"polluted":1},"extensions":{}}') as Rec });
    expect(Object.getPrototypeOf(raw.json)).toBe(Object.prototype);
    expect((raw.json as Rec).polluted).toBeUndefined();
    expect(Object.hasOwn(raw.json, '__proto__')).toBe(true);
    const toggles = rcPresetExport({ ...presetRow(), id: '__proto__' }, { config: { preset_prompt_overrides: {} } });
    expect(toggles.overridden).toBe(false);
  });

  test('ux#10: markers with nothing to send are one warning that lists them', () => {
    const row = rowWith([1, 2, 3].map((n) => ({ identifier: `empty${n}`, name: `Empty marker ${n}`, marker: true, enabled: true, sort_order: 70 + n, content: '' })));
    const ws = presetFromRow(row).warnings.filter((w) => w.code === 'unknown_marker');
    expect(ws).toEqual([{ code: 'unknown_marker', path: 'prompts[*].identifier', message: '3 marker prompt(s) without text have nothing to send and are kept disabled: "empty1", "empty2", "empty3"' }]);
  });
});
