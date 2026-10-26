// prompt/tokens.ts M2 (§11): gpt-tokenizer o200k behind TokenCounter, the default from M2 on.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { assemble, traceForSent } from '../../src/prompt/assemble.ts';
import {
  CHARS_COUNTER,
  charsEstimate,
  counterById,
  defaultCounter,
  estimateMessages,
  estimateTokens,
  O200K_COUNTER,
  o200kLoaded,
} from '../../src/prompt/tokens.ts';
import { input, ok } from './fixtures.ts';

const ROOT = join(import.meta.dir, '..', '..');

describe('O200K_COUNTER', () => {
  test('loads lazily: importing the whole core does not load the tables, the first count does', () => {
    const script = [
      `import * as core from ${JSON.stringify(join(ROOT, 'src/index.ts'))};`,
      `import { O200K_COUNTER, o200kLoaded } from ${JSON.stringify(join(ROOT, 'src/prompt/tokens.ts'))};`,
      'void core;',
      'const before = o200kLoaded();',
      "const n = O200K_COUNTER.count('hello world');",
      'console.log(JSON.stringify({ before, after: o200kLoaded(), n }));',
    ].join('\n');
    const p = Bun.spawnSync([process.execPath, '-e', script], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    expect(p.stderr.toString()).toBe('');
    expect(JSON.parse(p.stdout.toString().trim())).toEqual({ before: false, after: true, n: 2 });
  });

  test("special tokens are counted as text, never thrown on: '<|endoftext|>' in a card", () => {
    expect(() => O200K_COUNTER.count('<|endoftext|>')).not.toThrow();
    expect(O200K_COUNTER.count('<|endoftext|>')).toBe(7);
    expect(O200K_COUNTER.count('a <|im_start|>system<|im_end|> b')).toBeGreaterThan(3);
    expect(o200kLoaded()).toBe(true);
  });

  test('Cyrillic counts sanely: fewer tokens than characters, and below the chars/2.5 estimate', () => {
    const ru = 'Привет! Я Мира, картограф снов. Куда мы держим путь этой ночью?';
    const n = O200K_COUNTER.count(ru);
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(ru.length / 2);
    expect(n).toBeLessThan(charsEstimate(ru));
  });

  test('empty is 0; English is about four characters a token', () => {
    expect(O200K_COUNTER.count('')).toBe(0);
    expect(O200K_COUNTER.count('hello world')).toBe(2);
    const en = 'The lighthouse keeper climbed the spiral stairs as the storm rolled in from the sea.';
    expect(O200K_COUNTER.count(en)).toBeGreaterThan(en.length / 6);
    expect(O200K_COUNTER.count(en)).toBeLessThan(en.length / 3);
  });

  test('deterministic: a long text counted twice (the second time from the memo) gives the same number', () => {
    const long = 'Mira unrolls the map. '.repeat(50);
    const first = O200K_COUNTER.count(long);
    expect(O200K_COUNTER.count(long)).toBe(first);
    expect(O200K_COUNTER.count(`${long}!`)).toBeGreaterThanOrEqual(first);
  });
});

describe('the default counter', () => {
  test('is o200k; estimateTokens follows it unless a counter is given', () => {
    expect(defaultCounter()).toBe(O200K_COUNTER);
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('hello world', CHARS_COUNTER)).toBe(4);
  });

  test('counterById reads Trace.tokens.counter (absent = chars, M1)', () => {
    expect(counterById('o200k')).toBe(O200K_COUNTER);
    expect(counterById('chars')).toBe(CHARS_COUNTER);
    expect(counterById(undefined)).toBe(CHARS_COUNTER);
  });

  test("assemble counts with o200k by default and names it: trace.tokens.counter 'o200k'", () => {
    const r = ok(assemble(input({ counter: undefined })));
    expect(r.trace.tokens.counter).toBe('o200k');
    expect(r.trace.tokens.estimated).toBe(estimateMessages(r.messages, O200K_COUNTER));
    const chars = ok(assemble(input({ counter: CHARS_COUNTER })));
    expect(chars.trace.tokens.counter).toBe('chars');
    expect(chars.trace.tokens.estimated).toBe(estimateMessages(chars.messages, CHARS_COUNTER));
    expect(chars.trace.tokens.estimated).not.toBe(r.trace.tokens.estimated);
  });

  test('traceForSent recounts with the counter the trace names and keeps the name', () => {
    const r = ok(assemble(input({ counter: CHARS_COUNTER })));
    const sent = traceForSent(r.trace, r.messages.slice(1));
    expect(sent.tokens.counter).toBe('chars');
    expect(sent.tokens.estimated).toBe(estimateMessages(r.messages.slice(1), CHARS_COUNTER));
    const o = ok(assemble(input({ counter: undefined })));
    const oSent = traceForSent({ ...o.trace, tokens: { ...o.trace.tokens, reported: 999 } }, o.messages);
    expect(oSent.tokens).toEqual({ estimated: o.trace.tokens.estimated, counter: 'o200k', reported: 999 });
  });
});
