// M3 invariant (decisions I, C1, R14): no tools offered ⇒ the request and the trace are exactly M2's.
// The digests below were captured by running m2-scenarios.ts against the M2 tree (git HEAD c478eed,
// `git archive HEAD src`) with M2's own assemble; the M3 assemble must reproduce them byte for byte.
import { describe, expect, test } from 'bun:test';
import { assemble, CORE_TOOLS_SRC } from '../../src/prompt/assemble.ts';
import type { Trace } from '../../src/session/entries.ts';
import { base, CAPS, digest, okOf, RICH, scenarios, SPECS } from './fixtures.ts';

/** sha-256 of m2Json(assemble(input)) per scenario, from the M2 code. */
const M2_DIGESTS: Record<string, string> = {
  'builtin-short': 'f0a7041324a7cc8117328c8302db0606d62fdec91bfb6461ab958961ffa69d81',
  'mixed-history': '11fa51d62dcd326ad5f5f8a8b717deba1741680ed06dcb44fd7e8da5191d29d6',
  'lore-notes-guidance': 'c69a06f72a937989c6d534c06ab4f831e205b5088e3c8b60d7fa062fdc92855b',
  trimmed: '3302b1819f310e6f6ea36f736fa9460e5836e38358ec7e5fbbf3aec708fd5737',
  'trimmed-factor': '9b0e68298e94972f4004c76cf40e96dbd7c4d98254b0affdefc596d42645921a',
  'greeting-dropped': '189b28dd02c4d00fd6e9fb07ac658934814bd2455c6dfdbbe4f93e284b828376',
  exceeded: 'fa7f45d576a9b0bda721a16d77662adf020870d20dc7277b4196f07c1c51587c',
  'rich-prefill': 'a831e74b523d7af5d1b48d2a479415877c313c5b9a1d88bd94ccc5c1b16fce35',
  'rich-strict-max': '0eec7679899ffd6c8be62a793240636ae546be2cda638b3aadfd309d56a7683f',
  'continue-prefill': '1b0f12b8e62f6d62ea63d6a3aa9bffd5c21be9d0eeb8f95cb52b1f23dd536df1',
  'continue-cue': 'ca7200ba5b6cf46aa4a8e67842e47a8e3e9ecbce885da02311905a15e68b31b3',
  o200k: '96a4bfced2536f80370a4bc8fcbc41027e477330ea9bf36545eedb99c1f430b1',
};

const ALL = scenarios();

describe('no tools: byte-identical to M2', () => {
  test('every scenario is pinned', () => {
    expect(ALL.map((s) => s.name).sort()).toEqual(Object.keys(M2_DIGESTS).sort());
  });

  for (const s of ALL) {
    test(`${s.name}: tools [] reproduces M2's messages, trace, notices`, () => {
      const r = assemble(s.input);
      expect(digest(r)).toBe(M2_DIGESTS[s.name]!);
      if (r.ok) {
        expect(r.toolRoom).toBe(0);
        expect(r.tools).toEqual([]);
        expect(r.messages.some((m) => m.src === CORE_TOOLS_SRC)).toBe(false);
      }
    });

    test(`${s.name}: echoReasoning without tools changes nothing`, () => {
      const r = assemble({ ...s.input, echoReasoning: { connection: 'local', model: 'm1' } });
      expect(digest(r)).toBe(M2_DIGESTS[s.name]!);
    });

    test(`${s.name}: tools on a model with caps.tools 'none' are never offered`, () => {
      const r = assemble({ ...s.input, tools: SPECS, caps: { ...s.input.caps, tools: 'none' } });
      expect(digest(r)).toBe(M2_DIGESTS[s.name]!);
    });
  }

  test('the scenarios cover what they are named for', () => {
    const by = (name: string) => assemble(ALL.find((s) => s.name === name)!.input);
    expect(okOf(by('trimmed')).trace.trimmed).not.toBeNull();
    expect(okOf(by('trimmed-factor')).trace.trimmed).not.toBeNull();
    expect(okOf(by('greeting-dropped')).notices.map((n) => n.code)).toContain('greeting_dropped');
    expect(by('exceeded').ok).toBe(false);
    expect(okOf(by('rich-prefill')).trace.prefill).toBe('sent');
    expect(okOf(by('rich-strict-max')).trace.trimmed).not.toBeNull();
    expect(okOf(by('o200k')).trace.tokens.counter).toBe('o200k');
    // The reasoning of a1 never reaches a tool-less request.
    expect(JSON.stringify(okOf(by('mixed-history')).messages)).not.toContain('secret thoughts');
  });

  test('continue never offers tools: the request is the M2 one whatever is passed', () => {
    for (const name of ['continue-prefill', 'continue-cue']) {
      const s = ALL.find((x) => x.name === name)!;
      const r = assemble({ ...s.input, tools: SPECS, echoReasoning: { connection: 'local', model: 'm1' } });
      expect(digest(r)).toBe(M2_DIGESTS[name]!);
    }
  });

  test("D-28 'prefill': the prefill wins, the messages are M2's, only the trace's prefill verdict says why", () => {
    const m2 = okOf(assemble(base({ preset: RICH })));
    const r = okOf(assemble(base({ preset: RICH, tools: SPECS, echoReasoning: { connection: 'local', model: 'm1' } })));
    expect(r.tools).toEqual([]);
    expect(r.toolRoom).toBe(0);
    expect(r.prefill).toBe(m2.prefill);
    expect(r.messages).toEqual(m2.messages);
    const asSent: Trace = { ...r.trace, prefill: 'sent' };
    expect(asSent).toEqual(m2.trace);
    expect(r.trace.prefill).toBe('tools_off');
    expect(r.notices.map((n) => n.code)).toEqual(['prefill_disables_tools', ...m2.notices.map((n) => n.code)]);
    expect(r.kept).toEqual(m2.kept);
  });

  test('the fixture caps offer native tools (so the cases above really had tools to drop)', () => {
    expect(CAPS.tools).toBe('native');
  });
});
