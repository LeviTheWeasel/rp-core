// M2 REPL output, pure: verdict lines, the lore lines of /trace, /preview, /preset and /lore listings.
import { describe, expect, test } from 'bun:test';
import type { PreviewResult } from '../../src/engine/api.ts';
import type { LoreVerdict } from '../../src/lore/engine.ts';
import {
  loreTraceLines,
  makeStyle,
  previewFailureText,
  promptText,
  renderImported,
  renderLoreBooks,
  renderPresets,
  renderPreview,
  renderTrace,
  renderTraceMisses,
  renderVerdicts,
  renderWire,
} from '../../src/cli/repl-render.ts';
import type { Trace } from '../../src/session/entries.ts';

const plain = makeStyle(false);

const trace = (over: Partial<Trace> = {}): Trace => ({
  seed: 1,
  now: '2026-10-26T12:00:00.000Z',
  window: 8192,
  reserve: 512,
  tokens: { estimated: 300, counter: 'o200k' },
  blocks: [
    { src: 'main', role: 'system', tok: 20 },
    { src: 'history', role: 'user', tok: 9 },
  ],
  lore: { fired: [], cut: [], budget: 0 },
  recap: { ids: [], arcs: [], boundary: null },
  prefill: null,
  macros: { unknown: [] },
  trimmed: null,
  calls: [],
  agents: {},
  presetHash: 'h',
  loreHashes: {},
  ...over,
});

const v = (over: Partial<LoreVerdict> & Pick<LoreVerdict, 'id' | 'fired' | 'why'>): LoreVerdict => ({ book: 'harbor', matched: [], loop: 0, tokens: 10, ...over });

