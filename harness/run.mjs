// LongMemEval harness for Holt.
//   node run.mjs sample  --n 50                 -> writes sample-<n>.json (stratified question ids)
//   node run.mjs ingest  --ids sample-50.json   -> builds one fresh Holt memory per question (local embeddings)
//   node run.mjs answer  --ids sample-50.json --mode holt|full --model sonnet
//   node run.mjs grade   --hyp out/<file>.jsonl --model opus
//   node run.mjs report
// Holt code is bundled read-only from ~/holt/src (see holt-entry.ts). Nothing is written to ~/holt.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as holt from './holt-lib.mjs';
import { claude } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data', 'longmemeval_s_cleaned.json');
const WORK = join(HERE, 'work');
const OUT = join(HERE, 'out');
const CLEAN = join(HERE, 'clean-cwd');
mkdirSync(WORK, { recursive: true }); mkdirSync(OUT, { recursive: true }); mkdirSync(CLEAN, { recursive: true });

const args = Object.fromEntries(process.argv.slice(3).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const cmd = process.argv[2];
let _data;
const data = () => (_data ??= JSON.parse(readFileSync(DATA, 'utf8')));
const byId = () => new Map(data().map((q) => [q.question_id, q]));
const loadIds = (f) => JSON.parse(readFileSync(join(HERE, f), 'utf8'));
const h = (s) => createHash('sha1').update(s).digest('hex');

// "2023/05/20 (Sat) 02:21" -> epoch ms
const toTs = (d) => { const m = d.match(/(\d+)\/(\d+)\/(\d+) \(\w+\) (\d+):(\d+)/); return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]); };

async function pool(items, n, fn) {
  let i = 0; const res = [];
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}

// ---- sample: stratified by question_type, deterministic (sha1 order) ----
if (cmd === 'sample') {
  const n = +(args.n || 50);
  const groups = {};
  for (const q of data()) (groups[q.question_type] ??= []).push(q.question_id);
  const out = [];
  const total = data().length;
  const types = Object.keys(groups).sort();
  const quota = Object.fromEntries(types.map((t) => [t, Math.max(1, Math.round((groups[t].length / total) * n))]));
  for (const t of types) out.push(...groups[t].sort((a, b) => (h(a) < h(b) ? -1 : 1)).slice(0, quota[t]));
  writeFileSync(join(HERE, `sample-${n}.json`), JSON.stringify(out, null, 1));
  console.log(`sample-${n}.json: ${out.length} ids`, quota, 'abstention:', out.filter((x) => x.endsWith('_abs')).length);
}

// ---- ingest: one fresh Holt workspace per question, turns embedded with Holt's own embed() ----
if (cmd === 'ingest') {
  const ids = loadIds(args.ids); const m = byId();
  const t0 = Date.now(); let done = 0;
  for (const id of ids) {
    const q = m.get(id); const dir = join(WORK, id, '.holt', 'memory'); const file = join(dir, 'turns.jsonl');
    if (existsSync(file + '.done')) { done++; continue; }
    mkdirSync(dir, { recursive: true }); writeFileSync(file, '');
    const rows = [];
    q.haystack_sessions.forEach((sess, si) => sess.forEach((t, ti) => rows.push({
      id: `${si}-${ti}`, ts: toTs(q.haystack_dates[si]) + ti * 1000, session: q.haystack_session_ids[si], role: t.role, content: t.content,
    })));
    const embs = await pool(rows, 8, (r) => holt.embed(r.content));
    const missing = embs.filter((e) => !e).length;
    writeFileSync(file, rows.map((r, i) => JSON.stringify({ ...r, emb: embs[i] ?? undefined })).join('\n') + '\n');
    writeFileSync(file + '.done', String(missing));
    done++;
    console.log(`[${done}/${ids.length}] ${id} turns=${rows.length} missingEmb=${missing} elapsed=${((Date.now() - t0) / 60000).toFixed(1)}m`);
  }
}

