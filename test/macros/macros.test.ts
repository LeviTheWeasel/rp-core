// The macro table and syntax (ARCHITECTURE.md §10.4, D-42, D-43).
import { describe, expect, test } from 'bun:test';
import { isStructuralSlot, STRUCTURAL_SLOTS } from '../../src/prompt/macros.ts';
import { expand, run } from './env.ts';

describe('identity', () => {
  test('{{char}} and {{user}}, any case, inner whitespace', () => {
    expect(expand('{{char}} meets {{user}}.')).toBe('Alice meets Bob.');
    expect(expand('{{CHAR}}/{{User}}/{{ char }}')).toBe('Alice/Bob/Alice');
  });

  test('legacy <USER> <BOT> <CHAR>, case-insensitive', () => {
    expect(expand('<USER> <BOT> <CHAR> <user> <Bot> <char>')).toBe('Bob Alice Alice Bob Alice Alice');
  });

  test('names are inert: a name that looks like a macro is not expanded', () => {
    expect(expand('{{char}}', { char: '{{user}}' })).toBe('{{user}}');
  });
});

describe('card fields', () => {
  const card = {
    description: 'DESC',
    personality: 'PERS',
    scenario: 'SCEN',
    examples: 'EX',
    systemPrompt: 'SYS',
    postHistory: 'POST',
    firstMessage: 'FIRST',
  };

  test('every field and alias', () => {
    const cases: [string, string][] = [
      ['{{description}}', 'DESC'],
      ['{{personality}}', 'PERS'],
      ['{{scenario}}', 'SCEN'],
      ['{{persona}}', 'PERSONA'],
      ['{{examples}}', 'EX'],
      ['{{mesExamples}}', 'EX'],
      ['{{mes_example}}', 'EX'],
      ['{{system_prompt}}', 'SYS'],
      ['{{charPrompt}}', 'SYS'],
      ['{{post_history}}', 'POST'],
      ['{{charInstruction}}', 'POST'],
      ['{{first_message}}', 'FIRST'],
      ['{{firstMessage}}', 'FIRST'],
    ];
    for (const [tpl, want] of cases) expect(expand(tpl, { card, persona: 'PERSONA' })).toBe(want);
  });

  test('{{original}} is the overridden block, itself a template; empty outside an override', () => {
    expect(expand('{{system_prompt}} | {{original}}', { card }, 'main', 'Main prompt for {{char}}')).toBe('SYS | Main prompt for Alice');
    expect(expand('[{{original}}]')).toBe('[]');
  });

  test('{{mes_example}} is known: RoleCall stripping it was the bug §10.4 names', () => {
    const r = run({ card });
    expect(r.block('{{mes_example}}', 'main')).toBe('EX');
    expect(r.unknown()).toEqual([]);
  });
});

describe('text macros', () => {
  test('{{// comment}} renders nothing and never evaluates its body', () => {
    const r = run();
    expect(r.block('a{{// note: {{setvar::x::1}} :: {{char}} }}b', 'main')).toBe('ab');
    expect(r.block('{{//}}', 'main')).toBe('');
    expect(r.varsDiff()).toEqual({});
  });

  test('{{trim}} removes the line breaks around it, as in ST, but keeps spaces', () => {
    expect(expand('one\n\n{{trim}}\r\n\ntwo')).toBe('onetwo');
    expect(expand('{{trim}}\n\nstart')).toBe('start');
    expect(expand('end\n{{trim}}')).toBe('end');
    // ST: (?:\r?\n)*{{trim}}(?:\r?\n)* — inline words never run together.
    expect(expand('a {{trim}} b')).toBe('a  b');
    expect(expand('one\n  {{trim}}  \ntwo')).toBe('one\n    \ntwo');
  });

  test('{{newline}}', () => {
    expect(expand('a{{newline}}b{{NEWLINE}}c')).toBe('a\nb\nc');
  });
});

