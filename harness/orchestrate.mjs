// Runs the whole Holt benchmark sequence on one machine and keeps STATUS.md current.
// Ingest runs separately (it only needs Ollama); this script waits for each ingest to finish.
//   nohup node orchestrate.mjs > logs-orchestrate.txt 2>&1 &
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './common.mjs';

const STATUS = join(HERE, 'STATUS.md');
const log = (m) => { const line = `- ${new Date().toISOString().slice(0, 16)} ${m}`; console.log(line); appendFileSync(STATUS, line + '\n'); };
const sh = (cmd, env = {}) => execSync(cmd, { cwd: HERE, stdio: 'inherit', env: { ...process.env, ...env } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doneDirs = (dir, ids) => ids.every((id) => existsSync(join(HERE, dir, id, '.holt', 'memory', 'turns.jsonl.done')));
async function waitFor(label, fn) { if (fn()) return; log(`waiting for ${label}`); while (!fn()) await sleep(60000); log(`${label} ready`); }

function lmeScore(file) {
  const rows = readFileSync(join(HERE, 'out', file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { n: rows.length, acc: rows.filter((r) => r.label).length / rows.length };
}
const chars = (file) => {
  const rows = readFileSync(join(HERE, 'out', file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const v = rows.map((r) => r.prompt_chars).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};

const CONFIGS = {
  default: { HOLT_RECALL_K: '10', HOLT_RECALL_NEIGHBORS: '1', HOLT_RECALL_BUDGET: '16000' },
  wide: { HOLT_RECALL_K: '16', HOLT_RECALL_NEIGHBORS: '1', HOLT_RECALL_BUDGET: '24000' },
  tight: { HOLT_RECALL_K: '8', HOLT_RECALL_NEIGHBORS: '1', HOLT_RECALL_BUDGET: '10000' },
};

const dev = JSON.parse(readFileSync(join(HERE, 'sample-100.json'), 'utf8'));
const held = JSON.parse(readFileSync(join(HERE, 'heldout-399.json'), 'utf8'));
const locomoIds = JSON.parse(readFileSync(join(HERE, 'data', 'locomo10.json'), 'utf8')).map((c) => c.sample_id);
const beamIds = JSON.parse(readFileSync(join(HERE, 'data', 'beam-1M.json'), 'utf8')).map((c) => c.id);

writeFileSync(STATUS, `# Holt benchmark run\n\nStarted ${new Date().toISOString()}\n\n`);

// 1. Tune on the 101-question dev split only.
await waitFor('LongMemEval dev memories', () => doneDirs('work', dev));
const devResults = {};
for (const [tag, env] of Object.entries(CONFIGS)) {
  log(`dev: answering with ${tag} ${JSON.stringify(env)}`);
  sh(`node run.mjs answer --ids sample-100.json --mode holt2 --tag ${tag} --model sonnet --conc 3`, env);
  sh(`node run.mjs grade --hyp out/holt2-${tag}-sonnet-sample-100.jsonl --model opus --conc 3`);
  const s = lmeScore(`holt2-${tag}-sonnet-sample-100.graded-opus.jsonl`);
  devResults[tag] = { ...s, chars: chars(`holt2-${tag}-sonnet-sample-100.jsonl`) };
  log(`dev ${tag}: ${(s.acc * 100).toFixed(1)}% of ${s.n}, median ${devResults[tag].chars} chars`);
}
// Best dev accuracy wins; within 1 point, the smaller context wins.
const best = Object.entries(devResults).sort((a, b) => (Math.abs(b[1].acc - a[1].acc) <= 0.01 ? a[1].chars - b[1].chars : b[1].acc - a[1].acc))[0][0];
const env = CONFIGS[best];
writeFileSync(join(HERE, 'chosen.json'), JSON.stringify({ config: best, env, devResults }, null, 2));
log(`FROZEN config: ${best} ${JSON.stringify(env)}. Nothing below is tuned.`);

// 2. LoCoMo, never tuned on.
await waitFor('LoCoMo memories', () => doneDirs('work-locomo', locomoIds));
log('LoCoMo: answering 1,540 questions');
sh(`node locomo.mjs answer --model sonnet --tag ${best} --conc 3`, env);
sh(`node locomo.mjs grade --hyp out/locomo-${best}-sonnet.jsonl --model opus --conc 3`);
log('LoCoMo graded');

// 3. LongMemEval held-out 399.
await waitFor('LongMemEval all memories', () => doneDirs('work', held));
log('LongMemEval: answering held-out 399');
sh(`node run.mjs answer --ids heldout-399.json --mode holt2 --tag ${best} --model sonnet --conc 3`, env);
sh(`node run.mjs grade --hyp out/holt2-${best}-sonnet-heldout-399.jsonl --model opus --conc 3`);
log('LongMemEval held-out graded');

// 4. BEAM 1M, never tuned on.
await waitFor('BEAM 1M memories', () => doneDirs('work-beam-1M', beamIds));
log('BEAM 1M: answering 700 questions');
sh(`node beam.mjs answer --size 1M --model sonnet --tag ${best} --conc 3`, env);
sh(`node beam.mjs grade --hyp out/beam-1M-${best}-sonnet.jsonl --model opus --conc 3`);
log('BEAM graded');

sh('node run.mjs report > report-lme.txt; node locomo.mjs report > report-locomo.txt; node beam.mjs report > report-beam.txt');
log('ALL DONE');
