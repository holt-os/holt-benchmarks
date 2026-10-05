// LoCoMo harness for Holt (categories 1-4 = 1,540 questions; category 5 adversarial excluded, as is standard).
//   node locomo.mjs ingest
//   node locomo.mjs answer --model sonnet [--tag x] [--limit N]
//   node locomo.mjs grade  --hyp out/locomo-<tag>-<model>.jsonl --model opus
//   node locomo.mjs report
// Judge: the original LoCoMo J-score prompt from the Mem0 paper (arXiv:2504.19413, App. A).
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, parseArgs, pool, claude } from './common.mjs';
import * as holt from './holt-lib.mjs';

const DATA = join(HERE, 'data', 'locomo10.json');
const WORK = join(HERE, 'work-locomo');
const OUT = join(HERE, 'out');
mkdirSync(WORK, { recursive: true }); mkdirSync(OUT, { recursive: true });
const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const convs = JSON.parse(readFileSync(DATA, 'utf8'));
const CATS = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// "1:56 pm on 8 May, 2023" -> epoch ms (UTC)
function toTs(s) {
  const m = s.match(/(\d+):(\d+)\s*(am|pm)\s+on\s+(\d+)\s+(\w+),?\s+(\d{4})/i);
  if (!m) throw new Error('bad date ' + s);
  let h = +m[1] % 12; if (m[3].toLowerCase() === 'pm') h += 12;
  return Date.UTC(+m[6], MONTHS.indexOf(m[5].toLowerCase()), +m[4], h, +m[2]);
}
const sessionsOf = (c) => Object.keys(c.conversation).filter((k) => /^session_\d+$/.test(k)).sort((a, b) => +a.split('_')[1] - +b.split('_')[1]);
const questions = () => convs.flatMap((c) => c.qa.filter((q) => q.category >= 1 && q.category <= 4).map((q, i) => ({ ...q, conv: c.sample_id, qid: `${c.sample_id}-${i}` })));

if (cmd === 'ingest') {
  for (const c of convs) {
    const dir = join(WORK, c.sample_id, '.holt', 'memory'); const file = join(dir, 'turns.jsonl');
    if (existsSync(file + '.done')) continue;
    mkdirSync(dir, { recursive: true });
    const rows = [];
    for (const s of sessionsOf(c)) {
      const base = toTs(c.conversation[`${s}_date_time`]);
      c.conversation[s].forEach((t, i) => {
        const img = t.blip_caption ? ` [shares an image: ${t.blip_caption}]` : '';
        rows.push({ id: t.dia_id, ts: base + i * 1000, session: s, role: 'user', content: `${t.speaker}: ${t.text}${img}` });
      });
    }
    const embs = await pool(rows, 8, (r) => holt.embed(r.content));
    writeFileSync(file, rows.map((r, i) => JSON.stringify({ ...r, emb: embs[i] ?? undefined })).join('\n') + '\n');
    writeFileSync(file + '.done', String(embs.filter((e) => !e).length));
    console.log(`${c.sample_id}: ${rows.length} turns, ${embs.filter((e) => !e).length} missing embeddings`);
  }
}

if (cmd === 'answer') {
  const model = args.model || 'sonnet';
  const outFile = join(OUT, `locomo${args.tag ? '-' + args.tag : ''}-${model}.jsonl`);
  const have = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).qid) : []);
  let qs = questions().filter((q) => !have.has(q.qid));
  if (args.limit) qs = qs.slice(0, +args.limit);
  const lastDay = Object.fromEntries(convs.map((c) => {
    const ts = Math.max(...sessionsOf(c).map((s) => toTs(c.conversation[`${s}_date_time`])));
    return [c.sample_id, new Date(ts + 86400000).toISOString().slice(0, 10)];
  }));
  const prompts = [];
  for (const q of qs) {
    process.chdir(join(WORK, q.conv));
    const ctx = await holt.recallContext(q.question, 'bench-current');
    process.chdir(HERE);
    prompts.push({ q, prompt: holt.renderPrompt([], q.question, holt.formatMemoryContext(ctx, lastDay[q.conv])) });
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

if (cmd === 'grade') {
  const model = args.model || 'opus';
  const tpl = readFileSync(join(HERE, 'ref', 'locomo_judge_mem0paper.txt'), 'utf8');
  const byId = new Map(questions().map((q) => [q.qid, q]));
  const hypFile = join(HERE, args.hyp); const outFile = hypFile.replace('.jsonl', `.graded-${model}.jsonl`);
  const have = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).qid) : []);
  const hyps = readFileSync(hypFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => !have.has(x.qid));
  let n = 0;
  await pool(hyps, +(args.conc || 4), async (x) => {
    const q = byId.get(x.qid);
    const prompt = tpl.replace('{question}', q.question).replace('{gold_answer}', String(q.answer)).replace('{generated_answer}', x.hypothesis);
    const r = await claude(prompt, model, 'You are a careful grader.');
    if (!r.ok || !r.text) { console.log('judge skip', x.qid); return; }
    const label = /"label"\s*:\s*"CORRECT"/i.test(r.text) || (/\bCORRECT\b/.test(r.text) && !/\bWRONG\b/.test(r.text));
    appendFileSync(outFile, JSON.stringify({ qid: x.qid, category: CATS[q.category], label, judge: r.text.slice(-120) }) + '\n');
    if (++n % 50 === 0) console.log(`[${n}/${hyps.length}]`);
  });
  console.log('wrote', outFile);
}

if (cmd === 'report') {
  for (const f of readdirSync(OUT).filter((f) => f.startsWith('locomo') && f.includes('.graded-'))) {
    const rows = readFileSync(join(OUT, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const by = {};
    for (const r of rows) { (by[r.category] ??= [0, 0]); by[r.category][0] += r.label; by[r.category][1]++; }
    const c = rows.filter((r) => r.label).length;
    console.log(`\n${f}\n  overall ${((c / rows.length) * 100).toFixed(1)}% (${c}/${rows.length})`);
    for (const [k, [a, t]] of Object.entries(by).sort()) console.log(`  ${k.padEnd(14)} ${((a / t) * 100).toFixed(1).padStart(5)}%  (${a}/${t})`);
  }
}
