// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Install one golden case (test/golden/st/<case>/) into a scratch SillyBunny data folder:
// settings.json (the case's preset as the live chat-completion settings, the Custom source pointed
// at recorder.ts, the world book selected globally, the persona), the card as characters/Mira.png,
// the chat as chats/Mira/golden.jsonl, the world as worlds/golden.json. Close the SillyBunny page
// first: an open page saves its own settings over these.
// Usage: bun tools/st-golden/stage.ts <case> <sillybunny data root> [recorder url]

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const [caseName, dataRoot, recorder = 'http://127.0.0.1:5199/v1'] = process.argv.slice(2);
if (!caseName || !dataRoot) throw new Error('usage: stage.ts <case> <data root> [recorder url]');
const dir = join(import.meta.dir, '..', '..', 'test', 'golden', 'st', caseName);
const user = join(dataRoot, 'default-user');
const read = (f: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;

// ---- a PNG carrying the card ---------------------------------------------------------------------

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function pngWith(text: Record<string, string>): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  for (const [k, v] of Object.entries(text)) parts.push(chunk('tEXt', Buffer.from(`${k}\0${v}`, 'latin1')));
  parts.push(chunk('IDAT', deflateSync(Buffer.from([0, 120, 120, 120, 255]))), chunk('IEND', new Uint8Array()));
  return Buffer.concat(parts);
}

// ---- the case ------------------------------------------------------------------------------------

const card = read('card.json');
const persona = read('persona.json') as { name: string; description: string };
const preset = read('preset.json');
const chat = read('chat.json') as { messages: { user: boolean; text: string }[]; note?: { text: string; depth: number } };
const hasWorld = existsSync(join(dir, 'world.json'));
const DATE = '2026-10-26@12h00m00s';

// The card, with ST's own bookkeeping: the chat file it opens.
const stCard = { ...card, chat: 'golden', create_date: DATE, avatar: 'Mira.png' };
mkdirSync(join(user, 'characters'), { recursive: true });
writeFileSync(join(user, 'characters', 'Mira.png'), pngWith({ chara: Buffer.from(JSON.stringify(stCard), 'utf8').toString('base64') }));

mkdirSync(join(user, 'User Avatars'), { recursive: true });
writeFileSync(join(user, 'User Avatars', 'levi.png'), pngWith({}));

// The chat: a metadata line, then the messages.
const meta = {
  user_name: persona.name,
  character_name: 'Mira',
  create_date: DATE,
  chat_metadata: chat.note
    ? { note_prompt: chat.note.text, note_interval: 1, note_position: 1, note_depth: chat.note.depth, note_role: 0 }
    : { note_prompt: '', note_interval: 1, note_position: 1, note_depth: 4, note_role: 0 },
};
const lines = [JSON.stringify(meta)];
for (const m of chat.messages) {
  lines.push(
    JSON.stringify({
      name: m.user ? persona.name : 'Mira',
      is_user: m.user,
      is_system: false,
      send_date: DATE,
      mes: m.text,
      extra: {},
      ...(m.user ? { force_avatar: 'User Avatars/levi.png' } : { swipes: [m.text], swipe_id: 0 }),
    }),
  );
}
rmSync(join(user, 'chats', 'Mira'), { recursive: true, force: true });
mkdirSync(join(user, 'chats', 'Mira'), { recursive: true });
writeFileSync(join(user, 'chats', 'Mira', 'golden.jsonl'), `${lines.join('\n')}\n`);

// The world book.
mkdirSync(join(user, 'worlds'), { recursive: true });
rmSync(join(user, 'worlds', 'golden.json'), { force: true });
if (hasWorld) writeFileSync(join(user, 'worlds', 'golden.json'), readFileSync(join(dir, 'world.json')));

// The preset file (for the dropdown) and the live settings.
mkdirSync(join(user, 'OpenAI Settings'), { recursive: true });
writeFileSync(join(user, 'OpenAI Settings', 'golden.json'), JSON.stringify(preset, null, 4));

const settingsPath = join(user, 'settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, any>;
settings.main_api = 'openai';
settings.firstRun = false;
settings.user_avatar = 'levi.png';
settings.username = persona.name;
settings.oai_settings = {
  ...settings.oai_settings,
  ...preset,
  chat_completion_source: 'custom',
  custom_url: recorder,
  custom_model: 'gpt-4o',
  custom_prompt_post_processing: '',
  stream_openai: false,
  preset_settings_openai: 'golden',
};
const pu = settings.power_user;
pu.personas = { 'levi.png': persona.name };
pu.persona_descriptions = { 'levi.png': { description: persona.description, position: 0, depth: 2, role: 0, lorebook: '' } };
pu.persona_description = persona.description;
pu.persona_description_position = 0;
pu.default_persona = 'levi.png';
pu.auto_connect = true;
settings.world_info_settings = {
  ...settings.world_info_settings,
  world_info: { globalSelect: hasWorld ? ['golden'] : [] },
};
writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
console.log(`staged ${caseName} into ${user}${hasWorld ? ' (with world golden)' : ''}`);
