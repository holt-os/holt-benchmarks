# Holt memory benchmarks

How well does [Holt](https://github.com/holt-os/holt) remember? These are its scores on the three public benchmarks for long-term AI memory. Every answer and every grade is in this repo, along with the code to run it again.

| Benchmark | Holt 0.19 | What it tests |
|---|---|---|
| **LongMemEval-S** (500 questions) | **91.2%** (GPT-4o grader) | Facts, preferences, updates and dates spread across about 50 past chat sessions per question |
| **LoCoMo** (1,540 questions) | **88.2%** | Long conversations between two people |
| **BEAM 1M** (700 questions) | **79.6%** pass, 0.720 average | Conversations of about a million tokens each, too long for any context window |

Holt sends about 6,000 tokens of memory per question (about 3,500 on LoCoMo). Search and storage run locally, with `nomic-embed-text` through Ollama. Answers came from Claude Sonnet 5.5.

## Next to published numbers

| System | LongMemEval-S | LoCoMo | BEAM 1M |
|---|---|---|---|
| **Holt 0.19** | **91.2%** | **88.2%** | **79.6%** / 0.720 |
| Mem0 (platform, Sep 2026) | 94.4% | 92.5% | 70.1% / 0.641 |
| Tavus Memories (Sep 2026) | 93.4% | – | – |
| Zep | 71.2% | ~80% | – |

Other systems' numbers are their own published results. They used different answer models and graders, so this table is a rough guide, not a like-for-like contest. Mem0's current LoCoMo grader accepts an answer if it gets one item out of a list right and allows dates up to 14 days off. Holt's LoCoMo score uses the stricter original prompt from the Mem0 paper.

## How it was run

- **Holt code:** the real `recallContext()` and `renderPrompt()` from Holt 0.19, bundled with esbuild. Nothing was reimplemented for the test.
- **Memory:** each LongMemEval question gets a fresh, empty Holt memory, loaded with that question's chat history. LoCoMo and BEAM get one memory per conversation.
- **Answering:** Holt recalls, builds its normal prompt, and Claude Sonnet 5.5 answers through `claude -p` with no tools, no hooks and no other memory.
- **Grading:**
  - LongMemEval: the official prompts from `evaluate_qa_official.py`, run with GPT-4o (`gpt-4o-2024-08-06`, temperature 0). Claude Opus 5.5 also graded every answer and gave 91.4%. The two graders agreed on 97.8% of answers.
  - LoCoMo: the original Mem0-paper judge prompt (`judges/locomo_judge_mem0paper.txt`), graded by Claude Opus 5.5. Category 5 (adversarial) is excluded, as is standard.
  - BEAM: Mem0's open rubric judge (each rubric item scored 0, 0.5 or 1), graded by Claude Opus 5.5. A question passes at an average of 0.5 or more. Event ordering is scored on rubric items only, without the Kendall tau term.

## How the tuning was kept honest

All tuning used the same 101 LongMemEval questions (`splits/sample-100.json`). LoCoMo, BEAM and the other 399 LongMemEval questions were never used to choose a setting.

- **Round 1:** three recall settings were tried on the 101 (83.2%, 87.1%, 90.1%). The best was locked. Then everything else ran once: LongMemEval 85.4% (84.2% on the 399), LoCoMo 86.5%, BEAM 74.6%.
- **Round 2:** an offline search on the same 101 checked whether the messages that contain the answer make it into Holt's context. No model calls were involved. It showed that 94% of LongMemEval answer messages are the user's own words, while assistant replies run about ten times longer and crowded them out. Neighbouring messages are now short, user messages get a slight boost, and Holt recalls 32 messages instead of 16. Three Claude runs on the 101 picked the final setting (97.0%), which became Holt's default. Then everything ran once more.

The 399 held-out questions were scored in both rounds, so the round-2 number is the second look at them. Both rounds are published in full.

## What's in here

```
results/round2/      final answers and grades (the numbers above)
results/round1/      the first locked run
results/diagnostics/ the early 50-question trials, plus the offline coverage search
splits/              question ids for the 101 tuning questions and the 399 held out
harness/             the test code
judges/              grading prompts, with their sources in NOTICE.md
```

Each answer file has one JSON line per question with `hypothesis` (Holt's answer) and `prompt_chars`. Grade files have `label` (LongMemEval, LoCoMo) or per-item `nuggets` and `score` (BEAM).

One round-1 BEAM answer had the test machine's email address in it. Claude Code passes the signed-in account's email to the model, and in one "I don't know" answer the model suggested searching that inbox. It has been replaced with `[redacted email]`. Nothing else was edited.

## Run it yourself

You need Node 22+, Python 3 with `pyarrow`, [Ollama](https://ollama.com) with `nomic-embed-text`, the `claude` CLI signed in, and a Holt checkout.

```bash
cd harness
./download.sh                       # datasets into harness/data (not redistributed here)
./build-holt-lib.sh /path/to/holt   # bundles Holt's memory code
node run.mjs ingest --ids all-500.json
node run.mjs answer --ids all-500.json --mode holt2 --tag mine --model sonnet
node run.mjs grade  --hyp out/holt2-mine-sonnet-all-500.jsonl --model opus
OPENAI_API_KEY=... node gptgrade.mjs --hyp out/holt2-mine-sonnet-all-500.jsonl
node locomo.mjs ingest && node locomo.mjs answer --tag mine && node locomo.mjs grade --hyp out/locomo-mine-sonnet.jsonl
node beam.mjs ingest --size 1M && node beam.mjs answer --size 1M --tag mine && node beam.mjs grade --hyp out/beam-1M-mine-sonnet.jsonl
```

Copy the split files from `splits/` into `harness/` first. The full run makes about 6,000 model calls, so expect hours rather than minutes on a subscription plan.

## Datasets

- LongMemEval: [xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned), Wu et al., ICLR 2025
- LoCoMo: [snap-research/locomo](https://github.com/snap-research/locomo), Maharana et al., ACL 2024
- BEAM: [Mohammadta/BEAM](https://huggingface.co/datasets/Mohammadta/BEAM)

The code here is MIT. Grading prompts keep their original licences (see `judges/NOTICE.md`).
