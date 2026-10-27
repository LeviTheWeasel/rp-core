// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The chat transcript (T-7) on the host's ScrollBox: an append-only log with REPL semantics. Cards
// (`Name › ` + the prose-styled text, reasoning folded), the Repl's own rows (system lines, the
// player's echo, status lines) from its SGR strings, and one live card per turn (turn-view.ts).
// Every entry is one TextRenderable holding one StyledText. Performance (opentui.md §6): the
// newest LAYOUT.liveCards entries keep their renderables; older ones fold, ARCHIVE_BLOCK at a time,
// into archive TextRenderables of one StyledText each, so a frame's cost stays flat however long
// the story gets. Opening a session (T-16) builds the newest LAYOUT.liveCards entries and at most
// HISTORY_BATCH messages before them; older history is not built at all until Ctrl+Home asks for it
// (a dim row at the top counts it), so a long campaign opens fast and small. A card's finish /
// hidden / edited markers show once: in its status row when it has one, else before its text (T-15).
// A live turn's deltas reach the native text buffer once per frame (TurnHost.defer, T-16).
// OpenTUI's own selection (a drag while the mouse is on) is readable on every transcript renderable:
// the palette's bright black under the terminal's default foreground (T-17).

import { StyledText, TextAttributes, TextRenderable, type TextChunk } from '@opentui/core';
import type { Event } from '../../protocol/events.ts';
import type { MessageView } from '../../session/view.ts';
import type { TurnOptions, TurnView } from '../repl-view.ts';
import { selectionColours } from './app.ts';
import { appendChunks, chunk, sgrToChunks } from './sgr.ts';
import { cardMarkers, createTurnView, messageChunks, type CardLook, type Entry, type TurnHost } from './turn-view.ts';
import { LAYOUT, type Names, type Theme, type TranscriptApi, type Ui } from './types.ts';

/** Entries folded into one archive block. */
export const ARCHIVE_BLOCK = 50;
/** Messages built into archive blocks on open beyond the mounted ones, and per Ctrl+Home after that (T-16). */
export const HISTORY_BATCH = 300;

/**
 * OpenTUI's selection colours for a transcript renderable (T-17): the host's one definition in
 * app.ts (palette 8 under the default foreground, NO_COLOR included), re-exported for the chat's
 * modules and tests.
 */
export { selectionColours };

export interface TranscriptOptions {
  /** TERM_PROGRAM=WarpTerminal: the sanitiser also drops ZWJ / VS16 / skin tones (T-10). */
  warp: boolean;
  /** /think: reasoning blocks of finished cards shown instead of folded (default: folded). */
  showReasoning?: () => boolean;
}

type NewEntry = { kind: 'card' | 'row'; chunks: TextChunk[]; gap?: boolean; id?: string; live?: boolean };
type StatusOf = (m: MessageView) => string | null;

class Transcript implements TranscriptApi, TurnHost {
  private readonly entries: Entry[] = [];
  /** Archive blocks, top to bottom; `gap`: the block's first entry wants a blank line above it. */
  private readonly archives: { node: TextRenderable; gap: boolean }[] = [];
  private newestCard: Entry | null = null;
  /** The opened path's oldest messages, path[0, end), not built yet: Ctrl+Home builds them a batch at a time. */
  private older: { path: readonly MessageView[]; end: number; names: Names; statusOf: StatusOf } | null = null;
  /** The dim row at the very top that counts them. */
  private more: TextRenderable | null = null;
  /** Live entries to redraw at the next frame (TurnHost.defer). */
  private readonly pending = new Map<Entry, () => TextChunk[]>();

  constructor(
    private readonly ui: Ui,
    readonly theme: Theme,
    private readonly o: TranscriptOptions,
  ) {
    ui.renderer.setFrameCallback(async () => this.flush());
  }

  get warp(): boolean {
    return this.o.warp;
  }

  // ---- TranscriptApi ------------------------------------------------------------------------------