describe('renderVerdicts', () => {
  test('fired first with keys and tokens; the others with their numbers', () => {
    const out = renderVerdicts(
      [
        v({ id: 'a', fired: false, why: 'chance', title: 'Storm', detail: { rolled: 0.71, needed: 0.5 } }),
        v({ id: 'b', fired: true, why: 'key', title: 'Gull Point', matched: ['lighthouse', 'beacon'], tokens: 86 }),
        v({ id: 'c', fired: false, why: 'cooldown', detail: { remaining: 2 } }),
        v({ id: 'd', fired: false, why: 'budget-cut', tokens: 300, detail: { cost: 300, left: 120 } }),
        v({ id: 'e', fired: true, why: 'recursion', matched: ['keeper'], loop: 2, tokens: 5 }),
        v({ id: 'f', fired: true, why: 'sticky', detail: { remaining: 1 }, tokens: 7 }),
        v({ id: 'g', fired: false, why: 'regex-error', regexErrors: ['/(?<=x)y/'] }),
        v({ id: 'h', fired: false, why: 'delay', detail: { remaining: 3 } }),
        v({ book: '@card', id: '0', fired: true, why: 'constant', tokens: 54 }),
      ],
      { fired: [], cut: ['harbor:d'], budget: 512 },
      plain,
      new Map([['@card:0', 'Mira past']]),
    );
    expect(out.split('\n')).toEqual([
      '  ✓ "Gull Point" harbor:b · key · keys: lighthouse, beacon · 86 tok',
      '  ✓ harbor:e · recursion · keys: keeper · recursion loop 2 · 5 tok',
      '  ✓ harbor:f · sticky · sticky for 1 more message · 7 tok',
      '  ✓ "Mira past" @card:0 · constant · 54 tok',
      '  ✗ "Storm" harbor:a · chance · roll 0.71 > 0.50',
      '  ✗ harbor:c · cooldown · cooldown: 2 more messages',
      '  ✗ harbor:d · budget-cut · costs 300 budget tok, 120 left',
      '  ✗ harbor:g · regex-error · bad regex /(?<=x)y/',
      '  ✗ harbor:h · delay · delayed: 3 more messages',
      '4 of 9 fired · 1 cut by the budget · 152 tok of lore · budget 512 budget tok',
    ]);
  });

  // Regression: entry lines showed the budget's corrected counts and /preview the raw ones, both as
  // 'tok'; a budget cut ended in an unlabelled number.
  test('entries show their raw counts; the budget line is in budget tokens and names the factor', () => {
    const verdicts = [
      v({ id: 'b', fired: true, why: 'key', matched: ['lighthouse'], tokens: 99, rawTokens: 86 }),
      v({ id: 'd', fired: false, why: 'budget-cut', tokens: 345, rawTokens: 300, detail: { cost: 346, left: 120 } }),
      v({ book: '@card', id: '0', fired: true, why: 'constant', tokens: 63, rawTokens: 54 }),
    ];
    const lore = { fired: [], cut: ['harbor:d'], budget: 949 };
    expect(renderVerdicts(verdicts, lore, plain, undefined, 40, { used: 163, factor: 1.15 }).split('\n')).toEqual([
      '  ✓ harbor:b · key · keys: lighthouse · 86 tok',
      '  ✓ @card:0 · constant · 54 tok',
      '  ✗ harbor:d · budget-cut · costs 346 budget tok, 120 left',
      '2 of 3 fired · 1 cut by the budget · 140 tok of lore · 163 of 949 budget tok (counts ×1.15 for this model)',
    ]);
    // No correction learned yet (factor 1): the budget line has no factor to name.
    expect(renderVerdicts(verdicts, lore, plain, undefined, 40, { used: 141, factor: 1 }).split('\n').at(-1)).toBe(
      '2 of 3 fired · 1 cut by the budget · 140 tok of lore · 141 of 949 budget tok',
    );
  });

  test('a large book: the no-key-match and disabled tail is folded into one line', () => {
    const many = [v({ id: 'hit', fired: true, why: 'key', matched: ['x'] }), ...Array.from({ length: 50 }, (_, i) => v({ id: `n${i}`, fired: false, why: i % 10 === 0 ? 'disabled' : 'no-key-match' }))];
    const lines = renderVerdicts(many, { fired: [], cut: [], budget: 100 }, plain, undefined, 5).split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain('✓ harbor:hit');
    expect(lines[5]).toBe('  … and 46 more not fired (no-key-match 42, disabled 4)');
    expect(lines[6]).toBe('1 of 51 fired · 10 tok of lore · budget 100 budget tok');
    // Unlimited: every entry gets its line.
    expect(renderVerdicts(many, undefined, plain, undefined, Infinity).split('\n')).toHaveLength(52);
  });

  test('an entry past the recursion limit says so and is not folded into the no-key-match tail', () => {
    const many = [
      v({ id: 'l4', fired: false, why: 'no-key-match', matched: ['k4'], loop: 4, detail: { recursionLimit: 3 } }),
      ...Array.from({ length: 10 }, (_, i) => v({ id: `n${i}`, fired: false, why: 'no-key-match' })),
    ];
    const lines = renderVerdicts(many, undefined, plain, undefined, 1).split('\n');
    expect(lines[0]).toBe('  ✗ harbor:l4 · no-key-match · keys: k4 · recursion would wake it, but it stops after 3 loops');
    expect(lines[1]).toBe('  … and 10 more not fired (no-key-match 10)');
  });

  test('no entries; colour dims what did not fire', () => {
    expect(renderVerdicts([], undefined, plain)).toContain('no lore entries to test');
    const color = renderVerdicts([v({ id: 'x', fired: false, why: 'no-key-match' })], undefined, makeStyle(true));
    expect(color).toContain('\x1b[2m  ✗ harbor:x · no-key-match\x1b[22m');
  });
});

