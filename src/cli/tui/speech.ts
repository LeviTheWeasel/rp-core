// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors

import type { TextChunk } from '@opentui/core';
import { CLOSE_QUOTES, OPEN_QUOTES } from '../repl-render.ts';
import { appendChunks } from './sgr.ts';
import type { Theme } from './types.ts';

/** Colour quoted dialogue while retaining each chunk's bold and italic attributes. */
export function speechColourer(theme: Theme): { paint(chunks: readonly TextChunk[]): TextChunk[] } {
  let quoted = false;
  return {
    paint(chunks): TextChunk[] {
      if (theme.mono) return [...chunks];
      const out: TextChunk[] = [];
      for (const part of chunks) {
        let text = '';
        let speech = false;
        const flush = (): void => {
          if (text) appendChunks(out, [{ ...part, text, fg: speech ? theme.speech : part.fg }]);
          text = '';
        };
        for (const ch of part.text) {
          const opening = (!quoted && ch === '"') || (!quoted && OPEN_QUOTES.has(ch));
          const closing = (quoted && ch === '"') || (quoted && CLOSE_QUOTES.has(ch));
          const nextSpeech = ch !== '\n' && (quoted || opening);
          if (nextSpeech !== speech) {
            flush();
            speech = nextSpeech;
          }
          text += ch;
          if (ch === '\n') quoted = false;
          else if (opening) quoted = true;
          else if (closing) quoted = false;
          if (closing) {
            flush();
            speech = false;
          }
        }
        flush();
      }
      return out;
    },
  };
}
