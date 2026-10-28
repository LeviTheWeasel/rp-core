// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The {{recap}} slot in assemble (D-177, D-178, section G): nothing reserved without content (the
// request byte-identical), the message at the trim point (after the greeting when nothing is cut,
// ahead of the gap note), its cost taken from the history (one more trim), a preset's own {{recap}},
// no macro expansion, the arc half and the lite limits, library arcs always eligible, a session arc
// replacing the library arc of its plot, and the block skipping what the slot holds.
import { describe, expect, test } from 'bun:test';
import { BLOCK_HEADER } from '../../src/agents/compendium/place.ts';
import { RECAP_LITE_ARC_CHARS, recapArcText, recapSummaryText } from '../../src/agents/compendium/recap.ts';
import type { CompendiumBlockInput } from '../../src/agents/compendium/types.ts';
import { assemble } from '../../src/prompt/assemble.ts';
import { CHARS_COUNTER, MESSAGE_OVERHEAD_TOKENS } from '../../src/prompt/tokens.ts';
import { HISTORY_TOOLS, toolSpecs } from '../../src/tools/builtin/index.ts';
import { arc, asmIn, chatView, HISTORY_BLOCK, libArc, longChat, ok, preset, recapIn, recapText, srcs, summary, textOf, typed, WINDOW } from './kit.ts';

const CHAT = longChat(20);
const S1 = summary('Fog night', 'The Lantern', ['u1', 'a4']);
const S2 = summary('The door', 'The Lantern', ['u5', 'a8']);
const S3 = summary('Salt', 'Salt Road', ['u9', 'a12']);
const LANTERN = arc('The Lantern', 'A lamp went out and a door opened.', 30);
const SALT = arc('Salt Road', 'Salt on every road.', 40);

const available = WINDOW.window - WINDOW.reserve;
const share = Math.floor(0.1 * WINDOW.window);

describe('no content: nothing reserved, the request byte-identical (G-12)', () => {
  test('an empty Compendium: the request with the slot input equals the one without', () => {
    const view = chatView(CHAT, []);
    const without = ok(assemble(asmIn(view)));
    expect(without.trace.trimmed).toEqual({ from: 'u1', to: 'a4' });
    expect(ok(assemble(asmIn(view, { recap: recapIn() })))).toEqual(without);
  });

  test('summaries and session arcs but nothing cut and no library arc: equal, trace.recap empty', () => {
    const view = chatView(CHAT, [S1, S2, LANTERN]);
    const big = { window: 32768, reserve: 8192 };
    const without = ok(assemble(asmIn(view, big)));
    expect(without.trace.trimmed).toBeNull();
    const withInput = ok(assemble(asmIn(view, { ...big, recap: recapIn() })));
    expect(withInput).toEqual(without);
    expect(withInput.trace.recap).toEqual({ ids: [], arcs: [], boundary: null });
  });

  test('summaries only after the cut: equal', () => {
    const view = chatView(CHAT, [S3, SALT]);
    expect(ok(assemble(asmIn(view, { recap: recapIn() })))).toEqual(ok(assemble(asmIn(view))));
  });

  test('a preset holding {{recap}}: its block is not sent while the slot is empty, the request equals the one without', () => {
    const p = preset([{ id: 'story', role: 'system', enabled: true, content: '{{recap}}', at: 'relative' }, HISTORY_BLOCK]);
    const view = chatView(CHAT, [S3]);
    const without = ok(assemble(asmIn(view, { preset: p })));
    expect(srcs(without)).not.toContain('story');
    expect(ok(assemble(asmIn(view, { preset: p, recap: recapIn() })))).toEqual(without);
  });
});