describe('escapes and literals', () => {
  test('escaped braces stay literal braces', () => {
    expect(expand('\\{\\{char\\}\\}')).toBe('{{char}}');
    expect(expand('\\{\\{char}} and {{char}}')).toBe('{{char}} and Alice');
  });

  test('an escaped tag inside a value written by setvar is stored with real braces', () => {
    const r = run();
    r.block('{{setvar::tpl::\\{\\{user\\}\\}}}', 'main');
    expect(r.varsDiff()).toEqual({ tpl: '{{user}}' });
    // and a variable value is inert when read back
    expect(r.block('{{getvar::tpl}}', 'main')).toBe('{{user}}');
  });

  test('an unclosed {{ is text and later macros still expand', () => {
    expect(expand('{{ {{char}}')).toBe('{{ Alice');
    expect(expand('tail {{char')).toBe('tail {{char');
    expect(expand('}} {{user}}')).toBe('}} Bob');
  });
});

describe('unknown macros', () => {
  test('stay literal as authored and are recorded once, in order', () => {
    const r = run();
    expect(r.block('{{foo}} {{bar::x::y}} {{foo}} {{char}}', 'a')).toBe('{{foo}} {{bar::x::y}} {{foo}} Alice');
    expect(r.block('{{Baz}}', 'b')).toBe('{{Baz}}');
    expect(r.unknown()).toEqual(['foo', 'bar', 'Baz']);
  });

  test('an unknown macro stays literal with the known macros inside it resolved, as in ST', () => {
    const r = run();
    // ST MacroEngine: "keep macro syntax, but nested macros inside rawInner are already resolved".
    expect(r.block('{{wrap::{{setvar::x::1}}{{char}}}}', 'main')).toBe('{{wrap::Alice}}');
    expect(r.varsDiff()).toEqual({ x: 1 });
    expect(r.block('{{img={{char}}_happy}} {{ plain }}', 'main')).toBe('{{img=Alice_happy}} {{ plain }}');
    expect(r.block('{{foo::{{bar::{{user}}}}}}', 'main')).toBe('{{foo::{{bar::Bob}}}}');
    expect(r.unknown()).toEqual(['wrap', 'plain', 'foo', 'bar']);
  });

  test('an unknown macro inside a known macro arg is recorded', () => {
    const r = run();
    expect(r.block('{{random::{{mystery}}}}', 'main')).toBe('{{mystery}}');
    expect(r.unknown()).toEqual(['mystery']);
  });

  test('non-identifier braces (JSON, prose) stay literal without polluting the trace', () => {
    const r = run();
    expect(r.block('{{"a": 1}} {{ some words }}', 'main')).toBe('{{"a": 1}} {{ some words }}');
    expect(r.unknown()).toEqual([]);
  });

  test('ST block forms are not supported: their tags stay literal, the content between is evaluated', () => {
    const r = run();
    expect(r.block('{{#if x}}{{char}}{{/if}}', 'main')).toBe('{{#if x}}Alice{{/if}}');
    expect(r.block('{{#if .player-instructions}}x{{/if}}', 'main')).toBe('{{#if .player-instructions}}x{{/if}}');
    expect(r.block('{{.player-instructions =\n\n}} {{$n += 2}}', 'main')).toBe('{{.player-instructions =\n\n}} {{$n += 2}}');
    expect(r.unknown()).toEqual(['#if', '/if', '.player-instructions', '$n']);
  });

  test('prototype names are unknown, not Object members', () => {
    const r = run();
    expect(r.block('{{constructor}} {{__proto__}} {{toString}}', 'main')).toBe('{{constructor}} {{__proto__}} {{toString}}');
  });
});

