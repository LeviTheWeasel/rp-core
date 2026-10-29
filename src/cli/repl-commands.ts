// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// REPL input parsing (ARCHITECTURE.md §12.4 "Команды"): one typed line → plain text for the story,
// a command with checked arguments, or an error to print. Pure: no session, no terminal, so every
// rule here is unit-tested (test/repl/commands.test.ts). What a command does lives in repl.ts.
//
// Rules:
// - a line that is blank after trimming is ignored;
// - "/name args" is a command; names are case-insensitive;
// - "//text" sends "/text" as story text (the escape for a message that starts with a slash);
// - anything else is story text, trimmed.

import { ENTRY_TYPES, type EntryType } from '../agents/compendium/types.ts';
import { ConfigError, splitBinding } from '../config/config.ts';
import type { RecallMode } from '../engine/recall.ts';

export type RoleName = 'narrator' | 'director' | 'recorder' | 'recall';
export const ROLE_NAMES: readonly RoleName[] = ['narrator', 'director', 'recorder', 'recall'];

export type Command =
  /** /r (plain swipe; on a greeting: the next greeting; on your own message: ask for the answer) or /regen <guidance>. */
  | { name: 'swipe'; guidance?: string }
  /** /[ and /]: the previous / next sibling of the message at the head. */
  | { name: 'prev' }
  | { name: 'next' }
  | { name: 'continue' }
  /** /e [n]: n is the 1-based position on the active path (as /show numbers it); default the last. */
  | { name: 'edit'; n?: number }
  | { name: 'hide'; n: number; hidden: boolean }
  | { name: 'rewind'; n: number }
  | { name: 'tails' }
  | { name: 'goto'; id: string }
  | { name: 'fork'; n?: number }
  /** /model alone lists the bindings; /model <role> lists one; otherwise binds `spec` to `role`. */
  | { name: 'model'; role?: RoleName; spec?: string }
  | { name: 'note'; action: 'show' }
  | { name: 'note'; action: 'off' }
  | { name: 'note'; action: 'set'; text: string; depth?: number }
  /** /think show|hide; bare /think reports the current mode. */
  | { name: 'think'; show?: boolean }
  | { name: 'show' }
  | { name: 'sessions' }
  | { name: 'open'; id: string }
  | { name: 'usage' }
  | { name: 'trace' }
  /** /preset alone shows the preset and the library; with a ref (library id, 'builtin' or a file) switches. */
  | { name: 'preset'; ref?: string }
  | { name: 'persona'; action: 'show' | 'use' | 'name' | 'description'; value?: string }
  /** /lore (or /lore list): the books a turn scans. */
  | { name: 'lore'; action: 'list' }
  /** /lore add <id|file>: a file is imported first. */
  | { name: 'lore'; action: 'add'; ref: string }
  | { name: 'lore'; action: 'rm'; id: string }
  /** /lore test <text>: the verdicts of a reply to `text`, nothing sent [D-45]. */
  | { name: 'lore'; action: 'test'; text: string }
  /**
   * /preview [n|id] [--wire] [--verdicts]: the request of the next turn, or (with a target) of a
   * past answer: `n` is its /show number, `id` a message id or a unique prefix (/preview --turn <id>
   * too). --verdicts adds every lore entry's verdict, as /lore test prints them [D-45].
   */
  | { name: 'preview'; at?: { n: number } | { id: string }; wire: boolean; verdicts: boolean }
  /** /probe alone: how to probe from the shell; /probe --active [--write]: probe the narrator's model (M3). */
  | { name: 'probe'; active?: true; write?: boolean }
  /**
   * M5a (§7.4.9, D-161): the Compendium of this path. `ref` is C<n>, a key or a unique name. /memory and
   * /memory list [type|note|arc] [--retired]: the entries by tree bucket (live only unless --retired).
   */
  | { name: 'memory'; action: 'list'; type?: EntryType | 'note' | 'arc'; retired?: true }
  | { name: 'memory'; action: 'show'; ref: string }
  /** /memory tree [book]: the session's tree, then one per readable book (or only that book's). */
  | { name: 'memory'; action: 'tree'; book?: string }
  /** /memory new <type> [name] (D-160): a JSON template in the editor, then memoryFile. */
  | { name: 'memory'; action: 'new'; type: EntryType; entryName?: string }
  /** /memory add <title> | <keys> | <content>: keys comma-separated; [] lets the session key it by its title. */
  | { name: 'memory'; action: 'add'; title: string; keys: string[]; content: string }
  /**
   * /memory edit <ref>: the editor (a typed entry's or an arc's JSON, a note's text, D-160); without a
   * '|' the whole rest of the line is the ref (section I). With a '|', a note's one-line change (M3:
   * <ref> <title> | <keys> | <content>; an empty or missing part keeps the old value).
   */
  | { name: 'memory'; action: 'edit'; ref: string; title?: string; keys?: string[]; content?: string }
  | { name: 'memory'; action: 'retire'; ref: string; reason?: string }
  | { name: 'memory'; action: 'restore'; ref: string }
  /** /memory export <name> [--format core|compendium] [--force] (D-163); format absent = core. */
  | { name: 'memory'; action: 'export'; exportName: string; format?: 'core' | 'compendium'; force?: true }
  /** /memory on|off (the lead's ruling after the review): compendium.enabled of this session; entries are kept either way. */
  | { name: 'memory'; action: 'on' | 'off' }
  /**
   * M5b (D-180, D-181): the Compendium agents' pass bound to a message — `at` is its /show number (5 or
   * #5) or its id (a unique prefix) — undone, or queued again; `task` keeps the filing or the historian's.
   */
  | { name: 'memory'; action: 'undo' | 'refile'; at: MessageAt; task?: 'file' | 'hist' }
  /** /memory retry [#n]: the parked tasks (all of them on this path, or those bound to the message) queued again. */
  | { name: 'memory'; action: 'retry'; at?: MessageAt }
  /** /memory wait [sec]: until the background lane has nothing left to run (or `sec` passed; at most 24 h). */
  | { name: 'memory'; action: 'wait'; sec?: number }
  /** /memory status: the lane's running task, queue, parked tasks and backlog; M5c: the recall prefetch. */
  | { name: 'memory'; action: 'status' }
  /**
   * M5c (D-206): what recall did for an answer (its RecallRecord) — the last answer on the path, or the
   * one `at` names (5, #5 or its id; `--turn <id>` too): source, status, picks, reasons, counts, calls, time.
   */
  | { name: 'memory'; action: 'recall'; at?: MessageAt }
  /** M5c (D-206): the Compendium profile each agent runs (the block, recall, filing, the historian) and why. */
  | { name: 'memory'; action: 'profile' }
  /** M5c (D-206): bare /memory mode shows how recall runs; with a mode it sets compendium.recall.mode of this session. */
  | { name: 'memory'; action: 'mode'; mode?: RecallMode }
  /** /search <query> [before=<n>] (§7.5): the narrator's search_history over this path. */
  | { name: 'search'; query: string; before?: number }
  /** M4 (D-113): /director (= show), /director show|on|off. */
  | { name: 'director'; action: 'show' | 'on' | 'off' }
  | { name: 'help' }
  | { name: 'quit' }
  /** A §12.4 command that belongs to a later milestone. */
  | { name: 'later'; command: string; when: string };

