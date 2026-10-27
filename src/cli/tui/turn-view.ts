// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The TUI's streaming TurnView (T-7) and the card builders the transcript shares with it. A turn is
// a live card that mirrors repl-render.ts TurnPrinter: the `Name › ` header on the first text,
// reasoning folded to `⋯ thinking (N chars)` unless shown, one dim side line per tool / director /
// agent / memory / retry event, a dim [stopped], a red failure and a yellow conflict row. Text and
// reasoning deltas go through applyDelta (a gap is resynced from `done`), the stream sanitiser, the
// prose styler and the SGR reader. interject() closes the open text: what streams after the Repl's
// own row goes to a continuation entry under it, indented like the REPL. The prose state (inside
// *…*, inside quotes) runs over the whole answer, as a card of the stored text styles it: a Repl row
// or a side line mid-answer does not reset it (T-15). A continue is a new block after the `/c` row,
// `Name › …last words` and the addition, styled from the prose state of the text before it; on done
// the card it continues (when still mounted) is repainted from the committed message (T-15). The
// finish / edited / hidden markers are not drawn on a live card: the status line under it says them.
// Streaming deltas update the card once per frame (TurnHost.defer), not once per delta (T-16).
// The chat renders the REPL's prose styling as markdown does: `**bold**` bold (T-17) and an
// `*action*` italic (polish2), without their asterisks; a `*` that marks nothing stays drawn
// (createChatStyler); the line REPL keeps its own styler unchanged. A stopped answer's status line
// says `stopped`: no `[stopped]` row repeats it (T-17).

import type { TextChunk, TextRenderable } from '@opentui/core';
import { applyDelta, type Event, type Notice } from '../../protocol/events.ts';
import type { MessageView } from '../../session/view.ts';
import { markers, messageText } from '../render.ts';
import { CLOSE_QUOTES, lastWords, OPEN_QUOTES, SGR, sideLine, stripAnsi, type ProseStyler } from '../repl-render.ts';
import type { TurnOptions, TurnView } from '../repl-view.ts';
import { createSanitizer, sanitize, type Sanitizer } from './sanitize.ts';
import { appendChunks, chunk, createSgrReader, type SgrReader } from './sgr.ts';
import type { Names, Theme } from './types.ts';

// ---- the transcript's entries (implemented by transcript.ts) ----------------------------------------

/** One item of the transcript: a card (a message) or a row (system, echo, status, a turn's continuation). */
export interface Entry {
  readonly kind: 'card' | 'row';
  chunks: TextChunk[];
  /** A blank line before it (cards and the player's lines), drawn when something is above it. */
  gap: boolean;
  /** Cards: the message id. */
  id?: string;
  /** Cards: the status row under it. */
  status?: Entry;
  /** A turn still writes to it: never archived. */
  live: boolean;
  /** Its renderable; null once archived or removed. */
  node: TextRenderable | null;
  /** Cards: the card without its markers, drawn once a status row (which says them) joins it (T-15). */
  bare?: () => TextChunk[];
  /** A continue's block: the card it continued, repainted from the committed message; its status row follows this one's. */
  origin?: Entry;
}

/** What a turn needs from the transcript. */
export interface TurnHost {
  readonly theme: Theme;
  readonly warp: boolean;
  append(e: { kind: 'card' | 'row'; chunks: TextChunk[]; gap?: boolean; id?: string; live?: boolean }): Entry;
  /** New content for an entry (an archived one is left as it is). */
  set(e: Entry, chunks: TextChunk[]): void;
  /**
   * New content for a live entry at the next frame: `build` runs once before the frame is drawn,
   * however many times defer() was called for the entry since (streaming deltas, T-16).
   */
  defer(e: Entry, build: () => TextChunk[]): void;
  remove(e: Entry): void;
  /** Move an entry to the end of the transcript. */
  toEnd(e: Entry): void;
  /** The newest card, while it still has its own renderable. */
  lastCard(): Entry | null;
  isLast(e: Entry): boolean;
  /** The turn no longer writes to it. */
  release(e: Entry): void;
}

// ---- the chat's prose styler: the REPL's look, rendered as markdown --------------------------------------

/**
 * The TUI's prose styler: the REPL's look (*actions* italic, speech plain) with the asterisks that
 * mark it dropped, and markdown `**bold**` (T-17, polish2).
 */