describe('/trace: the recomputed misses [D-45]', () => {
  const lore = { fired: [{ book: 'harbor', id: 'hit', why: 'key' }], cut: ['harbor:big'], budget: 300 };
  const verdicts = [
    v({ id: 'hit', fired: true, why: 'key', matched: ['x'] }),
    v({ id: 'storm', fired: false, why: 'chance', title: 'Storm', detail: { rolled: 0.71, needed: 0.5 } }),
    v({ id: 'big', fired: false, why: 'budget-cut', detail: { cost: 400, left: 120 } }),
    v({ id: 'late', fired: false, why: 'budget-cut', detail: { cost: 90, left: 20 } }),
    v({ id: 'after', fired: false, why: 'budget-cut', detail: { cost: 3, left: 153, overflowed: true } }),
    ...Array.from({ length: 12 }, (_, i) => v({ id: `n${i}`, fired: false, why: i < 3 ? 'disabled' : 'no-key-match' })),
  ];

  test("each miss with its own reason on a line; the bulk as one count; cuts the stored line names are not repeated", () => {
    expect(renderTraceMisses(verdicts, lore, plain)).toEqual([
      '  lore not fired (recomputed from its seed):',
      '    ✗ "Storm" harbor:storm · chance · roll 0.71 > 0.50',
      '    ✗ harbor:late · budget-cut · costs 90 budget tok, 20 left',
      '    ✗ harbor:after · budget-cut · skipped: an earlier entry had already used up the budget (alone it costs 3 budget tok)',
      '    ✗ 12 more: disabled 3, no-key-match 9',
    ]);
  });

  test('only bulk misses: one line; a continue says whose request the verdicts are; nothing missed: nothing', () => {
    const bulk = verdicts.filter((x) => x.fired || x.why === 'disabled' || x.why === 'no-key-match');
    expect(renderTraceMisses(bulk, lore, plain, undefined, true)).toEqual([
      "  lore not fired (recomputed for the answer's own request, before its continue):",
      '    ✗ 12 entries: disabled 3, no-key-match 9',
    ]);
    expect(renderTraceMisses([verdicts[0]!], lore, plain)).toEqual([]);
  });

  test('renderTrace puts them right after the stored lore lines', () => {
    const t = trace({ lore, calls: [{ callKey: 'k', agent: 'narrator', model: 'm', ms: 1500 }] });
    const out = renderTrace('abcd1234', { trace: t, continued: false }, undefined, renderTraceMisses(verdicts, lore, plain)).split('\n');
    const cut = out.findIndex((l) => l.startsWith('  lore cut by the budget'));
    expect(out[cut + 1]).toBe('  lore not fired (recomputed from its seed):');
    expect(out.at(-1)).toBe('  calls: narrator m 1.5s');
  });
});

describe('/trace lore lines', () => {
  test('fired with why, cut labels, the budget; nothing for a trace without lore', () => {
    expect(loreTraceLines(trace())).toEqual([]);
    expect(loreTraceLines(trace({ lore: { fired: [], cut: [], budget: 300 } }))).toEqual(['  lore: nothing fired · budget 300 tok']);
    const t = trace({
      lore: {
        fired: [
          { book: 'harbor', id: '0', why: 'key' },
          { book: '@card', id: '1', why: 'constant' },
        ],
        cut: ['harbor:7', 'harbor:9'],
        budget: 512,
      },
    });
    expect(loreTraceLines(t, new Map([['harbor:0', 'Gull Point'], ['harbor:9', 'Old keeper']]))).toEqual([
      '  lore fired: 2 · budget 512 tok',
      '    ✓ "Gull Point" harbor:0 (key)',
      '    ✓ @card:1 (constant)',
      '  lore cut by the budget: harbor:7, "Old keeper" harbor:9',
    ]);
    expect(renderTrace('abcd1234', { trace: t, continued: false })).toContain('  lore cut by the budget: harbor:7, harbor:9');
  });

  test('an entry that fired but was not sent (its slot is off in the preset) says so, in /trace and /lore test', () => {
    // Regression: /trace and /lore test showed it as fired with no hint its text went nowhere.
    const lore = { fired: [{ book: 'harbor', id: '0', why: 'key' }], cut: [], budget: 512, unsent: { 'harbor:0': '{{lore::before}}' } };
    expect(loreTraceLines(trace({ lore }), new Map([['harbor:0', 'Gull Point']]))).toEqual([
      '  lore fired: 1 · budget 512 tok',
      '    ✓ "Gull Point" harbor:0 (key) · not sent: the preset has no enabled {{lore::before}}',
    ]);
    const out = renderVerdicts([v({ id: '0', fired: true, why: 'key', matched: ['lighthouse'], tokens: 13 })], lore, plain);
    expect(out.split('\n')[0]).toBe('  ✓ harbor:0 · key · keys: lighthouse · 13 tok · not sent: the preset has no enabled {{lore::before}}');
  });
});

