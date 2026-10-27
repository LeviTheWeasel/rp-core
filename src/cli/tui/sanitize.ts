// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Display sanitiser for the TUI (T-10). Model text and anything read from a file may hold escape
// sequences and control characters; OpenTUI drops a bare ESC but prints the rest of the sequence.
// Everything here removes whole sequences (CSI, OSC, DCS/SOS/PM/APC strings, short ESC sequences,
// their 8-bit C1 forms), every other C0/C1 control except "\n", turns "\t" into two spaces and the
// Unicode LINE / PARAGRAPH SEPARATORs (U+2028, U+2029) into "\n" (terminals size them differently,
// T-16). Under Warp it also drops ZWJ, VS16 and the skin-tone modifiers (ghost glyphs,
// opencode#58028). The stream variant gives the same result for any split of the input: a delta that
// ends inside a sequence or a surrogate pair holds that tail back until the next delta. Also the
// speaker labels the transcript pads, measured in terminal columns (T-16), not UTF-16 units.

import { USER_LABEL } from '../repl-render.ts';
import type { Names } from './types.ts';

export interface SanitizeOptions {
  /** TERM_PROGRAM=WarpTerminal: also drop ZWJ, VS16 and skin-tone modifiers. */
  warp: boolean;
}

/** A sequence longer than this is not treated as one: only its introducer is dropped. */
const MAX_SEQ = 256;

const ESC = 0x1b;
const BEL = 0x07;
const ST8 = 0x9c;

/** Where the escape sequence starting at `i` ends (exclusive), or INCOMPLETE / JUNK. */
const INCOMPLETE = -1;
const JUNK = -2;

function isStringIntro(c: number): boolean {
  // DCS, SOS, PM, APC (7-bit final byte after ESC, or the 8-bit C1 code).
  return c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f;
}

/** End of a control string (OSC: BEL or ST; others: ST), scanning from `j`. */
function stringEnd(s: string, start: number, j: number, osc: boolean): number {
  const limit = start + MAX_SEQ;
  for (; j < s.length; j++) {
    if (j >= limit) return JUNK;
    const c = s.charCodeAt(j);
    if ((osc && c === BEL) || c === ST8) return j + 1;
    if (c === ESC) {
      if (j + 1 >= s.length) return INCOMPLETE;
      if (s.charCodeAt(j + 1) === 0x5c) return j + 2;
    }
  }
  return INCOMPLETE;
}

/** CSI parameters, intermediates and the final byte, scanning from `j`. */
function csiEnd(s: string, start: number, j: number): number {
  const limit = start + MAX_SEQ;
  for (; j < s.length; j++) {
    if (j >= limit) return JUNK;
    const c = s.charCodeAt(j);
    if (c >= 0x40 && c <= 0x7e) return j + 1;
    // A byte that cannot belong to a CSI ends it: the bytes so far go, that byte stays.
    if (c < 0x20 || c > 0x3f) return j;
  }
  return INCOMPLETE;
}

/** The end of the sequence introduced at `i` (ESC or an 8-bit C1 introducer). */
export function sequenceEnd(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c === 0x9b) return csiEnd(s, i, i + 1);
  if (c === 0x9d) return stringEnd(s, i, i + 1, true);
  if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) return stringEnd(s, i, i + 1, false);
  if (c !== ESC) return i + 1;
  if (i + 1 >= s.length) return INCOMPLETE;
  const n = s.charCodeAt(i + 1);
  if (n === 0x5b) return csiEnd(s, i, i + 2);
  if (n === 0x5d) return stringEnd(s, i, i + 2, true);
  if (isStringIntro(n)) return stringEnd(s, i, i + 2, false);
  // nF / Fp / Fe / Fs: intermediates 0x20–0x2F, then one final byte 0x30–0x7E.
  let j = i + 1;
  while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
  if (j >= s.length) return j - i > MAX_SEQ ? JUNK : INCOMPLETE;
  const f = s.charCodeAt(j);
  if (f >= 0x30 && f <= 0x7e) return j + 1;
  // ESC before something that is no sequence: only the ESC (and stray intermediates) go.
  return j;
}

