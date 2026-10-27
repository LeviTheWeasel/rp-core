// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// `rp-core preview <session>` (ARCHITECTURE.md §6.1 `preview`, §12.3, §15 M2 "Отладка", D-45): the
// exact request a turn would send, built the way a turn builds it and never sent. The session is
// opened (lock and recovery, as for any open) but no turn runs and nothing is written by the
// preview itself. The same renderer as the REPL's /preview; --json prints the PreviewResult as is.
//
// Output contract, as for send: stdout carries the product (the rendered request, the wire body,
// or the JSON), everything for humans goes to stderr — with --wire that is the notices and the
// verdicts too, so stdout stays the JSON body. A preview that cannot be built exits 5 with
// {"type":"refusal","code","message"} as the last stderr line, like a refused turn.

import { Engine } from '../engine/engine.ts';
import { Refusal, type EngineOptions, type PreviewOptions, type SessionHandle } from '../engine/api.ts';
import { readSessionFile } from '../session/log.ts';
import type { Io } from './io.ts';
import { EXIT, reportRefusal } from './oneshot.ts';
import { entryTitles } from './refs.ts';
import { NOTES_BOOK_KEY, noteRefs } from '../agents/compendium/notes.ts';
import { entryLabel } from '../lore/engine.ts';
import { describeEvent } from './render.ts';
import { configOf, journalOf, resolveMessageId } from './repl-journal.ts';
import { makeStyle, previewFailureText, renderPreview, renderVerdicts } from './repl-render.ts';
import type { PreviewResult } from '../engine/api.ts';
import { bindingCaps, engineOptions, redactor, type Runtime } from './runtime.ts';

export interface PreviewArgs {
  home: string;
  sessionId: string;
  /** A reply to this text, as if it were sent. */
  draft?: string;
  /** A past answer's id (or a unique prefix): its request rebuilt. */
  turn?: string;
  /** Print the HTTP body instead (when the connection has one). */
  wire: boolean;
  /** Also every lore entry's verdict. */
  verdicts: boolean;
  json: boolean;
  io: Io;
  rt: Runtime;
  /** Extra engine options (tests: clock, random). */
  engine?: Partial<EngineOptions>;
}

/**
 * A --turn prefix → the full id (the journal is read without the lock's help; the session holds it),
 * or a refusal: a prefix that names no answer is a preview that cannot be built (exit 5).
 */
function turnId(home: string, session: SessionHandle, prefix: string): { ok: true; id: string } | { ok: false; code: 'not_found' | 'invalid_params'; message: string } {
  const { header, entries } = readSessionFile(home, session.id);
  const found = resolveMessageId(journalOf(header, entries), prefix);
  if (found.ok) return found;
  return { ok: false, code: found.message.startsWith('no message') ? 'not_found' : 'invalid_params', message: `--turn: ${found.message}` };
}

export async function cmdPreview(a: PreviewArgs): Promise<number> {
  const engine = await Engine.open({ ...a.engine, ...engineOptions(a.rt), home: a.home });
  let session: SessionHandle | null = null;
  try {
    try {
      session = engine.session(a.sessionId);
    } catch (e) {
      if (e instanceof Refusal) return reportRefusal(a.io, e, a.json, a.rt);
      throw e;
    }
    const redact = redactor(a.rt);
    // Recovery happened while opening: say so on stderr (stdout stays the product).
    for (const ev of session.openEvents()) {
      const line = describeEvent(ev);
      if (line !== null) a.io.err.write(`rp-core: ${redact(line)}\n`);
    }
    let turn: string | undefined;
    if (a.turn !== undefined) {
      const t = turnId(a.home, session, a.turn);
      if (!t.ok) {
        if (a.json) a.io.out.write(`${redact(JSON.stringify(t))}\n`);
        else a.io.err.write(`rp-core: ${redact(t.message)}\n`);
        a.io.err.write(`${JSON.stringify({ type: 'refusal', code: t.code, message: t.message })}\n`);
        return EXIT.refused;
      }
      turn = t.id;
    }
    const opts: PreviewOptions = {
      ...(a.draft !== undefined ? { draft: a.draft } : {}),
      ...(turn !== undefined ? { turn } : {}),
      ...(a.verdicts ? { explain: true } : {}),
    };
    const r = session.preview(opts);
    if (a.json) {
      a.io.out.write(`${redact(JSON.stringify(r))}\n`);
      if (!r.ok) a.io.err.write(`${JSON.stringify({ type: 'refusal', code: r.code, message: r.message })}\n`);
      return r.ok ? EXIT.done : EXIT.refused;
    }
    if (!r.ok) {
      a.io.err.write(`rp-core: ${redact(previewFailureText(r))}\n`);
      // Only a greeting so far: the next turn would be a swipe of it, which a greeting never is.
      if (r.code === 'nothing_to_swipe' && a.draft === undefined && a.turn === undefined) {
        a.io.err.write('rp-core: nothing to build yet: use --draft "text" to preview a reply to that text\n');
      }
      a.io.err.write(`${JSON.stringify({ type: 'refusal', code: r.code, message: r.message })}\n`);
      return EXIT.refused;
    }
    const style = makeStyle(false);
    const header = session.header();
    const { entries } = readSessionFile(a.home, session.id);
    const titles = entryTitles(a.home, header.cast, configOf(journalOf(header, entries)).lorebooks);
    // M3: a note that fired is named by its title too.
    for (const { entry } of noteRefs(session.view().compendium)) titles.set(entryLabel(NOTES_BOOK_KEY, entry.key), entry.name);
    const verdicts = (ok: Extract<PreviewResult, { ok: true }>): string =>
      `lore verdicts:\n${renderVerdicts(ok.verdicts ?? [], ok.trace.lore, style, titles, Infinity, ok.loreUse)}`;
    if (a.wire) {
      if (r.wire) {
        a.io.err.write(`rp-core: POST ${r.wire.url}\n`);
        a.io.out.write(`${redact(JSON.stringify(r.wire.body, null, 2))}\n`);
        // stdout is the body; the notices (preview_inputs_changed among them) and verdicts go to stderr.
        for (const n of r.notices) a.io.err.write(`rp-core: ${redact(`${n.level}: ${n.message} (${n.code})`)}\n`);
        if (a.verdicts) a.io.err.write(`${redact(verdicts(r))}\n`);
        return EXIT.done;
      }
      a.io.err.write('rp-core: this connection has no wire form (an in-process provider); printing the messages instead\n');
    }
    let text = renderPreview(r, style, titles, bindingCaps(a.rt, r.model.connection, r.model.model)?.tools ?? null);
    if (a.verdicts) text += `\n\n${verdicts(r)}`;
    a.io.out.write(`${redact(text)}\n`);
    return EXIT.done;
  } finally {
    if (session) await session.close();
    await engine.close();
  }
}
