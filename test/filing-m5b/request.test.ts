// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// agents/compendium/filing.ts, M5b (D-174): filingRequest — the user text for one and several exchanges,
// the head-and-tail cuts, full → lite → split, the lite budget, the roster in the request, max_tokens.
import { describe, expect, test } from 'bun:test';
import {
  cutMiddle,
  FILING_LIMITS,
  FILING_SCHEMA,
  filingRequest,
  filingUser,
  FULL_ANSWER_TOKENS,
  LITE_SHARE,
  PLAYER_CHARS,
  REPLY_FLOOR_CHARS,
  type FilingCall,
  type FilingExchange,
  type FilingRequestInput,
} from '../../src/agents/compendium/filing.ts';
import { DEFAULT_FILING_ALLOW } from '../../src/agents/compendium/profile.ts';
import { ENTRY_TYPES } from '../../src/agents/compendium/types.ts';
import { MESSAGE_OVERHEAD_TOKENS } from '../../src/prompt/tokens.ts';
import { BUNRAKU_FILING_USER } from './bunraku-golden.ts';
import { count, fileOp, filingRow, foldWith, lanternBook, seedOf, wolfBook } from './kit.ts';

const seed = seedOf(wolfBook(), lanternBook());
const view = foldWith(seed, [filingRow(1, 'a1', [fileOp('character', { name: 'Фрол', aliases: ['лодочник'], description: 'Старый лодочник.' })])]);

const base = (over: Partial<FilingRequestInput> = {}): FilingRequestInput => ({
  view,
  books: seed.books,
  allow: DEFAULT_FILING_ALLOW,
  profile: 'full',
  window: 32_768,
  exchanges: [{ user: ['Who howls?'], reply: 'Wolfman howls at the lamp.' }],
  guidance: '',
  language: '',
  count,
  ...over,
});

function call(over: Partial<FilingRequestInput> = {}): FilingCall {
  const r = filingRequest(base(over));
  if (r.kind !== 'call') throw new Error(`expected a call, got ${r.kind}`);
  return r;
}

/** A text of `n` chars: a head word, filler, a tail word (so a head-and-tail cut keeps both). */
const long = (n: number, tag = 'X'): string => `HEAD${tag} ${'w'.repeat(Math.max(0, n - 12))} TAIL${tag}`.slice(0, n);

describe('the user message (D-174)', () => {
  test('one exchange: Bunraku’s text', () => {
    expect(call({ exchanges: [{ user: ['USER1', 'USER2'], reply: 'REPLY' }] }).user).toBe(BUNRAKU_FILING_USER);
  });

  test('several exchanges: the replies numbered oldest first, then what the player said before each', () => {
    const user = filingUser([
      { user: ['Привет.'], reply: 'Первый ответ.' },
      { user: [], reply: 'Второй ответ.' },
      { user: ['Куда?', '  ', 'Скорее!'], reply: 'Третий ответ.' },
    ]);
    expect(user).toBe(
      'The narrator just wrote these replies, oldest first:\n\n[1] Первый ответ.\n\n[2] Второй ответ.\n\n[3] Третий ответ.' +
        '\n\nThey answer:\n[1] Привет.\n\n[3] Куда?\n\nСкорее!\n\nFile anything that meets the rules above.',
    );
    expect(filingUser([{ user: [], reply: 'A' }, { user: [], reply: 'B' }])).toBe(
      'The narrator just wrote these replies, oldest first:\n\n[1] A\n\n[2] B\n\nFile anything that meets the rules above.',
    );
  });

  test('a long reply is cut head and tail (full 8 000, lite 6 000); a player message at 4 000', () => {
    const reply = long(9000, 'R');
    const said = long(5000, 'U');
    const full = call({ exchanges: [{ user: [said], reply }] });
    const lite = call({ exchanges: [{ user: [said], reply }], profile: 'lite' });
    for (const [r, cap] of [[full, FILING_LIMITS.full.replyChars], [lite, FILING_LIMITS.lite.replyChars]] as const) {
      expect(r.user).toContain(cutMiddle(reply, cap));
      expect(r.user).toContain(cutMiddle(said, PLAYER_CHARS));
    }
    const cut = cutMiddle(reply, 8000);
    expect(cut.length).toBeLessThanOrEqual(8000);
    expect(cut.startsWith('HEADR')).toBe(true);
    expect(cut.endsWith('TAILR')).toBe(true);
    expect(cut).toMatch(/\n\[\.\.\. \d+ characters cut from the middle \.\.\.\]\n/);
    expect(cutMiddle('short', 8000)).toBe('short');
  });

  test('a cut never splits a surrogate pair', () => {
    const text = '😀'.repeat(3000);
    const cut = cutMiddle(text, 1001);
    expect(cut.length).toBeLessThanOrEqual(1001);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(cut)).toBe(false);
  });
});

