// Ported from Bunraku:src/stage/provider/transport-core.ts@702d8120 (createLineSplitter: one decoder
// for the whole stream) and the `data:` reading of its stream readers.
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Server-sent events reader (ARCHITECTURE.md §8.1 "Общий sse.ts"). One byte stream, one TextDecoder,
// LF or CRLF, 'data:' with or without a space, ':' comment lines skipped, multi-line data joined by
// '\n', an event dispatched on a blank line (and a pending one at EOF). Termination policy ([DONE],
// usage after finish, truncated streams) belongs to the adapter's parser, not here.
// CONTRACT FILE (M1b): signature is fixed; the transport agent implements the body.
//
// Changes from Bunraku: an event reader (WHATWG "interpreting an event stream") instead of a bare
// line splitter, so every adapter shares one field parser (RoleCall had three, §19.4). A lone CR also
// ends a line, as the SSE grammar allows; a CR at the end of a chunk is held until the next byte says
// whether it starts a CRLF. Deviation from the WHATWG spec, by contract: an event still open at EOF
// is dispatched instead of dropped (the adapter decides whether the stream was truncated); and a
// stream without blank lines (one `data:` line per event) is read line by line: buffered data that is
// already a whole JSON value or [DONE] is dispatched when the next `data:` line arrives.

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/** Per-stream field state (WHATWG: data buffer, event type buffer, last event id). */
interface Pending {
  data: string[];
  event: string | undefined;
  /** The last event id persists across events, as in the spec. */
  id: string | undefined;
}

/** The pending event, handed out; the data and type buffers start over (the id persists). */
function dispatch(st: Pending): SseEvent {
  const ev: SseEvent = { data: st.data.join('\n') };
  if (st.event !== undefined && st.event !== '') ev.event = st.event;
  if (st.id !== undefined) ev.id = st.id;
  st.data = [];
  st.event = undefined;
  return ev;
}

/**
 * The buffered data lines already make one whole payload: '[DONE]', or a complete JSON object or
 * array. Cheap brackets check first, so a long multi-line JSON event is not re-parsed on every line.
 */
function isWholePayload(data: readonly string[]): boolean {
  const first = data[0]!.trimStart();
  const last = data[data.length - 1]!.trimEnd();
  if (data.length === 1 && first.trimEnd() === '[DONE]') return true;
  const open = first.charCodeAt(0);
  const close = last.charCodeAt(last.length - 1);
  if (!((open === 0x7b /* { */ && close === 0x7d) /* } */ || (open === 0x5b /* [ */ && close === 0x5d) /* ] */)) return false;
  try {
    JSON.parse(data.join('\n'));
    return true;
  } catch {
    return false;
  }
}

/** One line → state change; events to dispatch are appended to `out`. */
function feedLine(line: string, st: Pending, out: SseEvent[]): void {
  if (line === '') {
    if (st.data.length === 0) st.event = undefined;
    else out.push(dispatch(st));
    return;
  }
  if (line.charCodeAt(0) === 0x3a /* ':' */) return; // comment (keep-alives, ': OPENROUTER PROCESSING')
  const colon = line.indexOf(':');
  const field = colon < 0 ? line : line.slice(0, colon);
  let value = colon < 0 ? '' : line.slice(colon + 1);
  if (value.charCodeAt(0) === 0x20 /* ' ' */) value = value.slice(1);
  switch (field) {
    case 'data': {
      // Servers that write one `data:` line per event with no blank line between them (Bunraku read
      // every data line on its own): data already buffered that is a whole payload was an event of
      // its own, so it goes out before this line starts the next one. A lone [DONE] goes out at once
      // (a server may keep the connection open after it). A genuine multi-line event is not a whole
      // payload until its last line, so it is still joined as the spec says.
      if (st.data.length > 0 && isWholePayload(st.data)) out.push(dispatch(st));
      st.data.push(value);
      if (st.data.length === 1 && value.trim() === '[DONE]') out.push(dispatch(st));
      break;
    }
    case 'event':
      st.event = value;
      break;
    case 'id':
      if (!value.includes('\0')) st.id = value;
      break;
    default:
      // 'retry' and unknown fields are ignored.
      break;
  }
}

export async function* sseEvents(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  // One decoder for the whole stream: a code point split across chunks is completed by the next
  // chunk instead of becoming U+FFFD. A leading BOM is dropped by the decoder (ignoreBOM false).
  const decoder = new TextDecoder();
  const st: Pending = { data: [], event: undefined, id: undefined };
  let buf = '';
  /** How far `buf` is known to hold no line break (so a long line is never rescanned). */
  let scanned = 0;

  /** Complete lines out of `buf`; with `final`, the unterminated rest is a line too. */
  function* lines(final: boolean): Generator<string> {
    let start = 0;
    let i = scanned;
    const n = buf.length;
    for (; i < n; i++) {
      const c = buf.charCodeAt(i);
      if (c === 0x0a /* LF */) {
        yield buf.slice(start, i);
        start = i + 1;
      } else if (c === 0x0d /* CR */) {
        if (i + 1 === n && !final) break; // CR at the edge: wait to see whether an LF follows
        yield buf.slice(start, i);
        if (buf.charCodeAt(i + 1) === 0x0a) i++;
        start = i + 1;
      }
    }
    buf = buf.slice(start);
    scanned = i - start;
    if (final && buf !== '') {
      const rest = buf;
      buf = '';
      scanned = 0;
      yield rest;
    }
  }

  const out: SseEvent[] = [];
  for await (const chunk of bytes) {
    buf += decoder.decode(chunk, { stream: true });
    for (const line of lines(false)) {
      feedLine(line, st, out);
      if (out.length > 0) yield* out.splice(0);
    }
  }
  buf += decoder.decode();
  for (const line of lines(true)) {
    feedLine(line, st, out);
    if (out.length > 0) yield* out.splice(0);
  }
  // EOF with an event still open (no trailing blank line): dispatch it, by contract.
  feedLine('', st, out);
  yield* out.splice(0);
}
