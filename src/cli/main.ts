#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The `rp-core` command (ARCHITECTURE.md §12.3, §12.4, §13, §14, §15 M1a/M1b/M2, §19.2 cli/main.ts):
// strict flag parsing with zero dependencies, global flags anywhere on the line, one function per
// subcommand. M1a: new, import, send, sessions, show. M1b: init, chat (the REPL), probe, models;
// config.toml's connections behind every turn. M2: import of presets and world info, new --preset /
// --lore, preview, --provider record:/replay:. M3: probe --active, a script's caps line, tool lines
// in send's text mode. M4.5: tui and new --tui
// (the full-screen host; OpenTUI is imported dynamically on that path only). M5a: --keep-requests on
// chat, tui and new (D-164). The RoleCall story import: `import <file.rolecall>` (D-185, import-story.ts).
// M6 adds `--stdio` (JSON-RPC 2.0 over JSONL) for external UIs.
//
// main() returns the exit code instead of exiting, so the entry point at the bottom can wait for
// stdout/stderr to drain first (see io.ts).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../config/config.ts';
import { Engine } from '../engine/engine.ts';
import { systemClock } from '../engine/system.ts';
import { runRpc } from '../protocol/rpc.ts';
import { redactEvent } from './render.ts';
import { bool, list, parseArgs, str, UsageError, type FlagKind, type Parsed } from './args.ts';
import { cmdModels, cmdProbe } from './catalog.ts';
import { cmdChat, runChat } from './chat.ts';
import { cmdCompact } from './compact.ts';
import { cmdImport, cmdInit, cmdNew, cmdSessions, cmdShow, CliError } from './commands.ts';
import { resolveHome, type Home } from './home.ts';
import { processIo, type Io } from './io.ts';
import { EXIT, runSend } from './oneshot.ts';
import { cmdPreview } from './preview.ts';
import { prepareProvider, ScriptFileError, type PreparedProvider } from './provider.ts';
import { engineOptions, loadRuntime, redactor, type Runtime } from './runtime.ts';
import type { SignalSource } from './signals.ts';
import type { TurnKind } from '../session/entries.ts';

const GLOBAL_FLAGS: Record<string, FlagKind> = {
  home: 'string',
  sandbox: 'bool',
  debug: 'bool',
  help: 'bool',
  version: 'bool',
  stdio: 'bool',
};
const SHORT = { h: 'help' } as const;

interface Command {
  flags: Record<string, FlagKind>;
  usage: string;
  summary: string;
  help: string;
}

const PROVIDER_HELP = `  --provider script:<file>  play a scripted provider (JSONL, one call per line) for every role;
                            a first line {"caps": {...}} sets its caps (e.g. "tools": "prompted");
                            a script with no line {"agent": "recall", ...} makes no recall calls
                            (lexical) unless a recall mode is set
  --provider record:<file>  use the configured connections and append every model call to <file>
                            (JSONL; keys and header values are scrubbed)
  --provider replay:<file>  play a recording back instead of the network; a request that differs
                            from the recorded one fails with replay_mismatch and a diff`;
const PROVIDER_FLAG = '--provider script:<f>|record:<f>|replay:<f>';
const KEEP_HELP = `  --keep-requests           keep every provider request of a turn in
                            <home>/sessions/<session>.requests/<call key>.json: the engine's
                            provider-level request for each model call (messages, tools, samplers),
                            not the HTTP body (/preview --wire shows that), never headers or keys`;
/** tui/run.ts NEEDS_TERMINAL, repeated here so main never loads OpenTUI to say it. */
const NEEDS_TERMINAL = 'rp-core tui needs a terminal; use rp-core chat';

