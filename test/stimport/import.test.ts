import { expect, test } from 'bun:test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSessionFile } from '../../src/session/log.ts';
import { buildTree, pathTo, swipeSiblings } from '../../src/session/tree.ts';
import { CARDS, run } from '../cli/kit.ts';
import { tmpHome } from '../helpers.ts';

const exportFile = (rows: unknown[]): string => {
  const file = join(tmpHome('rp-core-st-file-'), 'Harbor chat.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
};

const header = { user_name: 'Nika', character_name: 'Mira', create_date: '2026-01-01T00:00:00Z', chat_metadata: {} };
const history = [
  header,
  { name: 'Mira', is_user: false, mes: 'Hello.', swipes: ['Hello.', 'Welcome.'], swipe_id: 0, send_date: '2026-01-01T00:00:01Z' },
  { name: 'Nika', is_user: true, mes: 'Where are we?', send_date: '2026-01-01T00:00:02Z' },
  { name: 'Mira', is_user: false, mes: 'At the harbor.', swipes: ['At sea.', 'At the harbor.', 'In town.'], swipe_id: 1, swipe_info: [{}, { extra: { reasoning: 'Use the map.' } }, {}], send_date: '2026-01-01T00:00:03Z' },
  { name: 'Nika', is_user: true, mes: 'Private note', is_system: true },
];

async function card(home: string): Promise<string> {
  const result = await run(['import', join(CARDS, 'v3-full.json'), '--home', home]);
  expect(result.code).toBe(0);
  return result.stdout.trim();
}

test('SillyTavern JSONL imports the chosen swipe, other versions, reasoning and hidden messages', async () => {
  const home = tmpHome('rp-core-st-');
  const file = exportFile(history);
  const cardId = await card(home);
  const dry = await run(['import', file, '--card', cardId, '--dry-run', '--home', home]);
  expect(dry.code).toBe(0);
  expect(dry.stderr).toContain('nothing was written');
  expect(existsSync(join(home, 'sessions'))).toBe(false);

  const result = await run(['import', file, '--card', cardId, '--home', home]);
  expect(result.code).toBe(0);
  const id = result.stdout.match(/s_[0-9a-f]{8}/)?.[0];
  expect(id).toBeDefined();
  const journal = readSessionFile(home, id!);
  expect(journal.header.imported?.from).toBe('sillytavern');
  expect(journal.header.cast.persona?.name).toBe('Nika');
  expect(journal.header.config.compendium.enabled).toBe(false);
  const tree = buildTree(journal.entries);
  const path = pathTo(tree, tree.head);
  expect(path).toHaveLength(4);
  const texts = path.map((mid) => tree.msgs.get(mid)!.blocks?.find((b) => b.k === 'text')?.text);
  expect(texts).toEqual(['Hello.', 'Where are we?', 'At the harbor.', 'Private note']);
  expect(swipeSiblings(tree, path[2]!)).toHaveLength(3);
  expect(tree.hidden.get(path[3]!)).toBe(true);
  expect(tree.msgs.get(path[2]!)!.blocks?.find((b) => b.k === 'reasoning')?.text).toBe('Use the map.');
  expect(journal.entries.at(-1)).toMatchObject({ t: 'config', patch: { compendium: { enabled: true } } });
  const show = await run(['show', id!, '--home', home]);
  expect(show.stdout).toContain('At the harbor.');

  const again = await run(['import', file, '--card', cardId, '--home', home]);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain(`already imported as ${id}`);
  const fresh = await run(['import', file, '--card', cardId, '--new', '--home', home]);
  expect(fresh.code).toBe(0);
  expect(readdirSync(join(home, 'sessions')).filter((x) => x.endsWith('.jsonl'))).toHaveLength(2);
});

test('a missing card, group chat and bad JSONL fail without creating a session', async () => {
  const home = tmpHome('rp-core-st-');
  const file = exportFile(history);
  const missing = await run(['import', file, '--home', home]);
  expect(missing.code).toBe(64);
  expect(missing.stderr).toContain('--card');
  const cardId = await card(home);
  const group = exportFile([header, { name: 'Mira', is_user: false, mes: 'Hello' }, { name: 'Tavik', is_user: false, mes: 'Ahoy' }]);
  const g = await run(['import', group, '--card', cardId, '--home', home]);
  expect(g.code).toBe(1);
  expect(g.stderr).toContain('group chats are not supported');
  writeFileSync(file, `${JSON.stringify(header)}\n{broken\n`);
  const bad = await run(['import', file, '--card', cardId, '--home', home]);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain('line 2: not valid JSON');
  expect(existsSync(join(home, 'sessions'))).toBe(false);
});

test('a stale swipe_id follows mes; --persona overrides the export name', async () => {
  const home = tmpHome('rp-core-st-');
  const cardId = await card(home);
  const file = exportFile([header, { name: 'Mira', is_user: false, mes: 'Chosen.', swipes: ['Other.', 'Chosen.'], swipe_id: 0, extra: { reasoning: 'This is the chosen reply.' } }]);
  const persona = join(tmpHome('rp-core-st-persona-'), 'persona.json');
  writeFileSync(persona, JSON.stringify({ name: 'Levi', description: 'A sailor' }));
  const result = await run(['import', file, '--card', cardId, '--persona', persona, '--json', '--home', home]);
  expect(result.code).toBe(0);
  const report = JSON.parse(result.stdout) as { id: string; warnings: string[] };
  const journal = readSessionFile(home, report.id);
  expect(journal.header.cast.persona?.name).toBe('Levi');
  const tree = buildTree(journal.entries);
  const selected = tree.msgs.get(tree.head!);
  expect(selected?.blocks?.find((b) => b.k === 'text')?.text).toBe('Chosen.');
  expect(selected?.blocks?.find((b) => b.k === 'reasoning')?.text).toBe('This is the chosen reply.');
  expect(swipeSiblings(tree, tree.head!)).toHaveLength(2);
  expect(report.warnings).toBeArray();
});
