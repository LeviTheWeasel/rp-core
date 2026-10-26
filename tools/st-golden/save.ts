// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Turn one recorder capture into test/golden/st/<case>/expected.json: the request SillyTavern
// sent, plus where it came from. Usage: bun tools/st-golden/save.ts <case> <req-NNN.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [caseName, capture] = process.argv.slice(2);
if (!caseName || !capture) throw new Error('usage: save.ts <case> <capture file>');
const body = JSON.parse(readFileSync(capture, 'utf8')) as { messages: unknown[]; [k: string]: unknown };
const { messages, ...params } = body;

const expected = {
  source: 'SillyBunny 3021edcae (SillyTavern fork), Custom OpenAI-compatible source, model gpt-4o, streaming off',
  captured: '2026-10-26',
  settings: {
    note: "SillyBunny's shipped world info settings (default/content/settings.json), unchanged",
    world_info_depth: 2,
    world_info_budget: 25,
    world_info_include_names: true,
    world_info_recursive: true,
    world_info_case_sensitive: false,
    world_info_match_whole_words: true,
    world_info_character_strategy: 1,
    world_info_max_recursion_steps: 0,
    names_behavior: 'preset value',
    custom_prompt_post_processing: '',
  },
  params,
  messages,
};
writeFileSync(join(import.meta.dir, '..', '..', 'test', 'golden', 'st', caseName, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
console.log(`saved ${caseName}: ${messages.length} messages`);
