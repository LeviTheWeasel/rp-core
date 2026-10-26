// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The ONLY place in src/ that touches the wall clock and system entropy (§6.9). Everything else
// receives clock/random by injection. The purity test exempts this file.

import { randomFillSync } from 'node:crypto';
import type { RandomBytes } from '../session/ids.ts';

export const systemClock = (): Date => new Date();

export const systemRandom: RandomBytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  randomFillSync(b);
  return b;
};

export const systemTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