const COMMANDS: Record<string, Command> = {
  stdio: {
    flags: { provider: 'string' },
    usage: `rp-core --stdio [--home <dir>] [${PROVIDER_FLAG}]`,
    summary: 'JSON-RPC 2.0 over JSONL for external UIs (M6 in progress)',
    help: `Reads one JSON-RPC 2.0 request per UTF-8 line from stdin. Writes responses and live event
notifications to stdout, one JSON object per line. Send initialize with protocol:1 first.
shutdown or EOF closes every open session. This first M6 slice supports session lifecycle, message
edits and selection, turn/run, turn/submit, turn/stop, and basic history methods.
${PROVIDER_HELP}`,
  },
  init: {
    flags: { json: 'bool' },
    usage: 'rp-core init [--json]',
    summary: 'write a starter config.toml into the home (never overwrites)',
    help: `Writes <home>/config.toml with commented examples (Ollama, llama.cpp, LM Studio, OpenRouter)
unless the file exists, and prints its path. Edit [connections] and [roles] narrator next.
  --json  print {"path","created"}`,
  },
  new: {
    flags: {
      card: 'string',
      persona: 'string',
      model: 'string',
      'max-tokens': 'string',
      title: 'string',
      json: 'bool',
      'no-chat': 'bool',
      tui: 'bool',
      provider: 'string',
      preset: 'string',
      lore: 'list',
      'keep-requests': 'bool',
    },
    usage: `rp-core new --card <file> [--model conn:model] [--preset <id|file>] [--lore <id|file>]... [--max-tokens n] [--persona <id|file>] [--title text] [--tui | --no-chat] [--json] [--keep-requests] [${PROVIDER_FLAG}]`,
    summary: 'import a card and start a session (opens the chat on a terminal)',
    help: `Imports the card (PNG or JSON, CCv1/V2/V3) into the library and creates a session with its
greetings; its config starts from config.toml ([roles], [narrator], [director]). On a terminal
the chat opens right away; otherwise (or with --no-chat / --json) the session id is printed.
--card may also name a character already in the library (its id).
  --model conn:model  the narrator's binding; the connection must be in config.toml
  --preset <id|file>  the session's preset: builtin, a library id, or a SillyTavern chat-completion
                      preset file (imported into the library first)
  --lore <id|file>    a lorebook for the session: a library id, or a SillyTavern world info /
                      character_book file (imported first); repeat for more books
  --max-tokens <n>    the narrator's reply limit, kept free in the window (default: the preset's,
                      e.g. an ST preset's openai_max_tokens, else 2048, or 8192 from a 24576-token
                      window; never more than half the window)
  --persona <file|id> a persona JSON {name, description, aliases?, book?}, or an id from
                      library/personas; book is scanned before the card's
  --title <text>      the session title (default: the character's name)
  --tui               open the new session full-screen (rp-core tui) instead of the line REPL
  --no-chat           only create the session and print its id
  --json              print {"sessionId","title","greetings":[{id,text}]} (implies --no-chat)
${KEEP_HELP}
${PROVIDER_HELP}`,
  },
  chat: {
    flags: { provider: 'string', 'keep-requests': 'bool' },
    usage: `rp-core chat <session> [--keep-requests] [${PROVIDER_FLAG}]`,
    summary: 'open a session in the REPL (swipe, continue, edit, rewind, /model, /preset, /lore, /memory, /search, ...)',
    help: `Opens the session (lock + recovery of an interrupted answer) and reads lines: text is your
message, /help lists the commands (/r swipe, /c continue, /e edit, /rewind n, /tails, /goto,
/fork, /model, /persona, /preset, /lore, /memory, /search, /director, /preview, /usage, /trace, /probe,
/quit). The
banner says whether the narrator can use tools (native, prompted or off). Ctrl+C stops an answer and keeps
what arrived; twice at the prompt quits. Piped stdin is a script: each line waits for the
previous answer. The Compendium files the story in the background between turns (its lines start
with ⋯ memory:); a script does not wait for it unless it says /memory wait. RP_CORE_LANE=manual
runs that work only at /memory wait. Before a reply, recall picks the entries the narrator will need
(/memory mode: auto, sync, prefetch, lexical, off; its lines start with ⋯ recall:); with
RP_CORE_LANE=manual it never prefetches (auto on a local server and prefetch act as on_miss).
RP_CORE_RECALL=lexical (or off) is the mode of every session that sets none: no recall calls.
${KEEP_HELP}
${PROVIDER_HELP}
Exit 0 at /quit or the end of input; 3 under --provider script: or replay: when an answer failed
(a piped script or replay also stops at the first replay_mismatch, or when it runs out of calls).`,
  },
  tui: {
    flags: { provider: 'string', 'keep-requests': 'bool' },
    usage: `rp-core tui [session] [--keep-requests] [${PROVIDER_FLAG}]`,
    summary: 'choose a story or open a session full-screen (needs a terminal)',
    help: `Without a session id, opens the story browser first (F5 opens it again inside a session).
The same chat as rp-core chat (every slash command, held lines, Ctrl+C rules), on one screen:
the models and hotkeys on the left, the chat in the middle, the agents and their tool calls on the
right (the side panes fold away on narrow terminals; F2 toggles them). Enter sends; Shift+Enter,
Alt+Enter or Ctrl+J start a new line. Hotkeys: Ctrl+R swipe, Ctrl+G guided re-roll, Ctrl+O continue,
Ctrl+E edit the last message in the input (Enter saves, Esc cancels), Alt+Left/Right versions,
PgUp/PgDn and Ctrl+Home/End scroll, Ctrl+D the Director, F1 help, F3 mouse wheel on/off,
F4 choose the narrator model from the configured connections (type to filter; F9 connects OpenRouter
with a key for this run; ↑/↓, Enter, Esc), F5 browse stories
and branches (F2 names the selected one), F6 create a story from a library card with persona, preset and lorebook choices,
F7 choose or edit the current session's persona, F8 change its preset and lorebooks. Ctrl+C
stops an answer and keeps what arrived; twice at the prompt quits. /e edits in place (no $EDITOR).
Errors and debug lines also go to <home>/logs/tui.log. Needs a terminal on stdin and stdout: pipes
and scripts use rp-core chat.
${KEEP_HELP}
${PROVIDER_HELP}
Exit 0 at /quit; 3 under --provider script: or replay: when an answer failed; 64 without a terminal.`,
  },
  import: {
    flags: { as: 'string', json: 'bool', chat: 'string', card: 'string', persona: 'string', model: 'string', compendium: 'string', 'dry-run': 'bool', new: 'bool', 'keep-raw': 'bool' },
    usage:
      'rp-core import <file> [--as name] [--json]\n       rp-core import <chat.jsonl> --card <library id> [--persona <file>] [--model conn:model] [--as title] [--dry-run] [--new] [--json]\n       rp-core import <story.rolecall> [--chat main|all|<id prefix>[,…]] [--model conn:model] [--compendium on|off] [--as title] [--dry-run] [--new] [--keep-raw] [--json]',
    summary: 'import a card, preset, lorebook, SillyTavern chat or RoleCall story',
    help: `Detects RoleCall story exports (.rolecall zip), SillyTavern solo chats (.jsonl), PNG and
JSON cards (CCv1/V2/V3), SillyTavern chat-completion presets and world info, RoleCall Compendium
exports (compendium-v1.0.0), and bare character_books.
Cards, presets and lorebooks land in library/characters, library/presets or library/lorebooks as
<id>.json, where id is
the name in lower case with its words joined by "-". The name is the file's own name field when
it has one (cards, Compendium exports and character_books do); SillyTavern writes none into
presets and world info, so those are named after the file: "My Preset.json" becomes my-preset.
The preset id "builtin" is the built-in layout's: a preset of that name becomes builtin-2.
Importing the same file twice is a no-op; a different file with the same name gets id-2.
Warnings name what the file holds that rp-core does not honour.
  --as <name>  save under this name instead
  --json       print {"kind","id","path","name","warnings"}

A SillyTavern solo chat export (.jsonl) becomes a session. Import its character card first, then
give its library id with --card. The chat's text, swipes, chosen versions and hidden messages are
kept. The file has no character card or preset; the new session uses config.toml defaults.
  --card <id>            a character already in the library (required for a .jsonl chat)
  --persona <json file>  override the user name in the chat export with a persona
  --model conn:model     the new session's narrator (default: config.toml's)
  --dry-run              check and report without writing
  --new                  import the same file once more as a new session

A RoleCall story export (RoleCall's per-story .rolecall zip; its account backup, a .rolecall JSON
file, is not one) becomes library items and sessions: the character, the persona, the preset (and a
copy "<preset> (<story>)" when the chat's own settings change it), the lorebooks (identical ones
once), then one session per chat with its messages, swipes as versions, the reasoning split off as
RoleCall did, the Story Director's state and the lorebooks attached. The Compendium is turned on
after the imported past (it is not filed again; the lorebooks carry it). Trackers, storyboards and
RoleCall's chat summary are not carried (a warning says each; warnings name the session or library
item they are about). Everything is written at once or not at all. A chat imported before is skipped
(refused when it is all that was asked); an equal library item is reused. Each imported session's
next request is then built, never sent: one that does not fit the narrator's window is a warning.
  --chat main|all|<prefix>  the main chat (default), every chat (an exact copy of another is
                            skipped), or the chats whose id starts so (comma-separated, main may
                            stand among them; the session lines show each chat's id)
  --model conn:model        the sessions' narrator (default: config.toml's)
  --compendium on|off       turn the Compendium on after the import (default on)
  --as <title>              the story's title (default: the main chat's)
  --dry-run                 print what would be imported, write nothing
  --new                     import again as new sessions
  --keep-raw                copy each chat's tracker, storyboard and Director files to
                            <home>/imports/<session>/ (a line says what was kept where)
  --json                    print {"dryRun","library","sessions","skipped","kept","warnings"}`,
  },
  send: {
    flags: { kind: 'string', guidance: 'string', json: 'bool', provider: 'string' },
    usage: `rp-core send <session> [text] [--kind reply|swipe|continue] [--guidance text] [--json] [${PROVIDER_FLAG}]`,
    summary: 'run one turn and print it',
    help: `reply (the default) appends your text and answers it; "-" reads the text from stdin.
swipe re-rolls the last answer as a sibling; continue extends it. Both take no text.
The session's bindings pick the connection from config.toml.
  --guidance <text>         swipe only: steer the re-roll
  --json                    stdout carries only events, one JSON object per line
${PROVIDER_HELP}
In text mode stdout carries only the answer; notices, the narrator's tool calls and the Story
Director's outcome (one line each, e.g. "⋯ search_history "caravan" → 2 hits", "⋯ director:
planned — arcs +1 · seeds +1") go to stderr.
A failure after output keeps the partial answer, marked [interrupted].
Ctrl+C stops the turn and keeps what arrived; Ctrl+C again quits at once.
Exit codes: 0 done, 2 stopped, 3 failed, 4 conflict, 5 refused before the turn opened.`,
  },
  preview: {
    flags: { draft: 'string', turn: 'string', wire: 'bool', verdicts: 'bool', json: 'bool', provider: 'string' },
    usage: `rp-core preview <session> [--draft text] [--turn id] [--wire] [--verdicts] [--json] [${PROVIDER_FLAG}]`,
    summary: 'print the exact request a turn would send, without sending it',
    help: `Opens the session (no turn runs; the preview sends and writes nothing) and prints the request
of the next turn: a reply when your message is the last one, else a swipe of the last answer. Each
message comes numbered with its role, its source in the preset and its token count, then its
full text; then prefill, max tokens, the samplers the connection sends (the ones it drops on
their own line), and the lore that fired. This process draws its own seed: {{random}}, {{roll}}
and lore entries with a probability below 100 % can differ in the next send (inside the chat,
/preview uses the next answer's own seed).
  --draft <text>  the request of a reply to this text, as if you had sent it
  --turn <id>     rebuild the request of a past answer (an id or a unique prefix, as show prints)
  --verdicts      also every lore entry's verdict: fired or not, and why
  --wire          print the HTTP body the connection would send (stdout) instead; the URL, the
                  notices and the verdicts go to stderr
  --json          print the whole preview result as one JSON object
${PROVIDER_HELP}
Exit 5 when the request cannot be built (the reason as for send's refusals; --turn naming no
message is not_found).`,
  },
  probe: {
    flags: { write: 'bool', json: 'bool', active: 'bool' },
    usage: 'rp-core probe [connection[:model]] [--active] [--write] [--json]',
    summary: "ask a server for its models, windows and slots; show a model's caps",
    help: `Reads the server's catalog (/models, llama.cpp /props, Ollama /api/show and /api/ps, LM Studio,
koboldcpp, OpenRouter supported_parameters) for the connection (default: every connection in
config.toml) and prints the server kind, the models with their context windows, reported slots
(advice only: capacity stays at max_in_flight) and the caps the model would get.
  --active  also call the model (one <connection>:<model> only): a tiny reply, one tool offered
            with tool_choice auto, a json_schema reply; at most 6 calls, replies capped at 96
            tokens for a ping and 512-1024 for the tool and JSON calls, room for a thinking model
            (they cost money on a paid API). It shows whether the model calls tools natively, leaks
            them as text (prompted) or the server refuses them, and how usage and structured output
            arrive; a probe that learned nothing (a timeout, a reply cut short) says inconclusive
  --write   store the catalog (and with --active the probe facts) in <home>/caps-cache.json; new
            turns use them; [caps."conn:model"] in config.toml still wins
  --json    print an array of {connection, ok, server, models, slots, notes, model, caps, active?}
Exit 1 when a server did not answer or refused the key (nothing is stored for it then).`,
  },
  models: {
    flags: { json: 'bool' },
    usage: 'rp-core models <connection> [--json]',
    summary: "list a connection's model ids",
    help: `Walks the /models ladder of the connection's server and prints one model id per line.
  --json  print [{"id","contextLength"?}]`,
  },
  sessions: {
    flags: { json: 'bool' },
    usage: 'rp-core sessions [--json]',
    summary: 'list sessions, newest first',
    help: '  --json  print [{"id","title","updated"}]',
  },
  compact: {
    flags: { json: 'bool' },
    usage: 'rp-core compact <session> [--json]',
    summary: "shrink a session's journal: drop the checkpoints of finished turns",
    help: `Opens the session (an interrupted answer is recovered first), closes it, then rewrites its
journal without the chk lines (the answer checkpointed while it streamed) and prep lines (what the
turn sent) of finished turns. Only crash recovery reads them. Every other line stays byte for byte:
the story, its versions and the Story Director's plans do not change. The rewrite is atomic (a temp
file, fsync, rename); a session with nothing to remove is left untouched.
The file keeps its mode and modification time. A row whose removal would change what the reader
accepts is kept ("kept" in --json).
  --json  print {"sessionId","before","after","removed","kept"?} on stdout (sizes in bytes, lines
          removed); events of the recovery go to stderr as JSON lines
Exit 5 when another process has the session open or the journal changed meanwhile (session_locked),
an answer held by a conflict waits for a decision (turn_open), or the recovery just saved an unsent
draft (draft_recovered: it is shown first; run compact again).`,
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
  return `rp-core — headless roleplay agent core (milestone M5b)

Usage: rp-core <command> [flags]

Commands:
${rows.join('\n')}

Getting started: rp-core init, edit <home>/config.toml, rp-core probe <connection>,
then rp-core new --card <file> --model <connection>:<model>.

${GLOBAL_HELP}

Exit codes: 0 ok, 1 error, 2 stopped, 3 failed, 4 conflict, 5 refused, 64 usage or config.toml
error, 130/143 interrupted by SIGINT/SIGTERM.
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
  /** Byte stream for --stdio; defaults to process.stdin. */
  input?: AsyncIterable<Uint8Array>;
  /** stdin and stdout are a terminal: `new` then opens the chat right away. Default false. */
  tty?: boolean;
  /** For probe / models (default globalThis.fetch). */
  fetch?: typeof fetch;
  /** The wall clock (probe cache as_of). Default the system clock. */
  clock?: () => Date;
}

function noPositionals(p: Parsed, command: string, max: number): void {
  if (p.positionals.length > max) throw new UsageError(`unexpected argument ${JSON.stringify(p.positionals[max])}`, command);
}

const KINDS: readonly TurnKind[] = ['reply', 'swipe', 'continue'];

/**
 * --provider script:|record:|replay:<file>, its file read or opened now (a bad file fails before
 * anything is opened). `interactive`: a chat with a person at a terminal (a replayed call that was
 * stopped while recording then waits for Ctrl+C instead of failing at once).
 */
function providerOf(p: Parsed, command: string, interactive = false): PreparedProvider | undefined {
  const spec = str(p, 'provider');
  return spec !== undefined ? prepareProvider(spec, command, { interactive }) : undefined;
}

/**
 * config.toml and its connections, with --provider attached (script/replay: the override; record:
 * every connection wrapped). ConfigError propagates to main (exit 64). --debug wires the raw-failure tap,
 * --keep-requests the engine's request keeper.
 */
function runtimeOf(home: Home, deps: MainDeps, p: Parsed, provider?: PreparedProvider): Runtime {
  const debug = bool(p, 'debug') ? (line: string): void => deps.io.err.write(`rp-core: debug: ${line}\n`) : undefined;
  const rt = loadRuntime(home.dir, deps.env, debug ? { debug } : {});
  provider?.attach(rt);
  // Only chat, tui and new know the flag; the others' parse refuses it.
  if (bool(p, 'keep-requests')) rt.keepRequests = true;
  return rt;
}

/** What a chat takes from MainDeps: the signal source, and fetch and clock for /probe --active. */
function chatExtras(deps: MainDeps): { signals?: SignalSource; fetch?: typeof fetch; clock?: () => Date } {
  return { ...(deps.signals ? { signals: deps.signals } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.clock ? { clock: deps.clock } : {}) };
}

function positiveInt(p: Parsed, flag: string, command: string): number | undefined {
  const v = str(p, flag);
  if (v === undefined) return undefined;
  if (!/^[1-9][0-9]{0,6}$/.test(v)) throw new UsageError(`--${flag} must be a whole number from 1 to 9999999, got ${JSON.stringify(v)}`, command);
  return Number(v);
}

async function runCommand(name: string, p: Parsed, home: Home, deps: MainDeps): Promise<number> {
  const { io } = deps;
  const json = bool(p, 'json');
  /** A second signal leaves at once; the sandbox goes first. */
  const exitNow = (code: number): void => {
    home.dispose();
    deps.exit(code);
  };
  switch (name) {
    case 'stdio': {
      noPositionals(p, name, 0);
      const rt = runtimeOf(home, deps, p, providerOf(p, name));
      const engine = await Engine.open(engineOptions(rt));
      const redact = redactor(rt);
      await runRpc(deps.input ?? process.stdin, (line) => io.out.write(line), engine, home.dir, (event) => redactEvent(event, redact));
      return EXIT.done;
    }
    case 'init':
      noPositionals(p, name, 0);
      return cmdInit({ home: home.dir, json, io });
    case 'new': {
      noPositionals(p, name, 0);
      const card = str(p, 'card');
      if (card === undefined) throw new UsageError('--card <file> is required', name);
      const maxTokens = positiveInt(p, 'max-tokens', name);
      const tui = bool(p, 'tui');
      if (tui && (json || bool(p, 'no-chat'))) throw new UsageError(`--tui opens the chat; it cannot be combined with ${json ? '--json' : '--no-chat'}`, name);
      if (tui && deps.tty !== true) {
        io.err.write(`${NEEDS_TERMINAL}\n`);
        return EXIT.usage;
      }
      const chat = deps.tty === true && !json && !bool(p, 'no-chat');
      const rt = runtimeOf(home, deps, p, providerOf(p, name, chat));
      // Loaded before the session exists: a TUI that cannot load must not leave a locked session.
      const tuiModule = tui ? await import('./tui/index.ts') : null;
      return cmdNew({
        home: home.dir,
        card,
        json,
        io,
        rt,
        ...(tuiModule ? { reopen: 'tui' as const } : {}),
        ...(chat
          ? {
              chat: (engine, session) =>
                tuiModule
                  ? tuiModule.runTui(engine, session, { rt, io, exitNow, env: deps.env, ...chatExtras(deps) })
                  : runChat(engine, session, { rt, io, exitNow, ...chatExtras(deps) }),
            }
          : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(str(p, 'preset') !== undefined ? { preset: str(p, 'preset')! } : {}),
        ...(list(p, 'lore').length > 0 ? { lore: list(p, 'lore') } : {}),
        ...(str(p, 'persona') !== undefined ? { persona: str(p, 'persona')! } : {}),
        ...(str(p, 'model') !== undefined ? { model: str(p, 'model')! } : {}),
        ...(str(p, 'title') !== undefined ? { title: str(p, 'title')! } : {}),
      });
    }
    case 'chat': {
      noPositionals(p, name, 1);
      const sessionId = p.positionals[0];
      if (sessionId === undefined) throw new UsageError('which session? rp-core chat <session>', name);
      const rt = runtimeOf(home, deps, p, providerOf(p, name, deps.tty === true));
      return cmdChat({ rt, io, sessionId, exitNow, ...chatExtras(deps) });
    }
    case 'tui': {
      noPositionals(p, name, 1);
      const sessionId = p.positionals[0];
      // Checked before OpenTUI loads: a pipe never needs the native library.
      if (deps.tty !== true) {
        io.err.write(`${NEEDS_TERMINAL}\n`);
        return EXIT.usage;
      }
      const rt = runtimeOf(home, deps, p, providerOf(p, name, true));
      // T-2: OpenTUI is loaded on this path only.
      const { cmdTui } = await import('./tui/index.ts');
      return cmdTui({ rt, io, sessionId, exitNow, tty: true, env: deps.env, ...chatExtras(deps) });
    }
    case 'probe': {
      noPositionals(p, name, 2);
      const [target, model] = p.positionals;
      const rt = runtimeOf(home, deps, p);
      return cmdProbe({
        rt,
        io,
        json,
        write: bool(p, 'write'),
        active: bool(p, 'active'),
        clock: deps.clock ?? systemClock,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(target !== undefined ? { target } : {}),
        ...(model !== undefined ? { model } : {}),
      });
    }
    case 'models': {
      noPositionals(p, name, 1);
      const conn = p.positionals[0];
      if (conn === undefined) throw new UsageError('which connection? rp-core models <connection>', name);
      const rt = runtimeOf(home, deps, p);
      return cmdModels({ rt, io, json, conn, clock: deps.clock ?? systemClock, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    }
    case 'import': {
      noPositionals(p, name, 1);
      const file = p.positionals[0];
      if (file === undefined) throw new UsageError('which file? rp-core import <file>', name);
      const as = str(p, 'as');
      const story = {
        ...(str(p, 'chat') !== undefined ? { chat: str(p, 'chat')! } : {}),
        ...(str(p, 'model') !== undefined ? { model: str(p, 'model')! } : {}),
        ...(str(p, 'compendium') !== undefined ? { compendium: str(p, 'compendium')! } : {}),
        dryRun: bool(p, 'dry-run'),
        fresh: bool(p, 'new'),
        keepRaw: bool(p, 'keep-raw'),
      };
      return cmdImport({ home: home.dir, file, json, io, story, st: { ...(str(p, 'card') !== undefined ? { card: str(p, 'card')! } : {}), ...(str(p, 'persona') !== undefined ? { persona: str(p, 'persona')! } : {}) }, rt: () => runtimeOf(home, deps, p), ...(as !== undefined ? { as } : {}) });
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
    case 'compact': {
      noPositionals(p, name, 1);
      const sessionId = p.positionals[0];
      if (sessionId === undefined) throw new UsageError('which session? rp-core compact <session>', name);
      return cmdCompact({ home: home.dir, sessionId, json, io });
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
      const rt = runtimeOf(home, deps, p, providerOf(p, name));
      return runSend({
        home: home.dir,
        sessionId,
        kind,
        json,
        debug: bool(p, 'debug'),
        io,
        rt,
        exitNow,
        ...(text !== undefined ? { text } : {}),
        ...(guidance !== undefined ? { guidance } : {}),
        ...(rt.provider ? { provider: rt.provider } : {}),
        ...(deps.signals ? { signals: deps.signals } : {}),
      });
    }
    case 'preview': {
      noPositionals(p, name, 1);
      const sessionId = p.positionals[0];
      if (sessionId === undefined) throw new UsageError('which session? rp-core preview <session>', name);
      const draft = str(p, 'draft');
      const turn = str(p, 'turn');
      if (draft !== undefined && turn !== undefined) throw new UsageError('--draft and --turn cannot be combined: a draft is a new message, --turn a past answer', name);
      if (turn !== undefined && !/^[0-9a-f]+$/i.test(turn)) throw new UsageError(`--turn takes a message id (hex), got ${JSON.stringify(turn)}`, name);
      const rt = runtimeOf(home, deps, p, providerOf(p, name));
      return cmdPreview({
        home: home.dir,
        sessionId,
        json,
        wire: bool(p, 'wire'),
        verdicts: bool(p, 'verdicts'),
        io,
        rt,
        ...(draft !== undefined ? { draft } : {}),
        ...(turn !== undefined ? { turn: turn.toLowerCase() } : {}),
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
    const [givenName, ...rest] = head.positionals;
    if (bool(head, 'stdio') && givenName !== undefined) throw new UsageError('--stdio takes no command');
    const name = bool(head, 'stdio') ? 'stdio' : givenName;
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
    if (e instanceof ConfigError) {
      // The message starts with the key path (or "line N"); the file is named once in front.
      const file = home ? join(home.dir, 'config.toml') : 'config.toml';
      io.err.write(`rp-core: config error in ${file}: ${e.message}\n`);
      return EXIT.usage;
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
    tty: process.stdin.isTTY === true && process.stdout.isTTY === true,
  });
  // Only exit once both channels have drained; a bare process.exit can cut a piped stdout short.
  await io.out.flush();
  await io.err.flush();
  process.exit(code);
}