/** A message a command names: its 1-based position on the active path (as /show numbers it), or its id or a unique prefix. */
export type MessageAt = { n: number } | { id: string };

export type ParsedLine =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'command'; command: Command }
  | { kind: 'error'; message: string };

/**
 * How a command relates to a running turn:
 * - edit: changes the session (history, head, config, the open session); refused while a turn runs (§6.1, §12.4);
 * - read: only prints; while a turn runs it waits for the answer to end;
 * - local: REPL state only (/think, /help, /quit); always handled at once.
 */
export type CommandClass = 'edit' | 'read' | 'local';

/** The commands of class 'local'. */
export type LocalCommand = Extract<Command, { name: 'think' | 'help' | 'quit' }>;

export function isLocalCommand(c: Command): c is LocalCommand {
  return c.name === 'think' || c.name === 'help' || c.name === 'quit';
}

export function commandClass(c: Command): CommandClass {
  switch (c.name) {
    case 'think':
    case 'help':
    case 'quit':
      return 'local';
    case 'tails':
    case 'show':
    case 'sessions':
    case 'usage':
    case 'trace':
    case 'probe':
    case 'later':
      return 'read';
    case 'model':
      return c.spec === undefined ? 'read' : 'edit';
    case 'note':
      return c.action === 'show' ? 'read' : 'edit';
    case 'preset':
      return c.ref === undefined ? 'read' : 'edit';
    case 'persona':
      return c.action === 'show' ? 'read' : 'edit';
    case 'lore':
      return c.action === 'add' || c.action === 'rm' ? 'edit' : 'read';
    case 'preview':
    case 'search':
      return 'read';
    case 'memory':
      // Rows are written to the journal: refused mid-turn like any other edit (session_busy); an
      // export writes no row but is refused mid-turn too (D-159: one rule for every memory verb).
      // /memory wait only waits for the background lane (allowed during a turn: it runs after the answer).
      // M5c: recall, profile and a bare mode only print; /memory mode <m> changes the config.
      if (c.action === 'mode') return c.mode === undefined ? 'read' : 'edit';
      return c.action === 'list' || c.action === 'show' || c.action === 'tree' || c.action === 'status' || c.action === 'wait' || c.action === 'recall' || c.action === 'profile'
        ? 'read'
        : 'edit';
    case 'director':
      return c.action === 'show' ? 'read' : 'edit';
    default:
      return 'edit';
  }
}

/** §12.4 commands that arrive with later milestones (§15). */
const LATER: Readonly<Record<string, string>> = {
  impersonate: 'M9 (draft)',
};

/** §7.4.9 /memory subcommands of a later milestone: none since M5c (recall, profile and mode arrived; D-206). */
const MEMORY_LATER: Readonly<Record<string, string>> = {};

/** M5c (D-201): the recall modes /memory mode takes, in the order its usage names them. */
export const RECALL_MODES: readonly RecallMode[] = ['auto', 'sync', 'prefetch', 'lexical', 'off'];

/** Default author's note depth (SillyTavern's default). */
export const DEFAULT_NOTE_DEPTH = 4;

const positive = (s: string): number | null => (/^\d+$/.test(s) && Number(s) >= 1 && Number.isSafeInteger(Number(s)) ? Number(s) : null);

