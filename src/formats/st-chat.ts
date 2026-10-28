// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

// SillyTavern's solo-chat JSONL export: one header, then messages. No file or library I/O here.

import { createHash } from 'node:crypto';
import type { Block, EntryInput, Generation } from '../session/entries.ts';
import { rcIsoTime } from './rolecall-import.ts';
import { isRecord } from './wire.ts';

export class StChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StChatError';
  }
}

const hash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const named = (v: unknown): string | undefined => typeof v === 'string' && v.trim() !== '' && v !== 'unused' ? v.trim() : undefined;
const nextTime = (iso: string): string => new Date(Math.min(Date.parse(iso) + 1, 253402300799999)).toISOString();

export interface StChat {
  hash: string;
  characterName?: string;
  userName?: string;
  created?: string;
  entries: EntryInput[];
  messages: number;
  versions: number;
  hidden: number;
  warnings: string[];
}

/** Parse a complete .jsonl export. Bad JSON and missing header data are refused before any writes. */
export function parseStChat(bytes: Uint8Array): StChat {
  const source = Buffer.from(bytes).toString('utf8').replace(/^\ufeff/, '');
  const lines = source.split(/\r?\n/);
  while (lines.at(-1)?.trim() === '') lines.pop();
  if (lines.length < 2) throw new StChatError('a SillyTavern chat needs a header and at least one message');
  const read = (line: string, at: number): Record<string, unknown> => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new StChatError(`line ${at}: not valid JSON`);
    }
    if (!isRecord(value)) throw new StChatError(`line ${at}: expected a JSON object`);
    return value;
  };
  const header = read(lines[0]!, 1);
  if (header.kind === 'manifest' && header.format === 'rolecall-story') {
    throw new StChatError("RoleCall's story.jsonl is not imported: import the .rolecall export it came from");
  }
  if (header.mes !== undefined || (!isRecord(header.chat_metadata) && header.character_name === undefined && header.user_name === undefined)) {
    throw new StChatError('not a SillyTavern chat export: the first line must be its chat header');
  }
  const characterName = named(header.character_name);
  const userName = named(header.user_name);
  const created = rcIsoTime(header.create_date);
  const sourceHash = hash(bytes);
  const warnings: string[] = [];
  const entries: EntryInput[] = [];
  let parent: string | null = null;
  let lastTime = created ?? new Date(0).toISOString();
  let messages = 0;
  let versions = 0;
  let hidden = 0;
  const assistantNames = new Set<string>();

  for (let pos = 1; pos < lines.length; pos++) {
    const row = read(lines[pos]!, pos + 1);
    if (typeof row.is_user !== 'boolean') throw new StChatError(`line ${pos + 1}: is_user must be true or false`);
    if (row.mes !== undefined && typeof row.mes !== 'string') throw new StChatError(`line ${pos + 1}: mes must be text`);
    if (row.swipes !== undefined && (!Array.isArray(row.swipes) || row.swipes.some((s) => typeof s !== 'string'))) {
      throw new StChatError(`line ${pos + 1}: swipes must be an array of text`);
    }
    if (!row.is_user && named(row.name)) assistantNames.add(named(row.name)!);
    const role = row.is_user ? 'user' : 'assistant';
    const swipes: string[] = Array.isArray(row.swipes) ? row.swipes as string[] : [];
    const text = typeof row.mes === 'string' ? row.mes : undefined;
    const choices = [...swipes];
    let active = Number.isSafeInteger(row.swipe_id) && (row.swipe_id as number) >= 0 && (row.swipe_id as number) < choices.length
      && (text === undefined || choices[row.swipe_id as number] === text) ? row.swipe_id as number : -1;
    if (active < 0 && text !== undefined) active = choices.lastIndexOf(text);
    if (active < 0 && text !== undefined) {
      active = choices.push(text) - 1;
      if (swipes.length > 0) warnings.push(`line ${pos + 1}: mes was not among swipes; kept it as another version`);
    }
    if (choices.length === 0) {
      warnings.push(`line ${pos + 1}: empty message skipped`);
      continue;
    }
    if (active < 0) active = choices.length - 1;
    const ids: string[] = [];
    const info = Array.isArray(row.swipe_info) ? row.swipe_info : [];
    for (let j = 0; j < choices.length; j++) {
      const id = hash(`${sourceHash}\u0000${pos}\u0000${j}`).slice(0, 8);
      ids.push(id);
      const swipe = isRecord(info[j]) ? info[j] : {};
      const extra = { ...(isRecord(row.extra) && j === active ? row.extra : {}), ...(isRecord(swipe.extra) ? swipe.extra : {}) };
      const reasoning = role === 'assistant' && typeof extra.reasoning === 'string' && extra.reasoning !== '' ? extra.reasoning : undefined;
      const blocks: Block[] = [...(reasoning !== undefined ? [{ k: 'reasoning' as const, text: reasoning }] : []), { k: 'text', text: choices[j]! }];
      const ts = rcIsoTime(swipe.send_date) ?? rcIsoTime(row.send_date) ?? nextTime(lastTime);
      lastTime = ts;
      const gen: Generation | undefined = role === 'assistant'
        ? messages === 0 ? { kind: 'greeting' } : { kind: 'model', ...(typeof extra.model === 'string' ? { model: extra.model } : {}) }
        : undefined;
      entries.push({ t: 'msg', ts, id, parent, role, blocks, ...(gen ? { gen } : {}) });
      if (row.is_system === true) {
        entries.push({ t: 'hide', ts, target: id, hidden: true });
        hidden++;
      }
    }
    messages++;
    versions += choices.length;
    parent = ids[active]!;
  }
  if (messages === 0) throw new StChatError('the chat has no messages to import');
  if (assistantNames.size > 1) throw new StChatError(`group chats are not supported (assistant names: ${[...assistantNames].join(', ')})`);
  if (parent !== entries.filter((e) => e.t === 'msg').at(-1)?.id) entries.push({ t: 'head', ts: nextTime(lastTime), leaf: parent! });
  if (hidden > 0) warnings.push(`${hidden} hidden version(s) excluded from the model context, as in SillyTavern`);
  if (lines.some((line) => /"(?:files|media|image|video)"\s*:/.test(line))) warnings.push('media and file attachments are not carried; message text is kept');
  return { hash: sourceHash, ...(characterName ? { characterName } : {}), ...(userName ? { userName } : {}), ...(created ? { created } : {}), entries, messages, versions, hidden, warnings };
}
