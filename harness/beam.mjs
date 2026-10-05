// BEAM harness for Holt (Mohammadta/BEAM, converted to data/beam-<size>.json by the venv script).
//   node beam.mjs ingest --size 1M
//   node beam.mjs answer --size 1M --model sonnet [--tag x] [--limit N]
//   node beam.mjs grade  --hyp out/beam-1M-<tag>-<model>.jsonl --model opus
//   node beam.mjs report
// Judge: Mem0's BEAM nugget judge (0 / 0.5 / 1.0 per rubric nugget), question score = mean,
// pass = score >= 0.5. Event ordering is scored on nuggets only (no Kendall tau-b term).
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, parseArgs, pool, claude } from './common.mjs';
import * as holt from './holt-lib.mjs';

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const size = args.size || '1M';
const WORK = join(HERE, `work-beam-${size}`);
const OUT = join(HERE, 'out');
mkdirSync(WORK, { recursive: true }); mkdirSync(OUT, { recursive: true });
const convs = JSON.parse(readFileSync(join(HERE, 'data', `beam-${size}.json`), 'utf8'));
const questions = () => convs.flatMap((c) => c.questions.map((q) => ({ ...q, conv: c.id })));

if (cmd === 'ingest') {
  for (const c of convs) {
    const dir = join(WORK, c.id, '.holt', 'memory'); const file = join(dir, 'turns.jsonl');
    if (existsSync(file + '.done')) continue;
    mkdirSync(dir, { recursive: true });
    const rows = [];
    c.sessions.forEach((s, si) => s.turns.forEach((t, ti) => rows.push({ id: `${si}-${ti}`, ts: s.ts + ti * 1000, session: `b${si}`, role: t.role === 'assistant' ? 'assistant' : 'user', content: t.content })));
    const t0 = Date.now();
    const embs = await pool(rows, 8, (r) => holt.embed(r.content));
    writeFileSync(file, rows.map((r, i) => JSON.stringify({ ...r, emb: embs[i] ?? undefined })).join('\n') + '\n');
    writeFileSync(file + '.done', String(embs.filter((e) => !e).length));
    console.log(`conv ${c.id}: ${rows.length} turns, ${embs.filter((e) => !e).length} missing, ${((Date.now() - t0) / 60000).toFixed(1)}m`);
  }
}

if (cmd === 'answer') {
  const model = args.model || 'sonnet';
  const outFile = join(OUT, `beam-${size}${args.tag ? '-' + args.tag : ''}-${model}.jsonl`);
  const have = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).qid) : []);
  let qs = questions().filter((q) => !have.has(q.qid));
  if (args.limit) qs = qs.slice(0, +args.limit);
  const today = Object.fromEntries(convs.map((c) => [c.id, new Date(Math.max(...c.sessions.map((s) => s.ts)) + 86400000).toISOString().slice(0, 10)]));
  const prompts = [];
  for (const q of qs) {
    process.chdir(join(WORK, q.conv));
    const ctx = await holt.recallContext(q.question, 'bench-current');
    process.chdir(HERE);
    prompts.push({ q, prompt: holt.renderPrompt([], q.question, holt.formatMemoryContext(ctx, today[q.conv])) });
  }
  let n = 0;
  await pool(prompts, +(args.conc || 4), async ({ q, prompt }) => {
    const r = await claude(prompt, model);
    if (!r.ok || !r.text) { console.log('skip (will retry on resume)', q.qid); return; }
    appendFileSync(outFile, JSON.stringify({ qid: q.qid, hypothesis: r.text, ok: r.ok, prompt_chars: prompt.length }) + '\n');
    if (++n % 25 === 0) console.log(`[${n}/${prompts.length}]`);
  });
  console.log('wrote', outFile);
}

const JUDGE_SYS = "You are an expert evaluator assessing whether an AI assistant's response satisfies specific rubric criteria. You must be objective, fair, and consistent. Return ONLY valid JSON with the exact format requested.";
const judgeTpl = () => {
  const src = readFileSync(join(HERE, 'ref', 'beam_prompts.py'), 'utf8');
  const m = src.match(/def get_beam_nugget_judge_prompt[\s\S]*?return f"""([\s\S]*?)"""/);
  return m[1].replace(/\{\{/g, '{').replace(/\}\}/g, '}');
};

if (cmd === 'grade') {
  const model = args.model || 'opus';
  const tpl = judgeTpl();
  const byId = new Map(questions().map((q) => [q.qid, q]));
  const hypFile = join(HERE, args.hyp); const outFile = hypFile.replace('.jsonl', `.graded-${model}.jsonl`);
  const have = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).qid) : []);
  const hyps = readFileSync(hypFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => !have.has(x.qid));
  let n = 0;
  await pool(hyps, +(args.conc || 4), async (x) => {
    const q = byId.get(x.qid);
    const scores = [];
    for (const nug of q.rubric) {
      const prompt = tpl.replace('{question}', q.question).replace('{llm_response}', x.hypothesis).replace('{nugget}', nug);
      const r = await claude(prompt, model, JUDGE_SYS);
      if (!r.ok || !r.text) { console.log('judge skip', x.qid); return; }
      const m = r.text.match(/"score"\s*:\s*([0-9.]+)/);
      const raw = m ? parseFloat(m[1]) : (/\b1\.0\b/.test(r.text) ? 1 : /\b0\.5\b/.test(r.text) ? 0.5 : 0);
      scores.push(raw >= 0.75 ? 1 : raw >= 0.25 ? 0.5 : 0);
    }
    const score = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    appendFileSync(outFile, JSON.stringify({ qid: x.qid, type: q.type, score, pass: score >= 0.5, nuggets: scores }) + '\n');
    if (++n % 25 === 0) console.log(`[${n}/${hyps.length}]`);
  });
  console.log('wrote', outFile);
}

if (cmd === 'report') {
  for (const f of readdirSync(OUT).filter((f) => f.startsWith('beam') && f.includes('.graded-'))) {
    const rows = readFileSync(join(OUT, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const by = {};
    for (const r of rows) { (by[r.type] ??= []).push(r); }
    const avg = (a) => a.reduce((s, r) => s + r.score, 0) / a.length;
    const pr = (a) => a.filter((r) => r.pass).length;
    console.log(`\n${f}\n  pass ${((pr(rows) / rows.length) * 100).toFixed(1)}% (${pr(rows)}/${rows.length})  avg score ${avg(rows).toFixed(3)}`);
    for (const [k, a] of Object.entries(by).sort()) console.log(`  ${k.padEnd(26)} avg ${avg(a).toFixed(3)}  pass ${pr(a)}/${a.length}`);
  }
}
