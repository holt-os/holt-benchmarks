// Offline retrieval tuning on the dev split only: does Holt's context contain the
// turns LongMemEval marks has_answer? No LLM calls.
//   node cov.mjs --ids sample-100.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, parseArgs } from './common.mjs';
import * as holt from './holt-lib.mjs';

const args = parseArgs(process.argv.slice(2));
const ids = JSON.parse(readFileSync(join(HERE, args.ids), 'utf8'));
const data = new Map(JSON.parse(readFileSync(join(HERE, 'data', 'longmemeval_s_cleaned.json'), 'utf8')).map((q) => [q.question_id, q]));
const grid = [];
for (const k of [16, 24, 32, 48]) for (const neighbors of [0, 1]) for (const neighborCap of [2000, 600, 250]) for (const userBoost of [1, 1.15]) for (const budget of [24000, 32000])
  grid.push({ k, neighbors, neighborCap, userBoost, budget });

const results = [];
for (const cfg of grid) {
  let full = 0, turnHit = 0, turnTot = 0, n = 0; const chars = [];
  const byType = {};
  for (const id of ids) {
    if (id.endsWith('_abs')) continue;
    const q = data.get(id);
    const ev = new Set();
    q.haystack_sessions.forEach((s, si) => s.forEach((t, ti) => { if (t.has_answer) ev.add(`${si}-${ti}`); }));
    if (!ev.size) continue;
    process.chdir(join(HERE, 'work', id));
    const ctx = await holt.recallContext(q.question, 'bench-current', cfg);
    process.chdir(HERE);
    // map kept rows back to ids via session + content match
    const kept = new Set();
    for (const b of ctx.blocks) {
      const si = q.haystack_session_ids.indexOf(b.session);
      for (const r of b.rows) {
        const ti = q.haystack_sessions[si].findIndex((t) => r.content.startsWith(t.content.slice(0, 60)) || t.content.startsWith(r.content.slice(0, 60)));
        if (ti >= 0) kept.add(`${si}-${ti}`);
      }
    }
    const hit = [...ev].filter((e) => kept.has(e)).length;
    turnHit += hit; turnTot += ev.size; n++; if (hit === ev.size) full++;
    (byType[q.question_type] ??= [0, 0]); byType[q.question_type][0] += hit === ev.size; byType[q.question_type][1]++;
    chars.push(ctx.chars);
  }
  chars.sort((a, b) => a - b);
  const r = { ...cfg, full: +(full / n).toFixed(3), turnRecall: +(turnHit / turnTot).toFixed(3), medChars: chars[chars.length >> 1], ms: byType['multi-session'] ? +(byType['multi-session'][0] / byType['multi-session'][1]).toFixed(2) : null };
  results.push(r);
  console.log(JSON.stringify(r));
}
writeFileSync(join(HERE, 'cov-results.json'), JSON.stringify(results, null, 1));
