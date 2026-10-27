// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The demo's $EDITOR (not a test file): `bun test/demo-m5a/editor.ts <file>`, as the REPL runs
// $EDITOR on the JSON of /memory new and /memory edit (D-160). It plays the person at the keyboard:
// - the empty character template named «Мира» → the payload test/fixtures/ru/lantern/mira.character.json;
// - the library entry «Ульяна» → her current_state rewritten (she is found: the overlay demo);
// - anything else → exit 1 (the editor failed: the REPL writes nothing).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MIRA_FILE = join(import.meta.dir, '..', 'fixtures', 'ru', 'lantern', 'mira.character.json');

/** Ульяна's new state, as the person types it over the old one. */
export const ULYANA_STATE = { status: 'alive', location: 'Серый маяк', condition: 'нашлась: три ночи пряталась в фонарной башне' };

/** What the person saves for the text the editor was opened with, or null to give up. */
export function answer(text: string): string | null {
  const data = JSON.parse(text) as Record<string, unknown>;
  if (data.name === 'Мира' && data.description === '') return readFileSync(MIRA_FILE, 'utf8');
  if (data.name === 'Ульяна') return `${JSON.stringify({ ...data, current_state: ULYANA_STATE }, null, 2)}\n`;
  return null;
}

if (import.meta.main) {
  const file = process.argv[2];
  const saved = file === undefined ? null : answer(readFileSync(file, 'utf8'));
  if (saved === null) process.exit(1);
  writeFileSync(file!, saved);
}
