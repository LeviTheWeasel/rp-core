#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The `rp-core` command (ARCHITECTURE.md §12.3, §15 M1a, §19.2 cli/main.ts): strict flag parsing
// with zero dependencies, global flags anywhere on the line, one function per subcommand.
// M1a commands: new, import, send, sessions, show. `open` (the REPL) and `--stdio` come later.
//
// main() returns the exit code instead of exiting, so the entry point at the bottom can wait for
// stdout/stderr to drain first (see io.ts).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bool, parseArgs, str, UsageError, type FlagKind, type Parsed } from './args.ts';
import { cmdImport, cmdNew, cmdSessions, cmdShow, CliError } from './commands.ts';
import { resolveHome, type Home } from './home.ts';
import { processIo, type Io } from './io.ts';
import { EXIT, runSend } from './oneshot.ts';
import { ScriptFileError, scriptConnection } from './provider.ts';
import type { SignalSource } from './signals.ts';
import type { TurnKind } from '../session/entries.ts';

const GLOBAL_FLAGS: Record<string, FlagKind> = {
  home: 'string',
  sandbox: 'bool',
  debug: 'bool',
  help: 'bool',
  version: 'bool',
};
const SHORT = { h: 'help' } as const;

interface Command {
  flags: Record<string, FlagKind>;
  usage: string;
  summary: string;
  help: string;
}

const COMMANDS: Record<string, Command> = {
  new: {
    flags: { card: 'string', persona: 'string', model: 'string', title: 'string', json: 'bool' },
    usage: 'rp-core new --card <file> [--persona <json file>] [--model conn:model] [--title text] [--json]',
    summary: 'import a card and start a session; prints the session id',
    help: `Imports the card (PNG or JSON, CCv2/V3) into the library and creates a session with its
greetings. --card may also name a character already in the library (its id).
  --persona <file>   a persona JSON {name, description, aliases?}
  --model conn:model the narrator's binding (default script:default)
  --title <text>     the session title (default: the character's name)
  --json             print {"sessionId","title","greetings":[{id,text}]}`,
  },
  import: {
    flags: { as: 'string', json: 'bool' },
    usage: 'rp-core import <file> [--as name] [--json]',
    summary: 'import a card into the library; prints its library id',
    help: `Detects the file (PNG card, JSON card; presets and world info arrive in M2) and writes
library/characters/<id>.json, where id = canonicalId(name).
  --as <name>  save under this name instead of the card's
  --json       print {"kind","id","path","name","warnings"}`,
  },
  send: {
    flags: { kind: 'string', guidance: 'string', json: 'bool', provider: 'string' },
    usage: 'rp-core send <session> [text] [--kind reply|swipe|continue] [--guidance text] [--json] [--provider script:<file>]',
    summary: 'run one turn and print it',
    help: `reply (the default) appends your text and answers it; "-" reads the text from stdin.
swipe re-rolls the last answer as a sibling; continue extends it. Both take no text.
  --guidance <text>         swipe only: steer the re-roll
  --provider script:<file>  play a scripted provider (JSONL, one call per line) for every role
  --json                    stdout carries only events, one JSON object per line
A failure after output keeps the partial answer, marked [interrupted].
Ctrl+C stops the turn and keeps what arrived; Ctrl+C again quits at once.
Exit codes: 0 done, 2 stopped, 3 failed, 4 conflict, 5 refused before the turn opened.`,
  },
  sessions: {
    flags: { json: 'bool' },
    usage: 'rp-core sessions [--json]',
    summary: 'list sessions, newest first',
    help: '  --json  print [{"id","title","updated"}]',
  },
  show: {
    flags: { json: 'bool' },
    usage: 'rp-core show <session> [--json]',
    summary: 'print the active path of a session',
    help: `Reads the journal without taking the lock (safe while a turn runs elsewhere). Markers:
[interrupted] (recovered after a crash or a failure), [stopped], [hidden], [edited].
  --json  print the path as a JSON array of messages`,
  },
};