export function parseLine(raw: string): ParsedLine {
  // Piped input from Windows tools may carry CRLF; readline keeps the CR.
  const line = raw.replace(/\r$/, '').trim();
  if (line === '') return { kind: 'empty' };
  if (line.startsWith('//')) return { kind: 'text', text: line.slice(1) };
  if (!line.startsWith('/')) return { kind: 'text', text: line };

  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(line)!;
  const name = m[1]!.toLowerCase();
  const rest = m[2]!.trim();
  const cmd = (command: Command): ParsedLine => ({ kind: 'command', command });
  const err = (message: string): ParsedLine => ({ kind: 'error', message });
  const noArgs = (command: Command): ParsedLine => (rest === '' ? cmd(command) : err(`/${name} takes no arguments`));
  const position = (required: boolean, build: (n: number | undefined) => Command): ParsedLine => {
    if (rest === '') return required ? err(`/${name} needs a message number (the numbers /show prints)`) : cmd(build(undefined));
    const n = positive(rest);
    return n === null ? err(`/${name}: "${rest}" is not a message number (1, 2, … as /show numbers them)`) : cmd(build(n));
  };

  switch (name) {
    case '':
      return err('a lone "/" is not a command; /help lists them (start with // to send text that begins with "/")');
    case 'r':
      return rest === '' ? cmd({ name: 'swipe' }) : err('/r takes no arguments; for a guided re-roll use /regen <what to change>');
    case 'regen':
      return rest === '' ? err('/regen needs guidance, e.g. /regen make her angrier (a plain re-roll is /r)') : cmd({ name: 'swipe', guidance: rest });
    case '[':
      return noArgs({ name: 'prev' });
    case ']':
      return noArgs({ name: 'next' });
    case 'c':
      return noArgs({ name: 'continue' });
    case 'e':
      return position(false, (n) => (n === undefined ? { name: 'edit' } : { name: 'edit', n }));
    case 'hide':
      return position(true, (n) => ({ name: 'hide', n: n!, hidden: true }));
    case 'unhide':
      return position(true, (n) => ({ name: 'hide', n: n!, hidden: false }));
    case 'rewind':
      return position(true, (n) => ({ name: 'rewind', n: n! }));
    case 'tails':
      return noArgs({ name: 'tails' });
    case 'goto':
      if (rest === '') return err('/goto needs a message id (or the start of one), as /tails or /show print it');
      if (!/^[0-9a-f]+$/i.test(rest)) return err(`/goto: "${rest}" is not a message id (hex, as /tails prints it)`);
      return cmd({ name: 'goto', id: rest.toLowerCase() });
    case 'fork':
      return position(false, (n) => (n === undefined ? { name: 'fork' } : { name: 'fork', n }));
    case 'model':
      return parseModel(rest);
    case 'note':
      return parseNote(rest);
    case 'think': {
      const a = rest.toLowerCase();
      if (a === '') return cmd({ name: 'think' });
      if (a === 'show' || a === 'on') return cmd({ name: 'think', show: true });
      if (a === 'hide' || a === 'off') return cmd({ name: 'think', show: false });
      return err('/think takes show or hide');
    }
    case 'show':
      return noArgs({ name: 'show' });
    case 'sessions':
      return noArgs({ name: 'sessions' });
    case 'open':
      if (rest === '' || /\s/.test(rest)) return err('/open needs one session id, as /sessions lists them');
      return cmd({ name: 'open', id: rest });
    case 'usage':
      return noArgs({ name: 'usage' });
    case 'trace':
      return noArgs({ name: 'trace' });
    case 'preset':
      return rest === '' ? cmd({ name: 'preset' }) : cmd({ name: 'preset', ref: unquote(rest) });
    case 'persona': {
      if (rest === '' || rest === 'show') return cmd({ name: 'persona', action: 'show' });
      const space = rest.indexOf(' ');
      const action = (space < 0 ? rest : rest.slice(0, space)).toLowerCase();
      const value = space < 0 ? '' : rest.slice(space + 1);
      if (action === 'use') return value.trim() ? cmd({ name: 'persona', action: 'use', value: unquote(value.trim()) }) : err('/persona use needs a library persona id');
      if (action === 'name') return value.trim() ? cmd({ name: 'persona', action: 'name', value }) : err('/persona name needs a name');
      if (action === 'description') return cmd({ name: 'persona', action: 'description', value });
      return err('/persona: use /persona, /persona use <id>, /persona name <text>, or /persona description <text>');
    }
    case 'lore':
      return parseLore(rest);
    case 'preview':
      return parsePreview(rest);
    case 'probe':
      return parseProbe(rest);
    case 'memory':
      return parseMemory(rest);
    case 'search':
      return parseSearch(rest);
    case 'director': {
      const a = rest.toLowerCase();
      if (a === '' || a === 'show') return cmd({ name: 'director', action: 'show' });
      if (a === 'on' || a === 'off') return cmd({ name: 'director', action: a });
      return err('/director takes show, on or off (bare /director shows the plan)');
    }
    case 'help':
    case '?':
      return cmd({ name: 'help' });
    case 'quit':
    case 'exit':
    case 'q':
      return noArgs({ name: 'quit' });
    default: {
      const when = LATER[name];
      if (when !== undefined) return cmd({ name: 'later', command: name, when });
      return err(`unknown command /${name}; /help lists the commands (start with // to send text that begins with "/")`);
    }
  }
}