export interface ChatStyler extends ProseStyler {
  /**
   * The text pauses here (a side line follows): the asterisks held back, which the next character
   * would have told apart, are decided as if no text followed.
   */
  flush(): string;
  /**
   * The text a continue's addition follows: its styled output (for the reader's state; already on
   * screen), after which the asterisks it still holds back count as shown: their styles still apply
   * when the addition decides them, but they are not drawn again.
   */
  seed(before: string): string;
}

const BOLD_ON = SGR.boldOn;
/** SGR 22 also ends dim, which prose text never carries. */
const BOLD_OFF = SGR.intensityOff;
const blank = (c: string): boolean => c === '' || /\s/u.test(c);
const wordChar = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);

/**
 * The chat's styling, as rendered markdown: an `*action*` is italic without its asterisks, `**bold**`
 * bold without its asterisks; speech ("…", “…”, «…») inside an action is plain again, as in the
 * REPL, and `*emphasis*` inside speech is italic. What marks a span: a `*` opens one before a
 * non-blank character, unless a letter or digit is right before it (`f*ck`, `5*3`), and closes the
 * open one after a non-blank character, unless a letter or digit follows it. Any other `*` is a
 * literal asterisk, drawn and toggling nothing (`5 * 3`, `* item`, a lone `*` at the end). A run of
 * asterisks is held back until the character after it arrives (streaming: a `*` or `**` split across
 * deltas), then: `**` opens bold before a non-blank character and closes an open bold after one;
 * `***` is a span's `*` plus bold; any other run, or a `**` / `***` that does neither, is literal
 * asterisks. A newline ends whatever is open (one stray marker cannot restyle the rest of the
 * answer); the end of speech ends its emphasis. Any split of the text into push()es gives the same
 * output as one push() (+ end()). The line REPL keeps its own styler (asterisks shown).
 */
export function createChatStyler(): ChatStyler {
  /** An action (outside speech), speech, emphasis inside speech, bold. */
  let act = false;
  let quote = false;
  let emph = false;
  let bold = false;
  /** Asterisks held back (one run) and how many of them a seed already showed. */
  let run = 0;
  let shown = 0;
  /** The character before the held run, or the last one passed. */
  let prev = '';

  /** The italic span of where the text is: the action, or the emphasis in speech. */
  const italic = (): boolean => (quote ? emph : act);

  /** A span's `*` between `before` and `after`: the SGR of the span it opens or closes, or null (a literal). */
  const marker = (before: string, after: string): string | null => {
    const open = italic();
    if (open ? blank(before) || wordChar(after) : blank(after) || wordChar(before)) return null;
    if (quote) emph = !open;
    else act = !open;
    return open ? SGR.italicOff : SGR.italicOn;
  };

  /** The held run, now that `next` (the character after it, '' when none follows) is known. */
  const settle = (next: string): string => {
    const n = run;
    const hidden = shown;
    run = 0;
    shown = 0;
    if (n === 0) return '';
    let ops: ('*' | 'b' | 'lit')[];
    if ((n === 2 || n === 3) && bold && !blank(prev)) ops = n === 2 ? ['b'] : ['b', '*'];
    else if ((n === 2 || n === 3) && !bold && !blank(next)) ops = n === 2 ? ['b'] : ['*', 'b'];
    else if (n === 1) ops = ['*'];
    else ops = Array.from({ length: n }, () => 'lit' as const);
    let out = '';
    let at = 0;
    for (const op of ops) {
      if (op === 'b') {
        bold = !bold;
        out += bold ? BOLD_ON : BOLD_OFF;
        at += 2;
        continue;
      }
      const sgr = op === '*' ? marker(prev, next) : null;
      // A literal asterisk is drawn, unless the seed showed it already; a marker only restyles.
      if (sgr !== null) out += sgr;
      else if (at >= hidden) out += '*';
      at += 1;
    }
    prev = '*';
    return out;
  };

  /** One character that is not an asterisk. */
  const char = (ch: string): string => {
    let out = '';
    if (ch === '\n') {
      if (bold) out += BOLD_OFF;
      if (italic()) out += SGR.italicOff;
      bold = act = quote = emph = false;
    } else if ((ch === '"' && !quote) || OPEN_QUOTES.has(ch)) {
      // Speech inside an action is plain (its quotes too).
      if (!quote && act) out += SGR.italicOff;
      quote = true;
    } else if ((ch === '"' && quote) || CLOSE_QUOTES.has(ch)) {
      if (quote && emph) out += SGR.italicOff;
      emph = false;
      out += ch;
      if (quote && act) out += SGR.italicOn;
      quote = false;
      prev = ch;
      return out;
    }
    prev = ch;
    return out + ch;
  };

  const push = (delta: string): string => {
    let out = '';
    for (const ch of delta) {
      if (ch === '*') {
        run++;
        continue;
      }
      if (run > 0) out += settle(ch);
      out += char(ch);
    }
    return out;
  };

  return {
    push,
    flush: () => settle(''),
    seed(before: string): string {
      const out = push(before);
      shown = run;
      return out;
    },
    end(): string {
      let out = settle('');
      if (bold) out += BOLD_OFF;
      if (italic()) out += SGR.italicOff;
      bold = act = quote = emph = false;
      prev = '';
      return out;
    },
  };
}