describe('the slot in the request', () => {
  test('cut: one system message right before the first message after the cut, arcs then summaries, oldest first', () => {
    const view = chatView(CHAT, [S3, S2, S1, LANTERN, SALT]);
    const r = ok(assemble(asmIn(view, { recap: recapIn() })));
    expect(r.trace.trimmed).toEqual({ from: 'u1', to: 'a4' });
    const at = srcs(r).indexOf('recap');
    const recap = r.messages[at]!;
    expect(recap.role).toBe('system');
    expect(recap.placement).toBe('inline');
    // The greeting, the slot, then u5 (the first message sent after the cut).
    expect(textOf(r.messages[at - 1]!)).toBe('Hello, traveller.');
    expect(textOf(r.messages[at + 1]!)).toStartWith('u5: ');
    expect(recapText(r)).toBe([recapArcText('The Lantern', 'A lamp went out and a door opened.'), recapSummaryText('Fog night', 'Fog night happened.')].join('\n\n'));
    expect(r.trace.recap).toEqual({ ids: ['summary:a4.0'], arcs: [{ key: 'arc:the lantern', rev: 30 }], boundary: 'u5', profile: 'full', share: 160 });
    expect(r.trace.blocks[at]).toEqual({ src: 'recap', role: 'system', tok: CHARS_COUNTER.count(recapText(r)!) + MESSAGE_OVERHEAD_TOKENS });
    expect(r.trace.tokens.estimated).toBeLessThanOrEqual(available);
  });

  test('nothing cut: a library arc (always eligible) right after the greeting; the boundary is the greeting', () => {
    const view = chatView(longChat(2), [libArc('book', 'a1', 'Old War', 'The old war is not over.')]);
    const r = ok(assemble(asmIn(view, { recap: recapIn() })));
    expect(r.trace.trimmed).toBeNull();
    expect(srcs(r).slice(srcs(r).indexOf('recap') - 1, srcs(r).indexOf('recap') + 2)).toEqual(['history', 'recap', 'history']);
    expect(textOf(r.messages[srcs(r).indexOf('recap') - 1]!)).toBe('Hello, traveller.');
    expect(recapText(r)).toBe(recapArcText('Old War', 'The old war is not over.'));
    expect(r.trace.recap).toEqual({ ids: [], arcs: [{ key: 'lib:book:a1', rev: 0 }], boundary: 'g', profile: 'full', share: 160 });
  });

  test('with the history tools and a cut: the slot, then the gap note, then the first message after the cut', () => {
    // The tools' instructions take ~1 100 tokens and their room a quarter: a larger window, a longer chat.
    const view = chatView(longChat(60), [S1, S2, LANTERN]);
    const r = ok(assemble(asmIn(view, { window: 6000, reserve: 1000, recap: recapIn(), tools: toolSpecs(HISTORY_TOOLS()) })));
    expect(r.tools.map((t) => t.name).sort()).toEqual(['read_history', 'search_history']);
    expect(r.trace.trimmed).not.toBeNull();
    const at = srcs(r).indexOf('recap');
    expect(srcs(r)[at + 1]).toBe('core:gap');
    expect(srcs(r)[at + 2]).toBe('history');
    expect(textOf(r.messages[at + 2]!).split(':')[0]).toBe(r.trace.recap.boundary!);
  });

  test('its cost comes out of the history: a slot the cut leaves no room for moves the cut once, and the request still fits', () => {
    // A long summary: the M5a cut (u1…a4) leaves less room than the slot needs.
    const long = summary('Fog night', 'The Lantern', ['u1', 'a4'], {}, 'The fog came down. '.repeat(16).trim());
    const view = chatView(CHAT, [long, S2, LANTERN]);
    const before = ok(assemble(asmIn(view)));
    expect(before.trace.trimmed).toEqual({ from: 'u1', to: 'a4' });
    const r = ok(assemble(asmIn(view, { recap: recapIn() })));
    // One chunk more is cut, and the slot is chosen for that cut: The door (u5…a8) is now behind it too.
    expect(r.trace.trimmed).toEqual({ from: 'u1', to: 'a8' });
    expect(r.trace.recap.ids).toEqual(['summary:a4.0', 'summary:a8.0']);
    expect(r.trace.recap.boundary).toBe('u9');
    expect(r.trace.tokens.estimated).toBeLessThanOrEqual(available);
    const slotTok = r.trace.blocks.find((b) => b.src === 'recap')!.tok;
    expect(slotTok).toBeLessThanOrEqual(share);
  });

  test('a slot that cannot fit even after the second trim is left out: the request is the M5a one', () => {
    // Protected messages so big that nothing but the greeting and U fit: the slot has no room.
    const msgs = longChat(3);
    const huge = msgs.map((m) => (m.id === 'u4' ? { ...m, blocks: [{ k: 'text' as const, text: 'u4: '.padEnd(2400, 'y') }] } : m));
    const view = chatView(huge, [summary('Fog night', 'The Lantern', ['u1', 'a1'], {}, 'Fog. '.repeat(60).trim())]);
    const without = ok(assemble(asmIn(view)));
    expect(without.trace.trimmed).not.toBeNull();
    expect(ok(assemble(asmIn(view, { recap: recapIn() })))).toEqual(without);
  });

  test('never macro-expanded: a summary that writes {{char}} reaches the model as written', () => {
    const odd = summary('{{user}} at the door', 'The Lantern', ['u1', 'a4'], {}, '{{char}} said {{random::a,b}}.');
    const r = ok(assemble(asmIn(chatView(CHAT, [odd]), { recap: recapIn() })));
    expect(recapText(r)).toBe(recapSummaryText('{{user}} at the door', '{{char}} said {{random::a,b}}.'));
  });

  test("a preset's own {{recap}}: the text goes there (the first one only), no message at the trim point", () => {
    const p = preset([
      { id: 'story', role: 'system', enabled: true, content: 'Story so far:\n{{recap}}', at: 'relative' },
      { id: 'again', role: 'system', enabled: true, content: '{{recap}}', at: 'relative' },
      HISTORY_BLOCK,
    ]);
    const r = ok(assemble(asmIn(chatView(CHAT, [S1, LANTERN]), { preset: p, recap: recapIn() })));
    expect(srcs(r)).not.toContain('recap');
    expect(srcs(r)).not.toContain('again');
    const story = r.messages.find((x) => x.src === 'story')!;
    expect(textOf(story)).toBe(`Story so far:\n${[recapArcText('The Lantern', 'A lamp went out and a door opened.'), recapSummaryText('Fog night', 'Fog night happened.')].join('\n\n')}`);
    expect(r.trace.recap.ids).toEqual(['summary:a4.0']);
  });

  test('a preset whose history block holds {{recap}} before {{history}}: the slot opens the history block', () => {
    const p = preset([{ id: 'history', role: 'system', enabled: true, content: '{{recap}}\n{{history}}', at: 'relative' }]);
    const view = chatView(CHAT, [S1, libArc('book', 'a1', 'Old War', 'The old war.')]);
    // The whole chat fits this preset, so only the library arc is eligible; its cost leaves no room for
    // u1…a4, which the second trim cuts, and the slot chosen for that cut holds Fog night too.
    expect(ok(assemble(asmIn(view, { preset: p }))).trace.trimmed).toBeNull();
    const r = ok(assemble(asmIn(view, { preset: p, recap: recapIn() })));
    expect(r.trace.trimmed).toEqual({ from: 'u1', to: 'a4' });
    expect(srcs(r).slice(0, 3)).toEqual(['block:history', 'history', 'history']);
    expect(textOf(r.messages[0]!)).toBe([recapArcText('Old War', 'The old war.'), recapSummaryText('Fog night', 'Fog night happened.')].join('\n\n'));
    expect(textOf(r.messages[1]!)).toBe('Hello, traveller.');
    expect(textOf(r.messages[2]!)).toStartWith('u5: ');
  });
});

