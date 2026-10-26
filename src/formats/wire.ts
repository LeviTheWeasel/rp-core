// Ported from Bunraku:src/core/guards.ts@702d8120 (isRecord, deepEq, present-or-absent readers).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small readers for untrusted foreign JSON, shared by the importers in this folder. Every reader is
// present-or-absent: it returns undefined when the wire did not carry a usable value, and never
// invents a default (ARCHITECTURE.md §19.8 "отсутствующее остаётся отсутствующим").

import type { ImportWarning } from './native.ts';

export type Rec = Record<string, unknown>;

/** A plain JSON object: not null, not an array. */
export const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The string if present, else undefined. */
export const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A non-blank string, else undefined. ST writes '' for "not set", so blank means absent. */
export const nonBlank = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

/** The boolean if present, else undefined ("true" and 1 are not booleans here). */
export const optBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/**
 * A finite number, accepting numbers written as strings ("0.5", "4"): ST and card editors store
 * both spellings (Bunraku rule "приведение чисел, записанных строками").
 */
export function optNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A non-negative integer (depths, timers, scan depths), truncating fractions. */
export function optCount(v: unknown): number | undefined {
  const n = optNum(v);
  return n === undefined || n < 0 ? undefined : Math.trunc(n);
}

/** The string elements of an array, or undefined when the field is not an array. */
export const optStrArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

/**
 * Structural equality for JSON-shaped values. Key order carries no meaning, so stringify-equality
 * would call two identical objects different.
 */
export function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEq(v, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Rec;
    const bo = b as Rec;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) if (!deepEq(ao[k], bo[k])) return false;
    return true;
  }
  return false;
}

/** 'a' + 'b' → 'a.b'; '' + 'b' → 'b'; 'a' + 3 → 'a[3]'. */
export function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

/** Drop keys whose value is undefined so stored JSON only carries what the source carried. */
export function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o)) if ((o as Rec)[k] === undefined) delete (o as Rec)[k];
  return o;
}

/** Make ids unique in order: the first claim wins, later duplicates get -2, -3, ... (deterministic). */
export function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.map((item) => {
    let id = item.id;
    for (let n = 2; seen.has(id); n++) id = `${item.id}-${n}`;
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

/**
 * Collects import warnings. Per-entry warnings in a book are folded by (code, field) so a 300-entry
 * book with `vectorized: true` everywhere yields one line naming the count, not 300.
 */
export class WarningSink {
  private readonly plain: ImportWarning[] = [];
  private readonly folded = new Map<string, { code: string; paths: string[]; star: string; message: string }>();

  add(code: string, path: string, message: string): void {
    this.plain.push({ code, path, message });
  }

  /** Fold with other entries: `star` is the wildcard path used when more than one entry hits. */
  fold(code: string, path: string, star: string, message: string): void {
    const key = `${code}\u0000${star}`;
    const hit = this.folded.get(key);
    if (hit) hit.paths.push(path);
    else this.folded.set(key, { code, paths: [path], star, message });
  }

  addAll(ws: readonly ImportWarning[]): void {
    for (const w of ws) this.plain.push(w);
  }

  list(): ImportWarning[] {
    const out = [...this.plain];
    for (const f of this.folded.values()) {
      out.push(
        f.paths.length === 1
          ? { code: f.code, path: f.paths[0] ?? f.star, message: f.message }
          : { code: f.code, path: f.star, message: `${f.message} (${f.paths.length} entries)` },
      );
    }
    return out;
  }
}
