// SillyTavern chat-completion preset → core.preset/1 (ARCHITECTURE.md §10.2, §10.5, D-43, D-70, D-71).
// Cases follow Bunraku's preset.test.ts and st-preset-tolerance.test.ts (prompt_order law, string
// numbers, the custom_prompt_post_processing key) and ST's openai.js / PromptManager.js behaviour.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { historySlots } from '../../src/prompt/assemble/slots.ts';
import { validatePreset, type Preset, type PresetBlock } from '../../src/formats/native.ts';
import {
  isRoleCallExport,
  rewriteRcRandom,
  ST_GLOBAL_ORDER_ID,
  ST_MARKER_SLOTS,
  stPresetToPreset,
} from '../../src/formats/st-preset.ts';

type Rec = Record<string, unknown>;

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'presets');

/** A prompt row as ST writes a custom one (system_prompt false: ST sends it; D-71). */
const prompt = (identifier: string, extra: Rec = {}): Rec => ({ identifier, name: identifier, role: 'system', content: `${identifier} text`, system_prompt: false, ...extra });
const marker = (identifier: string, extra: Rec = {}): Rec => ({ identifier, name: identifier, system_prompt: true, marker: true, ...extra });
const order = (...items: [string, boolean][]): Rec => ({
  character_id: ST_GLOBAL_ORDER_ID,
  order: items.map(([identifier, enabled]) => ({ identifier, enabled })),
});

/** A minimal valid ST preset: main + chatHistory in the global order, plus whatever is added. */
function st(extra: Rec = {}, prompts: Rec[] = [], items: [string, boolean][] = []): Rec {
  return {
    temperature: 1,
    prompts: [prompt('main'), marker('chatHistory'), ...prompts],
    prompt_order: [order(['main', true], ['chatHistory', true], ...items)],
    ...extra,
  };
}

const convert = (json: unknown, name = 'Test'): { value: Preset; warnings: { code: string; path: string; message: string }[] } =>
  stPresetToPreset(json, name);
const byId = (p: Preset, id: string): PresetBlock => {
  const b = p.blocks.find((x) => x.id === id);
  if (!b) throw new Error(`no block ${id} in ${p.blocks.map((x) => x.id).join(', ')}`);
  return b;
};
const codes = (r: { warnings: { code: string }[] }): string[] => r.warnings.map((w) => w.code);
const valid = (p: Preset): boolean => {
  const v = validatePreset(p);
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return true;
};

describe('the prompt_order 100001 law', () => {
  test('order and enabled come from the global order; unreferenced prompts follow, disabled', () => {
    const r = convert({
      prompts: [prompt('a'), prompt('main'), marker('chatHistory'), prompt('b', { enabled: true }), prompt('c')],
      prompt_order: [
        { character_id: 100000, order: [{ identifier: 'a', enabled: true }] },
        { character_id: 100001, order: [{ identifier: 'b', enabled: true }, { identifier: 'main', enabled: false }, { identifier: 'chatHistory', enabled: true }] },
        { character_id: 7, order: [] },
      ],
    });
    expect(r.value.blocks.map((b) => [b.id, b.enabled])).toEqual([
      ['b', true],
      ['main', false],
      ['chatHistory', true],
      ['a', false],
      ['c', false],
    ]);
    // other characters' orders ride extras verbatim; 100000 is just another character there
    expect(r.value.extras?.prompt_order).toEqual([
      { character_id: 100000, order: [{ identifier: 'a', enabled: true }] },
      { character_id: 7, order: [] },
    ]);
    // a prompt's own `enabled` is not the source of truth: unreferenced b-like prompts stay off
    expect(byId(r.value, 'c').enabled).toBe(false);
    expect(valid(r.value)).toBe(true);
  });

  test('the global id is matched as ST does (string or number); enabled is ST truthiness', () => {
    const r = convert({
      prompts: [prompt('main'), marker('chatHistory'), prompt('x'), prompt('y')],
      prompt_order: [{ character_id: '100001', order: [{ identifier: 'main', enabled: 1 }, { identifier: 'chatHistory', enabled: true }, { identifier: 'x' }, { identifier: 'y', enabled: 'false' }] }],
    });
    expect(r.value.blocks.map((b) => [b.id, b.enabled])).toEqual([
      ['main', true],
      ['chatHistory', true],
      ['x', false], // no `enabled` in the order entry: off in ST
      ['y', false],
    ]);
  });

  test('a missing reference: an ST default is filled in, anything else is skipped with a warning', () => {
    const r = convert({
      prompts: [prompt('main'), marker('chatHistory')],
      prompt_order: [order(['main', true], ['nsfw', true], ['ghost', true], ['chatHistory', true], ['main', true])],
    });
    expect(r.value.blocks.map((b) => b.id)).toEqual(['main', 'nsfw', 'chatHistory']);
    expect(byId(r.value, 'nsfw')).toMatchObject({ name: 'Auxiliary Prompt', content: '', enabled: true });
    expect(codes(r)).toEqual(expect.arrayContaining(['default_prompt', 'missing_prompt', 'duplicate_order_entry']));
  });

  test('duplicate identifiers: ST uses the first, the later one is kept disabled under a suffixed id', () => {
    const r = convert(st({}, [prompt('main', { content: 'second main' })]));
    expect(r.value.blocks.map((b) => [b.id, b.enabled, b.content])).toEqual([
      ['main', true, 'main text'],
      ['chatHistory', true, '{{history}}'],
      ['main-2', false, 'second main'],
    ]);
    expect(codes(r)).toContain('duplicate_prompt');
    expect(valid(r.value)).toBe(true);
  });

  test("no global order: ST installs its default order — its default prompts only, every custom prompt disabled", () => {
    // Regression: the prompts' own order and enabled flags were used (Bunraku's reading), so a
    // Default-shaped file without its 100001 order sent the card fields after the chat, and custom
    // prompts ST never sends went out. ST's sanitizeServiceSettings installs
    // promptManagerDefaultPromptOrder (PromptManager.js).
    const r = convert({
      prompts: [prompt('main'), prompt('custom-x', { content: 'CUSTOM-X' }), prompt('off', { enabled: false }), marker('chatHistory')],
      prompt_order: [{ character_id: 100000, order: [{ identifier: 'custom-x', enabled: true }] }],
    });
    expect(r.value.blocks.map((b) => [b.id, b.enabled])).toEqual([
      ['main', true],
      ['worldInfoBefore', true],
      ['personaDescription', true],
      ['charDescription', true],
      ['charPersonality', true],
      ['scenario', true],
      ['enhanceDefinitions', false],
      ['nsfw', true],
      ['worldInfoAfter', true],
      ['dialogueExamples', true],
      ['chatHistory', true],
      ['jailbreak', true],
      ['custom-x', false],
      ['off', false],
    ]);
    expect(byId(r.value, 'main').content).toBe('main text');
    expect(codes(r)).toEqual(['no_global_order']);
    expect(r.warnings[0]!.message).toContain('the other 2 prompt(s) are imported disabled');
    // No prompt_order at all reads the same way (a fresh ST's order).
    expect(convert({ prompts: [prompt('main'), marker('chatHistory')] }).value.blocks.map((b) => b.id)).toEqual(r.value.blocks.slice(0, 12).map((b) => b.id));
  });

  test("no prompts at all: ST's default prompts in ST's default order", () => {
    const r = convert({ temperature: 0.7 });
    expect(r.value.blocks.map((b) => [b.id, b.enabled])).toEqual([
      ['main', true],
      ['worldInfoBefore', true],
      ['personaDescription', true],
      ['charDescription', true],
      ['charPersonality', true],
      ['scenario', true],
      ['enhanceDefinitions', false],
      ['nsfw', true],
      ['worldInfoAfter', true],
      ['dialogueExamples', true],
      ['chatHistory', true],
      ['jailbreak', true],
    ]);
    expect(codes(r)).toContain('no_prompts');
    expect(r.value.samplers).toEqual({ temperature: 0.7 });
    expect(valid(r.value)).toBe(true);
  });

  test('ids: missing identifiers fall back to the name, then the position; all unique', () => {
    const r = convert({ prompts: [{ name: 'Свой блок', content: 'x' }, { content: 'y' }, marker('chatHistory')], prompt_order: [order(['chatHistory', true])] });
    expect(r.value.blocks.map((b) => b.id)).toEqual(['chatHistory', 'свой-блок', 'prompt-2']);
    expect(valid(r.value)).toBe(true);
  });
});