const GLOBAL_HELP = `Global flags:
  --home <dir>   data directory (else $RP_CORE_HOME, else ~/.rp-core)
  --sandbox      use a temporary home, removed at exit
  --debug        raw provider errors and stack traces on stderr
  -h, --help     help (also: rp-core help <command>)
  --version      print the version`;

function generalHelp(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  const rows = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`);
  return `rp-core — headless roleplay agent core (milestone M1a)

Usage: rp-core <command> [flags]

Commands:
${rows.join('\n')}

${GLOBAL_HELP}

Exit codes: 0 ok, 1 error, 2 stopped, 3 failed, 4 conflict, 5 refused, 64 usage,
130/143 interrupted by SIGINT/SIGTERM.
`;
}

function commandHelp(name: string): string {
  const c = COMMANDS[name]!;
  return `Usage: ${c.usage}\n\n${c.help}\n\n${GLOBAL_HELP}\n`;
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface MainDeps {
  io: Io;
  env: Record<string, string | undefined>;
  /** Leave the process now (second SIGINT). The sandbox is removed before this is called. */
  exit: (code: number) => void;
  signals?: SignalSource;
  /** Read all of stdin (for `send <session> -`). */
  readStdin?: () => Promise<string>;
}

function noPositionals(p: Parsed, command: string, max: number): void {
  if (p.positionals.length > max) throw new UsageError(`unexpected argument ${JSON.stringify(p.positionals[max])}`, command);
}

const KINDS: readonly TurnKind[] = ['reply', 'swipe', 'continue'];

async function runCommand(name: string, p: Parsed, home: Home, deps: MainDeps): Promise<number> {
  const { io } = deps;
  const json = bool(p, 'json');
  switch (name) {
    case 'new': {
      noPositionals(p, name, 0);
      const card = str(p, 'card');
      if (card === undefined) throw new UsageError('--card <file> is required', name);
      return cmdNew({
        home: home.dir,
        card,
        json,
        io,
        ...(str(p, 'persona') !== undefined ? { persona: str(p, 'persona')! } : {}),
        ...(str(p, 'model') !== undefined ? { model: str(p, 'model')! } : {}),
        ...(str(p, 'title') !== undefined ? { title: str(p, 'title')! } : {}),
      });
    }
    case 'import': {
      noPositionals(p, name, 1);
      const file = p.positionals[0];
      if (file === undefined) throw new UsageError('which file? rp-core import <file>', name);
      const as = str(p, 'as');
      return cmdImport({ home: home.dir, file, json, io, ...(as !== undefined ? { as } : {}) });
    }
    case 'sessions':
      noPositionals(p, name, 0);
      return cmdSessions({ home: home.dir, json, io });
    case 'show': {
      noPositionals(p, name, 1);
      const id = p.positionals[0];
      if (id === undefined) throw new UsageError('which session? rp-core show <session>', name);
      return cmdShow({ home: home.dir, id, json, io });
    }
    case 'send': {
      noPositionals(p, name, 2);
      const [sessionId, rawText] = p.positionals;
      if (sessionId === undefined) throw new UsageError('which session? rp-core send <session> [text]', name);
      const kindArg = str(p, 'kind') ?? 'reply';
      if (!(KINDS as readonly string[]).includes(kindArg)) throw new UsageError(`--kind must be reply, swipe or continue, got ${JSON.stringify(kindArg)}`, name);
      const kind = kindArg as TurnKind;
      if (kind === 'reply' && rawText === undefined) throw new UsageError('a reply needs text: rp-core send <session> "text" (or "-" for stdin)', name);
      if (kind !== 'reply' && rawText !== undefined) throw new UsageError(`--kind ${kind} takes no text`, name);
      const guidance = str(p, 'guidance');
      // Checked here, not left to the engine: submit() has no guidance, so a reply would write the
      // user's line before the refusal.
      if (guidance !== undefined && kind !== 'swipe') throw new UsageError('--guidance only applies to --kind swipe', name);
      let text = rawText;
      if (text === '-') {
        if (!deps.readStdin) throw new UsageError('reading the text from stdin is not available here', name);
        text = (await deps.readStdin()).replace(/\r?\n$/, '');
      }
      const spec = str(p, 'provider');
      const provider = spec !== undefined ? scriptConnection(spec) : undefined;
      return runSend({
        home: home.dir,
        sessionId,
        kind,
        json,
        debug: bool(p, 'debug'),
        io,
        exitNow: (code) => {
          home.dispose();
          deps.exit(code);
        },
        ...(text !== undefined ? { text } : {}),
        ...(guidance !== undefined ? { guidance } : {}),
        ...(provider ? { provider } : {}),
        ...(deps.signals ? { signals: deps.signals } : {}),
      });
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(name)}`);
  }
}

