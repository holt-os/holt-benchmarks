#!/bin/sh
# Round 2 tuning, dev-101 only.
export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH CLAUDE_BIN=$HOME/.local/bin/claude
cd "$HOME/bench/longmemeval"
B="HOLT_RECALL_K=32 HOLT_RECALL_USER_BOOST=1.15 HOLT_RECALL_BUDGET=24000"
echo "- $(date -u +%FT%R) round2: c1 (k32 n0 ub1.15, sonnet)" >> STATUS.md
env $B HOLT_RECALL_NEIGHBORS=0 node run.mjs answer --ids sample-100.json --mode holt2 --tag r2c1 --model sonnet --conc 3
node run.mjs grade --hyp out/holt2-r2c1-sonnet-sample-100.jsonl --model opus --conc 3
echo "- $(date -u +%FT%R) round2: c2 (k32 n1 cap250 ub1.15, sonnet)" >> STATUS.md
env $B HOLT_RECALL_NEIGHBORS=1 HOLT_RECALL_NEIGHBOR_CAP=250 node run.mjs answer --ids sample-100.json --mode holt2 --tag r2c2 --model sonnet --conc 3
node run.mjs grade --hyp out/holt2-r2c2-sonnet-sample-100.jsonl --model opus --conc 3
echo "- $(date -u +%FT%R) round2: c1 with opus reader" >> STATUS.md
env $B HOLT_RECALL_NEIGHBORS=0 node run.mjs answer --ids sample-100.json --mode holt2 --tag r2c1 --model opus --conc 3
node run.mjs grade --hyp out/holt2-r2c1-opus-sample-100.jsonl --model opus --conc 3
node run.mjs report > report-round2.txt
echo "- $(date -u +%FT%R) ROUND2 DONE" >> STATUS.md