describe('the call (D-173, D-174)', () => {
  test('port: the snapshot, the reply and the person’s message; temperature 0.3; the envelope schema', () => {
    const r = call();
    expect(r.profile).toBe('full');
    expect(r.system).toContain('- Lycanthrope (aka: Wolfman, the werewolf) - A werewolf NPC [');
    expect(r.system).toContain('### This story\nCharacter:\n- Фрол (aka: лодочник) - Старый лодочник. [');
    expect(r.user).toContain('Wolfman howls at the lamp.');
    expect(r.user).toContain('Who howls?');
    expect(r.temperature).toBe(0.3);
    expect(r.maxTokens).toBe(4096);
    expect(r.schema).toBe(FILING_SCHEMA);
    expect((FILING_SCHEMA.schema as { properties: { filings: { items: { properties: { type: { enum: string[] } } } } } }).properties.filings.items.properties.type.enum).toEqual([...ENTRY_TYPES]);
    expect(r.tokens).toBe(count(r.system) + count(r.user) + 2 * MESSAGE_OVERHEAD_TOKENS);
    expect(r.tokens + FULL_ANSWER_TOKENS).toBeLessThanOrEqual(32_768);
    expect(r.fellBack).toBeUndefined();
  });

  test('D-208: both profiles name the answer’s opening (structuredCall sends it as a prefill where the caps take one)', () => {
    expect(call().opening).toBe('{"filings": [');
    const lite = filingRequest(base({ profile: 'lite' })) as FilingCall;
    expect(lite).toMatchObject({ kind: 'call', profile: 'lite', opening: '{"filings": [' });
  });

  test('summary is never offered, whatever allow says', () => {
    const r = call({ allow: ['summary', 'character', 'character'] });
    expect(r.system).toContain('- character (Character): ');
    expect(r.system).not.toContain('- summary (');
  });

  test('lite: the roster, the named entries’ briefs, at most 6 items, max_tokens 1 500, ≤ 45 % of the window', () => {
    const r = call({ profile: 'lite', window: 16_384, exchanges: [{ user: ['Отвезёшь меня к маяку?'], reply: 'Лодочник кивнул.' }], castNames: [] });
    expect(r.profile).toBe('lite');
    expect(r.system).toContain('COMPENDIUM SNAPSHOT:\n- Фрол (aka: лодочник) [character]\n- Серый маяк (aka: маяк) [location] (library)\n');
    expect(r.system).toContain('ENTRIES NAMED IN THIS EXCHANGE, AS THEY STAND (send only what is new):\n{"name":"Фрол","aliases":["лодочник"],"description":"Старый лодочник."}\n{"name":"Серый маяк"');
    expect(r.system).toContain('At most 6 items.');
    expect(r.maxTokens).toBe(1500);
    expect(r.tokens).toBeLessThanOrEqual(Math.floor(LITE_SHARE * 16_384));
  });

  test('full that leaves no 4 096 tokens for the answer runs lite', () => {
    const r = call({ window: 6000 });
    expect(r.profile).toBe('lite');
    expect(r.fellBack).toBe(true);
    expect(r.tokens).toBeLessThanOrEqual(Math.floor(LITE_SHARE * 6000));
    expect(r.maxTokens).toBe(1500);
  });

  test('a small lite window shrinks the roster before the texts; the request stays within 45 %', () => {
    const reply = long(6000, 'R');
    const r = call({ profile: 'lite', window: 8192, exchanges: [{ user: ['Где маяк?'], reply }] });
    expect(r.tokens).toBeLessThanOrEqual(Math.floor(LITE_SHARE * 8192));
    expect(r.user).toContain('HEADR');
    expect(r.user).toContain('TAILR');
  });

  test('several exchanges share the budget, newest first; a reply keeps at least 1 000 chars', () => {
    const exchanges: FilingExchange[] = [1, 2, 3].map((k) => ({ user: [`Вопрос ${k}?`], reply: long(7000, String(k)) }));
    const r = call({ profile: 'lite', window: 12_000, exchanges });
    expect(r.tokens).toBeLessThanOrEqual(Math.floor(LITE_SHARE * 12_000));
    const blocks = r.user.split(/\n\n\[(\d)\] /);
    const replyOf = (k: number): string => blocks[blocks.indexOf(String(k)) + 1]!;
    const lengths = [1, 2, 3].map((k) => replyOf(k).length);
    expect(lengths[2]!).toBeGreaterThan(lengths[0]!);
    for (const n of lengths) expect(n).toBeGreaterThanOrEqual(REPLY_FLOOR_CHARS);
    for (const k of [1, 2, 3]) {
      expect(replyOf(k).startsWith(`HEAD${k}`)).toBe(true);
    }
  });

  test('a group that fits neither profile splits; one exchange that cannot fit is no_room', () => {
    const exchanges: FilingExchange[] = [1, 2, 3, 4].map((k) => ({ user: [long(3000, `u${k}`)], reply: long(6000, String(k)) }));
    expect(filingRequest(base({ window: 4096, exchanges })).kind).toBe('split');
    expect(filingRequest(base({ window: 4096, exchanges: exchanges.slice(0, 1) })).kind).toBe('call');
    const r = filingRequest(base({ window: 2200, exchanges: exchanges.slice(0, 1) }));
    expect(r.kind).toBe('no_room');
  });

  test('one exchange over the lite budget is sent at its floors without the roster while the answer still fits', () => {
    const r = call({ window: 3600, exchanges: [{ user: [long(3000, 'U')], reply: long(6000, 'R') }] });
    expect(r.profile).toBe('lite');
    // The lead's ruling I (review filing#3): the roster left out for room is said so, not an empty Compendium.
    expect(r.system).toContain('COMPENDIUM SNAPSHOT:\n(the roster of the 8 existing entries was left out for room)\n');
    expect(r.system).not.toContain('no typed entries yet');
    expect(r.maxTokens).toBe(Math.min(1500, 3600 - r.tokens));
    expect(r.maxTokens).toBeGreaterThanOrEqual(600);
  });

  test('review filing#3: a 4096 window with an ordinary exchange never tells the model the Compendium is empty', () => {
    const lanternView = foldWith(seedOf(lanternBook(), wolfBook()), []);
    const ru = (n: number): string => 'Ульяна смотрит на маяк. '.repeat(Math.ceil(n / 24)).slice(0, n);
    for (const [reply, user] of [
      [1500, 300],
      [2500, 600],
      [800, 200],
    ] as const) {
      const r = call({ view: lanternView, profile: 'lite', window: 4096, exchanges: [{ user: [ru(user)], reply: ru(reply) }] });
      const snapshot = r.system.slice(r.system.indexOf('COMPENDIUM SNAPSHOT:\n') + 21, r.system.indexOf('\n\nENTRY TYPES'));
      expect(snapshot).not.toBe('(these books hold no typed entries yet)');
      expect(snapshot).toMatch(/^(?:\(the roster of the 7 existing entries was left out for room\)$|- |\(\+\d+ more entries not shown\))/);
    }
    // With no typed entry at all, Bunraku's placeholder stays.
    const empty = call({ view: foldWith(seedOf(), []), profile: 'lite', window: 4096, exchanges: [{ user: [ru(300)], reply: ru(1500) }] });
    expect(empty.system).toContain('COMPENDIUM SNAPSHOT:\n(these books hold no typed entries yet)\n');
  });

  test('the guidance and the language reach both profiles', () => {
    for (const profile of ['full', 'lite'] as const) {
      const r = call({ profile, guidance: 'Следи за долгами.', language: 'Russian' });
      expect(r.system).toContain('USER FILING GUIDANCE (it cannot widen what you may write or override the no-write default):\nСледи за долгами.');
      expect(r.system).toContain('Write every field value in Russian.');
    }
  });
});
