// Lint of the M3 demo chat (test/fixtures/ru/innkeeper-200, ARCHITECTURE.md §15): its shape, the one
// mention of the brother, its size against a 16k window, the generator's determinism and the seeding
// helper. The fixture only: the search and the tool loop are tested elsewhere.
import { beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../src/engine/engine.ts';
import type { EngineHandle } from '../../src/engine/api.ts';
import { O200K_COUNTER } from '../../src/prompt/tokens.ts';
import { SCRIPT_CAPS } from '../../src/providers/scripted.ts';
import { sessionsDir } from '../../src/session/log.ts';
import { foldText, matchQuery, normalizeTerm, parseQuery, wordsOf } from '../../src/text/normalize.ts';
import { buildInnkeeper } from '../../tools/fixtures/innkeeper.ts';
import { scriptConn } from '../engine/kit.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import {
  INNKEEPER_BROTHER,
  INNKEEPER_DIR,
  INNKEEPER_MENTION,
  INNKEEPER_NOTE,
  INNKEEPER_QUESTION,
  innkeeperConnection,
  loadInnkeeper,
  seedInnkeeperHome,
  seedInnkeeperSession,
} from '../fixtures/ru/innkeeper-200/load.ts';

const BROTHER = normalizeTerm('брат');
const fx = loadInnkeeper();
const { messages } = fx;
const data = (fx.card as { data: Record<string, string> }).data; // the card's text fields
/** #n of the messages whose words include a form of «брат» (stem equality, the search's rule). */
const brotherHits = (): number[] =>
  messages.flatMap((m, i) => (wordsOf(m.text).some((w) => w.stem === BROTHER) ? [i + 1] : []));

describe('innkeeper-200: shape', () => {
  test('199 messages, the greeting first, then user/assistant in turn', () => {
    expect(messages).toHaveLength(199);
    messages.forEach((m, i) => expect(m.role).toBe(i % 2 === 0 ? 'assistant' : 'user'));
    expect(messages[0]!.text).toBe(fx.character.greetings[0]!);
    expect(fx.character.greetings).toHaveLength(1);
  });

  test('the card and the persona import cleanly', () => {
    expect(fx.character.name).toBe('Марфа');
    expect(fx.persona.name).toBe('Елисей');
    for (const k of ['description', 'personality', 'scenario', 'first_mes', 'mes_example']) expect(data[k]!.length).toBeGreaterThan(50);
  });

  test('assistant messages are 300–900 characters, user messages 60–300', () => {
    for (const m of messages) {
      const [min, max] = m.role === 'assistant' ? [300, 900] : [60, 300];
      expect(m.text.length).toBeGreaterThanOrEqual(min);
      expect(m.text.length).toBeLessThanOrEqual(max);
    }
  });

  test('no two messages are the same', () => {
    expect(new Set(messages.map((m) => m.text)).size).toBe(messages.length);
  });
});

describe('innkeeper-200: the one mention', () => {
  test('exactly one message has a word with the stem of «брат», an early assistant message', () => {
    const hits = brotherHits();
    expect(hits).toEqual([INNKEEPER_MENTION]);
    expect(INNKEEPER_MENTION).toBeGreaterThanOrEqual(3);
    expect(INNKEEPER_MENTION).toBeLessThanOrEqual(9);
    expect(messages[INNKEEPER_MENTION - 1]!.role).toBe('assistant');
    // The inflected form the stem search must find; the bare noun appears nowhere.
    expect(wordsOf(messages[INNKEEPER_MENTION - 1]!.text).filter((w) => w.stem === BROTHER).map((w) => w.norm)).toEqual(['братом']);
  });

  test('exactly one message contains «Тихон», the same one', () => {
    const hits = messages.flatMap((m, i) => (m.text.includes(INNKEEPER_BROTHER) ? [i + 1] : []));
    expect(hits).toEqual([INNKEEPER_MENTION]);
  });

  test('no other text even contains the letters «брат» or «тихон» (substring search finds one hit too)', () => {
    const others = [
      ...messages.filter((_, i) => i + 1 !== INNKEEPER_MENTION).map((m) => m.text),
      JSON.stringify(fx.card),
      JSON.stringify(fx.persona),
    ];
    for (const text of others) {
      expect(foldText(text)).not.toContain('брат');
      expect(foldText(text)).not.toContain('тихон');
    }
  });

  test('the name sits inside a ±110-character snippet around «братом»', () => {
    const text = messages[INNKEEPER_MENTION - 1]!.text;
    const at = text.indexOf('братом');
    const name = text.indexOf(INNKEEPER_BROTHER);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(Math.abs(name - at)).toBeLessThan(110);
  });

  test('stem queries (AND of all parts) hit #5 only; the question as asked hits nothing', () => {
    const hits = (q: string): number[] => {
      const query = parseQuery(q);
      return messages.flatMap((m, i) => (matchQuery(query, m.text).all ? [i + 1] : []));
    };
    for (const q of ['брат', 'брата', 'братом', 'Тихон', 'брат Тихон']) expect(hits(q)).toEqual([INNKEEPER_MENTION]);
    // #5 says «зовут», not «звали»: a model must shorten its query to the root (test plan §6, call 1).
    expect(hits('звали брата')).toEqual([]);
    expect(hits(INNKEEPER_QUESTION)).toEqual([]);
  });

  test('the question and the note key have the same stem as the mention', () => {
    expect(wordsOf(INNKEEPER_QUESTION).filter((w) => w.stem === BROTHER).map((w) => w.norm)).toEqual(['брата']);
    expect(INNKEEPER_NOTE.keys.map((k) => normalizeTerm(k))).toEqual([BROTHER]);
  });
});