// ---- answer ----
if (cmd === 'answer') {
  const ids = loadIds(args.ids); const m = byId(); const mode = args.mode; const model = args.model || 'sonnet';
  const outFile = join(OUT, `${mode}${args.tag ? '-' + args.tag : ''}-${model}-${args.ids.replace('.json', '')}.jsonl`);
  const have = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).question_id) : []);
  const todo = ids.filter((id) => !have.has(id));
  // Build prompts first. Holt recall depends on process.cwd(), so run it serially.
  const prompts = [];
  for (const id of todo) {
    const q = m.get(id);
    if (mode === 'holt') {
      process.chdir(join(WORK, id));
      const hits = await holt.recall(q.question, 'bench-current', 4);
      process.chdir(HERE);
      // Holt's own prompt, as shipped. The only addition is the date, which a live user's brain would know.
      const prompt = `Current date: ${q.question_date}\n\n` + holt.renderPrompt([], q.question, hits);
      prompts.push({ id, prompt, recalled: hits.map((x) => ({ session: x.turn.session, score: +x.score.toFixed(3) })) });
    } else if (mode === 'holt2') {
      // Holt branch bench/recall-packing, exactly as shipped: recallContext() + formatMemoryContext()
      // through renderPrompt(). Tunables come from HOLT_RECALL_* env vars.
      process.chdir(join(WORK, id));
      const ctx = await holt.recallContext(q.question, 'bench-current');
      process.chdir(HERE);
      const day = q.question_date.slice(0, 10).replace(/\//g, '-');
      const prompt = holt.renderPrompt([], q.question, holt.formatMemoryContext(ctx, day));
      prompts.push({ id, prompt, recalled: ctx.blocks.map((b) => b.session) });
    } else if (mode === 'holtv2') {
      // EXPERIMENT, not shipped Holt: same Holt recall(), but k=8, each hit expanded with its
      // neighbouring turns, full text, session dates, grouped by session in date order,
      // fed to the official LongMemEval retrieval prompt (chain-of-thought).
      process.chdir(join(WORK, id));
      const hits = await holt.recall(q.question, 'bench-current', 8);
      process.chdir(HERE);
      const keep = new Set();
      for (const x of hits) { const [si, ti] = x.turn.id.split('-').map(Number); for (const d of [-1, 0, 1]) if (q.haystack_sessions[si][ti + d]) keep.add(`${si}-${ti + d}`); }
      const bySess = {};
      for (const k of keep) { const [si, ti] = k.split('-').map(Number); (bySess[si] ??= []).push(ti); }
      const order = Object.keys(bySess).map(Number).sort((a, b) => toTs(q.haystack_dates[a]) - toTs(q.haystack_dates[b]));
      const hist = order.map((si, i) => `\n### Session ${i + 1}:\nSession Date: ${q.haystack_dates[si]}\nSession Content:\n` + bySess[si].sort((a, b) => a - b).map((ti) => `\n\n${q.haystack_sessions[si][ti].role}: ${q.haystack_sessions[si][ti].content.trim().slice(0, 3000)}`).join('')).join('\n');
      const prompt = `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nHistory Chats:\n\n${hist}\n\nCurrent Date: ${q.question_date}\nQuestion: ${q.question}\nAnswer (step by step):`;
      prompts.push({ id, prompt, recalled: hits.map((x) => ({ session: x.turn.session, score: +x.score.toFixed(3) })) });
    } else if (mode === 'full') {
      // Official LongMemEval full-history prompt (nl format, chain-of-thought), sessions in date order.
      const sess = q.haystack_sessions.map((s, i) => [q.haystack_dates[i], s]).sort((a, b) => toTs(a[0]) - toTs(b[0]));
      const hist = sess.map(([d, s], i) => `\n### Session ${i + 1}:\nSession Date: ${d}\nSession Content:\n` + s.map((t) => `\n\n${t.role}: ${t.content.trim()}`).join('')).join('\n');
      const prompt = `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nHistory Chats:\n\n${hist}\n\nCurrent Date: ${q.question_date}\nQuestion: ${q.question}\nAnswer (step by step):`;
      prompts.push({ id, prompt });
    } else throw new Error('--mode holt|holt2|holtv2|full');
  }
  let n = 0;
  await pool(prompts, +(args.conc || 4), async (p) => {
    const r = await claude(p.prompt, model);
    if (!r.ok || !r.text) { console.log('skip (will retry on resume)', p.id); return; }
    appendFileSync(outFile, JSON.stringify({ question_id: p.id, hypothesis: r.text, ok: r.ok, err: r.ok ? undefined : r.err.slice(0, 300), recalled: p.recalled, prompt_chars: p.prompt.length }) + '\n');
    console.log(`[${++n}/${prompts.length}] ${p.id} ok=${r.ok} chars=${p.prompt.length}`);
  });
  console.log('wrote', outFile);
}

// ---- grade: official LongMemEval judge prompts ----
function judgePrompt(task, question, answer, response, abstention) {
  if (abstention) return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  const base = 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.';
  if (['single-session-user', 'single-session-assistant', 'multi-session'].includes(task)) return `${base} \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === 'temporal-reasoning') return `${base} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === 'knowledge-update') return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === 'single-session-preference') return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  throw new Error(task);
}

if (cmd === 'grade') {
  const m = byId(); const model = args.model || 'opus';
  const hypFile = join(HERE, args.hyp); const outFile = hypFile.replace('.jsonl', `.graded-${model}.jsonl`);
  const have = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).question_id) : []);
  const hyps = readFileSync(hypFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => !have.has(x.question_id));
  let n = 0;
  await pool(hyps, +(args.conc || 4), async (x) => {
    const q = m.get(x.question_id);
    const r = await claude(judgePrompt(q.question_type, q.question, q.answer, x.hypothesis, x.question_id.endsWith('_abs')), model);
    if (!r.ok || !r.text) { console.log('judge skip', x.question_id); return; }
    const label = /\byes\b/i.test(r.text.slice(0, 20)) && !/\bno\b/i.test(r.text.slice(0, 3));
    appendFileSync(outFile, JSON.stringify({ question_id: x.question_id, question_type: q.question_type, abstention: x.question_id.endsWith('_abs'), label, judge: r.text.slice(0, 40) }) + '\n');
    console.log(`[${++n}/${hyps.length}] ${x.question_id} ${label}`);
  });
  console.log('wrote', outFile);
}

// ---- report ----
if (cmd === 'report') {
  for (const f of readdirSync(OUT).filter((f) => f.includes('.graded-'))) {
    const rows = readFileSync(join(OUT, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const by = {};
    for (const r of rows) { const k = r.abstention ? 'abstention' : r.question_type; (by[k] ??= [0, 0]); by[k][0] += r.label; by[k][1]++; }
    const acc = rows.filter((r) => r.label).length / rows.length;
    console.log(`\n${f}\n  overall ${(acc * 100).toFixed(1)}% (${rows.filter((r) => r.label).length}/${rows.length})`);
    for (const [k, [c, t]] of Object.entries(by).sort()) console.log(`  ${k.padEnd(26)} ${((c / t) * 100).toFixed(0).padStart(3)}%  (${c}/${t})`);
  }
}