  showPath(path: readonly MessageView[], names: Names, statusOf: StatusOf): void {
    this.clear();
    const look = this.look();
    // The newest messages, up to LAYOUT.liveCards entries, get renderables of their own…
    const tail: Entry[] = [];
    let i = path.length;
    while (i > 0 && tail.length < LAYOUT.liveCards) tail.unshift(...this.built(path[--i]!, names, statusOf, look));
    // …at most HISTORY_BATCH messages before them go straight into archive blocks; older ones wait.
    const from = Math.max(0, i - HISTORY_BATCH);
    if (from > 0) {
      this.older = { path, end: from, names, statusOf };
      this.showMore();
    }
    const history: Entry[] = [];
    for (let k = from; k < i; k++) history.push(...this.built(path[k]!, names, statusOf, look));
    for (let k = 0; k < history.length; k += ARCHIVE_BLOCK) this.archive(history.slice(k, k + ARCHIVE_BLOCK));
    for (const e of tail) this.mount(e);
    this.newestCard = [...tail].reverse().find((e) => e.kind === 'card') ?? null;
  }

  card(m: MessageView, names: Names): void {
    const label = this.label(m, names);
    const look = this.look();
    const e = this.append({ kind: 'card', chunks: messageChunks(m, label, look), gap: true, id: m.id });
    // A status row may follow (view.message): it says the markers, the card then drops them.
    if (cardMarkers(m).length > 0) e.bare = () => messageChunks(m, label, { ...look, markers: false });
  }

  system(sgr: string): void {
    this.append({ kind: 'row', chunks: this.sgr(sgr) });
  }

  echo(sgr: string): void {
    const chunks = this.sgr(sgr);
    // The leading bold label is the player's name: the player's colour.
    const head = chunks[0];
    if (head && ((head.attributes ?? 0) & TextAttributes.BOLD) !== 0) {
      chunks[0] = chunk(head.text, this.theme, { bold: true, fg: this.theme.user });
    }
    this.append({ kind: 'row', chunks, gap: true });
  }

  /**
   * The status row of the newest card: a new row under it, or the same row again when nothing came
   * after it. The card's markers move into it (T-15). After a continue, the card the continue's
   * block continued shows the whole answer again, so its own status row says the same.
   */
  status(sgr: string): void {
    const chunks = this.sgr(sgr);
    const card = this.lastCard();
    const origin = card?.origin?.status;
    if (origin?.node) this.set(origin, [...chunks]);
    if (card?.status?.node && this.isLast(card.status)) {
      this.set(card.status, chunks);
      return;
    }
    const row = this.append({ kind: 'row', chunks });
    if (!card) return;
    if (card.bare && card.node) this.set(card, card.bare());
    delete card.bare;
    card.status = row;
  }

  turn(o: TurnOptions & { names: Names; onEvent?: (ev: Event) => void }): TurnView {
    return createTurnView(this, o);
  }

  scroll(how: 'pageUp' | 'pageDown' | 'top' | 'bottom'): void {
    const box = this.ui.transcript;
    const page = Math.max(1, box.viewport.height - 2);
    if (how === 'pageUp') box.scrollBy(-page);
    else if (how === 'pageDown') box.scrollBy(page);
    else if (how === 'top') {
      // Ctrl+Home: older history not built yet comes in first, a batch at a time (T-16).
      this.loadOlder();
      box.scrollTo(0);
    } else box.scrollTo(box.scrollHeight);
  }

  lastCardId(): string | null {
    return this.newestCard?.id ?? null;
  }

  // ---- TurnHost ----------------------------------------------------------------------------------------

  append(n: NewEntry): Entry {
    const e = this.entry(n);
    this.mount(e);
    if (e.kind === 'card') this.newestCard = e;
    this.fold();
    return e;
  }

  set(e: Entry, chunks: TextChunk[]): void {
    this.pending.delete(e);
    this.apply(e, chunks);
  }

  defer(e: Entry, build: () => TextChunk[]): void {
    this.pending.set(e, build);
    this.ui.renderer.requestRender();
  }

