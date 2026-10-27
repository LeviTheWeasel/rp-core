// Re-derives the M2 digests pinned in no-tools.test.ts (a script, not a test). Usage, from the repo:
//   d=$(mktemp -d) && git archive c478eed src | tar -x -C "$d" && ln -s "$PWD/node_modules" "$d/node_modules" \
//     && mkdir -p "$d/test/prompt-m3" && cp test/prompt-m3/m2-scenarios.ts "$d/test/prompt-m3/" \
//     && bun run test/prompt-m3/capture-m2.ts "$d"
// c478eed is the M2 commit. Run it with the repo root instead to see what the current code gives.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const { assemble } = (await import(`${root}/src/prompt/assemble.ts`)) as { assemble: (input: unknown) => unknown };
const { scenarios, m2Json } = (await import(`${root}/test/prompt-m3/m2-scenarios.ts`)) as {
  scenarios: () => { name: string; input: unknown }[];
  m2Json: (r: unknown) => string;
};
const out: Record<string, string> = {};
for (const s of scenarios()) out[s.name] = createHash('sha256').update(m2Json(assemble(s.input))).digest('hex');
console.log(JSON.stringify(out, null, 2));
