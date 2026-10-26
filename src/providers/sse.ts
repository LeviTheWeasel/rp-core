// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// Server-sent events reader (ARCHITECTURE.md §8.1 "Общий sse.ts"). One byte stream, one TextDecoder,
// LF or CRLF, 'data:' with or without a space, ':' comment lines skipped, multi-line data joined by
// '\n', an event dispatched on a blank line (and a pending one at EOF). Termination policy ([DONE],
// usage after finish, truncated streams) belongs to the adapter's parser, not here.
// CONTRACT FILE (M1b): signature is fixed; the transport agent implements the body.

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export function sseEvents(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  void bytes;
  throw new Error('not implemented: sseEvents');
}