/** One argument that may hold spaces (a file name): the rest of the line, outer quotes removed. */
export function unquote(s: string): string {
  const t = s.trim();
  const q = t[0];
  return t.length >= 2 && (q === '"' || q === "'") && t.endsWith(q) ? t.slice(1, -1) : t;
}

function parseLore(rest: string): ParsedLine {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(rest);
  const sub = m ? m[1]!.toLowerCase() : '';
  const arg = m ? m[2]!.trim() : '';
  const err = (message: string): ParsedLine => ({ kind: 'error', message });
  const cmd = (command: Command): ParsedLine => ({ kind: 'command', command });
  switch (sub) {
    case '':
    case 'list':
      return arg === '' ? cmd({ name: 'lore', action: 'list' }) : err('/lore list takes no arguments');
    case 'add':
      if (arg === '') return err('/lore add needs a library id or a file (SillyTavern world info, a character_book, or a card with a book)');
      return cmd({ name: 'lore', action: 'add', ref: unquote(arg) });
    case 'rm':
    case 'remove': {
      const id = unquote(arg);
      if (id === '' || /\s/.test(id)) return err('/lore rm needs one lorebook id, as /lore lists them');
      return cmd({ name: 'lore', action: 'rm', id });
    }
    case 'test':
      if (arg === '') return err('/lore test needs text to scan, e.g. /lore test the lighthouse at night');
      return cmd({ name: 'lore', action: 'test', text: arg });
    default:
      return err(`/lore: "${m![1]}" is not a subcommand; /lore lists the books, /lore add <id|file>, /lore rm <id>, /lore test <text>`);
  }
}

/** /probe, /probe --active [--write] (M3: the active probes of the narrator's model). */
function parseProbe(rest: string): ParsedLine {
  const err = (message: string): ParsedLine => ({ kind: 'error', message });
  let active = false;
  let write = false;
  for (const w of rest === '' ? [] : rest.split(/\s+/)) {
    if (w === '--active') active = true;
    else if (w === '--write') write = true;
    else return err(`/probe: unknown argument ${w} (it takes --active [--write])`);
  }
  if (write && !active) {
    return err('/probe --write needs --active here; a catalog probe of a whole server runs from the shell: rp-core probe <connection> --write');
  }
  return { kind: 'command', command: active ? { name: 'probe', active: true, write } : { name: 'probe' } };
}

const ADD_USAGE = '/memory add <title> | <keys> | <text>, e.g. /memory add Brother | Yan, brother | Mira\'s brother Yan sails the north road (keys may be empty)';
const EDIT_USAGE = '/memory edit <ref> opens an entry in the editor; a note also takes <ref> <title> | <keys> | <text> (an empty part keeps the old value)';
const REF_HINT = 'its C<n> as /memory lists it, its key, or its name';
const EXPORT_USAGE = '/memory export <name> [--format core|compendium] [--force]';
const SUBCOMMANDS = 'list, show, tree, new, add, edit, retire, restore, export, on, off, undo, refile, retry, wait, status, recall, profile, mode';
const AT_HINT = 'its number as /show prints it (5 or #5) or its id';
/** /memory wait waits at most this many seconds (24 h): a longer timer would overflow and fire at once. */
export const MEMORY_WAIT_MAX_SEC = 86_400;

/**
 * The note a command names, then the rest of the line: a quoted ref ("Old lighthouse") may hold
 * spaces, else the ref is the first word. null when there is none.
 */
export function takeRef(s: string): { ref: string; rest: string } | null {
  const t = s.trim();
  const q = t[0];
  if (q === '"' || q === "'") {
    const end = t.indexOf(q, 1);
    if (end > 1) return { ref: t.slice(1, end).trim(), rest: t.slice(end + 1).trim() };
    return null;
  }
  const m = /^(\S+)\s*([\s\S]*)$/.exec(t);
  return m ? { ref: m[1]!, rest: m[2]!.trim() } : null;
}

/** Comma-separated keys, trimmed, blanks dropped. */
const splitKeys = (s: string): string[] =>
  s
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');

/** An entry type as typed (any case; a plural "characters" too), or null. */
function entryTypeOf(word: string): EntryType | null {
  const w = word.toLowerCase();
  for (const t of ENTRY_TYPES) if (w === t || w === `${t}s` || (t === 'summary' && w === 'summaries')) return t;
  return null;
}

/** /memory list [type|note|arc] [--retired]: what to keep, or the error. */
function parseMemoryList(words: readonly string[]): ParsedLine {
  const err = (message: string): ParsedLine => ({ kind: 'error', message });
  let type: EntryType | 'note' | 'arc' | undefined;
  let retired = false;
  for (const w of words) {
    if (w === '--retired') {
      retired = true;
      continue;
    }
    if (w.startsWith('--')) return err(`/memory list: unknown flag ${w} (it takes [type|note|arc] [--retired])`);
    const lower = w.toLowerCase();
    const t = lower === 'note' || lower === 'notes' ? 'note' : lower === 'arc' || lower === 'arcs' ? 'arc' : entryTypeOf(w);
    if (t === null) return err(`/memory list: "${w}" is not an entry type (${ENTRY_TYPES.join(', ')}, note, arc)`);
    if (type !== undefined) return err('/memory list takes one type (or note, or arc)');
    type = t;
  }
  return { kind: 'command', command: { name: 'memory', action: 'list', ...(type !== undefined ? { type } : {}), ...(retired ? { retired: true as const } : {}) } };
}

