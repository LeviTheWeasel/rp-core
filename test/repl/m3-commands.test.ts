// M3 REPL command parsing (cli/repl-commands.ts): /memory and its subcommands (decision F6), /search
// with its before= cursor, /probe --active, the classes of the new commands, and /help.
import { describe, expect, test } from 'bun:test';
import { commandClass, helpText, parseLine, takeRef, type Command } from '../../src/cli/repl-commands.ts';

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

describe('/memory', () => {
  test('bare and list: the Compendium of this path; M5a: list takes a type (or note, arc) and --retired', () => {
    expect(cmd('/memory')).toEqual({ name: 'memory', action: 'list' });
    expect(cmd('/MEMORY list')).toEqual({ name: 'memory', action: 'list' });
    expect(cmd('/memory list character')).toEqual({ name: 'memory', action: 'list', type: 'character' });
    expect(cmd('/memory list --retired')).toEqual({ name: 'memory', action: 'list', retired: true });
  });

  test('show and restore take the rest of the line as the ref (a title may hold spaces)', () => {
    expect(cmd('/memory show C2')).toEqual({ name: 'memory', action: 'show', ref: 'C2' });
    expect(cmd('/memory show Old lighthouse')).toEqual({ name: 'memory', action: 'show', ref: 'Old lighthouse' });
    expect(cmd('/memory show "Old lighthouse"')).toEqual({ name: 'memory', action: 'show', ref: 'Old lighthouse' });
    expect(cmd('/memory restore note:брат')).toEqual({ name: 'memory', action: 'restore', ref: 'note:брат' });
    expect(error('/memory show')).toContain('/memory show needs an entry');
    expect(error('/memory restore')).toContain('C<n>');
  });

  test('add <title> | <keys> | <content>: keys comma-separated and may be empty; the text may hold "|"', () => {
    expect(cmd('/memory add Brother | Yan, brother | Mira\'s brother Yan sails the north road')).toEqual({
      name: 'memory',
      action: 'add',
      title: 'Brother',
      keys: ['Yan', 'brother'],
      content: "Mira's brother Yan sails the north road",
    });
    expect(cmd('/memory add Брат | | Её брат Ян')).toEqual({ name: 'memory', action: 'add', title: 'Брат', keys: [], content: 'Её брат Ян' });
    expect(cmd('/memory add Sign |sign,  , mark| a | b')).toEqual({ name: 'memory', action: 'add', title: 'Sign', keys: ['sign', 'mark'], content: 'a | b' });
  });

  test('add errors: missing parts, empty title, empty text', () => {
    expect(error('/memory add Brother')).toContain('usage: /memory add <title> | <keys> | <text>');
    expect(error('/memory add Brother | his name is Yan')).toContain('usage: /memory add');
    expect(error('/memory add  | k | text')).toContain('the title is empty');
    expect(error('/memory add Brother | k |   ')).toContain('the text is empty');
  });

  test('edit <ref> <title> | <keys> | <content>: an empty or missing part keeps the old value', () => {
    expect(cmd('/memory edit C1 Big brother | Yan | He came back')).toEqual({
      name: 'memory',
      action: 'edit',
      ref: 'C1',
      title: 'Big brother',
      keys: ['Yan'],
      content: 'He came back',
    });
    expect(cmd('/memory edit C1 | | He came back')).toEqual({ name: 'memory', action: 'edit', ref: 'C1', content: 'He came back' });
    expect(cmd('/memory edit C1 | Yan, Ян')).toEqual({ name: 'memory', action: 'edit', ref: 'C1', keys: ['Yan', 'Ян'] });
    // Section I: without a '|' the whole rest is the ref (the editor form), unless it starts with a
    // handle or key: then it is M3's title-only rename.
    expect(cmd('/memory edit c3 New title |')).toEqual({ name: 'memory', action: 'edit', ref: 'c3', title: 'New title' });
    expect(cmd('/memory edit c3 New title')).toEqual({ name: 'memory', action: 'edit', ref: 'c3', title: 'New title' });
    expect(cmd('/memory edit note:brother Uncle')).toEqual({ name: 'memory', action: 'edit', ref: 'note:brother', title: 'Uncle' });
    expect(cmd('/memory edit Мира Ванс')).toEqual({ name: 'memory', action: 'edit', ref: 'Мира Ванс' });
    expect(cmd('/memory edit "Old lighthouse" | | Rebuilt')).toEqual({ name: 'memory', action: 'edit', ref: 'Old lighthouse', content: 'Rebuilt' });
  });

  test('edit errors: no ref, nothing to change (M5a: the ref alone opens the editor)', () => {
    expect(error('/memory edit')).toContain('usage: /memory edit <ref>');
    expect(cmd('/memory edit C1')).toEqual({ name: 'memory', action: 'edit', ref: 'C1' });
    expect(error('/memory edit C1 | | ')).toContain('nothing to change');
    expect(error('/memory edit C1 | | ')).toContain('an empty part keeps the old value');
  });

  test('retire <ref> [reason]', () => {
    expect(cmd('/memory retire C2')).toEqual({ name: 'memory', action: 'retire', ref: 'C2' });
    expect(cmd('/memory retire C2 he left the story')).toEqual({ name: 'memory', action: 'retire', ref: 'C2', reason: 'he left the story' });
    expect(cmd('/memory retire "Old lighthouse" burnt down')).toEqual({ name: 'memory', action: 'retire', ref: 'Old lighthouse', reason: 'burnt down' });
    expect(error('/memory retire')).toContain('needs an entry');
  });

  test('the subcommands of M5b and M5c are "later"; an unknown one is an error', () => {
    for (const sub of ['undo', 'refile', 'retry']) expect(cmd(`/memory ${sub} x`)).toEqual({ name: 'later', command: `memory ${sub}`, when: 'M5b (Compendium agents)' });
    for (const sub of ['recall', 'profile', 'mode']) expect(cmd(`/memory ${sub} x`)).toEqual({ name: 'later', command: `memory ${sub}`, when: 'M5c (recall)' });
    expect(error('/memory forget C1')).toBe('/memory: "forget" is not a subcommand; /memory lists the Compendium, then show, tree, new, add, edit, retire, restore, export, on, off');
  });

  test('takeRef: a quoted ref, else the first word', () => {
    expect(takeRef('C1 rest of it')).toEqual({ ref: 'C1', rest: 'rest of it' });
    expect(takeRef("'a b' c")).toEqual({ ref: 'a b', rest: 'c' });
    expect(takeRef('"unclosed')).toBeNull();
    expect(takeRef('   ')).toBeNull();
  });
});