function isIntroducer(c: number): boolean {
  return c === ESC || c === 0x9b || c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f;
}

/** Characters Warp sizes wrongly: ZWJ, VS16 (BMP), skin tones U+1F3FB–U+1F3FF (low surrogates DFFB–DFFF after D83C). */
function warpDrops(c: number): boolean {
  return c === 0x200d || c === 0xfe0f;
}

/**
 * Walks `s`: clean text goes to `text`, every complete escape sequence to `seq` (raw). Returns the
 * index where an incomplete tail starts (s.length when there is none): an unfinished sequence or a
 * high surrogate at the very end. The caller holds that tail (stream) or drops it (end of input).
 */
export function walk(s: string, warp: boolean, text: (t: string) => void, seq?: (raw: string) => void): number {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f) {
      // Fast path: a run of printable ASCII.
      let j = i + 1;
      while (j < s.length) {
        const d = s.charCodeAt(j);
        if (d < 0x20 || d >= 0x7f) break;
        j++;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (isIntroducer(c)) {
      const end = sequenceEnd(s, i);
      if (end === INCOMPLETE) break;
      if (end === JUNK) {
        i++;
        continue;
      }
      if (seq) {
        if (out !== '') text(out);
        out = '';
        seq(s.slice(i, end));
      }
      i = end;
      continue;
    }
    if (c === 0x0a || c === 0x2028 || c === 0x2029) out += '\n';
    else if (c === 0x09) out += '  ';
    else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
      // other C0 controls, DEL, C1: dropped
    } else if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) break;
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        if (!(warp && c === 0xd83c && lo >= 0xdffb && lo <= 0xdfff)) out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      // a lone high surrogate: dropped
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // a lone low surrogate: dropped
    } else if (!(warp && warpDrops(c))) {
      out += s[i];
    }
    i++;
  }
  if (out !== '') text(out);
  return i;
}

/** The whole text, clean (T-10). */
export function sanitize(text: string, o: SanitizeOptions): string {
  let out = '';
  walk(text, o.warp, (t) => {
    out += t;
  });
  return out;
}

export interface Sanitizer {
  /** Clean text for this delta; an unfinished sequence or surrogate pair at its end waits for the next one. */
  push(delta: string): string;
  /** The stream ended: whatever is still held is incomplete and dropped. Returns ''. */
  end(): string;
}

/** The stream form of sanitize(): concatenating every push() and end() equals sanitize() of the whole. */
export function createSanitizer(o: SanitizeOptions): Sanitizer {
  let held = '';
  return {
    push(delta: string): string {
      const s = held + delta;
      let out = '';
      const stop = walk(s, o.warp, (t) => {
        out += t;
      });
      held = s.slice(stop);
      return out;
    },
    end(): string {
      held = '';
      return '';
    },
  };
}

// ---- speaker labels in columns ----------------------------------------------------------------------

/** The widest a speaker label gets (as the REPL's labels()). */
const LABEL_MAX = 16;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Pads `s` with spaces to `width` terminal columns. */
function padColumns(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - Bun.stringWidth(s)));
}

/**
 * The speaker labels as the TUI shows them: the REPL's labels() (repl-render.ts), but the name is
 * sanitised (a card file's string, T-10), and padding and cutting count terminal columns, cutting
 * whole graphemes (a cut never splits a surrogate pair or an emoji sequence). For an ASCII name the
 * result equals labels(). `width` is in columns.
 */
export function displayLabels(charName: string, o: SanitizeOptions): Names {
  const clean = sanitize(charName, o).replace(/\s+/g, ' ').trim();
  const name = clean === '' ? 'them' : clean;
  const cols = Bun.stringWidth(name);
  const width = Math.min(Math.max(cols, Bun.stringWidth(USER_LABEL)), LABEL_MAX);
  let cut = name;
  if (cols > width) {
    cut = '';
    let w = 0;
    for (const { segment } of graphemes.segment(name)) {
      const sw = Bun.stringWidth(segment);
      if (w + sw > width - 1) break;
      cut += segment;
      w += sw;
    }
    cut += '…';
  }
  return { char: padColumns(cut, width), user: padColumns(USER_LABEL, width), width };
}
