// M2 REPL commands: parsing of /preset, /lore and /preview, their classes, and /help (§12.4).
import { describe, expect, test } from 'bun:test';
import { commandClass, helpText, parseLine, unquote, type Command } from '../../src/cli/repl-commands.ts';

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

describe('/preset', () => {
  test('alone it shows; with an argument it switches (the rest of the line, outer quotes removed)', () => {
    expect(cmd('/preset')).toEqual({ name: 'preset' });
    expect(cmd('/preset builtin')).toEqual({ name: 'preset', ref: 'builtin' });
    expect(cmd('/PRESET lighthouse')).toEqual({ name: 'preset', ref: 'lighthouse' });
    expect(cmd('/preset ~/ST presets/My Preset.json')).toEqual({ name: 'preset', ref: '~/ST presets/My Preset.json' });
    expect(cmd('/preset "a b.json"')).toEqual({ name: 'preset', ref: 'a b.json' });
    expect(cmd("/preset 'a b.json'")).toEqual({ name: 'preset', ref: 'a b.json' });
  });

  test('unquote keeps unbalanced quotes', () => {
    expect(unquote('"a b')).toBe('"a b');
    expect(unquote(' "x" ')).toBe('x');
    expect(unquote('"')).toBe('"');
  });
});

describe('/lore', () => {
  test('list, add, rm, test', () => {
    expect(cmd('/lore')).toEqual({ name: 'lore', action: 'list' });
    expect(cmd('/lore list')).toEqual({ name: 'lore', action: 'list' });
    expect(cmd('/lore add harbor')).toEqual({ name: 'lore', action: 'add', ref: 'harbor' });
    expect(cmd('/lore add "~/worlds/Old Harbor.json"')).toEqual({ name: 'lore', action: 'add', ref: '~/worlds/Old Harbor.json' });
    expect(cmd('/lore rm harbor')).toEqual({ name: 'lore', action: 'rm', id: 'harbor' });
    expect(cmd('/lore remove harbor')).toEqual({ name: 'lore', action: 'rm', id: 'harbor' });
    expect(cmd('/lore TEST The lighthouse  at night ')).toEqual({ name: 'lore', action: 'test', text: 'The lighthouse  at night' });
  });

  test('mistakes say what is expected', () => {
    expect(error('/lore add')).toContain('/lore add needs a library id or a file');
    expect(error('/lore rm')).toContain('/lore rm needs one lorebook id');
    expect(error('/lore rm a b')).toContain('/lore rm needs one lorebook id');
    expect(error('/lore test')).toContain('/lore test needs text');
    expect(error('/lore list x')).toContain('takes no arguments');
    expect(error('/lore frobnicate')).toContain('"frobnicate" is not a subcommand');
  });
});

describe('/preview', () => {
  test('the next turn, an answer by number or by id, --wire, --turn', () => {
    expect(cmd('/preview')).toEqual({ name: 'preview', wire: false, verdicts: false });
    expect(cmd('/preview --wire')).toEqual({ name: 'preview', wire: true, verdicts: false });
    expect(cmd('/preview 3')).toEqual({ name: 'preview', at: { n: 3 }, wire: false, verdicts: false });
    expect(cmd('/preview 3 --wire')).toEqual({ name: 'preview', at: { n: 3 }, wire: true, verdicts: false });
    expect(cmd('/preview --wire ab12CD')).toEqual({ name: 'preview', at: { id: 'ab12cd' }, wire: true, verdicts: false });
    expect(cmd('/preview --turn 12345678')).toEqual({ name: 'preview', at: { id: '12345678' }, wire: false, verdicts: false });
  });

  test('--verdicts, with or without an answer', () => {
    expect(cmd('/preview --verdicts')).toEqual({ name: 'preview', wire: false, verdicts: true });
    expect(cmd('/preview 3 --verdicts')).toEqual({ name: 'preview', at: { n: 3 }, wire: false, verdicts: true });
    expect(cmd('/preview --verdicts ab12cd --wire')).toEqual({ name: 'preview', at: { id: 'ab12cd' }, wire: true, verdicts: true });
    expect(commandClass(cmd('/preview 2 --verdicts'))).toBe('read');
  });

  test('mistakes', () => {
    expect(error('/preview 0')).toContain('is not a message number');
    expect(error('/preview 1 2')).toContain('takes one answer');
    expect(error('/preview 2 --turn ab')).toContain('takes one answer');
    expect(error('/preview --turn')).toContain('--turn needs a message id');
    expect(error('/preview --turn xyz')).toContain('--turn needs a message id');
    expect(error('/preview --raw')).toContain('unknown flag --raw');
    expect(error('/preview last')).toContain('neither a message number nor an id');
  });
});

describe('classes and help', () => {
  test('/preset <x> and /lore add|rm change the session; the rest only read', () => {
    for (const l of ['/preset builtin', '/lore add x', '/lore rm x']) expect(commandClass(cmd(l))).toBe('edit');
    for (const l of ['/preset', '/lore', '/lore list', '/lore test hi', '/preview', '/preview 2 --wire']) expect(commandClass(cmd(l))).toBe('read');
  });

  test('they are no longer "later"; /help lists them', () => {
    for (const l of ['/preset', '/lore', '/preview']) expect(cmd(l).name).not.toBe('later');
    const help = helpText();
    for (const s of ['/preset', '/lore add <id|file>', '/lore rm <id>', '/lore test <text>', '/preview [n] [--wire] [--verdicts]']) expect(help).toContain(s);
    // M4: /director is no longer later (D-113); the Later line keeps the M5 subcommands.
    expect(help).toContain('Later: /memory recall|');
    expect(help).not.toContain('(M2)');
  });
});
