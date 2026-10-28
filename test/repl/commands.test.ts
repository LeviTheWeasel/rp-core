// cli/repl-commands.ts: line parsing, command classes, /model argument checks (§12.4).
import { describe, expect, test } from 'bun:test';
import { commandClass, helpText, isLocalCommand, parseLine, resolveBindingArg, type Command } from '../../src/cli/repl-commands.ts';

const cmd = (line: string): Command => {
  const p = parseLine(line);
  if (p.kind !== 'command') throw new Error(`not a command: ${JSON.stringify(p)}`);
  return p.command;
};
const error = (line: string): string => {
  const p = parseLine(line);
  if (p.kind !== 'error') throw new Error(`not an error: ${JSON.stringify(p)}`);
  return p.message;
};

describe('parseLine: text', () => {
  test('blank lines are ignored', () => {
    expect(parseLine('')).toEqual({ kind: 'empty' });
    expect(parseLine('   \t ')).toEqual({ kind: 'empty' });
    expect(parseLine('\r')).toEqual({ kind: 'empty' });
  });

  test('plain text is trimmed; a CRLF line loses its CR', () => {
    expect(parseLine('  I sit at the bar.  ')).toEqual({ kind: 'text', text: 'I sit at the bar.' });
    expect(parseLine('Hello\r')).toEqual({ kind: 'text', text: 'Hello' });
  });

  test('"//" escapes a leading slash', () => {
    expect(parseLine('//me waves')).toEqual({ kind: 'text', text: '/me waves' });
    expect(parseLine('// spaced')).toEqual({ kind: 'text', text: '/ spaced' });
  });

  test('a slash later in the line is text', () => {
    expect(parseLine('either/or')).toEqual({ kind: 'text', text: 'either/or' });
  });
});

describe('parseLine: commands', () => {
  test('swipe, guided swipe, browse, continue', () => {
    expect(cmd('/r')).toEqual({ name: 'swipe' });
    expect(cmd('/R')).toEqual({ name: 'swipe' });
    expect(cmd('/regen make her angrier')).toEqual({ name: 'swipe', guidance: 'make her angrier' });
    expect(cmd('/[')).toEqual({ name: 'prev' });
    expect(cmd('/]')).toEqual({ name: 'next' });
    expect(cmd('/c')).toEqual({ name: 'continue' });
    expect(error('/r louder')).toContain('/regen');
    expect(error('/regen')).toContain('needs guidance');
    expect(error('/c now')).toContain('takes no arguments');
  });

  test('message numbers', () => {
    expect(cmd('/e')).toEqual({ name: 'edit' });
    expect(cmd('/e 3')).toEqual({ name: 'edit', n: 3 });
    expect(cmd('/hide 2')).toEqual({ name: 'hide', n: 2, hidden: true });
    expect(cmd('/unhide 2')).toEqual({ name: 'hide', n: 2, hidden: false });
    expect(cmd('/rewind 4')).toEqual({ name: 'rewind', n: 4 });
    expect(cmd('/fork')).toEqual({ name: 'fork' });
    expect(cmd('/fork 5')).toEqual({ name: 'fork', n: 5 });
    expect(error('/hide')).toContain('needs a message number');
    expect(error('/rewind 0')).toContain('not a message number');
    expect(error('/e -1')).toContain('not a message number');
    expect(error('/e two')).toContain('not a message number');
    expect(error('/fork 1.5')).toContain('not a message number');
  });

  test('branches and sessions', () => {
    expect(cmd('/tails')).toEqual({ name: 'tails' });
    expect(cmd('/goto A1B2')).toEqual({ name: 'goto', id: 'a1b2' });
    expect(error('/goto')).toContain('needs a message id');
    expect(error('/goto zz')).toContain('not a message id');
    expect(cmd('/sessions')).toEqual({ name: 'sessions' });
    expect(cmd('/open s_1234abcd')).toEqual({ name: 'open', id: 's_1234abcd' });
    expect(error('/open')).toContain('one session id');
    expect(error('/open a b')).toContain('one session id');
  });

  test('/model: list, one role, narrator by default, role + binding', () => {
    expect(cmd('/model')).toEqual({ name: 'model' });
    expect(cmd('/model director')).toEqual({ name: 'model', role: 'director' });
    expect(cmd('/model ollama:qwen3:14b')).toEqual({ name: 'model', role: 'narrator', spec: 'ollama:qwen3:14b' });
    expect(cmd('/model Recall openrouter:a/b')).toEqual({ name: 'model', role: 'recall', spec: 'openrouter:a/b' });
    expect(error('/model writer x:y')).toContain('not a role');
    expect(error('/model narrator a:b c')).toContain('usage');
  });

  test('/note: show, off, set with and without @depth', () => {
    expect(cmd('/note')).toEqual({ name: 'note', action: 'show' });
    expect(cmd('/note OFF')).toEqual({ name: 'note', action: 'off' });
    expect(cmd('/note Keep it short.')).toEqual({ name: 'note', action: 'set', text: 'Keep it short.' });
    expect(cmd('/note Keep it short. @2')).toEqual({ name: 'note', action: 'set', text: 'Keep it short.', depth: 2 });
    expect(cmd('/note mail me@4')).toEqual({ name: 'note', action: 'set', text: 'mail me@4' });
    expect(cmd('/note @ the inn @0')).toEqual({ name: 'note', action: 'set', text: '@ the inn', depth: 0 });
    expect(error('/note @3')).toContain('note text');
  });

  test('/think, help, quit and the rest', () => {
    expect(cmd('/think')).toEqual({ name: 'think' });
    expect(cmd('/think show')).toEqual({ name: 'think', show: true });
    expect(cmd('/think hide')).toEqual({ name: 'think', show: false });
    expect(error('/think maybe')).toContain('show or hide');
    for (const q of ['/quit', '/exit', '/q']) expect(cmd(q)).toEqual({ name: 'quit' });
    expect(cmd('/help')).toEqual({ name: 'help' });
    expect(cmd('/?')).toEqual({ name: 'help' });
    expect(cmd('/show')).toEqual({ name: 'show' });
    expect(cmd('/usage')).toEqual({ name: 'usage' });
    expect(cmd('/trace')).toEqual({ name: 'trace' });
    expect(cmd('/probe')).toEqual({ name: 'probe' });
    expect(error('/probe local')).toContain('it takes --active [--write]');
  });

  test('later milestones are named, unknown commands get a hint', () => {
    // M5c (D-206): recall's subcommands arrived.
    expect(cmd('/memory recall')).toEqual({ name: 'memory', action: 'recall' });
    expect(cmd('/memory mode sync')).toEqual({ name: 'memory', action: 'mode', mode: 'sync' });
    // M4: /director arrived (D-113); /persona is still later.
    expect(cmd('/director on')).toEqual({ name: 'director', action: 'on' });
    expect(cmd('/persona')).toMatchObject({ name: 'later', command: 'persona' });
    expect(error('/me waves')).toContain('/help');
    expect(error('/me waves')).toContain('//');
    expect(error('/')).toContain('/help');
  });
});

