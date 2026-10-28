// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// D-195 (.notes/rcimport-decisions.md, ux#2): a turn whose never-trimmed part cannot fit the
// narrator's window is refused before the Director's model calls, with the refusal it always had.
// Before the fix the Director planned first (one or more calls on the narrator's model) and the turn
// was refused only afterwards, on every attempt. A turn that fits plans and sends as before.
//
// The check is a cheap bound first (no lore, its whole share held back), then pass A of the request
// itself only when the bound does not fit: lore that tips the request over is caught too, and a bound
// that does not fit never refuses a request that does.
import { describe, expect, test } from 'bun:test';
import type { Character, LoreBook } from '../../src/formats/native.ts';
import { loreBudget } from '../../src/prompt/budget.ts';
import { EMA_START, estimateTokens, O200K_COUNTER } from '../../src/prompt/tokens.ts';
import type { Entry } from '../../src/session/entries.ts';
import { byAgent, calls, dirCall, dirSession, entriesOf, fullCaps, MIRA, msgBySrc, rig, scriptConn, statuses, textOfMsg, turnOf } from '../engine-m4/kit.ts';

const NARR = (text = 'The abacus clicks.') => [{ text }];

/** A card whose description alone (~12k tokens) is more than a 16k window leaves for the prompt. */
const WORDY: Character = { ...MIRA, description: '{{char}} counts every dream she has ever mapped on an abacus for a traveller. '.repeat(900) };

const ends = (home: string, id: string): Extract<Entry, { t: 'end' }>[] => entriesOf(home, id).filter((e): e is Extract<Entry, { t: 'end' }> => e.t === 'end');
const preps = (home: string, id: string): Entry[] => entriesOf(home, id).filter((e) => e.t === 'prep');

describe('a request that cannot fit is refused before the Director (D-195)', () => {
  test('the Director follows a 16k narrator: no model call at all, the request refusal, nothing planned', async () => {
    const r = await rig(calls(dirCall(), NARR()), { caps: fullCaps({ contextLength: 16_384 }) });
    const s = dirSession(r.engine, { character: WORDY });
    const { evs, out } = await turnOf(s);
    expect(r.provider.requests).toHaveLength(0);
    expect(statuses(evs)).toEqual([]);
    expect(out).toMatchObject({ type: 'failed', category: 'request', code: 'context_length_exceeded', draft: '' });
    const message = out.type === 'failed' ? out.message : '';
    expect(message).toMatch(/^the required part of the prompt needs about \d+ tokens, but only \d+ are available \(window 16384 - reply reserve \d+\): /);
    expect(message).toContain("the Director's contract");
    expect(ends(r.home, s.id)).toMatchObject([{ outcome: 'failed', code: 'context_length_exceeded' }]);
    expect(preps(r.home, s.id)).toHaveLength(0);
    // Every attempt is refused the same way, and none of them calls the model.
    const again = await turnOf(s);
    expect(again.out).toMatchObject({ type: 'failed', code: 'context_length_exceeded', message });
    expect(r.provider.requests).toHaveLength(0);
    await r.engine.close();
  });

  test('the Director on its own connection: that connection is not called either', async () => {
    const dir = scriptConn('dir', calls(dirCall()), fullCaps());
    const r = await rig(calls(NARR()), { caps: fullCaps({ contextLength: 16_384 }), connections: { dir: dir.conn } });
    const s = dirSession(r.engine, { character: WORDY, config: { roles: { director: { conn: 'dir', model: 'm' } } } });
    const { evs, out } = await turnOf(s);
    expect(dir.provider.requests).toHaveLength(0);
    expect(r.provider.requests).toHaveLength(0);
    expect(statuses(evs)).toEqual([]);
    expect(out).toMatchObject({ type: 'failed', category: 'request', code: 'context_length_exceeded' });
    await r.engine.close();
  });

  test('the same card on a 32k narrator fits: the Director plans, the narrator gets its directive, as before', async () => {
    const r = await rig(calls(dirCall(), NARR()), { caps: fullCaps() });
    const s = dirSession(r.engine, { character: WORDY });
    const { evs, out, turn } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(statuses(evs)).toEqual(['planning', 'planned']);
    expect(r.provider.requests.map((q) => q.agent)).toEqual(['director', 'narrator']);
    const sent = byAgent(r.provider.requests, 'narrator')[0]!;
    expect(textOfMsg(msgBySrc(sent, 'director')!)).toContain('The lamp shows a door that was not there.');
    // What went out is the request preview({turn}) rebuilds from the stored directive: the check
    // before the Director changed nothing in it.
    const p = s.preview({ turn: turn.messageId });
    expect(p.ok && p.messages).toEqual(sent.messages);
    expect(preps(r.home, s.id)).toHaveLength(1);
    await r.engine.close();
  });

  test('the Director off: the same refusal, no Director, no change', async () => {
    const r = await rig(calls(NARR()), { caps: fullCaps({ contextLength: 16_384 }) });
    const s = dirSession(r.engine, { character: WORDY, director: { enabled: false } });
    const { out } = await turnOf(s);
    expect(r.provider.requests).toHaveLength(0);
    expect(out).toMatchObject({ type: 'failed', category: 'request', code: 'context_length_exceeded' });
    expect(out.type === 'failed' ? out.message : '').not.toContain("the Director's contract");
    await r.engine.close();
  });
});