describe('markers', () => {
  test('every marker becomes its slot macro (coverage over the contract table)', () => {
    const ids = Object.keys(ST_MARKER_SLOTS);
    const r = convert({
      prompts: [prompt('main'), ...ids.map((id) => marker(id))],
      prompt_order: [order(['main', true], ...ids.map((id): [string, boolean] => [id, true]))],
    });
    for (const id of ids) expect(byId(r.value, id).content).toBe(ST_MARKER_SLOTS[id]!);
    expect(Object.keys(ST_MARKER_SLOTS).sort()).toEqual(
      ['chatHistory', 'charDescription', 'charPersonality', 'dialogueExamples', 'personaDescription', 'scenario', 'worldInfoAfter', 'worldInfoBefore'].sort(),
    );
    expect(byId(r.value, 'dialogueExamples').content).toBe('{{lore::examples_before}}{{examples}}{{lore::examples_after}}');
    expect(r.warnings).toEqual([]);
    expect(valid(r.value)).toBe(true);
  });

  test("the identifier decides: a marker's own text is not sent, and warns", () => {
    const r = convert(st({}, [{ identifier: 'scenario', marker: false, content: 'my scenario frame' }], [['scenario', true]]));
    expect(byId(r.value, 'scenario').content).toBe('{{scenario}}');
    expect(byId(r.value, 'scenario').extras).toEqual({ content: 'my scenario frame', marker: false });
    expect(codes(r)).toEqual(['marker_content']);
  });

  test('main, nsfw, jailbreak and enhanceDefinitions are ordinary blocks', () => {
    const r = convert(
      st({}, [prompt('nsfw'), prompt('enhanceDefinitions', { marker: false }), prompt('jailbreak', { marker: true })], [
        ['nsfw', true],
        ['enhanceDefinitions', true],
        ['jailbreak', true],
      ]),
    );
    expect(['main', 'nsfw', 'enhanceDefinitions', 'jailbreak'].map((id) => byId(r.value, id).content)).toEqual([
      'main text',
      'nsfw text',
      'enhanceDefinitions text',
      'jailbreak text',
    ]);
  });

  test('a disabled marker stays a disabled block that sends nothing, one warning per slot (D-71)', () => {
    const r = convert(
      st({}, [marker('worldInfoBefore'), marker('personaDescription'), marker('worldInfoAfter')], [
        ['worldInfoBefore', false],
        ['personaDescription', false],
      ]),
    );
    expect(byId(r.value, 'worldInfoBefore')).toMatchObject({ enabled: false, content: '{{lore::before}}' });
    expect(byId(r.value, 'personaDescription')).toMatchObject({ enabled: false, content: '{{persona}}' });
    expect(byId(r.value, 'worldInfoAfter')).toMatchObject({ enabled: false, content: '{{lore::after}}' }); // unreferenced
    const disabled = r.warnings.filter((w) => w.code === 'marker_disabled');
    expect(disabled.map((w) => w.path)).toEqual(['prompts[2]', 'prompts[3]', 'prompts[4]']);
    expect(disabled[2]?.message).toContain('not in the global order');
  });

  test('an unknown marker is kept disabled with a warning', () => {
    const r = convert(st({}, [marker('vectorsMemory')], [['vectorsMemory', true]]));
    expect(byId(r.value, 'vectorsMemory')).toMatchObject({ enabled: false, content: '' });
    expect(codes(r)).toEqual(['unknown_marker']);
  });

  test('core slot syntax in ST text is not an ST macro: escaped to stay literal ({{outlet::x}} is ST and stays)', () => {
    const r = convert(st({}, [prompt('x', { content: 'see {{history}} and {{lore::before}}, {{outlet::Places}}' })], [['x', true]]));
    expect(byId(r.value, 'x').content).toBe('see \\{{history}} and \\{{lore::before}}, {{outlet::Places}}');
    expect(codes(r)).toEqual(['slot_escaped']);
    expect(valid(r.value)).toBe(true);
  });
});

