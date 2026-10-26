// Tiny PNG writer for format tests: a valid 1x1 image plus whatever text chunks a test needs
// (tEXt, zTXt, iTXt compressed or not), in the order given. CRC32 is computed here so the files are
// well-formed for any other reader too.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function chunk(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, data.length);
  head.set(ascii(type), 4);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(concat(ascii(type), data)));
  return concat(head, data, crc);
}

export type TextChunk =
  | { type: 'tEXt'; keyword: string; text: string }
  | { type: 'zTXt'; keyword: string; text: string }
  | { type: 'iTXt'; keyword: string; text: string; compressed?: boolean; lang?: string; translated?: string };

export function textChunk(c: TextChunk): Uint8Array {
  const kw = concat(ascii(c.keyword), Uint8Array.of(0));
  if (c.type === 'tEXt') return chunk('tEXt', concat(kw, ascii(c.text)));
  if (c.type === 'zTXt') return chunk('zTXt', concat(kw, Uint8Array.of(0), deflateSync(ascii(c.text))));
  const body = c.compressed ? deflateSync(utf8(c.text)) : utf8(c.text);
  return chunk(
    'iTXt',
    concat(
      kw,
      Uint8Array.of(c.compressed ? 1 : 0, 0),
      ascii(c.lang ?? ''),
      Uint8Array.of(0),
      utf8(c.translated ?? ''),
      Uint8Array.of(0),
      body,
    ),
  );
}

/** A 1x1 grey PNG carrying the given text chunks between IHDR and IDAT. */
export function makePng(texts: TextChunk[]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, 1);
  v.setUint32(4, 1);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return concat(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', ihdr),
    ...texts.map(textChunk),
    chunk('IDAT', deflateSync(Uint8Array.of(0, 0x80))), // filter byte + one pixel
    chunk('IEND', new Uint8Array(0)),
  );
}

/** base64 of the UTF-8 JSON of `obj`, the way ST writes `chara` / `ccv3`. */
export const b64json = (obj: unknown): string => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
