// M4 REPL command parsing (cli/repl-commands.ts, D-113): /director (= show), /director show|on|off,
// their classes (show reads, on/off change the session) and /help.
import { describe, expect, test } from 'bun:test';
import { commandClass, helpText, parseLine, type Command } from '../../src/cli/repl-commands.ts';

const cmd = (line: string): Command => {
  const p = parseLine(line);
  if (p.kind !== 'command') throw new Error(`not a command: ${line} → ${JSON.stringify(p)}`);
  return p.command;
};
const error = (line: string): string => {
  const p = parseLine(line);
  if (p.kind !== 'error') throw new Error(`not an error: ${line} → ${JSON.stringify(p)}`);
  return p.message;
};

describe('/director', () => {
  test('bare /director and /director show print the plan; on and off switch it (any case)', () => {
    expect(cmd('/director')).toEqual({ name: 'director', action: 'show' });
    expect(cmd('/director show')).toEqual({ name: 'director', action: 'show' });
    expect(cmd('/DIRECTOR Show')).toEqual({ name: 'director', action: 'show' });
    expect(cmd('/director on')).toEqual({ name: 'director', action: 'on' });
    expect(cmd('/director OFF')).toEqual({ name: 'director', action: 'off' });
    expect(cmd('  /director   on  ')).toEqual({ name: 'director', action: 'on' });
  });

  test('anything else is an error naming the three forms; it is no longer "later"', () => {
    expect(error('/director maybe')).toContain('/director takes show, on or off');
    expect(error('/director on now')).toContain('show, on or off');
    expect(cmd('/director').name).not.toBe('later');
    // /persona stays a later command.
    expect(cmd('/persona')).toMatchObject({ name: 'later', command: 'persona' });
  });

  test('show is read-only (it waits for a running answer); on and off change the session (refused mid-turn)', () => {
    expect(commandClass(cmd('/director'))).toBe('read');
    expect(commandClass(cmd('/director show'))).toBe('read');
    expect(commandClass(cmd('/director on'))).toBe('edit');
    expect(commandClass(cmd('/director off'))).toBe('edit');
  });

  test('/help lists /director and its switch; the Later line keeps only the Compendium', () => {
    const help = helpText();
    expect(help).toContain("/director          the Story Director's plan: chapter, arcs, seeds, hidden arcs, the last directive");
    expect(help).toContain('/director on|off   let the Director plan every reply, or stop it (its plan is kept)');
    expect(help).not.toContain('/director (M4)');
    expect(help).toContain('Later: /memory tree|new|undo|refile|retry|recall|export|profile|mode (M5, the Compendium).');
  });
});
