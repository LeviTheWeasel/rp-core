// Shared MacroEnv fixture for the macro tests.
import { createMacroRun, type MacroEnv, type MacroRun } from '../../src/prompt/macros.ts';

type EnvOver = Partial<Omit<MacroEnv, 'card'>> & { card?: Partial<MacroEnv['card']> };

export function env(over: EnvOver = {}): MacroEnv {
  const { card, ...rest } = over;
  return {
    char: 'Alice',
    user: 'Bob',
    persona: '',
    vars: {},
    now: '2026-10-26T15:45:00.000Z',
    timeZone: 'UTC',
    seed: 42,
    sessionId: 'sess-1',
    ...rest,
    card: {
      description: '',
      personality: '',
      scenario: '',
      examples: '',
      systemPrompt: '',
      postHistory: '',
      firstMessage: '',
      ...card,
    },
  };
}

export const run = (over: EnvOver = {}): MacroRun => createMacroRun(env(over));

/** Expand one block in a fresh run. */
export const expand = (text: string, over: EnvOver = {}, source = 'main', original?: string): string =>
  run(over).block(text, source, original === undefined ? undefined : { original });
