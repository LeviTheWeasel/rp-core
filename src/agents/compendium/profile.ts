// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The Compendium's profile and limits (ARCHITECTURE.md §7.4.1, .notes/m5a-decisions.md D-154) and
// the session config with its defaults filled (§7.4.9, D-158). Stored headers keep what was written;
// every reader goes through resolveCompendium. A stored value of the wrong kind reads as its default
// (config.ts refuses it on the way in; this only keeps an old or hand-edited header from breaking a turn).

import type { CompendiumConfig } from '../../session/entries.ts';
import { isEntryType } from './entry-types.ts';
import type { BlockLimits, CompendiumProfile, EntryType } from './types.ts';

/** 'auto' is lite below this window (tokens) [D-79]. */
export const LITE_WINDOW = 24_576;

/** D-154: what the block may hold per profile. */
export const COMPENDIUM_LIMITS: Readonly<Record<CompendiumProfile, BlockLimits>> = Object.freeze({
  full: Object.freeze({ maxEntries: 12, fullChars: 4000, briefChars: 1200, blockTok: Infinity }),
  lite: Object.freeze({ maxEntries: 6, fullChars: 0, briefChars: 700, blockTok: 1600 }),
});

/** The profile for an agent with this request window: 'full'/'lite' as set, 'auto' (or unset) by the window. */
export function compendiumProfile(p: 'auto' | 'full' | 'lite' | undefined, window: number): CompendiumProfile {
  if (p === 'full' || p === 'lite') return p;
  return window < LITE_WINDOW ? 'lite' : 'full';
}

/** D-77: the share of the lore budget the block keeps when it has candidates. */
export const DEFAULT_MIN_SHARE = 0.4;

/** §7.4.9: filing writes every type but summary unless told otherwise. */
export const DEFAULT_FILING_ALLOW: readonly EntryType[] = Object.freeze([
  'character',
  'location',
  'item',
  'power',
  'organization',
  'event',
  'plot',
  'threat',
  'worldbuilding',
  'creature',
] as const);

/**
 * CompendiumConfig with every default filled (D-158). The optional numbers are "by profile" or "by
 * origin" (§7.4.9): absent here, the reader that knows the profile or the origin picks the value.
 */
