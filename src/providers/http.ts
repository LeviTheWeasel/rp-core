// Ported from Bunraku:src/kit/providers/egress.ts@702d8120 (guardedFetch, lines 45-95: the host lock and
// manual redirects), Bunraku:src/core/stream-bytes.ts@702d8120 (chunksOf: the cancelling byte reader) and
// Bunraku:src/stage/provider/transport-core.ts@702d8120 (classifyHttpFailure: error-body detail extraction).
// Copyright (C) 2026 Coneja-Chibi; changes Copyright (C) 2026 the rp-core authors.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HTTP transport for adapters (ARCHITECTURE.md §8.8, §13; D-52, D-53). Fetch with a host lock and
// manual redirects, a status → ProviderError table, retry-after parsing, byte streaming of bodies.
// CONTRACT FILE (M1b): signatures are fixed; the transport agent implements the bodies.
//
// Changes from Bunraku: the lock is on the ORIGIN (scheme, host, port), not the host, so a redirect
// can neither switch scheme nor port; refusals are ProviderError 'unreachable' (category network)
// instead of EgressBlocked; the fetch is the caller's (env.fetch, per request) and Bun's own idle
// timer is switched off (`timeout: false`, see .notes/m1b-bun-fetch.md), because the engine owns
// first-byte and idle timeouts (§8.8). classifyHttpFailure no longer follows RoleCall's "401 is a bad
// key, everything else is a backend error" rule (§19.4 "Не переносить"): it maps every status onto
// the D-51 codes (a 403 moderation refusal is content_filter, not a bad key), reads at most 64 KiB of
// the body, and keeps the server's words only in ProviderError.detail (--debug); the message is the
// fixed sentence of the code (§13).

import { ProviderError, PROVIDER_ERROR_CATEGORY, providerMessage, type ProviderErrorCode } from './types.ts';

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

/** scheme://host:port with default ports made explicit (http 80, https 443). Throws on a non-http(s) URL. */
export function originOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // The URL is not echoed: a pasted base URL may carry a key in its query.
    throw new TypeError('not a valid http(s) URL');
  }
  const port = DEFAULT_PORTS[u.protocol];
  if (port === undefined) throw new TypeError(`not an http(s) URL (scheme ${u.protocol})`);
  // WHATWG URL already lower-cases the host and brackets IPv6 literals.
  return `${u.protocol}//${u.hostname}:${u.port || port}`;
}

/** IPv4 dotted quad → its four octets, or null. */
function ipv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  return o.every((n) => n <= 255) ? o : null;
}

function isLocalIpv4([a, b]: [number, number, number, number]): boolean {
  return (
    a === 127 || // loopback 127.0.0.0/8
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10: CGNAT, where Tailscale puts home servers
    a === 0 // 0.0.0.0, pasted from a server's "listening on" line, reaches this machine
  );
}

/** Host suffixes that only resolve on a local network. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home.arpa', '.internal'];

/**
 * localhost, 127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, *.local, *.localhost → true.
 * Also (a superset, all of them on-machine or on-LAN): 0.0.0.0, 169.254/16, 100.64/10, IPv6
 * unspecified/ULA/link-local, IPv4-mapped IPv6 of the above, *.lan, *.home.arpa, *.internal.
 * Accepts an origin or any http(s) URL; anything unparseable is not local.
 */
export function isLocalOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  host = host.replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1);
    if (v6 === '::1' || v6 === '::') return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6)) return true; // ULA fc00::/7, link-local fe80::/10
    // IPv4-mapped (the URL parser serialises ::ffff:127.0.0.1 as ::ffff:7f00:1).
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    if (mapped) {
      const hi = parseInt(mapped[1]!, 16);
      const lo = parseInt(mapped[2]!, 16);
      return isLocalIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    }
    return false;
  }
  const quad = ipv4(host);
  if (quad) return isLocalIpv4(quad);
  return host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function providerError(
  code: ProviderErrorCode,
  message: string,
  extra: { status?: number; retryAfterSec?: number; afterOutput?: boolean; detail?: string } = {},
): ProviderError {
  return new ProviderError({ category: PROVIDER_ERROR_CATEGORY[code], code, message, ...extra });
}