describe("the slot's content limits", () => {
  test('arc overviews take at most half the slot, the summaries the rest', () => {
    const plots = ['Ash', 'Bell', 'Coal'].map((p, i) => arc(p, `${p}: `.padEnd(120, 'o'), 50 - i));
    const sums = ['Ash', 'Bell', 'Coal'].map((p, i) => summary(`${p} night`, p, ['u1', 'a4'], { key: `summary:a4.${i}` }));
    const r = ok(assemble(asmIn(chatView(CHAT, [...sums, ...plots]), { recap: recapIn() })));
    // Each overview is ~44 tokens; half of (160 − 4) is 78: one fits.
    expect(r.trace.recap.arcs).toEqual([{ key: 'arc:ash', rev: 50 }]);
    expect(r.trace.recap.ids).toEqual(['summary:a4.0', 'summary:a4.1', 'summary:a4.2']);
  });

  test('lite: at most two overviews, each cut to 1 200 characters; full shows them whole, as many as fit', () => {
    const books = ['a1', 'a2', 'a3'].map((id, i) => libArc('book', id, `Plot ${id}`, `${id} `.repeat(700).trim(), 300 - i));
    const big = { window: 40_000, reserve: 8192 };
    const lite = ok(assemble(asmIn(chatView(longChat(2), books), { ...big, recap: recapIn({ profile: 'lite' }) })));
    expect(lite.trace.recap.arcs.map((a) => a.key)).toEqual(['lib:book:a1', 'lib:book:a2']);
    const parts = recapText(lite)!.split('\n\n');
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      const overview = part.slice(part.indexOf('\n') + 1);
      expect(overview.length).toBeLessThanOrEqual(RECAP_LITE_ARC_CHARS);
      expect(overview).toEndWith('…');
    }
    const full = ok(assemble(asmIn(chatView(longChat(2), books), { ...big, recap: recapIn() })));
    // 2 099 characters (700 tokens) each, 2 000 for the arcs: two whole overviews, and the third cut
    // head-first to what is left of the half (the lead's ruling I; it was left out before).
    expect(full.trace.recap.arcs.map((a) => a.key)).toEqual(['lib:book:a1', 'lib:book:a2', 'lib:book:a3']);
    const fullParts = recapText(full)!.split('\n\n');
    expect(fullParts.slice(0, 2).some((p) => p.includes('…'))).toBe(false);
    expect(fullParts[2]!.startsWith('[Arc] Plot a3\na3 a3')).toBe(true);
    expect(fullParts[2]!).toEndWith('…');
  });

  test('library arcs are always eligible, after the session arcs, higher order first', () => {
    const low = libArc('book', 'a1', 'Old War', 'The old war.', 50);
    const high = libArc('book', 'a2', 'The Crown', 'The crown.', 200);
    const r = ok(assemble(asmIn(chatView(CHAT, [low, high, S1, LANTERN]), { recap: recapIn() })));
    expect(r.trace.recap.arcs.map((a) => a.key)).toEqual(['arc:the lantern', 'lib:book:a2', 'lib:book:a1']);
  });

  test('a session arc replaces the library arc of its plot; a library arc of another plot stays', () => {
    const bookLantern = libArc('book', 'a1', 'the lantern', 'The book says the lamp is old.', 300);
    const bookSalt = libArc('book', 'a2', 'Salt Road', 'The book says salt.', 100);
    const r = ok(assemble(asmIn(chatView(CHAT, [bookLantern, bookSalt, S1, LANTERN]), { recap: recapIn() })));
    expect(r.trace.recap.arcs.map((a) => a.key)).toEqual(['arc:the lantern', 'lib:book:a2']);
    expect(recapText(r)).not.toContain('The book says the lamp is old.');
  });

  test("a library arc whose plot's session arc is not in the slot (its summaries are in view) still shows", () => {
    const bookLantern = libArc('book', 'a1', 'The Lantern', 'The book says the lamp is old.');
    // S3 (Salt Road) is after the cut, so the Lantern's session arc has no summary behind it.
    const r = ok(assemble(asmIn(chatView(CHAT, [bookLantern, S3, LANTERN]), { recap: recapIn() })));
    expect(r.trace.recap.arcs.map((a) => a.key)).toEqual(['lib:book:a1']);
  });
});

