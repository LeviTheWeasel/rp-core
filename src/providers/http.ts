// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// HTTP transport for adapters (ARCHITECTURE.md §8.8, §13; D-52, D-53). Fetch with a host lock and
// manual redirects, a status → ProviderError table, retry-after parsing, byte streaming of bodies.
// Port sources: Bunraku src/kit/providers/egress.ts guardedFetch (lines ~45-95), src/core/stream-bytes.ts,
// src/stage/provider/transport-core.ts classifyHttpFailure, provider-send.ts.
// CONTRACT FILE (M1b): signatures are fixed; the transport agent implements the bodies.

import type { ProviderError } from './types.ts';

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

/** scheme://host:port with default ports made explicit (http 80, https 443). Throws on a non-http(s) URL. */
export function originOf(url: string): string {
  void url;
  throw new Error('not implemented: originOf');
}

/** localhost, 127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, *.local, *.localhost → true. */
export function isLocalOrigin(origin: string): boolean {
  void origin;
  throw new Error('not implemented: isLocalOrigin');
}

/**
 * fetch with: redirects followed manually (only to the SAME origin, never https→http, at most 5),
 * the caller's AbortSignal, and Bun's own fetch timeout disabled (the engine owns first-byte and idle
 * timeouts, §8.8 — verify how Bun behaves on long pauses and document it). A redirect elsewhere
 * rejects with ProviderError code 'unreachable'. Network failures reject with ProviderError
 * 'unreachable' (category network). An abort rejects with the signal's reason.
 */
export function guardedFetch(
  req: HttpRequest,
  opts: { fetch: typeof fetch; signal: AbortSignal; allowedOrigin: string; maxRedirects?: number },
): Promise<Response> {
  void req; void opts;
  throw new Error('not implemented: guardedFetch');
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date relative to `now`); undefined if absent/invalid. */
export function parseRetryAfter(value: string | null, now: Date): number | undefined {
  void value; void now;
  throw new Error('not implemented: parseRetryAfter');
}

/**
 * A non-2xx response → ProviderError. Reads at most 64 KiB of the body for the message (never stored).
 * 401/403 auth_failed; 404 model_not_found; 408 timeout; 413 context_length_exceeded; 400/422
 * context_length_exceeded when the body says so, else bad_request; 429 rate_limited (+retryAfterSec);
 * 503/529 overloaded; 500/502/504/524 overloaded; anything else bad_request. status always set.
 */
export function classifyHttpFailure(res: Response, opts: { now: Date; afterOutput?: boolean }): Promise<ProviderError> {
  void res; void opts;
  throw new Error('not implemented: classifyHttpFailure');
}

/** The body as byte chunks; stops (throwing the reason) when the signal aborts. */
export function bodyBytes(res: Response, signal: AbortSignal): AsyncIterable<Uint8Array> {
  void res; void signal;
  throw new Error('not implemented: bodyBytes');
}