/** The allowed origin in canonical form (a caller may pass a full base URL or an origin without default port). */
function canonicalOrigin(allowed: string): string {
  try {
    return originOf(allowed);
  } catch {
    throw providerError('unreachable', 'the connection has no valid http(s) base URL');
  }
}

/** The origin of a hop, or a refusal: a non-http(s) or unparseable Location is not followed. */
function hopOrigin(url: string): string {
  try {
    return originOf(url);
  } catch {
    throw providerError('unreachable', 'refused a redirect to a non-http(s) address');
  }
}

/** Fetch spec rewrite: 303 (and 301/302 after a POST) turn the request into a bodiless GET. */
function redirectedRequest(req: HttpRequest, url: string, status: number): HttpRequest {
  const becomesGet = status === 303 || ((status === 301 || status === 302) && req.method === 'POST');
  if (!becomesGet) return { ...req, url };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (lower !== 'content-type' && lower !== 'content-length') headers[k] = v;
  }
  return { url, method: 'GET', headers };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * fetch with: redirects followed manually (only to the SAME origin, never https→http, at most 5),
 * the caller's AbortSignal, and Bun's own fetch timeout disabled (the engine owns first-byte and idle
 * timeouts, §8.8 — verify how Bun behaves on long pauses and document it). A redirect elsewhere
 * rejects with ProviderError code 'unreachable'. Network failures reject with ProviderError
 * 'unreachable' (category network). An abort rejects with the signal's reason.
 *
 * Same origin means scheme, host and port all equal, so https→http (and http→https) are refused too.
 * The initial URL is checked as well, before anything is sent. A 3xx without Location is returned
 * as is (the caller classifies it). A redirect response's body is cancelled before the next hop.
 */
export async function guardedFetch(
  req: HttpRequest,
  opts: { fetch: typeof fetch; signal: AbortSignal; allowedOrigin: string; maxRedirects?: number },
): Promise<Response> {
  const { signal } = opts;
  const allowed = canonicalOrigin(opts.allowedOrigin);
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  let current = req;
  if (hopOrigin(current.url) !== allowed) {
    throw providerError('unreachable', `refused to reach ${hopOrigin(current.url)}; this connection only talks to ${allowed}`);
  }
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    let res: Response;
    try {
      res = await opts.fetch(current.url, {
        method: current.method,
        headers: current.headers,
        ...(current.body !== undefined ? { body: current.body } : {}),
        signal,
        redirect: 'manual',
        // Bun extension: false disables the socket idle timer (default 5 min, BUN_CONFIG_HTTP_IDLE_TIMEOUT).
        // On Bun 1.3.14 a positive number is NOT honoured as a deadline, only false/0 change anything.
        timeout: false,
      });
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      if (err instanceof ProviderError) throw err;
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      // fetch's own words stay out of the message (§13): Bun quotes a header it refuses whole, key
      // included ("Header '14' has invalid value: 'Bearer …'"). They are kept for --debug only.
      throw providerError(timedOut ? 'timeout' : 'unreachable', `could not reach ${allowed}`, { detail: errorText(err) });
    }
    if (!REDIRECTS.has(res.status)) return res;
    const location = res.headers.get('location');
    if (location === null) return res;
    await res.body?.cancel().catch(() => undefined);
    if (redirects >= maxRedirects) {
      throw providerError('unreachable', `refused more than ${maxRedirects} redirects from ${allowed}`, { status: res.status });
    }
    let next: string;
    try {
      next = new URL(location, current.url).href;
    } catch {
      throw providerError('unreachable', 'refused a redirect with an invalid Location', { status: res.status });
    }
    const nextOrigin = hopOrigin(next);
    if (nextOrigin !== allowed) {
      const downgrade = new URL(current.url).protocol === 'https:' && new URL(next).protocol === 'http:';
      throw providerError(
        'unreachable',
        downgrade ? 'refused to downgrade a redirect from https to http' : `refused a redirect to ${nextOrigin}; this connection only talks to ${allowed}`,
        { status: res.status },
      );
    }
    current = redirectedRequest(current, next, res.status);
  }
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date relative to `now`); undefined if absent/invalid. */
export function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  // delta-seconds. RFC 9110 says a non-negative integer; a decimal is accepted, a sign is not.
  if (/^\d+(?:\.\d+)?$/.test(v)) return Number(v);
  // HTTP-date (IMF-fixdate, RFC 850 or asctime). All three carry hh:mm:ss; requiring it keeps
  // Date.parse's leniency ("5", "May") from turning garbage into a date.
  if (!/\d{1,2}:\d{2}:\d{2}/.test(v)) return undefined;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/** Error-body bytes kept for the live message. */
