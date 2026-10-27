// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 the rp-core authors
//
// The draft filing-answer reader of M4b (m4-decisions D-100): structuredCall with tag:null and the
// filing envelope {filings:[{type, entry}]} through a test-local read() — a fence, a bare object,
// broken JSON repaired, no corrective pass when repair is off. No src filing code (M5b).
import { describe, expect, test } from 'bun:test';
import type { ReadResult, Skip } from '../../src/agents/director/types.ts';
import { STRUCTURED_CAPS, calls, rig, textOfMsg } from './kit.ts';

/** The eleven entry types of §7.4 (enough of them for the envelope's enum). */
const TYPES = ['character', 'location', 'item', 'faction', 'event', 'lore', 'relationship', 'goal', 'secret', 'rule', 'misc'] as const;

const FILING_SCHEMA = {
  type: 'object',
  properties: {
    filings: {
      type: 'array',
      items: { type: 'object', properties: { type: { type: 'string', enum: TYPES }, entry: { type: 'object' } }, required: ['type', 'entry'] },
    },
  },
  required: ['filings'],
};

interface Filing {
  type: (typeof TYPES)[number];
  entry: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict core (a filings list), lenient elements (a bad one is skipped), as §7.2 says. */
function readFilings(raw: unknown): ReadResult<Filing[]> {
  const list = (raw as Record<string, unknown>)['filings'];
  if (!Array.isArray(list)) return { ok: false, code: 'invalid', message: 'filings must be a list of {type, entry}' };
  const out: Filing[] = [];
  const skipped: Skip[] = [];
  list.forEach((f, i) => {
    const type = isRecord(f) && typeof f['type'] === 'string' ? f['type'].trim().toLowerCase() : '';
    if (!isRecord(f) || !(TYPES as readonly string[]).includes(type) || !isRecord(f['entry'])) {
      skipped.push({ path: `filings[${i}]`, why: 'not a {type, entry} with a known type' });
      return;
    }
    out.push({ type: type as Filing['type'], entry: f['entry'] });
  });
  return { ok: true, value: out, skipped };
}

function filingRig(steps: Parameters<typeof calls>, repair = true, caps = undefined as typeof STRUCTURED_CAPS | undefined) {
  return rig<Filing[]>(calls(...steps), {
    ...(caps ? { caps } : {}),
    input: {
      agent: 'filing',
      tag: null,
      schema: { name: 'filings', schema: FILING_SCHEMA },
      read: readFilings,
      repair,
      callKeyPrefix: 'job_1:filing',
      system: `File what the reply established. Answer with one JSON object following this schema:\n${JSON.stringify(FILING_SCHEMA)}`,
      user: ['The reply: Мира нашла в лавке старую карту.'],
    },
  });
}

const MAP = '{"filings":[{"type":"item","entry":{"name":"Старая карта","owner":"Мира"}}]}';
const MAPPED: Filing[] = [{ type: 'item', entry: { name: 'Старая карта', owner: 'Мира' } }];

describe('the filing envelope through structuredCall (tag: null)', () => {
  test('a bare object', async () => {
    const out = await filingRig([[{ text: MAP }]]).run();
    expect(out.ok && out.value).toEqual(MAPPED);
    expect(out.attempts.map((a) => a.outcome)).toEqual(['ok']);
  });

  test('a ```json fence with prose around it', async () => {
    const out = await filingRig([[{ text: `Вот что стоит записать:\n\`\`\`json\n${MAP}\n\`\`\`\nГотово.` }]]).run();
    expect(out.ok && out.value).toEqual(MAPPED);
  });

  test('prose with braces before the object', async () => {
    const out = await filingRig([[{ text: `Filing {as asked}: ${MAP}` }]]).run();
    expect(out.ok && out.value).toEqual(MAPPED);
  });

  test('broken JSON is repaired: single quotes, trailing commas, a missing closing brace', async () => {
    const out = await filingRig([[{ text: "{'filings':[{'type':'item','entry':{'name':'Старая карта','owner':'Мира',},},]" }]]).run();
    expect(out.ok && out.value).toEqual(MAPPED);
  });

  test('an element of a bad shape is skipped, not the answer; a type is case-fixed', async () => {
    const out = await filingRig([[{ text: '{"filings":[{"type":"Item","entry":{"name":"Карта"}},{"type":"spaceship","entry":{}},"loose"]}' }]]).run();
    expect(out.ok && out.value).toEqual([{ type: 'item', entry: { name: 'Карта' } }]);
    expect(out.ok && out.skipped).toEqual([
      { path: 'filings[1]', why: 'not a {type, entry} with a known type' },
      { path: 'filings[2]', why: 'not a {type, entry} with a known type' },
    ]);
  });

  test('an object without a directive is fine here: the directive rule is the plan tag\'s only', async () => {
    const out = await filingRig([[{ text: '{"filings":[]}' }]]).run();
    expect(out.ok && out.value).toEqual([]);
  });

  test('a <plan> block means nothing to a tag:null agent: its object is still the first object', async () => {
    const out = await filingRig([[{ text: `<plan>${MAP}</plan>` }]]).run();
    expect(out.ok && out.value).toEqual(MAPPED);
  });

  test('the structured transport: the schema rides the request, the bare object is the answer', async () => {
    const r = filingRig([[{ text: MAP }]], true, STRUCTURED_CAPS);
    const out = await r.run();
    expect(out.ok && out.transport).toBe('structured');
    expect(r.provider.requests[0]!.responseSchema).toEqual({ name: 'filings', schema: FILING_SCHEMA });
    expect(r.provider.requests[0]!.agent).toBe('filing');
  });
});

describe('failures and the corrective pass', () => {
  test('repair: false: a bad answer fails with its own code and no second call', async () => {
    for (const [text, code] of [
      ['Nothing worth filing.', 'no_output'],
      ['{"filings": "none"}', 'invalid'],
      ['["item"]', 'no_output'],
    ] as const) {
      const r = filingRig([[{ text }], [{ text: MAP }]], false);
      const out = await r.run();
      expect(out.ok ? 'ok' : out.code).toBe(code);
      expect(r.provider.requests.length).toBe(1);
    }
  });

  test('a cut-off answer at the length finish is undecodable', async () => {
    const out = await filingRig([[{ text: '{"filings":[{"type":"item","entry":{"name":"Стар' }, { finish: 'length' }]], false).run();
    expect(out.ok ? 'ok' : out.code).toBe('undecodable');
  });

  test('repair: true: one correction with the tag:null wording, then ok', async () => {
    const r = filingRig([[{ text: '{"filings": "none"}' }], [{ text: MAP }]]);
    const out = await r.run();
    expect(out.ok && out.value).toEqual(MAPPED);
    expect(out.attempts.map((a) => a.outcome)).toEqual(['invalid', 'ok']);
    const q1 = r.provider.requests[1]!;
    expect(q1.messages.slice(-2).map((m) => [m.role, m.src, textOfMsg(m)])).toEqual([
      ['assistant', 'filing:answer', '{"filings": "none"}'],
      [
        'user',
        'filing:correction',
        'Your answer was not usable (filings must be a list of {type, entry}). Answer again with exactly one JSON object following the schema above. Write nothing else.',
      ],
    ]);
    expect(r.provider.requests.map((q) => q.callKey)).toEqual(['job_1:filing:0', 'job_1:filing:1']);
  });

  test('no JSON at all: the correction says no JSON object was found', async () => {
    const r = filingRig([[{ text: 'Nothing worth filing.' }], [{ text: MAP }]]);
    expect((await r.run()).ok).toBe(true);
    expect(textOfMsg(r.provider.requests[1]!.messages.at(-1)!)).toContain('(no JSON object was found)');
  });
});