describe('structural slots', () => {
  test('pass through untouched and are not unknown', () => {
    const r = run();
    const text = '{{history}}|{{recap}}|{{lore::before}}|{{outlet::Lair}}|{{slot::director}}|{{ History }}|{{LORE::examples_after}}';
    expect(r.block(text, 'main')).toBe(text);
    expect(r.unknown()).toEqual([]);
  });

  test('a slot inside a card field survives expansion', () => {
    expect(expand('{{scenario}}', { card: { scenario: 'Before {{lore::after}} {{char}}' } })).toBe('Before {{lore::after}} Alice');
  });

  test('isStructuralSlot', () => {
    expect(STRUCTURAL_SLOTS).toContain('history');
    for (const yes of ['history', 'RECAP', ' lore::before ', 'outlet::x', 'slot::director', '{{history}}', 'Lore::examples_before']) {
      expect(isStructuralSlot(yes)).toBe(true);
    }
    for (const no of ['char', 'history::x', 'lore', 'lore::', 'outlet:: ', 'slot::a::b', 'histories', '']) {
      expect(isStructuralSlot(no)).toBe(false);
    }
  });
});

describe('nesting', () => {
  test('args evaluate depth-first', () => {
    expect(expand('{{random::{{char}}}}')).toBe('Alice');
    expect(expand('{{getvar::{{getvar::ptr}}}}', { vars: { ptr: 'target', target: 'found' } })).toBe('found');
    expect(expand('{{setvar::who::{{user}} and {{char}}}}{{getvar::who}}')).toBe('Bob and Alice');
  });

  test('nesting deeper than 100 renders empty instead of throwing', () => {
    let deep = '{{char}}';
    for (let i = 0; i < 150; i++) deep = `{{random::${deep}}}`;
    expect(expand(deep)).toBe('');
    let ok = '{{char}}';
    for (let i = 0; i < 50; i++) ok = `{{random::${ok}}}`;
    expect(expand(ok)).toBe('Alice');
  });

  test('parsing is linear in unclosed braces: a field full of {{ cannot stall a turn', () => {
    const time = (text: string): number => {
      const t0 = performance.now();
      expand(text);
      return performance.now() - t0;
    };
    // Each of these took seconds with a rescan per unmatched `{{` (quadratic); linear, all are fast.
    const n = 100_000;
    expect(time('{{'.repeat(n))).toBeLessThan(1000);
    expect(time(`${'{{'.repeat(n)}}}`)).toBeLessThan(1000);
    expect(time(`${'{{ x '.repeat(n)}{{char}}`)).toBeLessThan(1000);
    expect(expand(`${'{{'.repeat(1000)}{{char}}`)).toBe(`${'{{'.repeat(1000)}Alice`);
    expect(expand('{{ {{char}} }} {{user}')).toBe('{{ Alice }} {{user}');
  });

  test('pathological nesting neither overflows the stack nor hangs', () => {
    const n = 20_000;
    const deep = '{{random::'.repeat(n) + 'x' + '}}'.repeat(n);
    expect(() => expand(deep)).not.toThrow();
  });
});