const ERROR_BODY_CAP = 64 * 1024;

/** At most `cap` bytes of a body, decoded; the rest is cancelled unread. A failed read keeps what arrived. */
async function readCapped(res: Response, cap: number): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  const reader = body.getReader();
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.byteLength > cap - total ? value.subarray(0, cap - total) : value;
      total += take.byteLength;
      out += decoder.decode(take, { stream: true });
    }
  } catch {
    // A body that breaks off still leaves its status, which is what classifies it.
  } finally {
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* Bun 1.3 can throw on releaseLock after cancel; the reader is finished either way. */
    }
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The server's own words from an error body: OpenAI / OpenRouter {error:{message, metadata}},
 * llama.cpp and Ollama {error:"..."}, FastAPI / vLLM / TabbyAPI {detail}, or {message}. Plain text
 * otherwise. (Bunraku transport-core classifyHttpFailure, plus the string and detail shapes.)
 */
function errorDetail(text: string): string {
  let detail = clip(text, 500);
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return detail;
    const err = parsed.error;
    if (isRecord(err) && str(err.message)) {
      detail = clip(str(err.message), 500);
      const meta = isRecord(err.metadata) ? err.metadata : undefined;
      if (meta?.raw !== undefined) {
        detail += ` | upstream: ${clip(typeof meta.raw === 'string' ? meta.raw : JSON.stringify(meta.raw), 300)}`;
      } else if (str(meta?.provider_name)) {
        detail += ` (via ${str(meta?.provider_name)})`;
      }
    } else if (str(err)) {
      detail = clip(str(err), 500);
    } else if (str(parsed.message)) {
      detail = clip(str(parsed.message), 500);
    } else if (str(parsed.detail)) {
      detail = clip(str(parsed.detail), 500);
    } else if (parsed.detail !== undefined) {
      detail = clip(JSON.stringify(parsed.detail), 500);
    }
  } catch {
    // Not JSON: the clipped text stands.
  }
  return detail;
}

/**
 * How servers say the prompt does not fit (matched on the whole capped body, case-insensitive):
 * OpenAI / DeepSeek / OpenRouter / vLLM / Mistral "maximum context length", the OpenAI code
 * context_length_exceeded, llama.cpp exceed_context_size_error / "exceeds the available context
 * size", Anthropic "prompt is too long", TabbyAPI max_seq_len, vLLM "maximum model length" /
 * max_model_len, Gemini "input token count ... exceeds". "max_tokens is too large" is NOT matched:
 * that is a bad request about the reply budget, not the context.
 */
const CONTEXT_EXCEEDED =
  /context[_ ]length[_ ]exceeded|exceed_context_size|maximum context length|context (?:length|window|size)[^.]{0,80}exceed|exceed[^.]{0,80}context (?:length|window|size)|prompt is too long|max_seq_len|maximum model length|max_model_len|input token count[^.]{0,40}exceed|too many (?:input|prompt) tokens/i;

/** Status → code, before the body is consulted. */
function codeForStatus(status: number): ProviderErrorCode {
  switch (status) {
    case 401:
    case 403:
      return 'auth_failed';
    case 404:
      return 'model_not_found';
    case 408:
      return 'timeout';
    case 413:
      return 'context_length_exceeded';
    case 429:
      return 'rate_limited';
    case 500:
    case 502:
    case 503:
    case 504:
    case 524:
    case 529:
      return 'overloaded';
    default:
      // Deviation (see .notes/m1b-contract-transport.md): any other 5xx (501, Cloudflare 520-523,
      // 525-527, 530 ...) is a server failure, so it is 'overloaded' (category server), not
      // bad_request. Every other status, 3xx and 1xx included, is bad_request.
      return status >= 500 && status <= 599 ? 'overloaded' : 'bad_request';
  }
}

