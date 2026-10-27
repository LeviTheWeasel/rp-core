// Shared setup for the M5a REPL tests (not a test file itself): the REPL rig over a home whose library
// holds the Russian lantern book (test/fixtures/ru/lantern, imported as RoleCall's export is), a
// scripted editor, a session seeded with raw rows (an arc, which no verb writes), and row readers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../src/engine/engine.ts';
import { importFile } from '../../src/formats/import.ts';
import type { MemEntry } from '../../src/agents/compendium/types.ts';
import type { DeepPartial, EntryInput, SessionConfig } from '../../src/session/entries.ts';
import type { ScriptCall } from '../../src/providers/scripted.ts';
import { fakeClock, fakeRandom, tmpHome } from '../helpers.ts';
import { entriesOf, LEVI, MIRA, replRig, writeRaw, type ReplRig, type ReplRigOptions } from '../repl/kit.ts';

export { calls, entriesOf } from '../repl/kit.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'ru', 'lantern');
/** RoleCall's export of the lantern world: 18 rows, 15 live typed entries once imported (D-167). */
export const LANTERN_FILE = join(FIXTURES, 'lantern.compendium.json');
/** The /memory new payload of the M5a demo: Мира, who is not in the book. */
export const MIRA_TEXT = readFileSync(join(FIXTURES, 'mira.character.json'), 'utf8');
export const MIRA_DATA = JSON.parse(MIRA_TEXT) as Record<string, unknown>;

/**
 * An editor that answers from a queue, one answer per opening: a string is the saved text, a function
 * gets the text it was opened with, null cancels. An empty queue cancels.
 */
export function editorOf(...answers: (string | null | ((initial: string) => string | null))[]): (initial: string) => string | null {
  return (initial) => {
    const a = answers.shift();
    if (a === undefined || a === null) return null;
    return typeof a === 'function' ? a(initial) : a;
  };
}

/** A fresh home with the lantern book in its library; returns the home and the book's library id. */
export function lanternHome(): { home: string; book: string } {
  const home = tmpHome('rp-core-repl-m5a-');
  return { home, book: importFile(home, LANTERN_FILE).id };
}

/** The REPL over a new session that reads the lantern book (unless `books` is []). */
export async function lanternRig(script: ScriptCall[], o: ReplRigOptions & { books?: string[] } = {}): Promise<ReplRig & { book: string }> {
  const { home, book } = o.home ? { home: o.home, book: 'lantern' } : lanternHome();
  const config: DeepPartial<SessionConfig> = { lorebooks: o.books ?? [book], ...(o.config ?? {}) };
  const r = await replRig(script, { ...o, home, config });
  return { ...r, book };
}

/** A closed session in `home` (Mira and Levi, `config`), with raw rows appended to its journal. */
export async function seededSession(home: string, config: DeepPartial<SessionConfig>, rows: EntryInput[]): Promise<string> {
  const engine = await Engine.open({ home, connections: {}, clock: fakeClock(), random: fakeRandom(3), timeZone: 'UTC' });
  const s = engine.createSession({ character: MIRA, persona: LEVI, config });
  const id = s.id;
  await s.close();
  await engine.close();
  writeRaw(home, id, (log) => {
    for (const row of rows) log.append(row);
  });
  return id;
}

/** The session's mem rows as written. */
export const memRows = (r: { home: string; session: { id: string } }): MemEntry[] =>
  entriesOf(r.home, r.session.id).filter((e): e is MemEntry => e.t === 'mem');

/** The output after the last echo of `line` (what that command printed, up to the next prompt echo). */
export function after(out: string, line: string): string {
  const at = out.lastIndexOf(`› ${line}\n`);
  if (at < 0) throw new Error(`no echo of ${JSON.stringify(line)} in:\n${out}`);
  const rest = out.slice(at + `› ${line}\n`.length);
  const next = rest.search(/^\S+\s*› /m);
  return next < 0 ? rest : rest.slice(0, next);
}
