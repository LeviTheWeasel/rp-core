// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// D-178's stability rule through assemble: while the boundary (the first message after the cut) is the
// previous request's, the same summaries and the same arc revisions render — an overview the historian
// rewrote reads back at its old revision, a new summary waits — minus entries no longer live; a moved
// boundary, or a changed book, chooses afresh.
import { describe, expect, test } from 'bun:test';
import { arcRevisionText, recapArcText, recapSummaryText, type RecapTrace } from '../../src/agents/compendium/recap.ts';
import { assemble } from '../../src/prompt/assemble.ts';
import { histRow } from '../historian-m5b/kit.ts';
import { arc, asmIn, chatView, longChat, ok, prev, recapIn, recapText, summary } from './kit.ts';

// 18 exchanges: the M5a cut leaves u1…a4 out with ~180 tokens to spare, room for the slot and one
// more exchange.
const CHAT = longChat(18);
const S1 = summary('Fog night', 'The Lantern', ['u1', 'a4']);
const S0 = summary('Before', 'The Lantern', ['u1', 'u2'], { key: 'summary:u2.0' });
const OLD = 'A lamp went out and a door opened.';
const NEW = 'The lamp was stolen; the door leads to the cellar.';
const LANTERN_30 = arc('The Lantern', OLD, 30);
const LANTERN_40 = arc('The Lantern', NEW, 40);

/** The rows an arc's revisions come from: seq 30 wrote OLD, seq 40 wrote NEW. */
const ROWS = [
  histRow(30, 'u1', 'a4', [{ op: 'arc', plot: 'The Lantern', overview: OLD }]),
  histRow(40, 'u1', 'a4', [{ op: 'arc', plot: 'The Lantern', overview: NEW }]),
];
const revisionText = (key: string, rev: number): string | null => arcRevisionText(ROWS, key, rev);

/** The first request: S1 and the Lantern's arc at rev 30. */
function first(): RecapTrace {
  const r = ok(assemble(asmIn(chatView(CHAT, [S1, LANTERN_30]), { recap: recapIn() })));
  expect(r.trace.recap).toEqual({ ids: ['summary:a4.0'], arcs: [{ key: 'arc:the lantern', rev: 30 }], boundary: 'u5', profile: 'full', share: 160 });
  return prev(r.trace.recap);
}

describe('the same boundary', () => {
  test('a historian rewrite (a new overview, a new summary): the same ids and the same arc revision, its old text', () => {
    const previous = first();
    const r = ok(assemble(asmIn(chatView(CHAT, [S0, S1, LANTERN_40]), { recap: recapIn({ previous, revisionText }) })));
    expect(r.trace.recap).toEqual(previous);
    expect(recapText(r)).toBe([recapArcText('The Lantern', OLD), recapSummaryText('Fog night', 'Fog night happened.')].join('\n\n'));
  });

  test('the chat grew by an exchange and the cut did not move: still the same slot', () => {
    const previous = first();
    const r = ok(assemble(asmIn(chatView(longChat(19), [S0, S1, LANTERN_40]), { recap: recapIn({ previous, revisionText }) })));
    expect(r.trace.trimmed).toEqual({ from: 'u1', to: 'a4' });
    expect(r.trace.recap).toEqual(previous);
  });

  test('an old revision that cannot be read renders the current text with the current revision', () => {
    const previous = first();
    const r = ok(assemble(asmIn(chatView(CHAT, [S1, LANTERN_40]), { recap: recapIn({ previous, revisionText: () => null }) })));
    expect(r.trace.recap.arcs).toEqual([{ key: 'arc:the lantern', rev: 40 }]);
    expect(recapText(r)).toStartWith(recapArcText('The Lantern', NEW));
  });

  test('an entry retired since drops out, nothing takes its place', () => {
    const previous = first();
    const gone = { ...S1, retired: { reason: 'gone' } };
    const r = ok(assemble(asmIn(chatView(CHAT, [S0, gone, LANTERN_30]), { recap: recapIn({ previous, revisionText }) })));
    expect(r.trace.recap).toEqual({ ids: [], arcs: [{ key: 'arc:the lantern', rev: 30 }], boundary: 'u5', profile: 'full', share: 160 });
  });

  test('a book changed since the previous request: chosen afresh', () => {
    const previous = first();
    const asLoaded = { books: { lantern: 'old-hash' } };
    const r = ok(assemble(asmIn(chatView(CHAT, [S0, S1, LANTERN_40]), { recap: recapIn({ previous, revisionText, ...asLoaded }) })));
    expect(r.trace.recap).toEqual({ ids: ['summary:u2.0', 'summary:a4.0'], arcs: [{ key: 'arc:the lantern', rev: 40 }], boundary: 'u5', profile: 'full', share: 160 });
  });

  test('the same books (the notes book aside): the pinned slot', () => {
    const previous = first();
    const r = ok(assemble(asmIn(chatView(CHAT, [S0, S1, LANTERN_40]), { recap: recapIn({ previous, revisionText, books: { '@notes': 'x' } }) })));
    expect(r.trace.recap).toEqual(previous);
  });
});

describe('a moved boundary', () => {
  test('the cut moved a chunk: chosen afresh, the new summary and the new revision come in', () => {
    const previous = first();
    const r = ok(assemble(asmIn(chatView(longChat(24), [S0, S1, LANTERN_40]), { recap: recapIn({ previous, revisionText }) })));
    expect(r.trace.trimmed).toEqual({ from: 'u1', to: 'a8' });
    expect(r.trace.recap).toEqual({ ids: ['summary:u2.0', 'summary:a4.0'], arcs: [{ key: 'arc:the lantern', rev: 40 }], boundary: 'u9', profile: 'full', share: 160 });
    expect(recapText(r)).toStartWith(recapArcText('The Lantern', NEW));
  });

  test('a previous request with no slot (boundary null) never pins: the slot comes as soon as it has content', () => {
    const r = ok(assemble(asmIn(chatView(CHAT, [S1, LANTERN_30]), { recap: recapIn({ previous: { ids: [], arcs: [], boundary: null } }) })));
    expect(r.trace.recap.ids).toEqual(['summary:a4.0']);
  });
});