/**
 * A moderation refusal in an error object (OpenRouter answers 403 "Your chosen model requires
 * moderation and your input was flagged", with error.metadata.reasons and flagged_input): a content
 * failure, not a bad key. Takes the parsed `error` value of the body.
 */
export function isModerationError(err: unknown): boolean {
  if (!isRecord(err)) return typeof err === 'string' && MODERATION.test(err);
  const meta = isRecord(err.metadata) ? err.metadata : undefined;
  if (meta && (Array.isArray(meta.reasons) || meta.flagged_input !== undefined)) return true;
  return MODERATION.test(`${str(err.code)} ${str(err.type)} ${str(err.message)}`);
}

/** Words of a moderation refusal (OpenRouter, OpenAI content_policy, Azure content_filter). */
const MODERATION = /moderation|flagged|content[_ ](?:policy|filter)/i;

/** The body's `error` value when it is JSON with one (undefined otherwise). */
function errorValue(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A non-2xx response → ProviderError. Reads at most 64 KiB of the body.
 * 401 auth_failed; 403 auth_failed, or content_filter when the body is a moderation refusal; 404
 * model_not_found; 408 timeout; 413 context_length_exceeded; 400/422 context_length_exceeded when the
 * body says so, else bad_request; 429 rate_limited (+retryAfterSec); 503/529 overloaded;
 * 500/502/504/524 overloaded; anything else bad_request. status always set.
 *
 * `message` is the fixed sentence of the code plus the status (§13: the server's words may quote the
 * prompt or echo a key back, so they never reach an event or plain output); the server's own words
 * (error.message, upstream metadata) are kept in `detail` for --debug.
 *
 * retryAfterSec is set whenever the response carries a valid Retry-After (or OpenAI's retry-after-ms),
 * not only on 429: a 503 with Retry-After says how long to wait just as well.
 */
export async function classifyHttpFailure(res: Response, opts: { now: Date; afterOutput?: boolean }): Promise<ProviderError> {
  const status = res.status;
  const text = await readCapped(res, ERROR_BODY_CAP);
  let code = codeForStatus(status);
  if ((status === 400 || status === 422) && CONTEXT_EXCEEDED.test(text)) code = 'context_length_exceeded';
  if (status === 403 && isModerationError(errorValue(text))) code = 'content_filter';
  let retryAfterSec = parseRetryAfter(res.headers.get('retry-after'), opts.now);
  if (retryAfterSec === undefined) {
    const ms = res.headers.get('retry-after-ms')?.trim();
    if (ms && /^\d+(?:\.\d+)?$/.test(ms)) retryAfterSec = Number(ms) / 1000;
  }
  const detail = errorDetail(text);
  return providerError(code, providerMessage(code, status), {
    status,
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    afterOutput: opts.afterOutput ?? false,
    ...(detail ? { detail } : {}),
  });
}

/**
 * The body as byte chunks; stops (throwing the reason) when the signal aborts.
 *
 * Leaving the loop early (break, throw, abort) cancels the body, and an abort also wakes a read that
 * waits on a silent server (Bunraku chunksOf). A body that breaks off for any other reason (reset
 * connection, Bun's own timer) throws ProviderError 'truncated_stream' (category network); the
 * adapter re-wraps it with the right afterOutput. A null body yields nothing.
 */
export async function* bodyBytes(res: Response, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const source = res.body;
  if (!source) return;
  const reader = source.getReader();
  const cancel = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        if (err instanceof ProviderError) throw err;
        throw providerError('truncated_stream', 'the response body broke off', { detail: errorText(err) });
      }
      signal.throwIfAborted();
      if (chunk.done) return;
      if (chunk.value.byteLength > 0) yield chunk.value;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* Bun 1.3: releaseLock after cancel can throw inside Bun; the reader is finished either way. */
    }
  }
}