/** /memory new <type> [name]: the type, then the rest of the line (outer quotes removed) as the name. */
function parseMemoryNew(arg: string): ParsedLine {
  const err = (message: string): ParsedLine => ({ kind: 'error', message });
  const m = /^(\S+)\s*([\s\S]*)$/.exec(arg);
  if (!m) return err(`/memory new needs a type: ${ENTRY_TYPES.join(', ')} (then a name if you like)`);
  const word = m[1]!.toLowerCase();
  if (word === 'note' || word === 'notes') return err(`/memory new files a typed entry; a note is written with ${ADD_USAGE.split(',')[0]}`);
  const type = entryTypeOf(word);
  if (type === null) return err(`/memory new: "${m[1]}" is not an entry type (${ENTRY_TYPES.join(', ')})`);
  const name = unquote(m[2]!);
  return { kind: 'command', command: { name: 'memory', action: 'new', type, ...(name !== '' ? { entryName: name } : {}) } };
}

/** /memory export <name> [--format core|compendium] [--force]: the words left after the flags are the name. */
function parseMemoryExport(arg: string): ParsedLine {
  const err = (message: string): ParsedLine => ({ kind: 'error', message });
  const words = arg === '' ? [] : arg.split(/\s+/);
  const name: string[] = [];
  let format: 'core' | 'compendium' | undefined;
  let force = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--force') {
      force = true;
    } else if (w === '--format' || w.startsWith('--format=')) {
      if (format !== undefined) return err('/memory export: --format given twice');
      const v = w === '--format' ? words[++i] : w.slice('--format='.length);
      if (v !== 'core' && v !== 'compendium') return err(`/memory export: --format takes core or compendium${v ? `, got "${v}"` : ''}`);
      format = v;
    } else if (w.startsWith('--')) {
      return err(`/memory export: unknown flag ${w} (${EXPORT_USAGE})`);
    } else {
      name.push(w);
    }
  }
  const exportName = unquote(name.join(' '));
  if (exportName === '') return err(`/memory export needs a name: ${EXPORT_USAGE}`);
  return {
    kind: 'command',
    command: { name: 'memory', action: 'export', exportName, ...(format !== undefined ? { format } : {}), ...(force ? { force: true as const } : {}) },
  };
}

/** A message as /memory undo|refile|retry name it: `5` or `#5` (its /show number), else a hex id or prefix; null when it is neither. */
function messageAt(word: string): MessageAt | null {
  const m = /^#?(\d+)$/.exec(word);
  if (m) {
    const n = positive(m[1]!);
    return n === null ? null : { n };
  }
  return /^[0-9a-f]+$/i.test(word) ? { id: word.toLowerCase() } : null;
}

/** file|filing → 'file', hist|historian → 'hist' (any case), else null. */
function taskOf(word: string): 'file' | 'hist' | null {
  const w = word.toLowerCase();
  return w === 'file' || w === 'filing' ? 'file' : w === 'hist' || w === 'historian' ? 'hist' : null;
}

/** /memory undo|refile <ref|#n> [file|hist] (D-181). */
function parseMemoryPass(sub: 'undo' | 'refile', arg: string): ParsedLine {
  const err = (message: string): ParsedLine => ({ kind: 'error', message });
  const words = arg === '' ? [] : arg.split(/\s+/);
  const usage = `/memory ${sub} <ref|#n> [file|hist]`;
  if (words.length === 0) return err(`/memory ${sub} needs a message: ${AT_HINT}, then file or hist if you like (${usage})`);
  if (words.length > 2) return err(`/memory ${sub} takes a message and at most file or hist (${usage})`);
  const at = messageAt(words[0]!);
  if (at === null) return err(`/memory ${sub}: "${words[0]}" is not a message (${AT_HINT})`);
  if (words.length === 1) return { kind: 'command', command: { name: 'memory', action: sub, at } };
  const task = taskOf(words[1]!);
  if (task === null) return err(`/memory ${sub}: "${words[1]}" is neither file nor hist (the filing pass or the historian's)`);
  return { kind: 'command', command: { name: 'memory', action: sub, at, task } };
}

/**
 * /memory [list|show|tree|new|add|edit|retire|restore|export|on|off|undo|refile|retry|wait|status] (D-161,
 * D-181) and M5c's recall, profile and mode (D-206).
 */