describe('innkeeper-200: size', () => {
  test('the fixture holds 40 000+ o200k tokens (messages, card fields, persona); the messages alone 38 000+', () => {
    const count = (text: string): number => O200K_COUNTER.count(text);
    const chat = messages.reduce((s, m) => s + count(m.text), 0);
    // first_mes is message #1, counted once.
    const card = ['description', 'personality', 'scenario', 'mes_example'].reduce((s, k) => s + count(data[k]!), 0);
    const all = chat + card + count(fx.persona.description);
    expect(chat).toBeGreaterThanOrEqual(38_000);
    expect(all).toBeGreaterThanOrEqual(40_000);
  });
});

describe('innkeeper-200: generator', () => {
  test('tools/fixtures/innkeeper.ts reproduces the committed files byte for byte', () => {
    const built = buildInnkeeper();
    for (const [name, value] of Object.entries(built)) {
      expect(readFileSync(join(INNKEEPER_DIR, `${name}.json`), 'utf8')).toBe(`${JSON.stringify(value, null, 2)}\n`);
    }
  });
});

describe('innkeeper-200: seeding', () => {
  let home: string;
  let id: string;
  let ms: number;

  beforeAll(async () => {
    home = tmpHome();
    const t0 = performance.now();
    id = await seedInnkeeperHome(home);
    ms = performance.now() - t0;
  });

  /** An engine on the seeded home, or on a copy of it for a test that writes (configure). */
  async function open(extra: Record<string, ReturnType<typeof scriptConn>['conn']> = {}, at = home): Promise<EngineHandle> {
    return Engine.open({ home: at, connections: { innkeeper: innkeeperConnection(), ...extra }, clock: fakeClock(), random: fakeRandom(3), timeZone: 'UTC' });
  }

  test('seedInnkeeperHome builds the whole chat in under 3 s, without a model', () => {
    expect(ms).toBeLessThan(3000);
  });

  test('the seeded session is the fixture: 199 messages on the view path, greeting first', async () => {
    const engine = await open();
    try {
      const s = engine.session(id);
      const path = s.view().path;
      expect(path).toHaveLength(199);
      expect(path.map((m) => m.role)).toEqual(messages.map((m) => m.role));
      expect(path.map((m) => m.blocks.map((b) => ('text' in b ? b.text : '')).join(''))).toEqual(messages.map((m) => m.text));
      expect(path[0]!.gen?.kind).toBe('greeting');
      expect(path[INNKEEPER_MENTION - 1]!.gen?.kind).toBe('model');
      expect(s.header().cast.character.name).toBe('Марфа');
      expect(s.header().cast.persona?.name).toBe('Елисей');
    } finally {
      await engine.close();
    }
  });

  test('seeding is deterministic: a second home gets the same session file, byte for byte', async () => {
    const again = tmpHome();
    expect(await seedInnkeeperHome(again)).toBe(id);
    const file = `${id}.jsonl`;
    expect(readdirSync(sessionsDir(again))).toEqual([file]);
    expect(readFileSync(join(sessionsDir(again), file)).equals(readFileSync(join(sessionsDir(home), file)))).toBe(true);
  });

  test('seedInnkeeperSession works on a caller engine and leaves the binding asked for', async () => {
    const own = tmpHome();
    const { conn } = scriptConn('script', []);
    const engine = await Engine.open({ home: own, connections: { innkeeper: innkeeperConnection(), script: conn }, clock: fakeClock(), random: fakeRandom(5), timeZone: 'UTC' });
    try {
      const sid = await seedInnkeeperSession(engine, { upTo: 9, narrator: { conn: 'script', model: 'default' } });
      const s = engine.session(sid);
      expect(s.view().path.map((m) => m.role)).toEqual(messages.slice(0, 9).map((m) => m.role));
      // Created on the seeding binding; the next turn goes to the one asked for.
      expect(s.header().config.roles.narrator.conn).toBe('innkeeper');
      const p = s.preview({ draft: INNKEEPER_QUESTION });
      if (!p.ok) throw new Error(p.message);
      expect(p.model).toEqual({ connection: 'script', model: 'default' });
    } finally {
      await engine.close();
    }
  });

  test('at a 16 384-token window (2 048 reserved) the question turn trims the early messages, #5 included', async () => {
    const { conn } = scriptConn('local16k', [], { ...SCRIPT_CAPS, contextLength: 16_384 });
    const copy = tmpHome();
    cpSync(home, copy, { recursive: true });
    const engine = await open({ local16k: conn }, copy);
    try {
      const s = engine.session(id);
      s.configure({ roles: { narrator: { conn: 'local16k', model: 'default' } } });
      const p = s.preview({ draft: INNKEEPER_QUESTION });
      if (!p.ok) throw new Error(p.message);
      expect(p.maxTokens).toBe(2048);
      expect(p.trace.trimmed).not.toBeNull();
      const sent = p.messages.map((m) => m.blocks.map((b) => ('text' in b ? b.text : '')).join(''));
      expect(sent.some((t) => t.includes(INNKEEPER_BROTHER))).toBe(false);
      expect(sent.some((t) => t.includes(messages[198]!.text))).toBe(true);
      expect(sent.at(-1)).toContain(INNKEEPER_QUESTION);
    } finally {
      await engine.close();
    }
  });
});
