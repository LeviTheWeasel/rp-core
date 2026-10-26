// sse.ts: the one SSE reader every adapter shares.
import { describe, expect, test } from 'bun:test';
import { sseEvents, type SseEvent } from '../../src/providers/sse.ts';
import { bytesOf, collect, enc } from './kit.ts';

const read = (chunks: readonly (string | Uint8Array)[]): Promise<SseEvent[]> => collect(sseEvents(bytesOf(chunks)));

/** Every way of cutting `bytes` into two chunks, plus one byte per chunk. */
function cuts(bytes: Uint8Array): Uint8Array[][] {
  const out: Uint8Array[][] = [];
  for (let i = 0; i <= bytes.length; i++) out.push([bytes.slice(0, i), bytes.slice(i)]);
  out.push(Array.from(bytes, (b) => Uint8Array.of(b)));
  return out;
}

describe('sseEvents: fields', () => {
  test('one event per blank line, data with or without the space', async () => {
    expect(await read(['data: a\n\ndata:b\n\n'])).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  test('only one leading space is stripped', async () => {
    expect(await read(['data:  two spaces\n\n'])).toEqual([{ data: ' two spaces' }]);
  });

  test('multi-line data is joined with \\n', async () => {
    expect(await read(['data: line one\ndata: line two\ndata:\n\n'])).toEqual([{ data: 'line one\nline two\n' }]);
  });

  test("comment lines are skipped, OpenRouter's processing note included", async () => {
    expect(await read([': keep-alive\n\n: OPENROUTER PROCESSING\n\ndata: {"x":1}\n: between\n\n'])).toEqual([{ data: '{"x":1}' }]);
  });

  test('event and id are carried; the event type resets per event, the id persists (WHATWG)', async () => {
    const evs = await read(['event: message_start\nid: 7\ndata: {}\n\ndata: next\n\nid: 8\nevent: ping\ndata: p\n\n']);
    expect(evs).toEqual([
      { event: 'message_start', id: '7', data: '{}' },
      { id: '7', data: 'next' },
      { event: 'ping', id: '8', data: 'p' },
    ]);
  });

  test('a blank line without data dispatches nothing; an event field alone is dropped', async () => {
    expect(await read(['\n\nevent: lonely\n\n\n'])).toEqual([]);
  });

  test('"data:" with an empty value is an event with empty data; a bare "data" line too', async () => {
    expect(await read(['data:\n\ndata\n\n'])).toEqual([{ data: '' }, { data: '' }]);
  });

  test('unknown fields and retry are ignored', async () => {
    expect(await read(['retry: 1000\nfoo: bar\ndata: x\n\n'])).toEqual([{ data: 'x' }]);
  });

  test('[DONE] is plain data: termination is the parser\'s call', async () => {
    expect(await read(['data: [DONE]\n\n'])).toEqual([{ data: '[DONE]' }]);
  });

  test('a leading BOM is dropped', async () => {
    expect(await read([Uint8Array.of(0xef, 0xbb, 0xbf), 'data: x\n\n'])).toEqual([{ data: 'x' }]);
  });

  test('colons after the first stay in the value', async () => {
    expect(await read(['data: {"a":"b:c"}\n\n'])).toEqual([{ data: '{"a":"b:c"}' }]);
  });
});

describe('sseEvents: line endings', () => {
  test('CRLF', async () => {
    expect(await read(['data: a\r\ndata: b\r\n\r\ndata: c\r\n\r\n'])).toEqual([{ data: 'a\nb' }, { data: 'c' }]);
  });

  test('a lone CR ends a line', async () => {
    expect(await read(['data: a\rdata: b\r\rdata: c\r\r'])).toEqual([{ data: 'a\nb' }, { data: 'c' }]);
  });

  test('a CRLF split across chunks is one line ending, not two', async () => {
    expect(await read(['data: a\r', '\ndata: b\r', '\n\r', '\n'])).toEqual([{ data: 'a\nb' }]);
  });

  test('a CR at the very end of the stream still ends the line', async () => {
    expect(await read(['data: a\r'])).toEqual([{ data: 'a' }]);
  });
});

describe('sseEvents: end of stream', () => {
  test('a pending event with no trailing blank line is dispatched at EOF', async () => {
    expect(await read(['data: a\n\ndata: tail\n'])).toEqual([{ data: 'a' }, { data: 'tail' }]);
  });

  test('an unterminated last line is read at EOF', async () => {
    expect(await read(['data: a\n\ndata: no newline'])).toEqual([{ data: 'a' }, { data: 'no newline' }]);
  });

  test('an empty stream yields nothing', async () => {
    expect(await read([])).toEqual([]);
    expect(await read([''])).toEqual([]);
  });

  test('stopping early returns the byte source (so the body is cancelled upstream)', async () => {
    let finished = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        yield enc.encode('data: 1\n\n');
        yield enc.encode('data: 2\n\n');
        await new Promise(() => {}); // would hang
      } finally {
        finished = true;
      }
    }
    for await (const ev of sseEvents(source())) {
      expect(ev).toEqual({ data: '1' });
      break;
    }
    expect(finished).toBe(true);
  });

  test('a source error propagates', async () => {
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield enc.encode('data: 1\n\n');
      throw new Error('reset');
    }
    const seen: SseEvent[] = [];
    let err: unknown;
    try {
      for await (const ev of sseEvents(broken())) seen.push(ev);
    } catch (e) {
      err = e;
    }
    expect(seen).toEqual([{ data: '1' }]);
    expect((err as Error).message).toBe('reset');
  });
});