describe('/search', () => {
  test('the query as typed, quotes kept for the search; before=<n> as the last word', () => {
    expect(cmd('/search караван')).toEqual({ name: 'search', query: 'караван' });
    expect(cmd('/search "north road" Mira')).toEqual({ name: 'search', query: '"north road" Mira' });
    expect(cmd('/search караван before=12')).toEqual({ name: 'search', query: 'караван', before: 12 });
    expect(cmd('/search old map BEFORE=3')).toEqual({ name: 'search', query: 'old map', before: 3 });
    // Glued to a word it is part of the query.
    expect(cmd('/search xbefore=3')).toEqual({ name: 'search', query: 'xbefore=3' });
  });

  test('errors: no words, a bad cursor', () => {
    expect(error('/search')).toContain('/search needs words to look for');
    expect(error('/search before=4')).toContain('/search needs words');
    expect(error('/search map before=0')).toBe('/search: before= takes a message number (the #n of a hit), got "0"');
    expect(error('/search map before=x')).toContain('got "x"');
    expect(error('/search map before=')).toContain('got ""');
  });
});

describe('/probe', () => {
  test('bare prints the hint; --active [--write] probes the narrator model', () => {
    expect(cmd('/probe')).toEqual({ name: 'probe' });
    expect(cmd('/probe --active')).toEqual({ name: 'probe', active: true, write: false });
    expect(cmd('/probe --active --write')).toEqual({ name: 'probe', active: true, write: true });
    expect(cmd('/probe --write --active')).toEqual({ name: 'probe', active: true, write: true });
  });

  test('errors: --write alone, unknown arguments', () => {
    expect(error('/probe --write')).toContain('/probe --write needs --active here');
    expect(error('/probe --json')).toBe('/probe: unknown argument --json (it takes --active [--write])');
    expect(error('/probe ollama')).toContain('unknown argument ollama');
  });
});

describe('classes and help (M3)', () => {
  test('notes are written to the journal: add/edit/retire/restore are edits; list, show, search, probe only read', () => {
    for (const l of ['/memory add a | | b', '/memory edit C1 x', '/memory retire C1', '/memory restore C1']) expect(commandClass(cmd(l))).toBe('edit');
    for (const l of ['/memory', '/memory show C1', '/search map', '/search map before=3', '/probe', '/probe --active --write']) {
      expect(commandClass(cmd(l))).toBe('read');
    }
  });

  test('/memory and /search are no longer later; /help lists them and keeps the M5b/M5c subcommands for later', () => {
    for (const l of ['/memory', '/search x']) expect(cmd(l).name).not.toBe('later');
    const help = helpText();
    for (const s of [
      '/search <words> [before=n]',
      '/memory add <title> | <keys> | <text>',
      '/memory edit <ref> <title> | <keys> | <text>',
      '/memory retire <ref> [reason], /memory restore <ref>',
      '/memory show <ref>',
      '/probe --active [--write]',
    ]) {
      expect(help).toContain(s);
    }
    // M4: /director arrived (D-113); M5a: tree, new and export did too, so the Later line keeps the agents' and recall's.
    expect(help).toContain('Later: /memory undo|refile|retry (M5b, the Compendium agents), /memory recall|profile|mode (M5c, recall).');
    expect(help).not.toContain('(M3)');
  });
});
