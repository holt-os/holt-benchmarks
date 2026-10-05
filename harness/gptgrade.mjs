// Regrade saved LongMemEval answers with GPT-4o (the official LongMemEval grader).
// Reads OPENAI_API_KEY from the environment only. temperature 0, max_tokens 10, as in the official script.
//   node gptgrade.mjs --hyp out/<file>.jsonl [--model gpt-4o-2024-08-06] [--limit N]
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, parseArgs, pool } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const model = args.model || 'gpt-4o-2024-08-06';
const data = new Map(JSON.parse(readFileSync(join(HERE, 'data', 'longmemeval_s_cleaned.json'), 'utf8')).map((q) => [q.question_id, q]));
function judgePrompt(task, question, answer, response, abstention) {
  if (abstention) return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  const base = 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.';
  if (['single-session-user', 'single-session-assistant', 'multi-session'].includes(task)) return `${base} \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === 'temporal-reasoning') return `${base} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === 'knowledge-update') return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === 'single-session-preference') return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  throw new Error(task);
}


let inTok = 0, outTok = 0;
async function ask(prompt) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 10 }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) { inTok += j.usage?.prompt_tokens || 0; outTok += j.usage?.completion_tokens || 0; return j.choices?.[0]?.message?.content || ''; }
    const msg = j.error?.message || res.statusText;
    if (res.status === 401 || res.status === 404 || /quota|billing/i.test(msg)) throw new Error(`${res.status} ${msg}`);
    await new Promise((s) => setTimeout(s, 3000 * (i + 1)));
  }
  throw new Error('gave up after retries');
}

const hypFile = join(HERE, args.hyp);
const outFile = hypFile.replace('.jsonl', `.graded-${model}.jsonl`);
const have = new Set(existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).question_id) : []);
let hyps = readFileSync(hypFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => !have.has(x.question_id));
if (args.limit) hyps = hyps.slice(0, +args.limit);
await pool(hyps, 4, async (x) => {
  const q = data.get(x.question_id);
  const out = await ask(judgePrompt(q.question_type, q.question, q.answer, x.hypothesis, x.question_id.endsWith('_abs')));
  appendFileSync(outFile, JSON.stringify({ question_id: x.question_id, question_type: q.question_type, abstention: x.question_id.endsWith('_abs'), label: /yes/i.test(out), judge: out }) + '\n');
});
const all = readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cost = (inTok * 2.5 + outTok * 10) / 1e6;
console.log(`${outFile}: ${all.filter((r) => r.label).length}/${all.length} = ${((all.filter((r) => r.label).length / all.length) * 100).toFixed(1)}%  this run tokens in=${inTok} out=${outTok} ~$${cost.toFixed(3)}`);
