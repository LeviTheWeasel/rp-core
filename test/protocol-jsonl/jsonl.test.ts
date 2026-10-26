// protocol/jsonl.ts: the one LF splitter [D-36] — U+2028/U+2029, CRLF, torn UTF-8, EOF without LF.
import { describe, expect, test } from 'bun:test';
import { lines, splitLines, splitLineSpans } from '../../src/protocol/jsonl.ts';
import { fakeRandom } from '../helpers.ts';

const enc = new TextEncoder();
const b = (s: string): Uint8Array => enc.encode(s);

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of it) out.push(l);
  return out;
}

/** An async iterable that yields the given byte chunks. */
async function* chunked(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield c;
}

/** Cut bytes at the given offsets. */
function cut(bytes: Uint8Array, at: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let prev = 0;
  for (const a of [...at, bytes.length]) {
    out.push(bytes.slice(prev, a));
    prev = a;
  }
  return out;
}

describe('splitLines', () => {
  test('complete lines, no torn tail', () => {
    const r = splitLines(b('{"a":1}\n{"b":2}\n'));
    expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.lineNumbers).toEqual([1, 2]);
    expect(r.torn).toBeNull();
    expect(r.tornOffset).toBeNull();
  });

  test('U+2028 and U+2029 never split a line', () => {
    const value = { text: 'one two three' };
    const json = JSON.stringify(value);
    expect(json).toContain(' '); // JSON.stringify leaves them raw: the splitter must cope
    const r = splitLines(b(`${json}\n${json}\n`));
    expect(r.lines.length).toBe(2);
    expect(JSON.parse(r.lines[0]!)).toEqual(value);
  });

  test('CRLF is tolerated and stripped; a lone CR inside a line is kept', () => {
    const r = splitLines(b('a\r\nb\rc\r\n\r\nd\n'));
    expect(r.lines).toEqual(['a', 'b\rc', 'd']);
    expect(r.lineNumbers).toEqual([1, 2, 4]);
  });

  test('empty lines are skipped but counted', () => {
    const r = splitLines(b('\n\nx\n\ny\n\n'));
    expect(r.lines).toEqual(['x', 'y']);
    expect(r.lineNumbers).toEqual([3, 5]);
    expect(r.torn).toBeNull();
  });

  test('a final segment without LF is torn, with its BYTE offset', () => {
    const first = '{"t":"ж"}\n'; // multi-byte: byte offset differs from char offset
    const r = splitLines(b(`${first}{"t":"to`));
    expect(r.lines).toEqual(['{"t":"ж"}']);
    expect(r.torn).toBe('{"t":"to');
    expect(r.tornOffset).toBe(b(first).length);
    expect(r.tornOffset).not.toBe(first.length);
  });

  test('torn UTF-8 decodes to U+FFFD and never throws', () => {
    const bytes = b('ok\nжж');
    const torn = bytes.slice(0, bytes.length - 1); // cut the last 2-byte char in half
    const r = splitLines(torn);
    expect(r.lines).toEqual(['ok']);
    expect(r.torn).toBe('ж�');
    // Broken bytes inside a complete line also decode leniently.
    const mid = new Uint8Array([0x61, 0xd0, 0x0a, 0x62, 0x0a]);
    expect(splitLines(mid).lines).toEqual(['a�', 'b']);
  });

  test('empty input', () => {
    expect(splitLines(new Uint8Array(0))).toEqual({ lines: [], lineNumbers: [], torn: null, tornOffset: null });
  });

  test('spans report start/end byte offsets', () => {
    const r = splitLineSpans(b('ab\r\n\nжc\n'));
    expect(r.spans).toEqual([
      { text: 'ab', line: 1, start: 0, end: 4 },
      { text: 'жc', line: 3, start: 5, end: 9 },
    ]);
  });
});

describe('lines (stream)', () => {
  test('final segment without LF IS a line; trailing empty line skipped', async () => {
    expect(await collect(lines(chunked([b('a\nb\n\n'), b('c')])))).toEqual(['a', 'b', 'c']);
    expect(await collect(lines(chunked([b('a\n'), b('\n')])))).toEqual(['a']);
  });

  test('chunk boundaries inside a multi-byte char, inside U+2028, and between CR and LF', async () => {
    const text = 'жар птица\r\nвторая\n';
    const bytes = b(text);
    for (let i = 1; i < bytes.length; i++) {
      expect(await collect(lines(chunked(cut(bytes, [i]))))).toEqual(['жар птица', 'вторая']);
    }
  });

  test('works with a ReadableStream source', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(b('{"x":1}\r\n{"y"'));
        c.enqueue(b(':2}\n'));
        c.close();
      },
    });
    expect(await collect(lines(stream))).toEqual(['{"x":1}', '{"y":2}']);
  });

  test('U+2028 round-trips through JSON.stringify → lines → JSON.parse', async () => {
    const msgs = [{ s: 'a b' }, { s: 'c d' }, { s: 'line\nfeed escaped' }];
    const bytes = b(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
    const got = (await collect(lines(chunked(cut(bytes, [3, 7, 11]))))).map((l) => JSON.parse(l));
    expect(got).toEqual(msgs);
  });

  test('a producer reusing its chunk buffer does not corrupt pending bytes', async () => {
    const shared = new Uint8Array(4);
    async function* reuse(): AsyncGenerator<Uint8Array> {
      for (const part of ['ab', 'cd', '\nef', '\n']) {
        shared.fill(0);
        const bytes = b(part);
        shared.set(bytes);
        yield shared.subarray(0, bytes.length);
      }
    }
    expect(await collect(lines(reuse()))).toEqual(['abcd', 'ef']);
  });

  test('fuzz: random bytes in random chunks agree with splitLines (+ torn as last line)', async () => {
    const rnd = fakeRandom(42);
    const alphabet = [0x0a, 0x0d, 0x61, 0x7b, 0x22, 0xd0, 0xb6, 0xe2, 0x80, 0xa8, 0xff, 0x20];
    for (let round = 0; round < 300; round++) {
      const len = rnd(1)[0]! % 64;
      const bytes = new Uint8Array(len);
      const r = rnd(len);
      for (let i = 0; i < len; i++) bytes[i] = alphabet[r[i]! % alphabet.length]!;
      const cuts = [...rnd(3)].map((x) => x % (len + 1)).sort((x, y) => x - y);
      const whole = splitLines(bytes);
      const expected = [...whole.lines];
      if (whole.torn !== null) {
        const t = whole.torn.endsWith('\r') ? whole.torn.slice(0, -1) : whole.torn;
        if (t.length > 0) expected.push(t);
      }
      expect(await collect(lines(chunked(cut(bytes, cuts))))).toEqual(expected);
    }
  });
});