describe('commandClass', () => {
  test('editing commands, read-only commands and local ones', () => {
    const edit = ['/r', '/regen x', '/[', '/]', '/c', '/e', '/hide 1', '/unhide 1', '/rewind 1', '/goto ab', '/fork', '/model a:b', '/note x', '/note off', '/open s_1'];
    for (const l of edit) expect(commandClass(cmd(l))).toBe('edit');
    const read = ['/tails', '/show', '/sessions', '/usage', '/trace', '/probe', '/model', '/model narrator', '/note', '/preset'];
    for (const l of read) expect(commandClass(cmd(l))).toBe('read');
    for (const l of ['/think show', '/help', '/quit']) {
      expect(commandClass(cmd(l))).toBe('local');
      expect(isLocalCommand(cmd(l))).toBe(true);
    }
    expect(isLocalCommand(cmd('/show'))).toBe(false);
  });
});

describe('resolveBindingArg', () => {
  const conns = ['ollama', 'openrouter'];

  test('a binding on a configured connection, split at the first colon', () => {
    expect(resolveBindingArg('narrator', 'ollama:qwen3:14b', conns)).toEqual({ ok: true, value: { conn: 'ollama', model: 'qwen3:14b' } });
    expect(resolveBindingArg('director', 'openrouter:vendor/model', conns)).toEqual({ ok: true, value: { conn: 'openrouter', model: 'vendor/model' } });
  });

  test('an unknown connection names the configured ones', () => {
    const r = resolveBindingArg('narrator', 'local:qwen', conns);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('/model narrator: unknown connection "local" (config.toml has: ollama, openrouter)');
    const none = resolveBindingArg('narrator', 'local:qwen', []);
    if (!none.ok) expect(none.message).toContain('no [connections]');
  });

  test('malformed bindings are refused with the config rules', () => {
    for (const bad of ['qwen', ':qwen', 'ollama:', 'oll ama:x']) {
      const r = resolveBindingArg('narrator', bad, conns);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.startsWith('/model narrator')).toBe(true);
    }
  });

  test('references: director/recorder follow the narrator, recall may follow the recorder', () => {
    expect(resolveBindingArg('director', 'narrator', conns)).toEqual({ ok: true, value: 'narrator' });
    expect(resolveBindingArg('recorder', 'Narrator', conns)).toEqual({ ok: true, value: 'narrator' });
    expect(resolveBindingArg('recall', 'recorder', conns)).toEqual({ ok: true, value: 'recorder' });
    expect(resolveBindingArg('narrator', 'narrator', conns).ok).toBe(false);
    expect(resolveBindingArg('director', 'recorder', conns).ok).toBe(false);
  });
});

test('helpText lists every M1b command', () => {
  const h = helpText();
  for (const c of ['/r', '/regen', '/[', '/]', '/c', '/e', '/hide', '/unhide', '/rewind', '/tails', '/goto', '/fork', '/model', '/note', '/think', '/show', '/usage', '/trace', '/probe', '/sessions', '/open', '/help', '/quit']) {
    expect(h).toContain(c);
  }
});