describe('renderPreview', () => {
  const ok: Extract<PreviewResult, { ok: true }> = {
    ok: true,
    kind: 'reply',
    upTo: 'draft',
    model: { connection: 'local', model: 'qwen' },
    messages: [
      { role: 'system', src: 'main', blocks: [{ k: 'text', text: 'You are the narrator.\nBe brief.' }] },
      { role: 'user', src: 'history', blocks: [{ k: 'text', text: 'Hello' }] },
    ],
    prefill: '*She',
    tools: [],
    maxTokens: 400,
    samplers: { temperature: 0.8, stop: ['\n\n'] },
    trace: trace({ lore: { fired: [{ book: 'harbor', id: '0', why: 'key' }], cut: [], budget: 100 } }),
    notices: [{ level: 'warn', code: 'preset_prefill_vs_tools', message: 'Tools are off.' }],
  };

  test('kind, model, numbered messages with role, source, tokens and full text, then settings', () => {
    expect(renderPreview(ok, plain).split('\n')).toEqual([
      'preview of a reply to your draft · local:qwen',
      '  window 8192 · reserve 512 · prompt ~300 tok (o200k) · 2 messages · nothing was sent',
      '',
      '#1 system · main · 20 tok',
      'You are the narrator.',
      'Be brief.',
      '',
      '#2 user · history · 9 tok',
      'Hello',
      '',
      'prefill: "*She" · max tokens 400 · samplers: temperature 0.8, stop ["\\n\\n"]',
      'tools: none',
      '  lore fired: 1 · budget 100 tok',
      '    ✓ harbor:0 (key)',
      '! Tools are off. (preset_prefill_vs_tools)',
    ]);
  });

  test('samplers the connection does not send are named apart, not shown as sent', () => {
    // Regression: the samplers line listed every sampler of the preset, top_k and the rest included,
    // although the connection drops them (--wire showed the truth).
    const lines = renderPreview({ ...ok, samplers: { temperature: 1, top_p: 1, top_k: 0, min_p: 0, repetition_penalty: 1 }, samplersNotSent: ['top_k', 'min_p', 'repetition_penalty'] }, plain).split('\n');
    expect(lines).toContain('prefill: "*She" · max tokens 400 · samplers: temperature 1, top_p 1');
    expect(lines).toContain('not sent by this connection: top_k, min_p, repetition_penalty');
  });

  test('token counts fall back to an estimate when shaping merged messages', () => {
    const merged = { ...ok, trace: trace({ blocks: [{ src: 'main', role: 'system', tok: 20 }] }) };
    expect(renderPreview(merged, plain)).toMatch(/#2 user · history · \d+ tok/);
  });

  test('kinds, wire, failures, tool blocks', () => {
    expect(renderPreview({ ...ok, kind: 'swipe', upTo: 'u1' }, plain)).toContain('preview of a swipe (a new answer to u1)');
    expect(renderPreview({ ...ok, kind: 'continue', upTo: 'a1' }, plain)).toContain('preview of a continue of a1');
    expect(renderWire({ url: 'http://x/v1/chat/completions', body: { model: 'm' } })).toBe('POST http://x/v1/chat/completions\n{\n  "model": "m"\n}');
    expect(previewFailureText({ ok: false, code: 'preset_missing', message: "preset 'x' is not in the library" })).toBe(
      "preview refused [preset_missing]: the session's preset is missing (preset 'x' is not in the library)",
    );
    expect(previewFailureText({ ok: false, code: 'assemble_failed', message: 'boom' })).toBe('preview refused [assemble_failed]: boom');
    expect(
      promptText({
        role: 'assistant',
        src: 'history',
        blocks: [
          { k: 'text', text: 'Let me look. ' },
          { k: 'tool_call', id: 'c1', name: 'search', args: '{"q":"x"}' },
        ],
      }),
    ).toBe('Let me look. [tool call search {"q":"x"}]');
  });
});

describe('/preset and /lore listings, imports', () => {
  test('presets: builtin first, the current one starred', () => {
    expect(renderPresets('lighthouse', [{ id: 'lighthouse', name: 'Lighthouse' }, { id: 'plain', name: 'plain' }])).toBe(
      [
        'preset: lighthouse',
        '  builtin     the built-in layout',
        '* lighthouse  "Lighthouse"',
        '  plain',
        '(/preset <id> switches; /preset <file> imports a SillyTavern preset first)',
      ].join('\n'),
    );
    expect(renderPresets('gone', [])).toContain('preset: gone (missing from the library: the next turn is refused)');
  });

  // Regression: a preset imported as Builtin.json (or --as builtin) was listed as a second builtin
  // that could never be selected.
  test("a library file named builtin is never listed as the built-in layout; it is named apart", () => {
    const out = renderPresets('builtin', [{ id: 'builtin', name: 'Builtin' }, { id: 'plain', name: 'plain' }]);
    expect(out.split('\n')).toEqual([
      'preset: builtin',
      '* builtin  the built-in layout',
      '  plain',
      "(library/presets/builtin.json is not listed: 'builtin' always means the built-in layout; rename the file to use it)",
      '(/preset <id> switches; /preset <file> imports a SillyTavern preset first)',
    ]);
    expect(out.match(/builtin {2}/g)).toHaveLength(1);
  });

  test("the current preset's window cap: named when it shrinks the model's window or the model's is unknown", () => {
    const lib = [{ id: 'st', name: 'Default' }];
    expect(renderPresets('st', lib, { maxContext: 4095, model: 16384 }).split('\n')[0]).toBe("preset: st · it caps the window at 4095 of the model's 16384 tokens");
    expect(renderPresets('st', lib, { maxContext: 4095, model: null }).split('\n')[0]).toBe('preset: st · it caps the window at 4095 tokens');
    expect(renderPresets('st', lib, { maxContext: 32768, model: 16384 }).split('\n')[0]).toBe('preset: st');
    expect(renderPresets('st', lib, { model: 16384 }).split('\n')[0]).toBe('preset: st');
  });

  test('books in scan order, problems named, spare library books', () => {
    const out = renderLoreBooks(
      [
        { key: '@persona', owner: 'persona', name: 'Me', entries: 1, disabled: 0 },
        { key: '@card', owner: 'card', name: 'World', entries: 4, disabled: 1, shadowedBy: 'world' },
        { key: 'world', owner: 'session', name: 'World', entries: 4, disabled: 0 },
        { key: 'ghost', owner: 'session', problem: 'missing from the library' },
      ],
      [{ id: 'harbor', name: 'Harbor' }, { id: 'ghost', name: 'ghost' }],
    );
    expect(out.split('\n')).toEqual([
      'lorebooks, in the order a turn scans them:',
      '  @persona  your persona\'s book "Me" · 1 entry',
      '  @card     the card\'s own book "World" · 4 entries (1 disabled) · not read: world has the same name (a world is read once, as in SillyTavern)',
      '  world     "World" · 4 entries',
      '  ghost     (missing from the library)',
      'in the library, not in this session: harbor (/lore add <id>)',
    ]);
  });

  test('an import with many warnings is cut short', () => {
    const warnings = Array.from({ length: 5 }, (_, i) => ({ code: 'not_honoured', path: `p${i}`, message: `w${i}` }));
    expect(renderImported('preset', { file: 'x.json', path: '/l/x.json', warnings }, 'x').split('\n')).toEqual([
      'imported preset x from x.json (5 warnings)',
      '  ! w0 (p0)',
      '  ! w1 (p1)',
      '  ! w2 (p2)',
      '  … and 2 more (rp-core import <file> lists them all)',
    ]);
  });
});