/** Parse, dispatch, report. Returns the exit code; never throws. */
export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const { io } = deps;
  let debug = argv.includes('--debug');
  let home: Home | null = null;
  try {
    // Global flags may come before the command; the command's own parse accepts them anywhere.
    const head = parseArgs(argv, { flags: GLOBAL_FLAGS, short: SHORT }, { stopAtPositional: true });
    const [name, ...rest] = head.positionals;
    if (name === 'help') {
      const topic = rest[0];
      if (topic !== undefined && !Object.hasOwn(COMMANDS, topic)) throw new UsageError(`unknown command ${JSON.stringify(topic)}`);
      io.out.write(topic !== undefined ? commandHelp(topic) : generalHelp());
      return EXIT.done;
    }
    if (name === undefined) {
      if (bool(head, 'version')) {
        io.out.write(`rp-core ${version()}\n`);
        return EXIT.done;
      }
      if (bool(head, 'help')) {
        io.out.write(generalHelp());
        return EXIT.done;
      }
      throw new UsageError('no command given');
    }
    const command = COMMANDS[name];
    if (!Object.hasOwn(COMMANDS, name) || !command) throw new UsageError(`unknown command ${JSON.stringify(name)}`);
    const p = parseArgs(rest, { flags: { ...GLOBAL_FLAGS, ...command.flags }, short: SHORT }, { command: name });
    // Globals given before the command count too (a repeat across the two halves is an error).
    for (const [k, v] of Object.entries(head.flags)) {
      if (Object.hasOwn(p.flags, k)) throw new UsageError(`--${k} given twice`, name);
      p.flags[k] = v;
    }
    debug = bool(p, 'debug');
    if (bool(p, 'help')) {
      io.out.write(commandHelp(name));
      return EXIT.done;
    }
    if (bool(p, 'version')) {
      io.out.write(`rp-core ${version()}\n`);
      return EXIT.done;
    }
    const homeFlag = str(p, 'home');
    home = resolveHome({ sandbox: bool(p, 'sandbox'), env: deps.env, ...(homeFlag !== undefined ? { home: homeFlag } : {}) });
    if (home.sandbox && debug) io.err.write(`rp-core: sandbox home ${home.dir} (removed at exit)\n`);
    return await runCommand(name, p, home, deps);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err.write(`rp-core: ${e.message}\n`);
      const usage = e.command && COMMANDS[e.command] ? COMMANDS[e.command]!.usage : 'rp-core <command> [flags]; rp-core --help';
      io.err.write(`usage: ${usage}\n`);
      return EXIT.usage;
    }
    if (e instanceof CliError) {
      io.err.write(`rp-core: ${e.message}\n`);
      return e.exitCode;
    }
    if (e instanceof ScriptFileError) {
      io.err.write(`rp-core: ${e.message}\n`);
      return EXIT.error;
    }
    io.err.write(`rp-core: error: ${e instanceof Error ? e.message : String(e)}\n`);
    if (debug && e instanceof Error && e.stack) io.err.write(`${e.stack}\n`);
    else io.err.write('rp-core: (run with --debug for details)\n');
    return EXIT.error;
  } finally {
    home?.dispose();
  }
}

async function readAllStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

if (import.meta.main) {
  const io = processIo();
  const code = await main(process.argv.slice(2), {
    io,
    env: process.env,
    exit: (c) => process.exit(c),
    readStdin: readAllStdin,
  });
  // Only exit once both channels have drained; a bare process.exit can cut a piped stdout short.
  await io.out.flush();
  await io.err.flush();
  process.exit(code);
}
