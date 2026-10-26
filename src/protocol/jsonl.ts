// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The ONE line splitter of the core [D-36]: an explicit byte-level LF splitter with a single
// streaming TextDecoder. Never node:readline (Node splits on U+2028/U+2029). CR before LF allowed.
// CONTRACT FILE: signatures are fixed; the storage agent implements the bodies.
//
// Why bytes and not decoded text: 0x0A never occurs inside a multi-byte UTF-8 sequence, so cutting
// on the raw byte is exact, and a line's bytes are only decoded once they are complete. A sequence
// torn across two chunks is therefore reassembled before decoding, and a sequence torn by EOF or by
// a crash decodes to U+FFFD (fatal:false) instead of throwing. U+2028/U+2029 are ordinary
// multi-byte characters here and never end a line.

const LF = 0x0a;
const CR = 0x0d;

/** One decoder per splitter run; `fatal:false` so broken UTF-8 becomes U+FFFD, never an exception. */
function makeDecoder(): TextDecoder {
  return new TextDecoder('utf-8', { fatal: false });
}

/** Decode a complete line's bytes (without its LF), dropping one CR that preceded the LF. */
function decodeLine(decoder: TextDecoder, bytes: Uint8Array): string {
  const end = bytes.length > 0 && bytes[bytes.length - 1] === CR ? bytes.length - 1 : bytes.length;
  // Non-streaming decode: the line is complete, so nothing may carry over into the next one.
  return end === 0 ? '' : decoder.decode(bytes.subarray(0, end));
}

/** A complete line with its position in the file. */
export interface LineSpan {
  /** Decoded text without LF/CR. Never empty (empty lines are skipped). */
  text: string;
  /** 1-based line number in the file. */
  line: number;
  /** Byte offset of the first byte of the line. */
  start: number;
  /** Byte offset just past the line's LF. */
  end: number;
}

/**
 * splitLines plus byte spans: what the journal reader needs to truncate a bad final line.
 * `tornLine` is the 1-based line number of the torn segment.
 */
export function splitLineSpans(bytes: Uint8Array): {
  spans: LineSpan[];
  torn: string | null;
  tornOffset: number | null;
  tornLine: number | null;
} {
  const decoder = makeDecoder();
  const spans: LineSpan[] = [];
  let start = 0;
  let line = 1;
  for (;;) {
    const lf = bytes.indexOf(LF, start);
    if (lf < 0) break;
    const text = decodeLine(decoder, bytes.subarray(start, lf));
    if (text.length > 0) spans.push({ text, line, start, end: lf + 1 });
    start = lf + 1;
    line++;
  }
  if (start >= bytes.length) return { spans, torn: null, tornOffset: null, tornLine: null };
  // The torn segment is reported verbatim (a lone CR included): it is evidence, not a line.
  return { spans, torn: decoder.decode(bytes.subarray(start)), tornOffset: start, tornLine: line };
}

/**
 * Split a whole file. Complete lines end with LF; a final segment without LF is `torn` (for the
 * journal it is a torn tail). `tornOffset` is the byte offset where the torn segment starts.
 * Empty lines are skipped but still counted in `lineNumbers`.
 */
export function splitLines(bytes: Uint8Array): {
  lines: string[];
  /** 1-based line numbers of `lines` in the file. */
  lineNumbers: number[];
  torn: string | null;
  tornOffset: number | null;
} {
  const { spans, torn, tornOffset } = splitLineSpans(bytes);
  return {
    lines: spans.map((s) => s.text),
    lineNumbers: spans.map((s) => s.line),
    torn,
    tornOffset,
  };
}

/** Join buffered chunk tails with the head of the current chunk into one contiguous line. */
function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const encoder = new TextEncoder();

/** Accept a ReadableStream or any async iterable; read through a reader so the lock is released. */
async function* chunksOf(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const asStream = source as ReadableStream<Uint8Array>;
  if (typeof asStream.getReader === 'function') {
    const reader = asStream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      // Releasing (not cancelling) leaves stdin usable if the consumer stops early.
      reader.releaseLock();
    }
  }
  yield* source as AsyncIterable<Uint8Array>;
}

/**
 * Stream lines from a byte stream (stdin, child stdout). A final segment without LF IS yielded as a
 * line on stdin semantics. Empty lines (including Bun's trailing empty line at EOF) are skipped.
 */
export async function* lines(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = makeDecoder();
  // Bytes of the current, not yet terminated line, kept as separate copies until LF arrives.
  let pending: Uint8Array[] = [];
  let pendingLen = 0;
  for await (const raw of chunksOf(source)) {
    // Be lenient with text streams handed in by mistake; the contract is bytes.
    const chunk: Uint8Array = typeof raw === 'string' ? encoder.encode(raw) : raw;
    let start = 0;
    for (;;) {
      const lf = chunk.indexOf(LF, start);
      if (lf < 0) break;
      const head = chunk.subarray(start, lf);
      let lineBytes = head;
      if (pendingLen > 0) {
        pending.push(head);
        lineBytes = concat(pending, pendingLen + head.length);
        pending = [];
        pendingLen = 0;
      }
      const text = decodeLine(decoder, lineBytes);
      if (text.length > 0) yield text;
      start = lf + 1;
    }
    if (start < chunk.length) {
      // Copy: the producer may reuse its chunk buffer after we return control.
      pending.push(chunk.slice(start));
      pendingLen += chunk.length - start;
    }
  }
  if (pendingLen > 0) {
    const text = decodeLine(decoder, concat(pending, pendingLen));
    if (text.length > 0) yield text;
  }
}