function parseMemory(rest: string): ParsedLine {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(rest);
  const sub = m ? m[1]!.toLowerCase() : '';
  const arg = m ? m[2]!.trim() : '';
  const err = (message: string): ParsedLine => ({ kind: 'error', message });
  const cmd = (command: Command): ParsedLine => ({ kind: 'command', command });
  // `/memory --retired` lists too.
  if (sub.startsWith('--')) return parseMemoryList(rest.split(/\s+/));
  switch (sub) {
    case '':
    case 'list':
      return parseMemoryList(arg === '' ? [] : arg.split(/\s+/));
    case 'show':
    case 'restore': {
      const ref = unquote(arg);
      if (ref === '') return err(`/memory ${sub} needs an entry: ${REF_HINT}`);
      return cmd({ name: 'memory', action: sub === 'show' ? 'show' : 'restore', ref });
    }
    case 'tree': {
      const book = unquote(arg);
      if (/\s/.test(book)) return err('/memory tree takes at most one book (its library id, as /lore lists it)');
      return cmd({ name: 'memory', action: 'tree', ...(book !== '' ? { book } : {}) });
    }
    case 'new':
      return parseMemoryNew(arg);
    case 'add': {
      const [title, keys, ...text] = arg.split('|');
      if (keys === undefined || text.length === 0) return err(`usage: ${ADD_USAGE}`);
      const content = text.join('|').trim();
      if (title!.trim() === '') return err(`/memory add: the title is empty (${ADD_USAGE})`);
      if (content === '') return err(`/memory add: the text is empty (${ADD_USAGE})`);
      return cmd({ name: 'memory', action: 'add', title: title!.trim(), keys: splitKeys(keys), content });
    }
    case 'edit': {
      // Without a '|' the whole rest is the ref, a name with spaces too, and it opens the editor
      // (D-160, section I); with one, or after a handle or key (`/memory edit C2 Uncle`, M3's
      // title-only rename), it is a note's <ref> <title> | <keys> | <text> (M3).
      const head = takeRef(arg);
      const handleFirst = head !== null && head.rest !== '' && /^(?:[CcСс]\d+|[^\s:]+:\S+)$/u.test(head.ref);
      if (!arg.includes('|') && !handleFirst) {
        const ref = unquote(arg);
        if (ref === '') return err(`usage: ${EDIT_USAGE}`);
        return cmd({ name: 'memory', action: 'edit', ref });
      }
      const r = takeRef(arg);
      if (!r || r.ref === '') return err(`usage: ${EDIT_USAGE}`);
      if (r.rest === '') return cmd({ name: 'memory', action: 'edit', ref: r.ref });
      const [title, keys, ...text] = r.rest.split('|');
      const change: { title?: string; keys?: string[]; content?: string } = {};
      if (title !== undefined && title.trim() !== '') change.title = title.trim();
      if (keys !== undefined && splitKeys(keys).length > 0) change.keys = splitKeys(keys);
      if (text.length > 0 && text.join('|').trim() !== '') change.content = text.join('|').trim();
      if (Object.keys(change).length === 0) return err(`/memory edit: nothing to change (${EDIT_USAGE})`);
      return cmd({ name: 'memory', action: 'edit', ref: r.ref, ...change });
    }
    case 'retire': {
      const r = takeRef(arg);
      if (!r || r.ref === '') return err(`/memory retire needs an entry (${REF_HINT}), then an optional reason`);
      return cmd({ name: 'memory', action: 'retire', ref: r.ref, ...(r.rest !== '' ? { reason: r.rest } : {}) });
    }
    case 'export':
      return parseMemoryExport(arg);
    case 'on':
    case 'off':
      if (arg !== '') return err(`/memory ${sub} takes nothing after it (/memory on sends the Compendium's entries, /memory off stops it)`);
      return cmd({ name: 'memory', action: sub });
    case 'undo':
    case 'refile':
      return parseMemoryPass(sub, arg);
    case 'retry': {
      if (arg === '') return cmd({ name: 'memory', action: 'retry' });
      const at = /\s/.test(arg) ? null : messageAt(arg);
      if (at === null) return err(`/memory retry takes at most one message: ${AT_HINT} (bare /memory retry retries every parked task)`);
      return cmd({ name: 'memory', action: 'retry', at });
    }
    case 'wait': {
      if (arg === '') return cmd({ name: 'memory', action: 'wait' });
      if (!/^\d+(?:\.\d+)?$/.test(arg) || !Number.isFinite(Number(arg))) return err(`/memory wait takes a number of seconds to wait at most, e.g. /memory wait 30 (got "${arg}")`);
      return cmd({ name: 'memory', action: 'wait', sec: Math.min(Number(arg), MEMORY_WAIT_MAX_SEC) });
    }
    case 'status':
      if (arg !== '') return err('/memory status takes nothing after it');
      return cmd({ name: 'memory', action: 'status' });
    case 'recall':
      return parseMemoryRecall(arg);
    case 'profile':
      if (arg !== '') return err('/memory profile takes nothing after it (it shows the profile of every Compendium agent)');
      return cmd({ name: 'memory', action: 'profile' });
    case 'mode': {
      if (arg === '') return cmd({ name: 'memory', action: 'mode' });
      const mode = RECALL_MODES.find((x) => x === arg.toLowerCase());
      if (mode === undefined) return err(`/memory mode takes ${RECALL_MODES.slice(0, -1).join(', ')} or off (got "${arg}"); bare /memory mode shows how recall runs now`);
      return cmd({ name: 'memory', action: 'mode', mode });
    }
    default: {
      const when = Object.hasOwn(MEMORY_LATER, sub) ? MEMORY_LATER[sub] : undefined;
      if (when !== undefined) return cmd({ name: 'later', command: `memory ${sub}`, when });
      return err(`/memory: "${m![1]}" is not a subcommand; /memory lists the Compendium, then ${SUBCOMMANDS.split(', ').slice(1).join(', ')}`);
    }
  }
}

