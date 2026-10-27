// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Put the M3 demo chat (test/fixtures/ru/innkeeper-200, 199 messages) into an rp-core home as a new
// session, so the demo can be played by hand in `rp-core chat` on any model. No model is called: the
// answers are the fixture's own, written by an in-process provider (load.ts). Prints the session id
// and the question to ask.
// Usage: bun tools/fixtures/seed-innkeeper.ts [--home <dir>] [--model <connection>:<model>]
//                                              [--max-tokens <n>] [--max-rounds <n>]
//   --home        the rp-core home (else $RP_CORE_HOME, else ~/.rp-core), as the CLI's --home
//   --model       the narrator binding left on the session; its connection must be in that home's
//                 config.toml. Without it the session keeps the seeding stand-in (innkeeper:fixture),
//                 so pick one in the chat: /model narrator <connection>:<model>
//   --max-tokens  the narrator's reply limit (with --model; default as `rp-core new`: 2048 at a
//                 16k window). A thinking model's thinking counts against it
//   --max-rounds  tool rounds per answer, 1-8 (default 4)
// Exit 0, 64 on a usage or config.toml error, 1 when the home cannot be written.

import { parseArgs } from 'node:util';
import { UsageError } from '../../src/cli/args.ts';
import { resolveHome } from '../../src/cli/home.ts';
import { ConfigError, loadConfig } from '../../src/config/config.ts';
import { Engine } from '../../src/engine/engine.ts';
import type { Binding } from '../../src/session/entries.ts';
import { INNKEEPER_QUESTION, innkeeperConnection, seedInnkeeperSession } from '../../test/fixtures/ru/innkeeper-200/load.ts';

const USAGE = 'usage: bun tools/fixtures/seed-innkeeper.ts [--home <dir>] [--model <connection>:<model>] [--max-tokens <n>] [--max-rounds <n>]';

/** "conn:model" split at the first colon (connection ids never hold one; model ids may). */
export function parseBinding(s: string): Binding | null {
  const at = s.indexOf(':');
  if (at <= 0 || at === s.length - 1) return null;
  return { conn: s.slice(0, at), model: s.slice(at + 1) };
}

/** A whole number in [min, max], or null. */
function intIn(s: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(s.trim())) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

class Usage extends Error {}

async function main(argv: string[]): Promise<number> {
  try {
    return await seed(argv);
  } catch (e) {
    if (e instanceof Usage || e instanceof UsageError) {
      console.error(`${e.message}\n${USAGE}`);
      return 64;
    }
    if (e instanceof ConfigError) {
      console.error(e.message);
      return 64;
    }
    console.error(`cannot seed: ${(e as Error).message}`);
    return 1;
  }
}

async function seed(argv: string[]): Promise<number> {
  let values: { home?: string; model?: string; 'max-tokens'?: string; 'max-rounds'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { home: { type: 'string' }, model: { type: 'string' }, 'max-tokens': { type: 'string' }, 'max-rounds': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    throw new Usage((e as Error).message);
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  let narrator: Binding | undefined;
  if (values.model !== undefined) {
    const b = parseBinding(values.model);
    if (b === null) throw new Usage('--model must be <connection>:<model>, e.g. openrouter:deepseek/deepseek-v4-pro');
    narrator = b;
  }
  if (values['max-tokens'] !== undefined) {
    const n = intIn(values['max-tokens'], 1, 1_000_000);
    if (n === null) throw new Usage('--max-tokens must be a whole number of tokens, 1 or more');
    if (narrator === undefined) throw new Usage('--max-tokens needs --model (the limit belongs to the narrator binding)');
    narrator = { ...narrator, maxTokens: n };
  }
  let maxRounds: number | undefined;
  if (values['max-rounds'] !== undefined) {
    const n = intIn(values['max-rounds'], 1, 8);
    if (n === null) throw new Usage('--max-rounds must be a whole number, 1-8');
    maxRounds = n;
  }
  const home = resolveHome({ ...(values.home !== undefined ? { home: values.home } : {}), sandbox: false, env: process.env });
  if (narrator !== undefined) {
    // As `rp-core new --model` does: a binding to a connection the home does not have would only fail
    // later, at the first answer.
    const config = loadConfig(home.dir);
    if (config.path === null) throw new Usage(`no config.toml in ${home.dir}: write one with [connections.${narrator.conn}] first`);
    if (config.connections[narrator.conn] === undefined) {
      const known = Object.keys(config.connections);
      throw new Usage(`no connection '${narrator.conn}' in ${config.path}${known.length > 0 ? ` (it has: ${known.join(', ')})` : ''}`);
    }
  }
  const engine = await Engine.open({
    home: home.dir,
    connections: { innkeeper: innkeeperConnection() },
    clock: () => new Date(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  let id: string;
  try {
    id = await seedInnkeeperSession(engine, {
      ...(narrator !== undefined ? { narrator } : {}),
      ...(maxRounds !== undefined ? { config: { narrator: { maxRounds } } } : {}),
    });
  } finally {
    await engine.close();
  }
  const homeFlag = values.home !== undefined ? ` --home ${JSON.stringify(home.dir)}` : '';
  console.log(`session ${id} · «Сонный гусь» · 199 messages · home ${home.dir}`);
  console.log(
    narrator
      ? `narrator: ${narrator.conn}:${narrator.model} · reply limit ${narrator.maxTokens ?? 'default'} · tool rounds ${maxRounds ?? 'default (4)'}`
      : 'narrator: innkeeper:fixture, the seeding stand-in: pick a real one in the chat with /model narrator <connection>:<model>',
  );
  console.log(`open it:  rp-core${homeFlag} chat ${id}`);
  console.log(`ask:      ${INNKEEPER_QUESTION}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
