// M3 AssembleResult.kept (D-56 inContext, decisions C2): the ids of the path messages whose text the
// request carries, in path order — hidden, blank and trimmed messages out; the greeting only when sent.
import { describe, expect, test } from 'bun:test';
import { assemble, HISTORY_SRC } from '../../src/prompt/assemble.ts';
import type { PromptMsg } from '../../src/providers/types.ts';
import type { PathView } from '../../src/session/view.ts';
import { CAPS, chain, longChat, msg, okOf, runOk, scenarios, SPECS, textOf } from './fixtures.ts';

const scenario = (name: string) => scenarios().find((s) => s.name === name)!.input;

/** The texts of the path messages `ids` names (user texts carry no macros in these fixtures). */
const textsOf = (view: PathView, ids: readonly string[]): string[] =>
  ids.map((id) => view.path.find((m) => m.id === id)!.blocks.map((b) => (b.k === 'text' ? b.text : '')).join(''));

/** The texts of the chat messages a request sends, in order. */
const sentChat = (msgs: readonly PromptMsg[]): string[] => msgs.filter((m) => m.src === HISTORY_SRC).map(textOf);

describe('kept', () => {
  test('everything fits: every path message with text, hidden and blank ones out', () => {
    const input = scenario('mixed-history');
    const r = okOf(assemble(input));
    expect(r.kept).toEqual(['g', 'u1', 'a1', 'u3']); // u2 is hidden, a2 is blank
    expect(okOf(assemble({ ...input, tools: SPECS })).kept).toEqual(['g', 'u1', 'a1', 'u3']);
  });

  test('a trimmed range is out; the greeting stays; the order is the path order; the request sends exactly these', () => {
    const input = scenario('trimmed');
    const r = okOf(assemble(input));
    const ids = input.view.path.map((m) => m.id);
    expect(r.trace.trimmed).not.toBeNull();
    const from = ids.indexOf(r.trace.trimmed!.from);
    const to = ids.indexOf(r.trace.trimmed!.to);
    expect(r.kept).toEqual(['g', ...ids.slice(to + 1)]);
    expect(from).toBe(1);
    expect(sentChat(r.messages)).toEqual(textsOf(input.view, r.kept));
  });

  test('the greeting dropped as a last resort is not kept', () => {
    const input = scenario('greeting-dropped');
    const r = okOf(assemble(input));
    expect(r.notices.map((n) => n.code)).toContain('greeting_dropped');
    expect(r.kept).not.toContain('g');
    expect(sentChat(r.messages)).toEqual(textsOf(input.view, r.kept));
  });

  test('tools trim more, so fewer messages are in context', () => {
    const view = chain(longChat(40));
    const plain = runOk({ view, window: 4000, reserve: 500 });
    const tools = runOk({ view, window: 4000, reserve: 500, tools: SPECS });
    expect(tools.kept.length).toBeLessThan(plain.kept.length);
    expect(plain.kept.slice(-tools.kept.length + 1)).toEqual(tools.kept.slice(1));
    expect(sentChat(tools.messages)).toEqual(textsOf(view, tools.kept));
  });

  test('continue: the answer being continued is in context (sent as the prefill or as a message)', () => {
    const pre = okOf(assemble(scenario('continue-prefill')));
    expect(pre.kept.at(-1)).toBe('a3');
    expect(pre.kept.at(-2)).toBe('u3');
    const cue = okOf(assemble(scenario('continue-cue')));
    expect(cue.kept.at(-1)).toBe('a3');
  });

  test('a blank message the turn is about is sent but carries no text: not kept', () => {
    const view = chain([...longChat(2), msg('a2', 'assistant', 'The road ends.'), msg('u3', 'user', '')]);
    const r = runOk({ view });
    expect(r.kept).toEqual(['g', 'u1', 'a1', 'u2', 'a2']);
    expect(r.messages.filter((m) => m.src === HISTORY_SRC)).toHaveLength(6);
  });

  test('an exceeded request has no kept list (it is refused)', () => {
    expect(assemble(scenario('exceeded')).ok).toBe(false);
  });

  test('kept does not depend on what is injected into the chat (depth inserts are not path messages)', () => {
    const r = runOk({
      view: chain(longChat(3)),
      authorNote: { text: 'Note.', depth: 1, role: 'system' },
      placements: [{ depth: 0, role: 'system', src: 'director', text: 'Direct.' }],
      caps: CAPS,
    });
    expect(r.kept).toEqual(['g', 'u1', 'a1', 'u2', 'a2', 'u3']);
    expect(runOk({ view: chain(longChat(3)) }).kept).toEqual(r.kept);
  });
});