describe('the block skips what the slot holds (inPrompt, D-155)', () => {
  const candidates = (): CompendiumBlockInput => ({
    rev: 'rev0',
    profile: 'full',
    candidates: [
      { key: 'summary:a4.0', ref: 'C1', tier: 1, via: 'mention', name: 'Fog night', full: '# Fog night\n\nFog night happened.', brief: 'Fog night happened.', briefTail: '' },
      { key: 'character:ада', ref: 'C2', tier: 1, via: 'mention', name: 'Ада', full: '# Ада\n\nA keeper.', brief: 'A keeper.', briefTail: '' },
    ],
    limits: { maxEntries: 8, fullChars: 4000, briefChars: 400, blockTok: Infinity },
    minShare: 0.4,
    inPrompt: new Set(),
    hidden: 0,
  });
  const ADA = typed('character:ада', 'character', { name: 'Ада' });

  test('a summary in the slot is repeated in the block, not injected; the rest of the block stays', () => {
    const r = ok(assemble(asmIn(chatView(CHAT, [S1, LANTERN, ADA]), { recap: recapIn(), compendium: candidates() })));
    expect(r.trace.recap.ids).toEqual(['summary:a4.0']);
    expect(r.trace.compendium).toMatchObject({ repeated: ['summary:a4.0'], injected: [{ ref: 'C2', mode: 'full' }] });
    const block = textOf(r.messages.find((x) => x.src === 'compendium:block')!);
    expect(block).toBe(`${BLOCK_HEADER}\n[Lore: Ада]\n# Ада\n\nA keeper.`);
  });

  test('no slot: the block as in M5a (nothing repeated)', () => {
    const view = chatView(CHAT, [ADA]);
    const r = ok(assemble(asmIn(view, { recap: recapIn(), compendium: candidates() })));
    expect(r.trace.compendium).toMatchObject({ repeated: [], injected: [{ ref: 'C1' }, { ref: 'C2' }] });
    expect(r).toEqual(ok(assemble(asmIn(view, { compendium: candidates() }))));
  });
});