describe('sseEvents: every cut point', () => {
  const STREAMS: { name: string; text: string; want: SseEvent[] }[] = [
    {
      name: 'LF, split events and fields',
      text: 'event: delta\ndata: {"t":"héllo"}\n\n: c\ndata: x\ndata: y\n\n',
      want: [{ event: 'delta', data: '{"t":"héllo"}' }, { data: 'x\ny' }],
    },
    {
      name: 'CRLF with comments and a tail without blank line',
      text: ': ping\r\ndata:{"a":1}\r\n\r\ndata: tail\r\n',
      want: [{ data: '{"a":1}' }, { data: 'tail' }],
    },
    {
      name: 'multi-byte UTF-8 (2, 3 and 4 bytes) split anywhere',
      text: 'data: привет — 日本語 🙂🎭\n\ndata: ◁think▷\n\n',
      want: [{ data: 'привет — 日本語 🙂🎭' }, { data: '◁think▷' }],
    },
    {
      name: 'lone CRs',
      text: 'data: a\rdata: б\r\rdata: c\r\r',
      want: [{ data: 'a\nб' }, { data: 'c' }],
    },
  ];
  for (const s of STREAMS) {
    test(s.name, async () => {
      const bytes = enc.encode(s.text);
      for (const chunks of cuts(bytes)) {
        const got = await collect(sseEvents(bytesOf(chunks)));
        expect(got).toEqual(s.want);
        // Never a replacement character: no code point was broken by a cut.
        expect(JSON.stringify(got)).not.toContain('�');
      }
    });
  }

  test('three-way cuts through a UTF-8 code point', async () => {
    const bytes = enc.encode('data: 🙂x\n\n');
    for (let i = 0; i <= bytes.length; i++) {
      for (let j = i; j <= bytes.length; j++) {
        const got = await collect(sseEvents(bytesOf([bytes.slice(0, i), bytes.slice(i, j), bytes.slice(j)])));
        expect(got).toEqual([{ data: '🙂x' }]);
      }
    }
  });

  test('a long line over many chunks is read whole', async () => {
    const big = 'x'.repeat(200_000);
    const bytes = enc.encode(`data: ${big}\n\n`);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 997) chunks.push(bytes.slice(i, i + 997));
    const got = await collect(sseEvents(bytesOf(chunks)));
    expect(got).toHaveLength(1);
    expect(got[0]!.data.length).toBe(200_000);
  });
});

describe('sseEvents: servers without blank lines (review M1b, Bunraku read each data line)', () => {
  test('one data line per event, no blank lines: each whole JSON value is an event, [DONE] too', async () => {
    const text = 'data: {"a":1}\ndata: {"b":2}\ndata: [1,2]\ndata: [DONE]\n';
    const want = [{ data: '{"a":1}' }, { data: '{"b":2}' }, { data: '[1,2]' }, { data: '[DONE]' }];
    expect(await read([text])).toEqual(want);
    for (const chunks of cuts(enc.encode(text))) expect(await read(chunks)).toEqual(want);
  });

  test('each event goes out when the next data line arrives, not at EOF (streaming is kept)', async () => {
    const it = sseEvents(bytesOf(['data: {"a":1}\n', 'data: {"b":2}\n']))[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ data: '{"a":1}' });
  });

  test('a lone [DONE] line goes out at once, even if the server keeps the connection open', async () => {
    async function* open(): AsyncGenerator<Uint8Array> {
      yield enc.encode('data: {"a":1}\ndata: [DONE]\n');
      await new Promise(() => {}); // never ends
    }
    const it = sseEvents(open())[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ data: '{"a":1}' });
    expect((await it.next()).value).toEqual({ data: '[DONE]' });
  });

  test('a genuine multi-line JSON event is still joined (it is not whole until its last line)', async () => {
    expect(await read(['data: {\ndata:   "a": 1\ndata: }\n\n'])).toEqual([{ data: '{\n  "a": 1\n}' }]);
    // Lines that are not JSON keep the spec's joining.
    expect(await read(['data: line one\ndata: line two\n\n'])).toEqual([{ data: 'line one\nline two' }]);
  });
});