/** What a text shows once styled (the asterisks of bold and italic dropped), as plain text. */
export function visibleText(text: string): string {
  const s = createChatStyler();
  return stripAnsi(s.push(text) + s.end());
}

// ---- card builders ------------------------------------------------------------------------------------

export interface CardLook {
  theme: Theme;
  warp: boolean;
  /** /think show: reasoning blocks shown dimmed instead of folded. */
  showReasoning: boolean;
  /** The finish / hidden / edited markers before the text (default true); false when a status line says them (T-15). */
  markers?: boolean;
}

/** `Name › `: the label (a card file's string: sanitised) bold in the speaker's colour. */
export function headerChunks(label: string, role: 'user' | 'assistant', theme: Theme, warp = false): TextChunk[] {
  return [chunk(sanitize(label, { warp }).replace(/\n/g, ' '), theme, { bold: true, fg: role === 'user' ? theme.user : theme.char }), chunk(' › ', theme)];
}

/**
 * A text as the story shows it: sanitised, *actions* italic. `before`: the text it continues (a
 * continue's addition), whose prose state (inside *…*, inside quotes) the addition starts in.
 */
export function proseChunks(text: string, theme: Theme, warp: boolean, before?: string): TextChunk[] {
  const styler = createChatStyler();
  const reader = createSgrReader(theme);
  if (before !== undefined) reader.push(styler.seed(sanitize(before, { warp })));
  return reader.push(styler.push(sanitize(text, { warp })) + styler.end());
}

const dim = (text: string, theme: Theme): TextChunk => chunk(text, theme, { dim: true });

/** A reasoning block: folded to one line, or shown dimmed and indented. */
export function reasoningChunks(text: string, show: boolean, theme: Theme, warp: boolean): TextChunk[] {
  if (!show) return [dim(`  ⋯ thinking (${text.length} chars)`, theme)];
  return [dim(`  ⋯ ${sanitize(text, { warp }).replace(/\n/g, '\n    ')}`, theme)];
}

/** The markers a card shows before its text (markers() without `[reasoning]`: the reasoning lines say that). */
export function cardMarkers(m: MessageView): string[] {
  return markers(m).filter((x) => x !== '[reasoning]');
}

/** A finished message as a card: its reasoning lines, then `Name › ` [markers] and the text. */
export function messageChunks(m: MessageView, label: string, look: CardLook): TextChunk[] {
  const { theme, warp } = look;
  const out: TextChunk[] = [];
  for (const b of m.blocks) {
    if (b.k !== 'reasoning') continue;
    appendChunks(out, reasoningChunks(b.text, look.showReasoning, theme, warp));
    appendChunks(out, [chunk('\n', theme)]);
  }
  appendChunks(out, headerChunks(label, m.role, theme, warp));
  const marks = look.markers === false ? [] : cardMarkers(m);
  if (marks.length > 0) appendChunks(out, [dim(`${marks.join(' ')} `, theme)]);
  const text = messageText(m);
  appendChunks(out, text.trim() === '' ? [dim('(no text)', theme)] : proseChunks(text, theme, warp));
  return out;
}

// ---- the live turn -----------------------------------------------------------------------------------

interface Part {
  /** Starts on a line of its own (else it continues the line before it). */
  nl: boolean;
  chunks: TextChunk[];
}

/** One entry the turn writes: the card, or a continuation row after an interjection. */
interface Seg {
  entry: Entry;
  parts: Part[];
}

export type TurnViewOptions = TurnOptions & { names: Names; onEvent?: (ev: Event) => void };