describe('card fields are templates (D-42)', () => {
  test('{{char}}/{{user}} inside description and scenario expand in the same pass', () => {
    const card = { description: '{{char}} is a knight sworn to {{user}}.', scenario: '<BOT> waits for <USER>.' };
    expect(expand('{{description}}\n{{scenario}}', { card })).toBe('Alice is a knight sworn to Bob.\nAlice waits for Bob.');
  });

  test('fields expand recursively: description → personality → scenario', () => {
    const card = { description: 'D[{{personality}}]', personality: 'P[{{scenario}}]', scenario: 'S[{{char}}]' };
    expect(expand('{{description}}', { card })).toBe('D[P[S[Alice]]]');
  });

  test('persona is a template too', () => {
    expect(expand('{{persona}}', { persona: '{{user}} is {{char}}’s rival.' })).toBe('Bob is Alice’s rival.');
  });

  test('a cycle stops at the point it closes (no hang, no raw macro leak)', () => {
    const card = { description: 'D({{personality}})', personality: 'P({{description}})' };
    expect(expand('{{description}}', { card })).toBe('D(P())');
    expect(expand('{{description}}', { card: { description: 'self {{description}} ref' } })).toBe('self  ref');
  });

  test('a field repeated side by side is expanded each time (not a cycle)', () => {
    expect(expand('{{scenario}}+{{scenario}}', { card: { scenario: '{{char}}' } })).toBe('Alice+Alice');
  });

  test('a fan-out bomb across fields ends without hanging', () => {
    const wide = (inner: string): string => Array.from({ length: 40 }, () => `{{${inner}}}`).join('');
    const card = {
      description: wide('personality'),
      personality: wide('scenario'),
      scenario: wide('examples'),
      examples: wide('system_prompt'),
      systemPrompt: wide('post_history'),
      postHistory: wide('first_message'),
      firstMessage: 'xxxxxxxxxx',
    };
    const out = expand('{{description}}', { card });
    expect(out.length).toBeLessThanOrEqual(1_000_000);
  });

  test('unknown macros inside fields are recorded; slots and escapes inside fields behave as at top level', () => {
    const r = run({ card: { description: '{{oddity}} \\{\\{char}} {{history}}' } });
    expect(r.block('{{description}}', 'main')).toBe('{{oddity}} {{char}} {{history}}');
    expect(r.unknown()).toEqual(['oddity']);
  });
});

describe('Cyrillic content', () => {
  test('names, fields, legacy tokens and list options', () => {
    const over = {
      char: 'Алиса',
      user: 'Борис',
      card: { description: '{{char}} — рыцарь, присягнувший {{user}}. <USER> молчит.' },
    };
    expect(expand('{{description}}', over)).toBe('Алиса — рыцарь, присягнувший Борис. Борис молчит.');
    expect(['север', 'юг']).toContain(expand('{{random::север::юг}}', over));
    expect(['да, конечно', 'нет']).toContain(expand('{{random:да\\, конечно,нет}}', over));
  });
});

describe('time macros', () => {
  // 2026-10-26T15:45Z is a Monday.
  test('UTC', () => {
    expect(expand('{{time}} | {{date}} | {{weekday}}')).toBe('3:45 PM | October 26, 2026 | Monday');
  });

  test('the zone shifts the clock and the calendar day', () => {
    expect(expand('{{time}} | {{date}} | {{weekday}}', { timeZone: 'Asia/Tokyo' })).toBe('12:45 AM | October 27, 2026 | Tuesday');
    expect(expand('{{time}} | {{date}}', { timeZone: 'America/Los_Angeles' })).toBe('8:45 AM | October 26, 2026');
    expect(expand('{{time}}', { timeZone: 'Europe/Moscow' })).toBe('6:45 PM');
  });

  test('uses a plain space before AM/PM', () => {
    expect(expand('{{time}}', { now: '2026-10-26T00:05:00.000Z' })).toBe('12:05 AM');
  });

  test('an unknown zone falls back to UTC; an unparseable instant renders empty', () => {
    expect(expand('{{time}}', { timeZone: 'Nowhere/Atlantis' })).toBe('3:45 PM');
    expect(expand('[{{time}}{{date}}{{weekday}}]', { now: 'not a date' })).toBe('[]');
  });
});

describe('userText', () => {
  test('only identity macros, read-only', () => {
    const r = run();
    const typed = 'Hi {{char}}, I am {{user}} (<USER>/<BOT>). {{setvar::x::1}} {{random::a::b}} {{description}} {{time}}';
    expect(r.userText(typed)).toBe('Hi Alice, I am Bob (Bob/Alice). {{setvar::x::1}} {{random::a::b}} {{description}} {{time}}');
    expect(r.varsDiff()).toEqual({});
    expect(r.unknown()).toEqual([]);
  });

  test('escaped tags and $-patterns in names are left alone', () => {
    const r = run({ char: '$& $1' });
    expect(r.userText('\\{{char}} {{char}}')).toBe('\\{{char}} $& $1');
  });
});