/** /memory recall [--turn <#n|id>] (D-206; also a bare 5, #5 or id): at most one answer. */
function parseMemoryRecall(arg: string): ParsedLine {
  const err = (message: string): ParsedLine => ({ kind: 'error', message });
  const usage = '/memory recall [--turn <#n|id>]';
  const words = arg === '' ? [] : arg.split(/\s+/);
  let at: MessageAt | undefined;
  for (let i = 0; i < words.length; i++) {
    let w = words[i]!;
    if (w === '--turn') {
      const next = words[++i];
      if (next === undefined) return err(`/memory recall --turn needs an answer: ${AT_HINT} (${usage})`);
      w = next;
    } else if (w.startsWith('--')) {
      return err(`/memory recall: unknown flag ${w} (${usage})`);
    }
    const one = messageAt(w);
    if (one === null) return err(`/memory recall: "${w}" is not a message (${AT_HINT})`);
    if (at !== undefined) return err(`/memory recall takes one answer (${usage}); bare /memory recall shows the last one`);
    at = one;
  }
  return { kind: 'command', command: at === undefined ? { name: 'memory', action: 'recall' } : { name: 'memory', action: 'recall', at } };
}

/** /search <query> [before=<n>]: the cursor is the last word. */
function parseSearch(rest: string): ParsedLine {
  const err = (message: string): ParsedLine => ({ kind: 'error', message });
  const need = '/search needs words to look for, e.g. /search caravan (quotes keep a phrase together: /search "north road")';
  if (rest === '') return err(need);
  const m = /^([\s\S]*?)\s*\bbefore=(\S*)$/i.exec(rest);
  if (!m) return { kind: 'command', command: { name: 'search', query: rest } };
  const before = positive(m[2]!);
  if (before === null) return err(`/search: before= takes a message number (the #n of a hit), got "${m[2]}"`);
  const query = m[1]!.trim();
  if (query === '') return err(need);
  return { kind: 'command', command: { name: 'search', query, before } };
}

function parsePreview(rest: string): ParsedLine {
  const err = (message: string): ParsedLine => ({ kind: 'error', message });
  const words = rest === '' ? [] : rest.split(/\s+/);
  let wire = false;
  let verdicts = false;
  let at: { n: number } | { id: string } | undefined;
  const target = (t: { n: number } | { id: string }): ParsedLine | null => {
    if (at !== undefined) return err('/preview takes one answer: its /show number or its id');
    at = t;
    return null;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    let bad: ParsedLine | null = null;
    if (w === '--wire') {
      wire = true;
    } else if (w === '--verdicts') {
      verdicts = true;
    } else if (w === '--turn') {
      const id = words[++i];
      if (id === undefined || !/^[0-9a-f]+$/i.test(id)) return err('/preview --turn needs a message id (hex, as /show prints it)');
      bad = target({ id: id.toLowerCase() });
    } else if (w.startsWith('--')) {
      return err(`/preview: unknown flag ${w} (it takes [n|id] [--wire] [--verdicts])`);
    } else if (/^\d+$/.test(w)) {
      const n = positive(w);
      if (n === null) return err(`/preview: "${w}" is not a message number (1, 2, … as /show numbers them)`);
      bad = target({ n });
    } else if (/^[0-9a-f]+$/i.test(w)) {
      bad = target({ id: w.toLowerCase() });
    } else {
      return err(`/preview: "${w}" is neither a message number nor an id (/preview [n|id] [--wire] [--verdicts])`);
    }
    if (bad) return bad;
  }
  return { kind: 'command', command: at === undefined ? { name: 'preview', wire, verdicts } : { name: 'preview', at, wire, verdicts } };
}

function parseModel(rest: string): ParsedLine {
  const words = rest === '' ? [] : rest.split(/\s+/);
  if (words.length === 0) return { kind: 'command', command: { name: 'model' } };
  const first = words[0]!.toLowerCase();
  const isRole = (ROLE_NAMES as readonly string[]).includes(first);
  if (words.length === 1) {
    return isRole
      ? { kind: 'command', command: { name: 'model', role: first as RoleName } }
      : { kind: 'command', command: { name: 'model', role: 'narrator', spec: words[0]! } };
  }
  if (words.length === 2 && isRole) return { kind: 'command', command: { name: 'model', role: first as RoleName, spec: words[1]! } };
  if (!isRole) return { kind: 'error', message: `/model: "${words[0]}" is not a role (narrator, director, recorder, recall)` };
  return { kind: 'error', message: 'usage: /model [narrator|director|recorder|recall] <connection:model>' };
}

function parseNote(rest: string): ParsedLine {
  if (rest === '') return { kind: 'command', command: { name: 'note', action: 'show' } };
  if (rest.toLowerCase() === 'off') return { kind: 'command', command: { name: 'note', action: 'off' } };
  // A trailing "@depth" sets the depth; "@" elsewhere is ordinary text.
  const m = /^([\s\S]*?)(?:^|\s)@(\d+)$/.exec(rest);
  let text = rest;
  let depth: number | undefined;
  if (m) {
    text = m[1]!.trim();
    depth = Number(m[2]);
    if (!Number.isSafeInteger(depth) || depth > 10_000) return { kind: 'error', message: '/note: the depth after @ is too large' };
  }
  if (text === '') return { kind: 'error', message: '/note needs the note text before @depth' };
  return { kind: 'command', command: depth === undefined ? { name: 'note', action: 'set', text } : { name: 'note', action: 'set', text, depth } };
}

/**
 * The value /model writes for `role`: a binding on a configured connection, or (director, recorder,
 * recall) a reference to the role it follows. `connections` are the ids in config.toml [connections].
 */
