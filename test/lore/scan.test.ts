// Ported from Bunraku:src/core/lore/engine/scan.test.ts@702d8120 (depth cases).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lore/scan.ts: the scan buffer — "Name: text" newest first, hidden messages out, depth windows.
// Depth cases adapted from Bunraku src/core/lore/engine/scan.test.ts @702d8120 (buildScanText).
import { describe, expect, test } from 'bun:test';
import { foldView } from '../../src/session/fold.ts';
import type { EntryInput } from '../../src/session/entries.ts';
import { DEFAULT_SCAN_DEPTH, scanMessages, scanText } from '../../src/lore/scan.ts';
import { head, hide, makeHeader, msg, seqd, TS } from '../session/fixtures.ts';

const names = { char: 'Mira', user: 'Levi' };

describe('scanMessages', () => {
  const entries = seqd([
    msg('g0000001', null, 'assistant', 'Hello, traveller.', { gen: { kind: 'greeting' } }),
    msg('u0000001', 'g0000001', 'user', '  Where is the castle?  '),
    {
      t: 'msg',
      ts: TS,
      id: 'a0000001',
      parent: 'u0000001',
      role: 'assistant',
      blocks: [
        { k: 'reasoning', text: 'secret dragon thoughts' },
        { k: 'text', text: 'North, ' },
        { k: 'tool_call', id: 'c1', name: 'roll', args: '{"dragon":1}' },
        { k: 'text', text: 'past the moat.' },
      ],
    } as EntryInput,
    msg('u0000002', 'a0000001', 'user', 'OOC note', {}),
    msg('a0000002', 'u0000002', 'assistant', 'Indeed.'),
    msg('u0000003', 'a0000002', 'user', 'Thanks'),
    hide('u0000002'),
    head('u0000003'),
  ]);
  const view = foldView(makeHeader(), entries);

  test('newest first, "Name: text", hidden left out, only text blocks, trimmed', () => {
    expect(scanMessages(view, 'u0000003', names)).toEqual([
      'Levi: Thanks',
      'Mira: Indeed.',
      'Mira: North, past the moat.',
      'Levi: Where is the castle?',
      'Mira: Hello, traveller.',
    ]);
  });

  test('stops at upTo: later messages are not scanned', () => {
    expect(scanMessages(view, 'u0000001', names)).toEqual(['Levi: Where is the castle?', 'Mira: Hello, traveller.']);
  });

  test('a message off the path is an error', () => {
    expect(() => scanMessages(view, 'zzz', names)).toThrow(/not on the active path/);
  });
});

describe('scanText', () => {
  const msgs = ['Levi: gamma', 'Mira: beta', 'Levi: alpha'];

  test('the newest `depth` messages, newest first, joined with a newline', () => {
    expect(scanText(msgs, 2)).toBe('Levi: gamma\nMira: beta');
    expect(scanText(msgs, 1)).toBe('Levi: gamma');
  });

  test('depth 0 scans nothing; depth past the chat scans everything', () => {
    expect(scanText(msgs, 0)).toBe('');
    expect(scanText(msgs, 99)).toBe('Levi: gamma\nMira: beta\nLevi: alpha');
    expect(scanText(msgs, -1)).toBe('');
  });

  test('ST default depth is 2', () => {
    expect(DEFAULT_SCAN_DEPTH).toBe(2);
  });
});
