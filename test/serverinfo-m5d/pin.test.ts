// D-211's pinning rule as pinVerdict's table, the line rp-core probe prints for it, and the engine's
// callCaps / slotPinOf around it.
import { describe, expect, test } from 'bun:test';
import { callCaps, slotPinOf } from '../../src/engine/server-notices.ts';
import { pinLine, pinVerdict, type ServerInfo } from '../../src/providers/server-info.ts';
import type { ModelCaps } from '../../src/providers/types.ts';

const llama = (totalSlots: number | null, build: number | null): ServerInfo => ({ kind: 'llama.cpp', totalSlots, build });
const ON = { narrator: 0, agents: 1 };

describe('pinVerdict', () => {
  const rows: [string, ServerInfo, { capacity: number; override?: boolean }, boolean][] = [
    ['new build, 2 slots, capacity 2', llama(2, 11901), { capacity: 2 }, true],
    ['exactly b11552', llama(2, 11552), { capacity: 2 }, true],
    ['b11551 at capacity 2', llama(2, 11551), { capacity: 2 }, false],
    ['old build at capacity 1', llama(2, 9000), { capacity: 1 }, true],
    ['unknown build at capacity 1', llama(4, null), { capacity: 1 }, true],
    ['unknown build at capacity 2', llama(4, null), { capacity: 2 }, false],
    ['one slot, new build', llama(1, 11901), { capacity: 1 }, false],
    ['slot count unknown', llama(null, 11901), { capacity: 1 }, false],
    ['override true beats one slot', llama(1, 9000), { capacity: 2, override: true }, true],
    ['override true on unknown', { kind: 'unknown', reason: 'x' }, { capacity: 1, override: true }, true],
    ['override false beats a new build', llama(2, 11901), { capacity: 1, override: false }, false],
    ['Ollama', { kind: 'ollama', loaded: [] }, { capacity: 1 }, false],
    ['LM Studio', { kind: 'lmstudio', loaded: {} }, { capacity: 1 }, false],
    ['unknown', { kind: 'unknown', reason: 'nothing answered' }, { capacity: 1 }, false],
  ];
  for (const [name, info, o, pins] of rows) {
    test(name, () => {
      const v = pinVerdict(info, o);
      expect(v.pin).toEqual(pins ? ON : null);
      expect(v.why.length).toBeGreaterThan(0);
    });
  }

  test('the reasons say why', () => {
    expect(pinVerdict(llama(2, 11901), { capacity: 2 }).why).toBe('2 slots, build b11901');
    expect(pinVerdict(llama(2, 9000), { capacity: 1 }).why).toBe('2 slots, capacity 1 (build b9000)');
    expect(pinVerdict(llama(2, 9000), { capacity: 2 }).why).toContain('older than b11552 and capacity is 2');
    // An unknown build is not said to be old: rp-core does not know.
    const unknownBuild = pinVerdict(llama(2, null), { capacity: 2 }).why;
    expect(unknownBuild).toStartWith('the build is unknown (pinning a busy slot is safe only from b11552) and capacity is 2');
    expect(unknownBuild).not.toContain('older');
    expect(pinVerdict(llama(1, 11901), { capacity: 1 }).why).toContain('-np 2 --no-kv-unified');
    expect(pinVerdict(llama(2, 11901), { capacity: 1, override: false }).why).toBe('slot_pin = false in config');
    expect(pinVerdict({ kind: 'unknown', reason: 'nothing answered' }, { capacity: 1 }).why).toBe('server unknown (nothing answered)');
  });

  test('a returned pin is a fresh object', () => {
    const a = pinVerdict(llama(2, 11901), { capacity: 1 }).pin!;
    a.narrator = 5;
    expect(pinVerdict(llama(2, 11901), { capacity: 1 }).pin).toEqual(ON);
  });
});

test('pinLine', () => {
  expect(pinLine(pinVerdict(llama(2, 11901), { capacity: 2 }))).toBe('slot pinning: on — narrator 0, agents 1 (2 slots, build b11901)');
  expect(pinLine(pinVerdict(llama(2, 11901), { capacity: 2, override: false }))).toBe('slot pinning: off — slot_pin = false in config');
});

test("callCaps and slotPinOf leave a hand-set extra_body id_slot alone", () => {
  const caps = { extraBody: { id_slot: 2 } } as unknown as ModelCaps;
  expect(callCaps(caps, llama(2, 11901), 1)).toBe(caps);
  expect(slotPinOf(caps, llama(2, 11901), 1)).toEqual({ pin: null, why: 'id_slot 2 is set in extra_body' });
  // Without it the rule pins a copy.
  const plain = { extraBody: { cache_prompt: true } } as unknown as ModelCaps;
  expect(callCaps(plain, llama(2, 11901), 1).slotPin).toEqual(ON);
  expect(plain.slotPin).toBeUndefined();
});
