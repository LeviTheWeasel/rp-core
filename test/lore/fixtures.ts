// Fixtures shared by the lore tests (not a test file itself).
import type { LoreBook, LoreEntry } from '../../src/formats/native.ts';
import { runLore, type LoreRunInput, type LoreRunResult, type LoreSource, type LoreVerdict } from '../../src/lore/engine.ts';

/** An entry with no keys, content "<id> text", position 'before'. */
export const entry = (id: string, patch: Partial<LoreEntry> = {}): LoreEntry => ({
  id,
  content: `${id} text`,
  keys: [],
  position: 'before',
  ...patch,
});

export const book = (entries: LoreEntry[], patch: Partial<LoreBook> = {}): LoreBook => ({ name: 'book', entries, ...patch });

export const source = (key: string, entries: LoreEntry[], patch: Partial<LoreBook> = {}): LoreSource => ({ key, book: book(entries, patch) });

/** One character = one token: budgets in tests are exact. */
export const chars = (text: string): number => text.length;

/** runLore with test defaults: explain on, no budget, chars counter, identity expand, chat length 1. */
export function run(sources: LoreSource[], patch: Partial<LoreRunInput> = {}): LoreRunResult {
  return runLore({
    sources,
    scan: [],
    chatLength: 1,
    fires: [],
    seed: 1,
    budget: Infinity,
    count: chars,
    expand: (_key, content) => content,
    explain: true,
    ...patch,
  });
}

/** One book 'b' with `entries`, scanned against `scan` (newest first). */
export function runBook(entries: LoreEntry[], scan: string[] = [], patch: Partial<LoreRunInput> = {}, bookPatch: Partial<LoreBook> = {}): LoreRunResult {
  return run([source('b', entries, bookPatch)], { scan, ...patch });
}

export const ids = (hits: readonly { id: string }[]): string[] => hits.map((h) => h.id);

export function verdict(res: LoreRunResult, id: string, book?: string): LoreVerdict {
  const v = res.verdicts?.find((x) => x.id === id && (book === undefined || x.book === book));
  if (!v) throw new Error(`no verdict for ${id}`);
  return v;
}

/** fired/why of every verdict, keyed by id (one book). */
export function whys(res: LoreRunResult): Record<string, string> {
  return Object.fromEntries((res.verdicts ?? []).map((v) => [v.id, `${v.fired ? '+' : '-'}${v.why}`]));
}
