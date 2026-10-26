// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Id helpers. Entropy is injected (§6.9: no Math.random in src/).

export type RandomBytes = (n: number) => Uint8Array;

/** 8 lowercase hex chars. */
export function hex8(random: RandomBytes): string {
  const b = random(4);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export const newSessionId = (random: RandomBytes): string => `s_${hex8(random)}`;
export const newMessageId = (random: RandomBytes): string => hex8(random);
export const newTurnId = (random: RandomBytes): string => `t_${hex8(random)}`;

/** A uint32 seed. */
export function newSeed(random: RandomBytes): number {
  const b = random(4);
  return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
}