export interface ResolvedCompendiumConfig {
  enabled: boolean;
  profile: 'auto' | 'full' | 'lite';
  /** '' = the story's language. */
  language: string;
  guidance: string;
  minShare: number;
  maxAttempts: number;
  idleDelaySec: number;
  /** Library id → access; a book not listed is 'read'. */
  books: Record<string, 'read' | 'off'>;
  recall: {
    mode: 'auto' | 'sync' | 'prefetch' | 'lexical' | 'off';
    onMiss: 'auto' | 'lexical' | 'sync';
    /** Absent: by profile (full 10, lite 4). */
    maxEntries?: number;
    minEntries: number;
    /** Absent: by profile (full 20, lite 6). */
    contextMessages?: number;
    graceSec: number;
    /** Absent: by origin (30 local, 20 remote). */
    timeoutSec?: number;
    onSwipe: 'reuse' | 'rerun';
    guidance: string;
  };
  filing: {
    enabled: boolean;
    wait: number;
    everyN: number;
    allow: EntryType[];
    /** Absent: by origin (300 local, 120 remote). */
    timeoutSec?: number;
  };
  historian: {
    interval: number;
    recapAfter: number;
    /** Absent: by profile (full 10, lite 6). */
    overlap?: number;
  };
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const oneOf = <T extends string>(v: unknown, values: readonly T[], d: T): T =>
  typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : d;
/** A number from min to max (whole when `whole`), else the default: the ranges config.toml checks (D-158). */
const within = (v: unknown, min: number, max: number, d: number, whole = false): number => {
  const n = num(v, Number.NaN);
  return n >= min && n <= max && (!whole || Number.isInteger(n)) ? n : d;
};
/** A string of at most `max` code points, else the default. */
const text = (v: unknown, max: number, d: string): string => (typeof v === 'string' && [...v].length <= max ? v : d);
/**
 * A "0 = by profile / origin" number (§13) as `{[k]: v}` when it is a whole number from min to max,
 * else nothing (0 and a value out of range both read as "by profile").
 */
const byProfile = <K extends string>(k: K, v: unknown, min: number, max: number): Partial<Record<K, number>> => {
  const n = within(v, min, max, 0, true);
  return n > 0 ? ({ [k]: n } as Record<K, number>) : {};
};

/**
 * A field of a stored table: the camelCase name, or when it is absent the snake_case one an older
 * header may hold (M4 copied config.toml's [compendium] table into new headers as written).
 */
const field = (o: Obj, camel: string, snake: string): unknown => (o[camel] !== undefined ? o[camel] : o[snake]);

/**
 * The config with D-158's defaults: absent → enabled with every default (a new session's), each
 * nested table filled field by field. A field whose camelCase name is absent is read from its older
 * snake_case name (`min_share`, `idle_delay_sec`, `max_attempts`, recall's `on_miss`…, filing's
 * `every_n`, `timeout_sec`, historian's `recap_after`). A value of the wrong kind or out of
 * config.toml's range reads as its default, so whatever a header holds never breaks a turn.
 */
export function resolveCompendium(c: CompendiumConfig | undefined): ResolvedCompendiumConfig {
  const cfg: Obj = isObj(c) ? c : {};
  const recall: Obj = isObj(cfg.recall) ? cfg.recall : {};
  const filing: Obj = isObj(cfg.filing) ? cfg.filing : {};
  const historian: Obj = isObj(cfg.historian) ? cfg.historian : {};
  const books: Record<string, 'read' | 'off'> = {};
  if (isObj(cfg.books)) for (const [k, v] of Object.entries(cfg.books)) if (v === 'read' || v === 'off') books[k] = v;
  const allow = Array.isArray(filing.allow) ? [...new Set(filing.allow.filter(isEntryType))] : [];
  return {
    enabled: bool(cfg.enabled, true),
    profile: oneOf(cfg.profile, ['auto', 'full', 'lite'], 'auto'),
    language: text(cfg.language, 80, ''),
    guidance: text(cfg.guidance, 4000, ''),
    minShare: within(field(cfg, 'minShare', 'min_share'), 0, 1, DEFAULT_MIN_SHARE),
    maxAttempts: within(field(cfg, 'maxAttempts', 'max_attempts'), 1, 10, 3, true),
    idleDelaySec: within(field(cfg, 'idleDelaySec', 'idle_delay_sec'), 0, 60, 8),
    books,
    recall: {
      mode: oneOf(recall.mode, ['auto', 'sync', 'prefetch', 'lexical', 'off'], 'auto'),
      onMiss: oneOf(field(recall, 'onMiss', 'on_miss'), ['auto', 'lexical', 'sync'], 'auto'),
      ...byProfile('maxEntries', field(recall, 'maxEntries', 'max_entries'), 1, 30),
      minEntries: within(field(recall, 'minEntries', 'min_entries'), 0, 20, 0, true),
      ...byProfile('contextMessages', field(recall, 'contextMessages', 'context_messages'), 5, 100),
      graceSec: within(field(recall, 'graceSec', 'grace_sec'), 0, 60, 4),
      ...byProfile('timeoutSec', field(recall, 'timeoutSec', 'timeout_sec'), 1, 3600),
      onSwipe: oneOf(field(recall, 'onSwipe', 'on_swipe'), ['reuse', 'rerun'], 'reuse'),
      guidance: text(recall.guidance, 8000, ''),
    },
    filing: {
      enabled: bool(filing.enabled, true),
      wait: within(filing.wait, 0, 5, 1, true),
      everyN: within(field(filing, 'everyN', 'every_n'), 1, 10, 1, true),
      // §13: an empty list means the default.
      allow: allow.length > 0 ? allow : [...DEFAULT_FILING_ALLOW],
      ...byProfile('timeoutSec', field(filing, 'timeoutSec', 'timeout_sec'), 1, 3600),
    },
    historian: {
      interval: within(historian.interval, 0, 100, 20, true),
      recapAfter: within(field(historian, 'recapAfter', 'recap_after'), 1, 1000, 24, true),
      ...byProfile('overlap', historian.overlap, 1, 100),
    },
  };
}