class LiveTurn implements TurnView {
  private readonly theme: Theme;
  private readonly prose: ChatStyler = createChatStyler();
  private readonly reader: SgrReader;
  private readonly clean: Sanitizer;
  private card: Seg | null = null;
  private cur: Seg | null = null;
  private readonly segs: Seg[] = [];
  /** interject(): the next output goes under whatever the Repl showed. */
  private detached = false;
  /** A continue: the card it continues (the newest card of that message, when still mounted). */
  private origin: Entry | null = null;
  private kind: string | null = null;
  private textPart: Part | null = null;
  private textSeg: Seg | null = null;
  private prefixed = false;
  private streamed = false;
  private afterSide = false;
  private reasoning: { show: boolean; chars: number; part: Part; clean: Sanitizer; seg: Seg } | null = null;
  /** The turn's text as the deltas built it (applyDelta), and whether it can no longer be trusted. */
  private raw = '';
  private rawReasoning = '';
  private resync = false;
  private kept_ = false;
  private finished = false;

  constructor(
    private readonly host: TurnHost,
    private readonly o: TurnViewOptions,
  ) {
    this.theme = host.theme;
    this.reader = createSgrReader(host.theme);
    this.clean = createSanitizer({ warp: host.warp });
  }

  get kept(): boolean {
    return this.kept_;
  }