describe('chat history', () => {
  test('a missing chatHistory is synthesised, enabled, at the end, with a warning', () => {
    const r = convert({ prompts: [prompt('main'), prompt('jb')], prompt_order: [order(['main', true], ['jb', true])] });
    expect(r.value.blocks.at(-1)).toEqual({ id: 'chatHistory', name: 'Chat History', role: 'system', enabled: true, content: '{{history}}', at: 'relative' });
    expect(codes(r)).toEqual(['history_synthesised']);
    expect(valid(r.value)).toBe(true);
  });

  test('a disabled or unreferenced chatHistory is switched on in place', () => {
    for (const items of [[['main', true], ['chatHistory', false]], [['main', true]]] as [string, boolean][][]) {
      const r = convert({ prompts: [prompt('main'), marker('chatHistory'), prompt('z')], prompt_order: [order(...items)] });
      expect(byId(r.value, 'chatHistory').enabled).toBe(true);
      expect(codes(r)).toContain('history_enabled');
      expect(codes(r)).not.toContain('marker_disabled');
      expect(valid(r.value)).toBe(true);
    }
  });

  test('an in-chat chatHistory is placed relative', () => {
    const r = convert(st({ prompts: [prompt('main'), marker('chatHistory', { injection_position: 1, injection_depth: 2 })] }));
    expect(byId(r.value, 'chatHistory').at).toBe('relative');
    expect(codes(r)).toEqual(['history_relative']);
  });

  test("an ST preset without chatHistory but with RoleCall's {{message_history}} uses that block", () => {
    const r = convert({
      prompts: [prompt('main'), prompt('frame', { content: '[TRANSCRIPT]\n{{message_history}}\n[END]' })],
      prompt_order: [order(['main', true], ['frame', true])],
    });
    expect(byId(r.value, 'frame').content).toBe('[TRANSCRIPT]\n{{history}}\n[END]');
    expect(r.value.blocks.map((b) => b.id)).toEqual(['main', 'frame']);
    expect(codes(r)).toEqual(['history_macro']);
    expect(valid(r.value)).toBe(true);
  });

  test('with a chatHistory marker, {{message_history}} in an ST preset stays literal text (ST rules)', () => {
    const r = convert(st({}, [prompt('frame', { content: '{{message_history}}' })], [['frame', true]]));
    expect(byId(r.value, 'frame').content).toBe('{{message_history}}');
    expect(byId(r.value, 'chatHistory').enabled).toBe(true);
  });
});

describe('placement and overrides', () => {
  test('injection_position 0 → relative; 1 → depth/order (ST convention, 1:1); defaults like ST', () => {
    const r = convert(
      st({}, [
        prompt('rel', { injection_position: 0, injection_depth: 9, injection_order: 3 }),
        prompt('deep', { injection_position: 1, injection_depth: 2, injection_order: 50, role: 'user' }),
        prompt('bare', { injection_position: '1' }),
        prompt('weird', { injection_position: 3 }),
      ], [
        ['rel', true],
        ['deep', true],
        ['bare', true],
        ['weird', true],
      ]),
    );
    expect(byId(r.value, 'rel').at).toBe('relative');
    expect(byId(r.value, 'deep')).toMatchObject({ at: { depth: 2, order: 50 }, role: 'user' });
    expect(byId(r.value, 'bare').at).toEqual({ depth: 4 }); // ST DEFAULT_DEPTH; order left to depth.ts (100)
    expect(byId(r.value, 'weird')).toMatchObject({ at: 'relative', extras: { injection_position: 3 } });
    expect(codes(r)).toEqual(['unknown_position']);
    expect(valid(r.value)).toBe(true);
  });

  test('roles: from the prompt, system by default, an unknown role is sent as system with a warning', () => {
    const r = convert(st({}, [prompt('a', { role: 'assistant' }), prompt('b', { role: undefined }), prompt('c', { role: 'tool' })], [
      ['a', true],
      ['b', true],
      ['c', true],
    ]));
    expect(['a', 'b', 'c'].map((id) => byId(r.value, id).role)).toEqual(['assistant', 'system', 'system']);
    expect(byId(r.value, 'c').extras).toEqual({ role: 'tool', system_prompt: false });
    expect(codes(r)).toEqual(['invalid_value']);
  });

  test('main → card_system, jailbreak → card_post_history; forbid_overrides keeps the card out of that block', () => {
    const plain = convert(st({}, [prompt('jailbreak')], [['jailbreak', true]]));
    expect(byId(plain.value, 'main').override).toBe('card_system');
    expect(byId(plain.value, 'jailbreak').override).toBe('card_post_history');
    expect(plain.value.forbidOverrides).toBeUndefined();

    const locked = convert({
      prompts: [prompt('main', { forbid_overrides: true }), marker('chatHistory'), prompt('jailbreak', { forbid_overrides: false }), prompt('x', { forbid_overrides: true })],
      prompt_order: [order(['main', true], ['chatHistory', true], ['jailbreak', true], ['x', true])],
    });
    expect(byId(locked.value, 'main').override).toBeUndefined();
    expect(byId(locked.value, 'main').extras).toEqual({ forbid_overrides: true, system_prompt: false });
    expect(byId(locked.value, 'jailbreak').override).toBe('card_post_history');
    expect(byId(locked.value, 'x').override).toBeUndefined(); // ST only overrides main and jailbreak
    // ...but the flag rides extras for the round trip
    expect(byId(locked.value, 'x').extras).toEqual({ forbid_overrides: true, system_prompt: false });
  });

  test('injection_trigger rides block extras with one folded warning; unknown prompt fields too', () => {
    const r = convert(
      st({}, [prompt('a', { injection_trigger: ['normal'] }), prompt('b', { injection_trigger: ['continue'], foo: 1 }), prompt('c', { injection_trigger: [] })], [
        ['a', true],
        ['b', true],
        ['c', true],
      ]),
    );
    expect(byId(r.value, 'a').extras).toEqual({ injection_trigger: ['normal'], system_prompt: false });
    expect(byId(r.value, 'b').extras).toEqual({ injection_trigger: ['continue'], foo: 1, system_prompt: false });
    // an empty trigger list is ST's "every turn": no warning, but it rides extras for the round trip
    expect(byId(r.value, 'c').extras).toEqual({ injection_trigger: [], system_prompt: false });
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([
      ['not_honoured', 'prompts[*].injection_trigger'],
      ['unknown_field', 'prompts[3].foo'],
    ]);
    expect(r.warnings[0]?.message).toContain('(2 blocks)');
  });
});

