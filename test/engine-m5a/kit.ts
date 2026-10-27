// Shared setup for the M5a engine tests (not a test file itself): a library book with typed entries
// (the Compendium's seed), sessions that read it, and readers for previews, events and refusals.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineHandle, PreviewResult, SessionHandle } from '../../src/engine/api.ts';
import { Refusal, type RefusalCode } from '../../src/engine/api.ts';
import { libraryDir, saveToLibrary } from '../../src/formats/library.ts';
import type { LoreBook, LoreEntry } from '../../src/formats/native.ts';
import type { Event } from '../../src/protocol/events.ts';
import type { PromptMsg } from '../../src/providers/types.ts';
import type { DeepPartial, MemEntry, SessionConfig } from '../../src/session/entries.ts';
import { entriesOf, LEVI, MIRA } from '../engine/kit.ts';

export { calls, drain, entriesOf, LEVI, MIRA, rig, scriptConn, textOf, writeRaw } from '../engine/kit.ts';
export { byAgent, dirCall, dirConfig, dirSession, directorUser, fullCaps, msgBySrc, planOf, textOfMsg, turnOf } from '../engine-m4/kit.ts';

/** Мира, a typed character of the library book (Cyrillic: never the card's Latin "Mira"). */
export const MIRA_ENTRY: LoreEntry = {
  id: 'e1',
  title: 'Мира',
  keys: ['Мира', 'Фонарщица'],
  content: 'Мира — младшая фонарщица Вельмара.',
  position: 'after',
  meta: {
    type: 'character',
    aliases: ['Фонарщица'],
    data: {
      name: 'Мира',
      description: 'Младшая фонарщица Вельмара. Хранит последний огонь гильдии.',
      role: 'protagonist',
      current_state: { status: 'alive', location: 'Фонарный ряд', condition: 'не спала две ночи' },
      relationships: [{ with: 'Арсений Кеттер', nature: 'mentor', status: 'active', notes: 'учитель с её двенадцати лет' }],
      likes: ['тёплый свет', 'тишина порта'],
    },
  },
};

/** A typed place. */
export const LIGHTHOUSE: LoreEntry = {
  id: 'e2',
  title: 'Серый маяк',
  keys: ['маяк'],
  content: 'Серый маяк стоит на мысу.',
  position: 'after',
  meta: { type: 'location', data: { name: 'Серый маяк', description: 'Старый маяк на мысу над гаванью.', type: 'building' } },
};

/** A plain constant entry at depth 1 (lore that fires every turn, at the block's depth). */
export const HARBOUR: LoreEntry = {
  id: 'e3',
  title: 'Гавань',
  keys: ['гавань'],
  content: 'В гавани пахнет солью.',
  constant: true,
  position: { depth: 1, role: 'system' },
};

/** A plain (untyped) entry: the name a typed `file` may not take (classic_conflict). */
export const GUILD: LoreEntry = { id: 'e4', title: 'Гильдия', keys: ['гильдия'], content: 'Гильдия фонарщиков.', position: 'before' };

export const LANTERN: LoreBook = { name: 'Lantern', entries: [MIRA_ENTRY, LIGHTHOUSE, HARBOUR, GUILD] };

/** A book with no typed entry at all. */
export const PLAIN: LoreBook = { name: 'Plain', entries: [HARBOUR, GUILD] };

/** Save a book to the test home's library; returns its library id. */
export function putBook(home: string, book: LoreBook, name = book.name): string {
  return saveToLibrary(home, 'lorebooks', name, book).id;
}

/** The book file as text (to prove nothing wrote it). */
export const bookText = (home: string, id: string): string => readFileSync(join(libraryDir(home, 'lorebooks'), `${id}.json`), 'utf8');

/** Rewrite a library book in place (a changed file). */
export function rewriteBook(home: string, id: string, book: LoreBook): void {
  writeFileSync(join(libraryDir(home, 'lorebooks'), `${id}.json`), `${JSON.stringify(book, null, 2)}\n`);
}

/** A session with the book attached (persona Levi) and, unless `text` is null, one user message. */
export function bookSession(
  engine: EngineHandle,
  books: string[],
  opts: { text?: string | null; config?: DeepPartial<SessionConfig> } = {},
): SessionHandle {
  const s = engine.createSession({ character: MIRA, persona: LEVI, config: { lorebooks: books, ...(opts.config ?? {}) } });
  if (opts.text !== null) s.send({ text: opts.text ?? 'Я ищу Миру у маяка.', expectedVersion: s.version() });
  return s;
}

export const ok = (p: PreviewResult): Extract<PreviewResult, { ok: true }> => {
  if (!p.ok) throw new Error(`preview refused: ${p.code} ${p.message}`);
  return p;
};

export const textOfPrompt = (m: PromptMsg): string => m.blocks.reduce((s, b) => (b.k === 'text' ? s + b.text : s), '');

/** The texts of the request's messages with this src. */
export const srcTexts = (messages: readonly PromptMsg[], src: string): string[] => messages.filter((m) => m.src === src).map(textOfPrompt);

/** The refusal a call throws: its code and message. */
export function refusalOf(fn: () => unknown): { code: RefusalCode; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof Refusal) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error('expected a Refusal');
}

/** Collect every engine event until the engine closes. */
export function collect(engine: { events(): AsyncIterable<Event> }): { seen: Event[]; done: Promise<void> } {
  const seen: Event[] = [];
  const tail = engine.events();
  const done = (async () => {
    for await (const ev of tail) seen.push(ev);
  })();
  return { seen, done };
}

/** Wait for the event bus to hand over what was published. */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

export const memRows = (home: string, id: string): MemEntry[] => entriesOf(home, id).filter((e): e is MemEntry => e.t === 'mem');
