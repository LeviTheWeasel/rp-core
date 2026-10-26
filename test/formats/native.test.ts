// canonicalId [D-72] and the hand-written validators for the native formats (§5.1, §10.2).
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_PRESET,
  canonicalId,
  validateCharacter,
  validateLoreBook,
  validatePersona,
  validatePreset,
  type Preset,
} from '../../src/formats/native.ts';

const paths = (r: { ok: boolean; errors?: { path: string }[] }): string[] => (r.ok ? [] : (r.errors ?? []).map((e) => e.path));

describe('canonicalId', () => {
  test('Cyrillic names stay Cyrillic', () => {
    expect(canonicalId('Мира Солнцева')).toBe('мира-солнцева');
    expect(canonicalId('Ёжик в тумане!')).toBe('ёжик-в-тумане');
  });

  test('lower-case, punctuation runs collapse, ends trimmed', () => {
    expect(canonicalId('  Hello,   World!! ')).toBe('hello-world');
    expect(canonicalId('a/b\\c..d')).toBe('a-b-c-d');
    expect(canonicalId('../etc/passwd')).toBe('etc-passwd');
    expect(canonicalId("Alice's World")).toBe('alice-s-world');
  });

  test('NFKC folds compatibility forms', () => {
    expect(canonicalId('Ｆｕｌｌｗｉｄｔｈ')).toBe('fullwidth');
    expect(canonicalId('ﬁne ①')).toBe('fine-1');
    expect(canonicalId('Café')).toBe('café');
  });

  test('other scripts survive, including combining marks', () => {
    expect(canonicalId('한국 이름')).toBe('한국-이름');
    expect(canonicalId('नमस्ते')).toBe('नमस्ते');
    expect(canonicalId('東京')).toBe('東京');
  });

  test('empty after cleaning → untitled', () => {
    expect(canonicalId('')).toBe('untitled');
    expect(canonicalId('!!! ---')).toBe('untitled');
    expect(canonicalId('🙂')).toBe('untitled');
  });

  test('capped at 64 code points with no trailing hyphen', () => {
    const id = canonicalId(`${'я'.repeat(63)} tail`);
    expect(Array.from(id)).toHaveLength(63);
    expect(id.endsWith('-')).toBe(false);
    expect(Array.from(canonicalId('ж'.repeat(100)))).toHaveLength(64);
  });

  test('Windows device names get a suffix', () => {
    expect(canonicalId('CON')).toBe('con-id');
    expect(canonicalId('lpt1')).toBe('lpt1-id');
    expect(canonicalId('console')).toBe('console');
  });
});

describe('validateCharacter', () => {
  test('a minimal character is valid and returned as-is', () => {
    const c = { name: 'A', description: '', greetings: [] };
    expect(validateCharacter(c)).toEqual({ ok: true, value: c });
  });

  test('a matching format tag is accepted, a wrong one is not', () => {
    expect(validateCharacter({ format: 'core.character/1', name: 'A', description: '', greetings: [] }).ok).toBe(true);
    expect(paths(validateCharacter({ format: 'core.preset/1', name: 'A', description: '', greetings: [] }))).toEqual(['format']);
  });

  test('reports every error with its path', () => {
    const r = validateCharacter({
      name: '',
      greetings: ['ok', 3],
      depthPrompt: { text: 't', depth: -1, role: 'narrator' },
      book: { name: 'b', entries: [{ id: 'x', content: '', keys: [], position: 'sideways' }] },
      tags: 'x',
      nickname: 'Ali',
    });
    expect(paths(r).sort()).toEqual(
      [
        'name',
        'description',
        'greetings[1]',
        'depthPrompt.depth',
        'depthPrompt.role',
        'book.entries[0].position',
        'tags',
        'nickname',
      ].sort(),
    );
  });

  test('not an object', () => {
    expect(paths(validateCharacter(null))).toEqual(['$']);
    expect(paths(validateCharacter([]))).toEqual(['$']);
  });
});

describe('validatePersona', () => {
  test('valid with aliases and a book', () => {
    expect(validatePersona({ name: 'Levi', aliases: ['L'], description: 'd', book: { name: 'p', entries: [] } }).ok).toBe(true);
  });
  test('errors', () => {
    expect(paths(validatePersona({ name: 3, aliases: [1] })).sort()).toEqual(['aliases[0]', 'description', 'name']);
  });
});

