// Library books for the memory tests (not a test file itself).
import type { LoreEntry } from '../../src/formats/native.ts';
import type { LoreSource } from '../../src/lore/engine.ts';

/** A typed library entry (meta.type + meta.data), as the compendium-v1 import writes one. */
export function typed(id: string, type: string, data: Record<string, unknown>, extra: Partial<LoreEntry> = {}): LoreEntry {
  const title = data.name ?? data.title ?? data.topic ?? id;
  return { id, title: String(title), content: `${String(title)}.`, keys: [String(title)], position: 'after', meta: { type, data }, ...extra };
}

/** A classic (untyped) library entry. */
export function classic(id: string, title: string, extra: Partial<LoreEntry> = {}): LoreEntry {
  return { id, title, content: `About ${title}.`, keys: [title], position: 'after', ...extra };
}

export const source = (key: string, name: string, entries: LoreEntry[]): LoreSource => ({ key, book: { name, entries } });

/** The small Russian book most fold tests read: two characters, a place, a plot, a classic entry, an arc. */
export function lantern(): LoreSource {
  return source('lantern', 'Фонарщики', [
    typed('e1', 'character', {
      name: 'Ульяна',
      aliases: ['Уля'],
      description: 'Смотрительница Серого маяка. Помнит всех фонарщиков.',
      relationships: [{ with: 'Мира', nature: 'ally' }],
    }),
    typed('e2', 'location', { name: 'Серый маяк', description: 'Маяк на мысе.' }, { meta: { type: 'location', data: { name: 'Серый маяк', description: 'Маяк на мысе.' }, aliases: ['маяк'] } }),
    typed('e3', 'plot', { name: 'Украденный свет', status: 'active' }),
    classic('k1', 'Песня фонарщиков'),
    classic('k2', '[Arc] Украденный свет', { meta: { arc: 'Украденный свет' } }),
  ]);
}
