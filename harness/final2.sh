#!/bin/sh
# Round 2 FROZEN run: Holt branch defaults (commit 69ebbcb), no env overrides, nothing tuned below.
export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH CLAUDE_BIN=$HOME/.local/bin/claude
cd "$HOME/bench/longmemeval"
s(){ echo "- $(date -u +%FT%R) $1" >> STATUS.md; }
s "FINAL2 start: frozen Holt defaults k32 n1 cap250 ub1.15 budget24000"
node run.mjs answer --ids heldout-399.json --mode holt2 --tag r2 --model sonnet --conc 3
node run.mjs grade --hyp out/holt2-r2-sonnet-heldout-399.jsonl --model opus --conc 3
s "FINAL2 LongMemEval held-out graded"
node locomo.mjs answer --model sonnet --tag r2 --conc 3
node locomo.mjs grade --hyp out/locomo-r2-sonnet.jsonl --model opus --conc 3
s "FINAL2 LoCoMo graded"
node beam.mjs answer --size 1M --model sonnet --tag r2 --conc 3
node beam.mjs grade --hyp out/beam-1M-r2-sonnet.jsonl --model opus --conc 3
s "FINAL2 BEAM graded"
node run.mjs report > report2-lme.txt; node locomo.mjs report > report2-locomo.txt; node beam.mjs report > report2-beam.txt
s "FINAL2 ALL DONE"