describe('settings', () => {
  test('samplers, context, prefill, impersonation, post-processing and formats map (D-70)', () => {
    const r = convert(
      st({
        temperature: 0.9,
        top_p: 0.95,
        top_k: 40,
        min_p: 0.05,
        top_a: 0.1,
        frequency_penalty: 0.2,
        presence_penalty: 0.3,
        repetition_penalty: 1.1,
        seed: 42,
        openai_max_tokens: 500,
        openai_max_context: 16384,
        assistant_prefill: 'Sure,',
        impersonation_prompt: '[Write as {{user}}]',
        assistant_impersonation: 'I',
        custom_prompt_post_processing: 'merge',
        wi_format: '[{0}]',
        personality_format: "{{char}}'s personality: {{personality}}",
        scenario_format: 'Scenario: {{scenario}}',
        new_chat_prompt: '[Start a new Chat]',
        new_example_chat_prompt: '[Example Chat]',
      }),
    );
    expect(r.value.samplers).toEqual({
      temperature: 0.9,
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      top_a: 0.1,
      frequency_penalty: 0.2,
      presence_penalty: 0.3,
      repetition_penalty: 1.1,
      seed: 42,
      max_tokens: 500,
    });
    expect(r.value.context).toEqual({ maxContext: 16384 });
    expect(r.value.prefill).toBe('Sure,');
    expect(r.value.impersonation).toEqual({ prompt: '[Write as {{user}}]', prefill: 'I' });
    expect(r.value.postProcessing).toBe('merge');
    expect(r.value.formats).toEqual({
      wi: '[{0}]',
      personality: "{{char}}'s personality: {{personality}}",
      scenario: 'Scenario: {{scenario}}',
      newChat: '[Start a new Chat]',
      newExampleChat: '[Example Chat]',
    });
    expect(r.value.extras).toBeUndefined();
    expect(r.warnings).toEqual([]);
    expect(valid(r.value)).toBe(true);
  });

  test('numbers written as strings are read; seed -1 (ST: random) is absent; blank prefills are absent', () => {
    const r = convert(st({ temperature: '1.0', top_k: '0', seed: -1, openai_max_tokens: '300', assistant_prefill: '', assistant_impersonation: '  ' }));
    expect(r.value.samplers).toEqual({ temperature: 1, top_k: 0, max_tokens: 300 });
    expect(r.value.prefill).toBeUndefined();
    expect(r.value.impersonation).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  test('ambiguous values are not guessed: kept in extras with a warning', () => {
    const r = convert(st({ temperature: 'hot', openai_max_tokens: 0, openai_max_context: '' }));
    expect(r.value.samplers).toBeUndefined();
    expect(r.value.context).toBeUndefined();
    expect(r.value.extras).toEqual({ temperature: 'hot', openai_max_tokens: 0, openai_max_context: '' });
    expect(codes(r)).toEqual(['invalid_value', 'invalid_value', 'invalid_value']);
  });

  test("post-processing: ST's key and names; '' is none; claude → merge; _tools folds with a warning", () => {
    const pp = (v: unknown): Preset['postProcessing'] => convert(st({ custom_prompt_post_processing: v })).value.postProcessing;
    expect(pp('')).toBe('none');
    expect(['merge', 'semi', 'strict', 'single'].map(pp)).toEqual(['merge', 'semi', 'strict', 'single']);
    expect(pp('claude')).toBe('merge');
    const tools = convert(st({ custom_prompt_post_processing: 'strict_tools' }));
    expect(tools.value.postProcessing).toBe('strict');
    expect(codes(tools)).toEqual(['not_honoured']);
    const odd = convert(st({ custom_prompt_post_processing: 'loose' }));
    expect(odd.value.postProcessing).toBeUndefined();
    expect(codes(odd)).toEqual(['invalid_value']);
  });

  test("RoleCall's prompt_post_processing key is not ST's (§19.8): extras, warned unless it says none", () => {
    const r = convert(st({ prompt_post_processing: 'merge' }));
    expect(r.value.postProcessing).toBeUndefined();
    expect(r.value.extras).toEqual({ prompt_post_processing: 'merge' });
    expect(codes(r)).toEqual(['not_honoured']);
    expect(codes(convert(st({ prompt_post_processing: 'none' })))).toEqual([]);
  });

  test('secrets and connection settings never reach the preset, not even extras', () => {
    const secret = 'sk-very-secret-value';
    const r = convert(
      st({
        proxy_password: secret,
        reverse_proxy: 'https://proxy.example',
        custom_url: 'https://custom.example/v1',
        custom_include_headers: `Authorization: Bearer ${secret}`,
        custom_include_body: 'x: 1',
        custom_exclude_body: 'y',
        chat_completion_source: 'openrouter',
        openai_model: 'gpt-4o',
        claude_model: 'claude-x',
        custom_model: 'm',
        openrouter_providers: ['a'],
        vertexai_region: 'eu',
        azure_base_url: 'https://az',
        minimax_endpoint: 'global',
        bypass_status_check: true,
        some_api_key: secret,
      }),
    );
    const text = JSON.stringify(r);
    for (const needle of [secret, 'proxy', 'custom_url', 'example', 'openrouter', 'gpt-4o', 'claude-x', 'vertexai', 'azure', 'minimax', 'bypass']) {
      expect(text).not.toContain(needle);
    }
    expect(r.value.extras).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  test('settings that are not honoured ride extras and warn only when they would change what ST does', () => {
    const live = convert(
      st({
        names_behavior: 2,
        squash_system_messages: true,
        continue_nudge_prompt: '[Continue]',
        continue_prefill: true,
        continue_postfix: '\n\n',
        media_inlining: true,
        function_calling: true,
        bias_preset_selected: 'Anti',
        bias_presets: { 'Default (none)': [], Anti: [{ text: 'x', value: -100 }] },
        show_external_models: true,
        n: 2,
        reasoning_effort: 'high',
      }),
    );
    expect(live.warnings.map((w) => w.path).sort()).toEqual(
      [
        'names_behavior',
        'squash_system_messages',
        'continue_nudge_prompt',
        'continue_prefill',
        'continue_postfix',
        'media_inlining',
        'function_calling',
        'bias_presets',
        'show_external_models',
        'n',
        'reasoning_effort',
      ].sort(),
    );
    expect(new Set(codes(live))).toEqual(new Set(['not_honoured']));
    expect(live.value.extras).toMatchObject({ names_behavior: 2, bias_preset_selected: 'Anti', n: 2 });
    // Said in words, not as a section number of the design doc (which users do not have).
    const nudge = live.warnings.find((w) => w.path === 'continue_nudge_prompt')!.message;
    expect(nudge).toContain("the continue nudge (rp-core's /c continues the last answer its own way)");
    for (const w of live.warnings) expect(w.message).not.toContain('§');

    const inert = convert(
      st({
        names_behavior: 0,
        squash_system_messages: false,
        continue_nudge_prompt: '',
        continue_prefill: false,
        continue_postfix: ' ',
        media_inlining: false,
        function_calling: false,
        bias_preset_selected: 'Default (none)',
        bias_presets: { 'Default (none)': [] },
        show_external_models: false,
        n: 1,
        reasoning_effort: 'auto',
        stream_openai: true,
        max_context_unlocked: true,
        new_group_chat_prompt: '[Group]',
        group_nudge_prompt: '[Nudge]',
      }),
    );
    expect(inert.warnings).toEqual([]);
    expect(Object.keys(inert.value.extras ?? {})).toHaveLength(16);
  });

  test('unknown fields and extension data: extras with a warning; regex scripts are named', () => {
    const r = convert(st({ mystery: 1, extensions: { regex_scripts: [{ id: 'r1' }, { id: 'r2' }], SPreset: { x: 1 }, empty: {} } }));
    expect(r.value.extras).toEqual({ mystery: 1, extensions: { regex_scripts: [{ id: 'r1' }, { id: 'r2' }], SPreset: { x: 1 }, empty: {} } });
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([
      ['not_honoured', 'extensions.regex_scripts'],
      ['unknown_field', 'extensions.SPreset'],
      ['unknown_field', 'mystery'],
    ]);
    expect(r.warnings[0]?.message).toContain('2 regex script(s)');
    // an empty extensions object is template noise
    expect(convert(st({ extensions: {} })).value.extras).toBeUndefined();
  });

  test('name: the file\'s own name field, else the fallback', () => {
    expect(convert(st({ name: 'Named' }), 'file').value.name).toBe('Named');
    expect(convert(st({ name: '  ' }), 'file').value.name).toBe('file');
    expect(convert(st(), 'file').value.name).toBe('file');
  });

  test('not an object: default prompts and a warning, still a valid preset', () => {
    const r = convert([1, 2], 'odd');
    expect(r.value.name).toBe('odd');
    expect(codes(r)).toEqual(expect.arrayContaining(['invalid_value', 'no_prompts']));
    expect(valid(r.value)).toBe(true);
  });
});

describe("SillyTavern's Default.json round trip", () => {
  const json = JSON.parse(readFileSync(join(FIXTURES, 'Default.json'), 'utf8')) as Rec;
  const r = convert(json, 'Default');

  test('validates and has every expected slot exactly once, enabled', () => {
    expect(valid(r.value)).toBe(true);
    const enabled = r.value.blocks.filter((b) => b.enabled);
    const all = enabled.map((b) => b.content).join('\n');
    for (const slot of ['{{history}}', '{{lore::before}}', '{{lore::after}}', '{{lore::examples_before}}', '{{examples}}', '{{lore::examples_after}}', '{{description}}', '{{personality}}', '{{scenario}}', '{{persona}}']) {
      expect(all.split(slot).length - 1).toBe(1);
    }
    expect(enabled.reduce((n, b) => n + historySlots(b.content), 0)).toBe(1);
  });

  test('order, enabled flags, overrides, settings', () => {
    expect(r.value.blocks.map((b) => [b.id, b.enabled])).toEqual([
      ['main', true],
      ['worldInfoBefore', true],
      ['personaDescription', true],
      ['charDescription', true],
      ['charPersonality', true],
      ['scenario', true],
      ['enhanceDefinitions', false],
      ['nsfw', true],
      ['worldInfoAfter', true],
      ['dialogueExamples', true],
      ['chatHistory', true],
      ['jailbreak', true],
    ]);
    expect(byId(r.value, 'main')).toMatchObject({ name: 'Main Prompt', override: 'card_system', content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}." });
    expect(byId(r.value, 'jailbreak')).toMatchObject({ name: 'Post-History Instructions', override: 'card_post_history', content: '' });
    expect(r.value.samplers).toEqual({ temperature: 1, frequency_penalty: 0, presence_penalty: 0, top_p: 1, top_k: 0, top_a: 0, min_p: 0, repetition_penalty: 1, max_tokens: 300 });
    expect(r.value.context).toEqual({ maxContext: 4095 });
    expect(r.value.impersonation?.prompt).toStartWith('[Write your next reply from the point of view of {{user}}');
    expect(r.value.formats).toEqual({ wi: '{0}', personality: '{{personality}}', scenario: '{{scenario}}', newChat: '[Start a new Chat]', newExampleChat: '[Example Chat]' });
    expect(r.value.postProcessing).toBeUndefined(); // Default.json carries no custom_prompt_post_processing
    expect(r.value.extras?.prompt_order).toEqual([(json.prompt_order as Rec[])[0]]);
  });

  test('no connection settings survive; warnings name the two live settings rp-core does not honour', () => {
    const text = JSON.stringify(r.value);
    for (const key of ['chat_completion_source', 'openai_model', 'claude_model', 'reverse_proxy', 'proxy_password', 'custom_url', 'custom_include_headers', 'show_external_models_x']) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(r.warnings.map((w) => w.path)).toEqual(['continue_nudge_prompt', 'media_inlining']);
  });
});

describe('RoleCall exports (D-71 mixed, D-43 amendment)', () => {
  const rc = (extra: Rec = {}, prompts: Rec[] = [], items: [string, boolean][] = []): Rec => ({
    ...st(extra, prompts, items),
    extensions: { rolecall: { schema_version: 1, edition_kind: 'rolecall' } },
  });

  test('isRoleCallExport: extensions.rolecall present', () => {
    expect(isRoleCallExport(rc())).toBe(true);
    expect(isRoleCallExport(st())).toBe(false);
    expect(isRoleCallExport({ extensions: { rolecall: null } })).toBe(false);
    expect(isRoleCallExport('x')).toBe(false);
  });

  test('in-chat depths get +1 through fromRcDepth; the ST reading of the same file does not', () => {
    const p = prompt('note', { injection_position: 1, injection_depth: 0, injection_order: 5 });
    expect(byId(convert(rc({}, [p], [['note', true]])).value, 'note').at).toEqual({ depth: 1, order: 5 });
    expect(byId(convert(st({}, [p], [['note', true]])).value, 'note').at).toEqual({ depth: 0, order: 5 });
    expect(codes(convert(rc({}, [p], [['note', true]])))).toContain('rc_export');
  });

  test("disabled lore markers are forced on in place; a disabled persona marker stays off and RoleCall's persona block goes after main", () => {
    const r = convert(
      rc({}, [marker('worldInfoBefore'), marker('worldInfoAfter'), marker('personaDescription')], [
        ['worldInfoBefore', false],
        ['worldInfoAfter', true],
        ['personaDescription', false],
      ]),
    );
    expect(['worldInfoBefore', 'worldInfoAfter', 'personaDescription'].map((id) => byId(r.value, id).enabled)).toEqual([true, true, false]);
    expect(r.warnings.filter((w) => w.code === 'rc_forced_on').map((w) => w.path)).toEqual(['prompts[2]']);
    expect(r.value.blocks.map((b) => b.id).slice(0, 2)).toEqual(['main', 'personaInjection']);
    expect(codes(r)).not.toContain('marker_disabled');
    expect(r.warnings.filter((w) => w.code === 'rc_synthesised')).toHaveLength(1);
  });

  test("a disabled persona marker moved down the order: the persona still goes right after main, as RoleCall's loader puts it", () => {
    // Regression: rcAlwaysOn revived the marker where it stood (before the chat). RoleCall only sees
    // enabled prompts, so the marker is invisible to it and it synthesises the persona after main.
    const r = convert(
      rc({}, [marker('personaDescription'), prompt('desc', { content: '{{description}}' })], [
        ['desc', true],
        ['personaDescription', false],
      ]),
    );
    // The disabled marker sits last in the order; RoleCall puts the persona after main whatever its place.
    const ids = r.value.blocks.filter((b) => b.enabled).map((b) => b.id);
    expect(ids.indexOf('personaInjection')).toBe(ids.indexOf('main') + 1);
    expect(byId(r.value, 'personaDescription').enabled).toBe(false);
    // Without main, after jailbreak; without both, first.
    const noMain = convert({
      ...rc(),
      prompts: [prompt('jailbreak'), marker('chatHistory'), marker('personaDescription')],
      prompt_order: [order(['chatHistory', true], ['jailbreak', true], ['personaDescription', false])],
    });
    expect(noMain.value.blocks.filter((b) => b.enabled).map((b) => b.id).slice(-2)).toEqual(['jailbreak', 'personaInjection']);
  });

  test('a slot already carried by another block is not doubled; a missing one is added where RoleCall puts it', () => {
    const r = convert(rc({}, [marker('personaDescription'), prompt('mine', { content: 'Protagonist: {{persona}}' })], [['personaDescription', false], ['mine', true]]));
    expect(byId(r.value, 'personaDescription').enabled).toBe(false);
    // no lore markers at all: both lore slots go right above the chat
    expect(r.value.blocks.map((b) => [b.id, b.enabled])).toEqual([
      ['main', true],
      ['loreBefore', true],
      ['loreAfter', true],
      ['chatHistory', true],
      ['personaDescription', false],
      ['mine', true],
    ]);
    expect(byId(r.value, 'loreBefore').content).toBe('{{lore::before}}');
    expect(byId(r.value, 'loreAfter').content).toBe('{{lore::after}}');
    expect(r.warnings.filter((w) => w.code === 'rc_synthesised')).toHaveLength(2);

    // no persona anywhere: a Persona block right after main (RoleCall's fill)
    const bare = convert(rc({}, [marker('worldInfoBefore'), marker('worldInfoAfter')], [['worldInfoBefore', true], ['worldInfoAfter', true]]));
    expect(bare.value.blocks.map((b) => b.id)).toEqual(['main', 'personaInjection', 'chatHistory', 'worldInfoBefore', 'worldInfoAfter']);
    expect(byId(bare.value, 'personaInjection').content).toBe('{{persona}}');
    expect(valid(bare.value)).toBe(true);
  });

  test("{{message_history}} places the chat; the chatHistory marker then sends nothing (RoleCall's rule)", () => {
    const r = convert(rc({}, [prompt('frame', { content: '[T]\n{{message_history}}\n[/T]' })], [['frame', true]]));
    expect(byId(r.value, 'frame').content).toBe('[T]\n{{history}}\n[/T]');
    expect(byId(r.value, 'chatHistory').enabled).toBe(false);
    expect(codes(r)).toContain('history_macro');
    expect(valid(r.value)).toBe(true);
  });

  test('numeric {{random}} forms are rewritten in every block, wide ones warn, the ST reading is untouched', () => {
    const content = 'a {{random}} b {{random::1::6}} c {{random::1::1000}} d {{random::x::y::z}}';
    const r = convert(rc({ assistant_prefill: 'Roll {{random::1::3}}' }, [prompt('dice', { content })], [['dice', true]]));
    const out = byId(r.value, 'dice').content;
    expect(out).toContain(`a {{random::${Array.from({ length: 101 }, (_, i) => i).join('::')}}} b`);
    expect(out).toContain('b {{random::1::2::3::4::5::6}} c {{random::1::1000}} d {{random::x::y::z}}');
    expect(r.value.prefill).toBe('Roll {{random::1::2::3}}');
    expect(r.warnings.filter((w) => w.code === 'rc_random_range').map((w) => [w.path, w.message.split(':')[0]])).toEqual([
      ['prompts[2].content', '{{random'],
    ]);
    expect(byId(convert(st({}, [prompt('dice', { content })], [['dice', true]])).value, 'dice').content).toBe(content);
  });

  test('pins (4 top, 3 bottom) keep their places as groups, each sorted by injection_order (default 100); the ST reading stays relative', () => {
    const pins = [
      prompt('t1', { injection_position: 4, injection_order: 50 }),
      prompt('b1', { injection_position: 3 }),
      prompt('t2', { injection_position: 4, injection_order: 10 }),
      prompt('b2', { injection_position: 3, injection_order: 20 }),
      prompt('t3', { injection_position: 4 }),
    ];
    const items: [string, boolean][] = pins.map((p) => [p.identifier as string, true]);
    const r = convert(rc({}, pins, items));
    // (main, the chat and RoleCall's synthesised lore/persona blocks come first, relative)
    expect(r.value.blocks.filter((b) => b.at !== 'relative').map((b) => [b.id, b.at])).toEqual([
      ['t2', 'top'],
      ['b2', 'bottom'],
      ['t1', 'top'],
      ['b1', 'bottom'],
      ['t3', 'top'],
    ]);
    expect(codes(r)).not.toContain('unknown_position');
    expect(r.warnings.find((w) => w.code === 'rc_export')?.message).toContain('5 top/bottom pin(s)');
    expect(valid(r.value)).toBe(true);
    const plain = convert(st({}, pins, items));
    expect(plain.value.blocks.filter((b) => b.at !== 'relative')).toEqual([]);
    expect(codes(plain)).toContain('unknown_position');
  });

  test('appends (2) are imported disabled with one folded warning; their placement rides extras', () => {
    const r = convert(
      rc({}, [prompt('a1', { injection_position: 2, injection_depth: 0, role: 'user' }), prompt('a2', { injection_position: 2, injection_depth: 1 })], [
        ['a1', true],
        ['a2', true],
      ]),
    );
    expect([byId(r.value, 'a1').enabled, byId(r.value, 'a2').enabled]).toEqual([false, false]);
    expect(byId(r.value, 'a1').extras).toEqual({ injection_position: 2, injection_depth: 0, system_prompt: false });
    const w = r.warnings.filter((x) => x.code === 'rc_append');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toEndWith('(2 blocks)');
  });

  test('template formats and the new-chat / example headers ride extras unapplied (RoleCall never applies them)', () => {
    // Regression: new_chat_prompt and new_example_chat_prompt were applied to RC exports, so rp-core
    // sent '[Start a new Chat]' and '[Example Chat]' lines RoleCall never sends (preset-loader.ts
    // reads only the prefill, impersonation and continue prompts; {{mesExamples}} is the raw text).
    const fmt = {
      wi_format: '[Details of the fictional world the RP is set in:\n{0}]',
      scenario_format: '{{scenario}}',
      personality_format: "[{{char}}'s personality: {{personality}}]",
      new_chat_prompt: '[Start a new Chat]',
      new_example_chat_prompt: '[Example Chat]',
    };
    const r = convert(rc(fmt));
    expect(r.value.formats).toBeUndefined();
    expect(r.value.extras).toMatchObject(fmt);
    expect(r.warnings.filter((w) => w.code === 'rc_formats').map((w) => w.message.split(':')[0])).toEqual([
      'wi_format, personality_format, scenario_format, new_chat_prompt, new_example_chat_prompt',
    ]);
    expect(codes(r)).not.toContain('unknown_field');
    // the ST reading applies them (D-70)
    expect(convert(st(fmt)).value.formats).toEqual({
      wi: fmt.wi_format,
      scenario: '{{scenario}}',
      personality: fmt.personality_format,
      newChat: '[Start a new Chat]',
      newExampleChat: '[Example Chat]',
    });
  });

  test("RoleCall's own prompt_post_processing key is read in an RC export", () => {
    const r = convert(rc({ prompt_post_processing: 'semi' }));
    expect(r.value.postProcessing).toBe('semi');
    expect(r.value.extras?.prompt_post_processing).toBeUndefined();
  });

  test('extensions.rolecall rides extras; its regex rules warn', () => {
    const r = convert({
      ...st(),
      extensions: { rolecall: { category_hierarchy: [{ name: 'x' }], prompt_regex_rules: { main: [{ find: 'a' }], other: [] } } },
    });
    expect(r.value.extras?.extensions).toEqual({ rolecall: { category_hierarchy: [{ name: 'x' }], prompt_regex_rules: { main: [{ find: 'a' }], other: [] } } });
    expect(r.warnings.find((w) => w.path === 'extensions.rolecall.prompt_regex_rules')?.message).toContain('1 prompt(s)');
  });
});

describe('rewriteRcRandom', () => {
  const list = (lo: number, hi: number): string => `{{random::${Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).join('::')}}}`;

  test('{{random}} bare is 0..100; {{random::a}} is a..100; {{random::a::b}} is a..b', () => {
    expect(rewriteRcRandom('{{random}}')).toEqual({ text: list(0, 100), wide: [] });
    expect(rewriteRcRandom('{{random::95}}')).toEqual({ text: list(95, 100), wide: [] });
    expect(rewriteRcRandom('{{random::1::6}}')).toEqual({ text: '{{random::1::2::3::4::5::6}}', wide: [] });
    expect(rewriteRcRandom('{{ random :: -2 :: 2 }}').text).toBe('{{random::-2::-1::0::1::2}}');
    expect(rewriteRcRandom('{{RANDOM::3::3}}').text).toBe('{{random::3}}');
  });

  test('the 101-value boundary', () => {
    expect(rewriteRcRandom('{{random::0::100}}').text).toBe(list(0, 100));
    expect(rewriteRcRandom('{{random::-100::0}}').text).toBe(list(-100, 0));
    expect(rewriteRcRandom('{{random::0::101}}')).toEqual({ text: '{{random::0::101}}', wide: ['{{random::0::101}}'] });
    expect(rewriteRcRandom('{{random::-1}}')).toEqual({ text: '{{random::-1}}', wide: ['{{random::-1}}'] }); // -1..100: 102 values
    expect(rewriteRcRandom('{{random::99999999999999999999::1}}').wide).toHaveLength(1);
  });

  test('a reversed range is read as the same span', () => {
    expect(rewriteRcRandom('{{random::6::1}}').text).toBe('{{random::1::2::3::4::5::6}}');
  });

  test('three or more arguments and non-integer arguments are ST choices: untouched', () => {
    for (const s of ['{{random::1::2::3}}', '{{random::1.5::3}}', '{{random::a::b}}', '{{random::a}}', '{{random::1,2,3}}', '{{random::}}', '{{random:1,2}}', '{{random::1::{{getvar::n}}}}']) {
      expect(rewriteRcRandom(s)).toEqual({ text: s, wide: [] });
    }
  });

  test('an escaped tag is literal and stays; text around tags is kept; every occurrence is handled', () => {
    expect(rewriteRcRandom('\\{{random::1::2}}').text).toBe('\\{{random::1::2}}');
    expect(rewriteRcRandom('x {{random::1::2}} y {{random::2::3}} z')).toEqual({ text: 'x {{random::1::2}} y {{random::2::3}} z', wide: [] });
    const twice = rewriteRcRandom('{{random::0::500}}{{random::0::500}}');
    expect(twice.wide).toEqual(['{{random::0::500}}', '{{random::0::500}}']);
  });
});

describe('an imported preset assembles', () => {
  test("ST's Default.json lays the card out the way ST does", async () => {
    const { assemble } = await import('../../src/prompt/assemble.ts');
    const { input, lines, ok } = await import('../assemble/fixtures.ts');
    const json = JSON.parse(readFileSync(join(FIXTURES, 'Default.json'), 'utf8')) as Rec;
    const preset = convert(json, 'Default').value;
    const got = lines(ok(assemble(input({ preset }))).messages);
    // Subsequence check: other milestones may add messages (new_chat_prompt, lore), never reorder these.
    const want = [
      "system|main|Write Mira's next reply in a fictional chat between Mira and Levi.",
      'system|personaDescription|A traveller with a broken compass.',
      'system|charDescription|Mira is a cartographer who maps dreams for Levi.',
      'system|charPersonality|Curious, dry.',
      'system|scenario|A lighthouse at dusk.',
      'assistant|history|Hello, traveller.',
      'user|history|Where are we?',
    ];
    let at = 0;
    for (const line of got) if (line === want[at]) at++;
    expect({ matched: at, got }).toEqual({ matched: want.length, got });
    // enhanceDefinitions is off in Default.json's global order
    expect(got.some((l) => l.includes('enhance them'))).toBe(false);
  });
});

describe('which custom prompts SillyTavern sends (openai.js populateChatCompletion)', () => {
  test('a relative custom prompt is sent only with system_prompt false; true or missing is imported disabled, with one folded warning', () => {
    const r = convert(
      st({}, [prompt('sent'), prompt('sysCustom', { system_prompt: true }), prompt('noFlag', { system_prompt: undefined }), prompt('deep', { system_prompt: true, injection_position: 1 })], [
        ['sent', true],
        ['sysCustom', true],
        ['noFlag', true],
        ['deep', true],
      ]),
    );
    expect(['sent', 'sysCustom', 'noFlag', 'deep'].map((id) => byId(r.value, id).enabled)).toEqual([true, false, false, true]);
    const w = r.warnings.filter((x) => x.code === 'st_not_sent');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toEndWith('(2 blocks)');
  });

  test('a custom row flagged marker with system_prompt false and text is sent as text (ST ignores the marker flag there)', () => {
    const r = convert(st({}, [{ identifier: 'divider', name: 'Divider', marker: true, system_prompt: false, content: 'DIVIDER TEXT' }], [['divider', true]]));
    expect(byId(r.value, 'divider')).toMatchObject({ enabled: true, content: 'DIVIDER TEXT' });
    expect(codes(r)).not.toContain('unknown_marker');
  });

  test('a file with RoleCall signs keeps RoleCall\'s reading of them, and says how many ST would not send', () => {
    const born = convert({ ...st({ prompt_post_processing: 'strict' }, [prompt('sysCustom', { system_prompt: true })], [['sysCustom', true]]) });
    expect(byId(born.value, 'sysCustom').enabled).toBe(true);
    expect(born.warnings.find((x) => x.code === 'rc_signs')?.message).toContain('SillyTavern would not send 1 of them');
    const history = convert(st({}, [prompt('frame', { content: '{{message_history}}', system_prompt: true })], [['frame', true]]));
    expect(byId(history.value, 'frame').enabled).toBe(true);
    expect(codes(history)).toContain('rc_signs');
  });
});

describe('the round trip: row fields the block does not represent ride extras (D-70)', () => {
  test('system_prompt, marker, a relative block\'s depth and order, forbid_overrides on any block, an empty trigger', () => {
    const r = convert(
      st({}, [prompt('custom1', { name: 'C', content: 'X', system_prompt: false, marker: false, injection_depth: 7, injection_order: 3, forbid_overrides: true, injection_trigger: [] })], [
        ['custom1', true],
      ]),
    );
    expect(byId(r.value, 'custom1')).toEqual({
      id: 'custom1',
      name: 'C',
      role: 'system',
      enabled: true,
      content: 'X',
      at: 'relative',
      extras: { system_prompt: false, marker: false, injection_depth: 7, injection_order: 3, forbid_overrides: true, injection_trigger: [] },
    });
    // an in-chat block represents its depth and order: they are not repeated
    const deep = convert(st({}, [prompt('d', { injection_position: 1, injection_depth: 2, injection_order: 50 })], [['d', true]]));
    expect(byId(deep.value, 'd')).toMatchObject({ at: { depth: 2, order: 50 }, extras: { system_prompt: false } });
  });
});

describe('dialogueExamples stays in the relative frame (ST populateDialogueExamples)', () => {
  test('injection_position 1 on the examples marker is ignored with a warning; the placement rides extras', () => {
    const r = convert(st({}, [marker('dialogueExamples', { injection_position: 1, injection_depth: 2 })], [['dialogueExamples', true]]));
    expect(byId(r.value, 'dialogueExamples')).toMatchObject({ at: 'relative', enabled: true, extras: { injection_position: 1, injection_depth: 2 } });
    expect(codes(r)).toContain('examples_relative');
  });
});

describe('macros rp-core does not run are named at import (D-70)', () => {
  test("SillyBunny's {{#if}} and {{.var}} forms and RoleCall's macros: one warning per name, counting the blocks", () => {
    const r = convert(
      st({ assistant_prefill: '{{choice::a::b}}' }, [
        prompt('a', { content: '{{.player-instructions =\n\n}}{{#if .genre}}x{{else}}y{{/if}}' }),
        prompt('b', { content: '{{#if .mood}}z{{/if}} {{char}} {{random::1::2}}' }),
      ], [
        ['a', true],
        ['b', true],
      ]),
    );
    const w = r.warnings.filter((x) => x.code === 'unknown_macro');
    expect(w.map((x) => [x.path, x.message])).toEqual([
      ['assistant_prefill', '{{choice}} is not an rp-core macro; it is sent as literal text'],
      ['prompts[2].content', '{{.player-instructions}} is not an rp-core macro; it is sent as literal text'],
      ['prompts[*].content', '{{#if}} is not an rp-core macro; it is sent as literal text (2 blocks)'],
      ['prompts[2].content', '{{else}} is not an rp-core macro; it is sent as literal text'],
      ['prompts[*].content', '{{/if}} is not an rp-core macro; it is sent as literal text (2 blocks)'],
    ]);
  });

  test("SillyTavern's Default.json has none", () => {
    const r = convert(JSON.parse(readFileSync(join(FIXTURES, 'Default.json'), 'utf8')));
    expect(codes(r)).not.toContain('unknown_macro');
  });
});