describe('validatePreset', () => {
  test('BUILTIN_PRESET is valid', () => {
    expect(validatePreset(BUILTIN_PRESET)).toEqual({ ok: true, value: BUILTIN_PRESET });
  });

  const preset = (blocks: Preset['blocks'], extra: Partial<Preset> = {}): Preset => ({ name: 'p', blocks, ...extra });
  const block = (id: string, content: string, enabled = true): Preset['blocks'][number] => ({
    id,
    role: 'system',
    enabled,
    content,
    at: 'relative',
  });

  test('exactly one enabled {{history}} is required', () => {
    expect(paths(validatePreset(preset([block('a', 'x')])))).toEqual(['blocks']);
    expect(paths(validatePreset(preset([block('a', '{{history}}'), block('b', '{{history}}')])))).toEqual(['blocks']);
    expect(paths(validatePreset(preset([block('a', '{{history}} {{history}}')])))).toEqual(['blocks']);
    // a disabled extra history block does not count
    expect(validatePreset(preset([block('a', '{{history}}'), block('b', '{{history}}', false)])).ok).toBe(true);
    // only a disabled one: missing
    expect(paths(validatePreset(preset([block('a', '{{history}}', false)])))).toEqual(['blocks']);
  });

  test('history slots are counted the way assemble finds them (the macro lexer)', () => {
    // The macro engine treats these spellings as the slot, so validation must too.
    expect(validatePreset(preset([block('a', '{{ History }}')])).ok).toBe(true);
    // An escaped tag renders literally: it is no second slot.
    expect(validatePreset(preset([block('a', '{{history}}'), block('b', 'say \\{{history}} aloud')])).ok).toBe(true);
    // A slot nested in another macro's argument is no top-level slot either.
    expect(paths(validatePreset(preset([block('a', '{{trim::{{history}}}}')])))).toEqual(['blocks']);
  });

  test('block, sampler and option errors carry paths', () => {
    const r = validatePreset({
      name: 'p',
      blocks: [
        { ...block('h', '{{history}}'), at: { depth: 1.5 } },
        { ...block('h', 'dup'), role: 'narrator', override: 'card_main' },
      ],
      samplers: { temperature: 'hot', stop: ['x', 1], mirostat: 1 },
      context: { maxContext: 0 },
      postProcessing: 'loose',
      formats: { wi: 3 },
      forbidOverrides: 'yes',
    });
    expect(paths(r).sort()).toEqual(
      [
        'blocks[0].at.depth',
        'blocks[1].role',
        'blocks[1].override',
        'blocks[1].id',
        'samplers.temperature',
        'samplers.stop[1]',
        'samplers.mirostat',
        'context.maxContext',
        'postProcessing',
        'formats.wi',
        'forbidOverrides',
      ].sort(),
    );
  });

  test('all optional preset fields accepted', () => {
    const r = validatePreset(
      preset([{ ...block('h', '{{history}}'), at: { depth: 0, order: 2 }, name: 'History', extras: { uid: 1 } }], {
        forbidOverrides: true,
        samplers: { temperature: 0.7, stop: ['\n'], max_tokens: 300 },
        context: { maxContext: 8000, maxMessages: 50 },
        prefill: 'Sure,',
        impersonation: { prompt: 'Write as {{user}}', prefill: '' },
        postProcessing: 'merge',
        formats: { wi: '[{0}]', personality: '{0}', scenario: '{0}', newChat: '[Start]', newExampleChat: '[Example]' },
        extras: { st: true },
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('validateLoreBook', () => {
  const entry = { id: 'e1', content: 'c', keys: ['k'], position: 'before' };

  test('every position shape', () => {
    const positions = [
      'before',
      'after',
      'examples_before',
      'examples_after',
      'note_before',
      'note_after',
      'top',
      'bottom',
      'recap',
      { depth: 0 },
      { depth: 3, role: 'assistant' },
      { outlet: 'map' },
    ];
    const book = { name: 'b', entries: positions.map((position, i) => ({ ...entry, id: `e${i}`, position })) };
    expect(validateLoreBook(book).ok).toBe(true);
  });

  test('a full entry is valid', () => {
    const r = validateLoreBook({
      format: 'core.lorebook/1',
      name: 'b',
      scanDepth: 2,
      recursive: true,
      caseSensitive: false,
      wholeWords: true,
      match: 'stem',
      extras: {},
      entries: [
        {
          ...entry,
          title: 't',
          enabled: true,
          constant: false,
          secondary: ['s'],
          logic: 'not_all',
          order: -5,
          probability: 50,
          groups: ['g'],
          groupWeight: 10,
          scanDepth: 4,
          caseSensitive: true,
          wholeWords: false,
          preventRecursion: true,
          excludeRecursion: false,
          ignoreBudget: true,
          sticky: 1,
          cooldown: 2,
          delay: 0,
          meta: { type: 'npc', data: { age: 3 }, aliases: ['x'], featured: true, arc: 'a1' },
          extras: { uid: 7 },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  test('errors: duplicate ids, bad position objects, probability range, unknown keys', () => {
    const r = validateLoreBook({
      name: 'b',
      match: 'fuzzy',
      entries: [
        entry,
        { ...entry, position: { depth: 2, outlet: 'x' } },
        { ...entry, id: 'e2', position: { depth: 1, role: 'narrator' }, probability: 120, group: 'old' },
        { ...entry, id: 'e3', keys: 'k', meta: { featured: 'yes' } },
      ],
    });
    expect(paths(r).sort()).toEqual(
      [
        'match',
        'entries[1].id',
        'entries[1].position.depth',
        'entries[2].position.role',
        'entries[2].probability',
        'entries[2].group',
        'entries[3].keys',
        'entries[3].meta.featured',
      ].sort(),
    );
  });
});