  remove(e: Entry): void {
    this.pending.delete(e);
    const i = this.entries.indexOf(e);
    if (i >= 0) this.entries.splice(i, 1);
    if (e.node) {
      this.ui.transcript.remove(e.node);
      e.node.destroy();
      e.node = null;
    }
    if (this.newestCard === e) this.newestCard = [...this.entries].reverse().find((x) => x.kind === 'card') ?? null;
    for (const x of this.entries) if (x.status === e) delete x.status;
  }

  toEnd(e: Entry): void {
    const i = this.entries.indexOf(e);
    if (i < 0 || !e.node || i === this.entries.length - 1) return;
    this.entries.splice(i, 1);
    this.entries.push(e);
    this.ui.transcript.remove(e.node);
    e.node.marginTop = e.gap ? 1 : 0;
    this.ui.transcript.add(e.node);
  }

  lastCard(): Entry | null {
    return this.newestCard?.node ? this.newestCard : null;
  }

  isLast(e: Entry): boolean {
    return this.entries[this.entries.length - 1] === e;
  }

  release(e: Entry): void {
    this.flushOne(e);
    e.live = false;
    this.fold();
  }

  // ---- deferred redraws -------------------------------------------------------------------------------

  private apply(e: Entry, chunks: TextChunk[]): void {
    e.chunks = chunks;
    if (e.node) e.node.content = new StyledText(chunks);
  }

  private flushOne(e: Entry): void {
    const build = this.pending.get(e);
    if (!build) return;
    this.pending.delete(e);
    this.apply(e, build());
  }

  /** Before a frame: every deferred redraw, once. Never throws (it runs inside OpenTUI's frame loop). */
  private flush(): void {
    if (this.pending.size === 0) return;
    const jobs = [...this.pending];
    this.pending.clear();
    for (const [e, build] of jobs) {
      try {
        this.apply(e, build());
      } catch {
        // A turn's state that cannot be drawn: the next delta or the turn's end draws it again.
      }
    }
  }

  // ---- entries, renderables, archive -------------------------------------------------------------------

  private entry(n: NewEntry): Entry {
    const e: Entry = { kind: n.kind, chunks: n.chunks, gap: n.gap ?? false, live: n.live ?? false, node: null };
    if (n.id !== undefined) e.id = n.id;
    return e;
  }

  /** A message as entries: its card, and its status row when `statusOf` gives one (the card then without markers). */
  private built(m: MessageView, names: Names, statusOf: StatusOf, look: CardLook): Entry[] {
    const st = statusOf(m);
    const card = this.entry({ kind: 'card', chunks: messageChunks(m, this.label(m, names), { ...look, markers: st === null }), gap: true, id: m.id });
    if (st === null) return [card];
    card.status = this.entry({ kind: 'row', chunks: this.sgr(st) });
    return [card, card.status];
  }

  /** Whether anything is drawn above the mounted entries. */
  private get above(): boolean {
    return this.entries.length > 0 || this.archives.length > 0 || this.more !== null;
  }

  private mount(e: Entry): void {
    // The gap is drawn only when something is above (never a blank first line).
    e.node = new TextRenderable(this.ui.renderer, {
      content: new StyledText(e.chunks),
      fg: this.theme.text,
      ...selectionColours(this.theme),
      wrapMode: 'word',
      flexShrink: 0,
      marginTop: e.gap && this.above ? 1 : 0,
    });
    this.ui.transcript.add(e.node);
    this.entries.push(e);
  }

  /** Fold the oldest entries into archive blocks while more than LAYOUT.liveCards + a block are mounted. */
  private fold(): void {
    while (this.entries.length >= LAYOUT.liveCards + ARCHIVE_BLOCK) {
      const block: Entry[] = [];
      for (const e of this.entries) {
        if (e.live || block.length === ARCHIVE_BLOCK) break;
        block.push(e);
      }
      if (block.length < ARCHIVE_BLOCK) return;
      this.entries.splice(0, block.length);
      for (const e of block) {
        this.flushOne(e);
        if (e.node) {
          this.ui.transcript.remove(e.node);
          e.node.destroy();
          e.node = null;
        }
      }
      this.archive(block);
    }
  }