// ---- the bound's lore share ---------------------------------------------------------------------

/**
 * A text the budget counts as about `tokens` (o200k, the engine's counter, scaled by the correction a
 * model starts with: EMA_START, as every size the budget compares).
 */
function wordsOf(tokens: number): string {
  const unit = 'The abacus counts one more dream. ';
  const per = (EMA_START * estimateTokens(unit.repeat(100), O200K_COUNTER)) / 100;
  return unit.repeat(Math.max(1, Math.round(tokens / per)));
}

/** A card book with one constant entry of about `tokens` tokens, sent as its own message (top). */
const bookOf = (tokens: number): LoreBook => ({ name: 'Abacus', entries: [{ id: 'all', keys: [], constant: true, position: 'top', content: wordsOf(tokens) }] });

/**
 * On a 16k narrator, in budget tokens: what the prompt may hold, the lore share, and the size of
 * everything a Director session sends but the card's description (read off a preview with a one-word
 * description; its stub directive makes it a little larger than what the check counts).
 */
async function room(): Promise<{ available: number; share: number; other: number }> {
  const r = await rig(calls(), { caps: fullCaps({ contextLength: 16_384 }) });
  const p = dirSession(r.engine, { character: { ...MIRA, description: 'x' } }).preview();
  await r.engine.close();
  if (!p.ok) throw new Error(p.message);
  const { window, reserve } = p.trace;
  return { available: window - reserve, share: loreBudget(window, reserve), other: Math.ceil(EMA_START * p.trace.tokens.estimated) };
}

describe('lore and the bound (D-195)', () => {
  test('lore that tips the request over the window: refused before the Director too', async () => {
    const { available, share, other } = await room();
    // Without the lore the request fits with half the share to spare; the lore takes 0.8 of it.
    const card: Character = { ...MIRA, description: wordsOf(available - other - share / 2), book: bookOf(0.8 * share) };
    const r = await rig(calls(dirCall(), NARR()), { caps: fullCaps({ contextLength: 16_384 }) });
    const s = dirSession(r.engine, { character: card });
    const { evs, out } = await turnOf(s);
    expect(r.provider.requests).toHaveLength(0);
    expect(statuses(evs)).toEqual([]);
    expect(out).toMatchObject({ type: 'failed', category: 'request', code: 'context_length_exceeded' });
    // The refusal is the request's own: the lore that fired is in its numbers.
    expect(out.type === 'failed' ? out.message : '').toMatch(/lore included: [1-9]\d* of its budget/);
    await r.engine.close();
  });

  test('a bound that does not fit never refuses a request that does: the Director plans, the reply arrives', async () => {
    const { available, share, other } = await room();
    // The same card with a small book: the bound (no lore, the whole share held back) is over the
    // window, the request itself is not.
    const card: Character = { ...MIRA, description: wordsOf(available - other - share / 2), book: bookOf(50) };
    const r = await rig(calls(dirCall(), NARR()), { caps: fullCaps({ contextLength: 16_384 }) });
    const s = dirSession(r.engine, { character: card });
    const { evs, out } = await turnOf(s);
    expect(out.type).toBe('done');
    expect(statuses(evs)).toEqual(['planning', 'planned']);
    expect(r.provider.requests.map((q) => q.agent)).toEqual(['director', 'narrator']);
    await r.engine.close();
  });
});