  push(ev: Event): void {
    this.o.onEvent?.(ev);
    switch (ev.type) {
      case 'start':
        this.start(ev.kind, ev.messageId);
        return;
      case 'reasoning':
        this.onReasoning(ev);
        return;
      case 'text':
        this.onText(ev);
        return;
      case 'changed':
        if (ev.change === 'msg' || ev.change === 'edit') this.kept_ = true;
        return;
      case 'notice':
        this.endReasoning();
        this.closeText();
        this.o.notice({ level: ev.level, code: ev.code, message: ev.message } satisfies Notice);
        return;
      case 'done':
        this.endReasoning();
        this.endText();
        this.finalise(ev.message);
        return;
      case 'stopped':
        this.endReasoning();
        this.endText();
        if (ev.message) this.finalise(ev.message);
        // One stop marker (T-17): the status line under a kept answer says `stopped` already.
        if (ev.message?.gen?.finish !== 'stopped') this.row([this.dim(ev.message ? '[stopped]' : '[stopped] nothing had arrived; nothing was kept')]);
        return;
      case 'failed':
        this.endReasoning();
        this.endText();
        this.row([
          chunk(`✗ the answer failed (${ev.category}/${ev.code}): ${sanitize(ev.message, { warp: this.host.warp })}`, this.theme, {
            fg: this.theme.red,
          }),
        ]);
        if (this.kept_) this.row([this.dim('  the partial answer was kept, marked [interrupted]')]);
        return;
      case 'conflict': {
        this.endReasoning();
        this.endText();
        this.row([chunk('! the session changed during the turn; the answer was not committed', this.theme, { fg: this.theme.yellow })]);
        const draft = sanitize(ev.draft, { warp: this.host.warp });
        if (draft.trim() !== '' && ev.draft !== this.raw) this.row([this.dim(`  draft: ${draft}`)]);
        return;
      }
      default: {
        const side = sideLine(ev);
        if (side === null) return;
        this.endReasoning();
        if (this.prefixed) this.afterSide = true;
        // Asterisks held back for the next character go out before the side line, as the text's end.
        this.emitHeld(this.prose.flush());
        this.closeText();
        const seg = this.segment();
        seg.parts.push({ nl: true, chunks: [this.dim(`  ${sanitize(side, { warp: this.host.warp })}`)] });
        this.render(seg);
      }
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.endReasoning();
    this.endText();
    this.clean.end();
    const card = this.card;
    if (card && card.parts.length === 0) {
      // Nothing arrived (a failure before output, a stop with nothing kept): no empty card stays.
      this.host.remove(card.entry);
      this.segs.splice(this.segs.indexOf(card), 1);
    }
    for (const s of this.segs) this.host.release(s.entry);
  }

  interject(): void {
    this.endReasoning();
    this.closeText();
    this.detached = true;
  }

  // ---- events -------------------------------------------------------------------------------------

  private start(kind: string, messageId: string): void {
    if (this.card) return;
    this.kind = kind;
    if (kind === 'continue') {
      // The card continued: the newest one of this message (the first card, when that one is itself a continue's block).
      const last = this.host.lastCard();
      if (last && last.id === messageId) this.origin = last.origin?.node ? last.origin : last;
      // The addition starts in the prose state the text before it ends in.
      const before = this.o.continueFrom;
      if (before !== undefined) this.reader.push(this.prose.seed(sanitize(before, { warp: this.host.warp })));
    }
    // Always a block of its own after the `/c` row, as the REPL prints it (T-15): never off-screen.
    const entry = this.host.append({ kind: 'card', chunks: this.placeholder(), gap: true, id: messageId, live: true });
    this.card = { entry, parts: [] };
    this.segs.push(this.card);
    this.cur = this.card;
  }

  private onReasoning(ev: Extract<Event, { type: 'reasoning' }>): void {
    if (ev.delta === '') return;
    // applyDelta: a re-delivered piece adds nothing; after a gap each delta counts as it came.
    let added = ev.delta;
    try {
      const next = applyDelta(this.rawReasoning, ev);
      added = next.startsWith(this.rawReasoning) ? next.slice(this.rawReasoning.length) : '';
      this.rawReasoning = next;
    } catch {
      // The stored message has the real reasoning; only the count is approximate.
    }
    if (added === '') return;
    if (!this.reasoning) {
      this.closeText();
      const show = this.o.showReasoning();
      const seg = this.segment();
      const part: Part = { nl: true, chunks: [this.dim(show ? '  ⋯ ' : '  ⋯ thinking')] };
      seg.parts.push(part);
      this.reasoning = { show, chars: 0, part, clean: createSanitizer({ warp: this.host.warp }), seg };
    }
    const r = this.reasoning;
    r.chars += added.length;
    if (r.show) appendChunks(r.part.chunks, [this.dim(r.clean.push(added).replace(/\n/g, '\n    '))]);
    else r.part.chunks = [this.dim(`  ⋯ thinking (${r.chars} chars)`)];
    this.render(r.seg);
  }

  private onText(ev: Extract<Event, { type: 'text' }>): void {
    if (this.resync) return;
    let next: string;
    try {
      next = applyDelta(this.raw, ev);
    } catch {
      // Text went missing: show nothing more until `done` brings the whole answer.
      this.resync = true;
      return;
    }
    if (!next.startsWith(this.raw)) {
      // A re-delivery rewrote text already shown: `done` repaints the card.
      this.raw = next;
      this.resync = true;
      return;
    }
    let delta = next.slice(this.raw.length);
    this.raw = next;
    // D-55: after a side line the next round's leading "\n" is not shown (the stored answer keeps it);
    // the prose state still sees it, as a card of the stored text does.
    if (this.afterSide && delta.startsWith('\n')) {
      this.reader.push(this.prose.push('\n'));
      delta = delta.slice(1);
    }
    if (delta === '') return;
    this.afterSide = false;
    this.endReasoning();
    this.openText();
    const part = this.textPart;
    const seg = this.textSeg;
    if (!part || !seg) return;
    appendChunks(part.chunks, this.reader.push(this.prose.push(this.clean.push(delta))));
    this.streamed = true;
    this.render(seg);
  }

  // ---- text and reasoning segments --------------------------------------------------------------

  private openText(): void {
    if (this.textPart) return;
    const seg = this.segment();
    const label = this.o.label;
    const chunks: TextChunk[] = [];
    if (!this.prefixed) {
      appendChunks(chunks, headerChunks(label, 'assistant', this.theme, this.host.warp));
      const before = this.o.continueFrom;
      if (before !== undefined && before.trim() !== '') appendChunks(chunks, [this.dim(`…${this.lastWords(before)}`)]);
      this.prefixed = true;
    } else {
      // Under the header's text: as wide as `Name › ` in terminal columns (T-16).
      appendChunks(chunks, [chunk(' '.repeat(Bun.stringWidth(label) + 3), this.theme)]);
    }
    const part: Part = { nl: true, chunks };
    this.textPart = part;
    this.textSeg = seg;
    seg.parts.push(part);
  }

  /** The streamed line stops here (a side line, a Repl row): the prose state carries on (T-15). */
  private closeText(): void {
    this.textPart = null;
  }

  /** The answer's text ended: close whatever style is open (and draw the asterisks still held back). */
  private endText(): void {
    this.emitHeld(this.prose.end());
    this.textPart = null;
  }

  /** Styled output that may carry held-back asterisks: into the open text line (opened again if a row closed it). */
  private emitHeld(styled: string): void {
    const chunks = this.reader.push(styled);
    if (chunks.length === 0) return;
    this.openText();
    const part = this.textPart;
    const seg = this.textSeg;
    if (!part || !seg) return;
    appendChunks(part.chunks, chunks);
    this.render(seg);
  }

  /** The continued text's last words as the chat shows them (sanitised, `**` dropped), and the space it ends with. */
  private lastWords(before: string): string {
    return lastWords(visibleText(sanitize(before, { warp: this.host.warp }))) + (/\s$/.test(before) ? ' ' : '');
  }

  private endReasoning(): void {
    const r = this.reasoning;
    if (!r) return;
    this.reasoning = null;
    if (!r.show) r.part.chunks = [this.dim(`  ⋯ thinking (${r.chars} chars)`)];
    this.render(r.seg);
  }

  /** The entry to write to now: the current one, unless a row of the Repl came after it. */
  private segment(): Seg {
    if (!this.card) this.start(this.kind ?? 'reply', '');
    const cur = this.cur;
    if (cur && (!this.detached || this.host.isLast(cur.entry))) {
      this.detached = false;
      return cur;
    }
    this.detached = false;
    const card = this.card;
    if (card && cur === card && card.parts.length === 0) {
      // The card is still empty: move it under the Repl's row instead of leaving a stub above it.
      this.host.toEnd(card.entry);
      return card;
    }
    const entry = this.host.append({ kind: 'row', chunks: [], gap: false, live: true });
    const seg: Seg = { entry, parts: [] };
    this.segs.push(seg);
    this.cur = seg;
    return seg;
  }

  // ---- finalising -----------------------------------------------------------------------------------

  /**
   * The committed message: keep the streamed card when it shows the same text, else repaint it. The
   * markers are left out: the Repl's status line under the card says them (T-15). A continue's
   * block keeps showing `…last words` and the addition; the card it continued is repainted whole.
   */
  private finalise(m: MessageView): void {
    const card = this.card;
    if (!card) return;
    card.entry.id = m.id;
    const look: CardLook = { theme: this.theme, warp: this.host.warp, showReasoning: this.o.showReasoning(), markers: false };
    const final = messageText(m);
    const before = this.o.continueFrom ?? '';
    let chunks: TextChunk[] | null = null;
    if (this.kind === 'continue') {
      const addition = final.startsWith(before) ? final.slice(before.length) : null;
      if (this.resync || !this.streamed || addition !== this.raw) {
        chunks = headerChunks(this.o.label, 'assistant', this.theme, this.host.warp);
        if (addition !== null && before.trim() !== '') {
          appendChunks(chunks, [this.dim(`…${this.lastWords(before)}`)]);
          appendChunks(chunks, proseChunks(addition, this.theme, this.host.warp, before));
        } else appendChunks(chunks, proseChunks(final, this.theme, this.host.warp));
      }
      const origin = this.origin;
      if (origin?.node) {
        // The card it continued now shows the whole answer; its status row follows this block's (transcript.status).
        this.host.set(origin, messageChunks(m, this.o.label, { ...look, markers: origin.status === undefined }));
        delete origin.bare;
        card.entry.origin = origin;
      }
    } else if (this.resync || !this.streamed || final !== this.raw) {
      chunks = messageChunks(m, this.o.label, look);
    }
    if (!chunks) return;
    // Repaint: the card holds the whole answer; continuation rows of this turn go.
    for (const s of this.segs.splice(0)) if (s !== card) this.host.remove(s.entry);
    this.segs.push(card);
    card.parts = [{ nl: true, chunks }];
    this.cur = card;
    this.render(card);
  }

  // ---- drawing ----------------------------------------------------------------------------------------

  private placeholder(): TextChunk[] {
    return [...headerChunks(this.o.label, 'assistant', this.theme, this.host.warp), this.dim('…')];
  }

  /** Redraw an entry of the turn: at the next frame, once however many deltas arrive before it (T-16). */
  private render(seg: Seg): void {
    this.host.defer(seg.entry, () => this.chunksOf(seg));
  }

  private chunksOf(seg: Seg): TextChunk[] {
    if (seg === this.card && seg.parts.length === 0) return this.placeholder();
    const out: TextChunk[] = [];
    for (const p of seg.parts) {
      if (p.nl && out.length > 0) appendChunks(out, [chunk('\n', this.theme)]);
      appendChunks(out, p.chunks);
    }
    return out;
  }

  private row(chunks: TextChunk[]): void {
    this.host.release(this.host.append({ kind: 'row', chunks, gap: false }));
  }

  private dim(text: string): TextChunk {
    return dim(text, this.theme);
  }
}

/** The streaming view of one turn on the transcript `host`. */
export function createTurnView(host: TurnHost, o: TurnViewOptions): TurnView {
  return new LiveTurn(host, o);
}
