// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseModelRef } from '../engine/route.ts';
import { systemClock } from '../engine/system.ts';
import { loadFromLibrary } from '../formats/library.ts';
import { validateCharacter, validatePersona, type Persona } from '../formats/native.ts';
import { StChatError, type StChat } from '../formats/st-chat.ts';
import { DEFAULT_SESSION_CONFIG, type SessionConfig, type SessionHeader } from '../session/entries.ts';
import { mergePatch } from '../session/fold.ts';
import { createSessionLogWith, sessionsDir } from '../session/log.ts';
import { UsageError } from './args.ts';
import type { Io } from './io.ts';
import { EXIT } from './oneshot.ts';
import { connectionProblem, type Runtime } from './runtime.ts';

export interface ImportStChatArgs {
  home: string;
  file: string;
  chat: StChat;
  card: string;
  persona?: string;
  model?: string;
  as?: string;
  dryRun: boolean;
  fresh: boolean;
  json: boolean;
  io: Io;
  rt?: Runtime;
  now?: () => Date;
}

const idFor = (source: string, card: string, n: number): string =>
  `s_${createHash('sha256').update(`${source}\u0000${card}\u0000${n}`).digest('hex').slice(0, 8)}`;

function personaFile(file: string): Persona {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    throw new StChatError(`cannot read persona ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const checked = validatePersona(value);
  if (!checked.ok) throw new StChatError(`persona ${file} is invalid: ${checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  return checked.value;
}

/** Import one SillyTavern solo chat; the card already lives in the rp-core library. */
export function cmdImportStChat(a: ImportStChatArgs): number {
  const chat = a.chat;
  let raw: unknown;
  try {
    raw = loadFromLibrary(a.home, 'characters', a.card);
  } catch (e) {
    throw new StChatError(`cannot load library character ${JSON.stringify(a.card)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (raw === null) throw new StChatError(`no library character ${JSON.stringify(a.card)}; import the card first with rp-core import <card.png>`);
  const checked = validateCharacter(raw);
  if (!checked.ok) throw new StChatError(`library character ${JSON.stringify(a.card)} is invalid: ${checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  const character = checked.value;
  const persona = a.persona ? personaFile(a.persona) : chat.userName ? { name: chat.userName, description: '' } : undefined;
  if (a.model !== undefined) {
    const ref = parseModelRef(a.model);
    if (!ref) throw new UsageError(`--model must be conn:model, got ${JSON.stringify(a.model)}`, 'import');
    if (a.rt) {
      const problem = connectionProblem(a.rt, ref.conn);
      if (problem) throw new UsageError(`--model ${a.model}: ${problem}`, 'import');
    }
  }
  let config = mergePatch<SessionConfig>(DEFAULT_SESSION_CONFIG, a.rt?.config.sessionDefaults);
  if (a.model !== undefined) {
    const ref = parseModelRef(a.model)!;
    config = mergePatch(config, { roles: { narrator: { conn: ref.conn, model: ref.model } } });
  }
  const enableCompendium = config.compendium.enabled;
  config = mergePatch(config, { compendium: { enabled: false } });
  const now = (a.now ?? systemClock)().toISOString();
  const title = a.as?.trim() || basename(a.file).replace(/\.jsonl$/i, '');
  if (title === '') throw new StChatError('the chat needs a title (--as)');
  let id = '';
  for (let n = 1; n <= 10_000; n++) {
    const candidate = idFor(chat.hash, a.card, n);
    if (!existsSync(join(sessionsDir(a.home), `${candidate}.jsonl`))) {
      id = candidate;
      break;
    }
    if (!a.fresh && n === 1) throw new StChatError(`already imported as ${candidate}; rp-core chat ${candidate} continues it, or use --new`);
  }
  if (!id) throw new StChatError('no free session id for this chat');
  const header: SessionHeader = {
    t: 'session', v: 1, id, created: chat.created ?? now, title,
    imported: { from: 'sillytavern', hash: chat.hash, file: basename(a.file) },
    cast: { character, ...(persona ? { persona } : {}) },
    config,
  };
  const entries = [...chat.entries];
  if (enableCompendium) entries.push({ t: 'config' as const, ts: now, patch: { compendium: { enabled: true } } });
  if (!a.dryRun) {
    try {
      createSessionLogWith(a.home, header, entries).close();
    } catch (e) {
      throw new StChatError(`could not create session: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const warnings = [...chat.warnings, ...(chat.characterName && chat.characterName !== character.name
    ? [`chat names ${JSON.stringify(chat.characterName)} but --card is ${JSON.stringify(character.name)}`] : [])];
  if (a.json) a.io.out.write(`${JSON.stringify({ kind: 'session', id, title, messages: chat.messages, versions: chat.versions, dryRun: a.dryRun, warnings })}\n`);
  else {
    a.io.out.write(`session   ${id}   ${JSON.stringify(title)} · ${chat.messages} messages (${chat.versions} versions)\n`);
    for (const warning of warnings) a.io.err.write(`rp-core: warning: ${warning}\n`);
    a.io.err.write(a.dryRun ? 'rp-core: dry run: nothing was written\n' : `rp-core: hint: rp-core chat ${id} (or rp-core tui ${id}) continues the chat\n`);
  }
  return EXIT.done;
}