  /** One archive block at position `at` among the archive blocks (default: after them): the entries' chunks in one StyledText. */
  private archive(block: readonly Entry[], at = this.archives.length): void {
    if (block.length === 0) return;
    const chunks: TextChunk[] = [];
    block.forEach((e, i) => {
      if (i > 0) appendChunks(chunks, [chunk(e.gap ? '\n\n' : '\n', this.theme)]);
      appendChunks(chunks, e.chunks);
      e.node = null;
    });
    const gap = block[0]!.gap;
    const node = new TextRenderable(this.ui.renderer, {
      content: new StyledText(chunks),
      fg: this.theme.text,
      ...selectionColours(this.theme),
      wrapMode: 'word',
      flexShrink: 0,
      marginTop: gap && (at > 0 || this.more !== null) ? 1 : 0,
    });
    this.ui.transcript.add(node, (this.more ? 1 : 0) + at);
    this.archives.splice(at, 0, { node, gap });
    // The block that was under it now has something above it.
    const next = this.archives[at + 1];
    if (next) next.node.marginTop = next.gap ? 1 : 0;
  }

  /** Ctrl+Home: the next HISTORY_BATCH older messages into archive blocks at the top. */
  private loadOlder(): void {
    const o = this.older;
    if (!o) return;
    const from = Math.max(0, o.end - HISTORY_BATCH);
    const look = this.look();
    const built: Entry[] = [];
    for (let k = from; k < o.end; k++) built.push(...this.built(o.path[k]!, o.names, o.statusOf, look));
    o.end = from;
    let at = 0;
    for (let k = 0; k < built.length; k += ARCHIVE_BLOCK) this.archive(built.slice(k, k + ARCHIVE_BLOCK), at++);
    if (from === 0) this.older = null;
    this.showMore();
  }

  /** The dim row at the top that counts the history not built yet (removed once it is all built). */
  private showMore(): void {
    const n = this.older?.end ?? 0;
    if (n === 0) {
      if (!this.more) return;
      this.ui.transcript.remove(this.more);
      this.more.destroy();
      this.more = null;
      // Whatever is now first is at the very top: no blank line above it.
      const first = this.archives[0]?.node ?? this.entries[0]?.node;
      if (first) first.marginTop = 0;
      return;
    }
    const content = new StyledText([chunk(`⋯ ${n} earlier message${n === 1 ? '' : 's'} · Ctrl+Home loads more`, this.theme, { dim: true })]);
    if (this.more) {
      this.more.content = content;
      return;
    }
    this.more = new TextRenderable(this.ui.renderer, { content, fg: this.theme.text, ...selectionColours(this.theme), wrapMode: 'word', flexShrink: 0 });
    this.ui.transcript.add(this.more, 0);
  }

  private clear(): void {
    this.pending.clear();
    for (const e of this.entries) {
      if (e.node) {
        this.ui.transcript.remove(e.node);
        e.node.destroy();
        e.node = null;
      }
    }
    for (const a of this.archives) {
      this.ui.transcript.remove(a.node);
      a.node.destroy();
    }
    if (this.more) {
      this.ui.transcript.remove(this.more);
      this.more.destroy();
      this.more = null;
    }
    this.entries.length = 0;
    this.archives.length = 0;
    this.older = null;
    this.newestCard = null;
  }

  private look(): CardLook {
    return { theme: this.theme, warp: this.o.warp, showReasoning: this.o.showReasoning?.() ?? false };
  }

  private label(m: MessageView, names: Names): string {
    return m.role === 'user' ? names.user : names.char;
  }

  private sgr(s: string): TextChunk[] {
    return sgrToChunks(s, this.theme, { warp: this.o.warp });
  }
}

/** The chat transcript on `ui.transcript` (a sticky ScrollBox the host built). */
export function createTranscript(ui: Ui, theme: Theme, o: TranscriptOptions): TranscriptApi {
  return new Transcript(ui, theme, o);
}