export function resolveBindingArg(
  role: RoleName,
  spec: string,
  connections: readonly string[],
): { ok: true; value: { conn: string; model: string } | 'narrator' | 'recorder' } | { ok: false; message: string } {
  const lower = spec.toLowerCase();
  if (role !== 'narrator' && lower === 'narrator') return { ok: true, value: 'narrator' };
  if (role === 'recall' && lower === 'recorder') return { ok: true, value: 'recorder' };
  let parts: { conn: string; model: string };
  try {
    parts = splitBinding(spec, `/model ${role}`);
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, message: e.message };
    throw e;
  }
  if (!connections.includes(parts.conn)) {
    const known = connections.length > 0 ? `config.toml has: ${[...connections].sort().join(', ')}` : 'config.toml has no [connections] yet';
    return { ok: false, message: `/model ${role}: unknown connection "${parts.conn}" (${known})` };
  }
  return { ok: true, value: parts };
}

/** /help text (the M5c set). */
export function helpText(): string {
  return [
    'Type to speak. Commands:',
    '  /r                 swipe: a new version of the last answer (on a greeting: the next greeting)',
    '  /regen <guidance>  guided swipe: a new version that follows your direction',
    '  /[  /]             previous / next version of the last message',
    '  /c                 continue the last answer',
    '  /e [n]             edit message n (default: the last) in place: Enter saves, Ctrl+C cancels; in $EDITOR when it is set',
    '  /hide n, /unhide n leave message n out of the prompt / bring it back',
    '  /rewind n          go back to message n; your next message starts a new branch',
    '  /tails             list the branches off this path; /goto <id> switches to one',
    '  /fork [n]          copy the story up to message n (default: all) into a new session and open it',
    '  /model [role] [connection:model]   show or change the model of narrator|director|recorder|recall',
    '  /note <text> [@depth], /note off   the author\'s note (default depth 4)',
    '  /think show|hide   show the model\'s reasoning or fold it to one line',
    '  /show              the story so far, numbered      /usage   tokens and cost of this path',
    '  /trace             what the last answer\'s prompt held: the lore that fired, and why the rest did not; recall; its tool rounds',
    '  /search <words> [before=n]   find earlier messages on this path, newest first (what the narrator\'s search_history finds)',
    '  /memory [list] [type|note|arc] [--retired]   the Compendium of this path by bucket: C<n>, name, tagline, book, size',
    '  /memory show <ref>, /memory tree [book]   one entry and where it came from (ref: C<n>, its key or its name); the tree',
    '  /memory new <type> [name]   file an entry: its JSON template opens in the editor (character, location, item, …)',
    '  /memory edit <ref>  change an entry in the editor (a typed entry\'s or an arc\'s JSON, a note\'s text)',
    '  /memory add <title> | <keys> | <text>    a note: sent to the narrator when one of its keys comes up',
    '  /memory edit <ref> <title> | <keys> | <text>    change a note in one line (an empty part keeps the old value)',
    '  /memory retire <ref> [reason], /memory restore <ref>    take an entry out of the story / bring it back',
    '  /memory export <name> [--format core|compendium] [--force]   copy this session\'s entries to a library lorebook or a RoleCall file',
    '  /memory on|off     send the Compendium\'s entries with every reply, or stop sending them (they are kept)',
    '  /memory undo <ref|#n> [file|hist]   take back what the filing agent (or the historian) wrote from message n',
    '  /memory refile <ref|#n> [file|hist] file message n again (its new pass replaces the old one, an undo too)',
    '  /memory retry [#n]  run the parked tasks again (those that failed every attempt), or only message n\'s',
    '  /memory wait [sec]  wait until the Compendium\'s background work is done (at most sec seconds, up to 24 h)',
    '  /memory status     the background work: what runs, what waits, what is parked, answers not filed yet, the recall prefetch',
    '  /memory recall [--turn #n|id]   what recall picked for the last answer (or answer n): picks, reasons, calls, time',
    '  /memory profile    the Compendium profile (full or lite) of the block, recall, filing and the historian, and why',
    '  /memory mode [auto|sync|prefetch|lexical|off]   how recall picks entries before a reply: show it, or change it',
    '  /director          the Story Director\'s plan: chapter, arcs, seeds, hidden arcs, the last directive',
    '  /director on|off   let the Director plan every reply, or stop it (its plan is kept)',
    '  /probe             how to probe a server; /probe --active [--write] tests the narrator\'s model (a few tiny calls)',
    '  /preset [id|file]  show the preset and the library, or switch (builtin, a library id, or an ST preset file to import)',
    '  /persona          show the current persona and library; /persona use <id>, /persona name <text>, /persona description <text>',
    '  /lore              the lorebooks of this session; /lore add <id|file> (a world info file is imported), /lore rm <id>',
    '  /lore test <text>  which lore entries a message would wake, and why (nothing is sent)',
    '  /preview [n] [--wire] [--verdicts]   the exact request of the next turn (or of answer n), without sending it;',
    '                     --wire: the HTTP body; --verdicts: every lore entry\'s verdict, as /lore test prints them',
    '  /sessions, /open <id>   list sessions, switch to one',
    '  /help, /quit       (Ctrl+C stops an answer; twice at an empty prompt quits)',
    'Start a line with // to send text that begins with "/".',
  ].join('\n');
}
