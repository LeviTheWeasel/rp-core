// Ported from Bunraku:src/core/director/fixtures.ts@702d81201120a6b90eb29a783a77c60ffdebc374
// (Coneja-Chibi: arcOf, seedOf, hiddenOf, stateOf).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Builders for the state tests (not a test file itself): every required field set, so a test names
// only what it is about. Changed: the D-61 shape (no turnsActive, involvedCharacters, plannedBeats,
// relatedVisibleArcs, foreshadowingSeeds, arc scope, removedAt); hidden ids are hidden-N. Added:
// chapterOf, recordOf, ru / zh / proseOf (Cyrillic, Chinese or any text of a given length) and the
// tree helpers for the fold tests.

import { emptyState } from '../../src/agents/director/state.ts';
import {
  REDUCER_VERSION,
  type DirectorArc,
  type DirectorChapter,
  type DirectorInvisibleArc,
  type DirectorRecord,
  type DirectorSeed,
  type DirectorState,
} from '../../src/agents/director/types.ts';

export const arcOf = (over: Partial<DirectorArc> = {}): DirectorArc => ({
  id: 'arc-1',
  title: 'The Locked Room',
  description: 'A door nobody opens.',
  status: 'building',
  priority: 'active',
  arcType: 'side',
  horizon: 'medium',
  stages: [],
  createdAtTurn: 1,
  ...over,
});

export const seedOf = (over: Partial<DirectorSeed> = {}): DirectorSeed => ({
  id: 'seed-1',
  hint: 'A cracked bell',
  payoff: 'It rings at the finale.',
  scope: 'world',
  plantedAtTurn: 1,
  payoffHorizon: 'long',
  payoffDelivered: false,
  reinforcements: [],
  ...over,
});

export const hiddenOf = (over: Partial<DirectorInvisibleArc> = {}): DirectorInvisibleArc => ({
  id: 'hidden-1',
  title: 'The Ledger Conspiracy',
  description: 'Someone is cooking the books.',
  arcType: 'conspiracy',
  horizon: 'medium',
  scope: 'world',
  status: 'building',
  stages: [],
  playerClues: [],
  createdAtTurn: 1,
  ...over,
});

export const chapterOf = (over: Partial<DirectorChapter> = {}): DirectorChapter => ({
  id: 'chapter-1',
  number: 1,
  title: 'Прибытие',
  premise: 'Караван приходит в город у моря.',
  status: 'active',
  themes: ['доверие'],
  tone: 'тревожный',
  majorGoal: 'Найти смотрителя маяка.',
  createdAtTurn: 1,
  ...over,
});

export const stateOf = (over: Partial<DirectorState> = {}): DirectorState => ({ ...emptyState(), ...over });

/** A valid record as the turn writes it on a reply (msg.dir). */
export const recordOf = (state: DirectorState, over: Partial<DirectorRecord> = {}): DirectorRecord => ({
  turn: state.turn,
  ok: true,
  transport: 'tagged',
  profile: 'full',
  model: 'dir:m',
  directive: { pacing: 'medium', mood: 'напряжённый', narrativeGoal: 'Смотритель лжёт о письме.' },
  skipped: [],
  attempts: [{ transport: 'tagged', outcome: 'ok', ms: 1200, tokens: 400 }],
  state,
  reducer: REDUCER_VERSION,
  ...over,
});

const RU =
  'Старый смотритель маяка прячет письмо от сестры, и ночью кто-то снова зажигает огонь на башне. ' +
  'Рыбаки шепчутся о долгах гильдии, а в порту ждут корабль, которого нет ни в одном реестре. ';

/** Russian prose of exactly `n` code points (2 UTF-8 bytes per letter); `from` shifts the start so texts differ. */
export function ru(n: number, from = 0): string {
  return proseOf(RU, n, from);
}

const ZH = '老灯塔看守把姐姐的信藏了起来，夜里又有人在塔上点火。渔民们低声谈论行会的债务，港口在等一艘不在任何登记册上的船。';

/** Chinese prose of exactly `n` code points (3 UTF-8 bytes each, no spaces); `from` shifts the start. */
export function zh(n: number, from = 0): string {
  return proseOf(ZH, n, from);
}

/** `n` code points of `src` repeated, from code point `from` on (surrogate pairs kept whole). */
export function proseOf(src: string, n: number, from = 0): string {
  const cps = Array.from(src);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(cps[(from + i) % cps.length]!);
  return out.join('');
}
