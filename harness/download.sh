#!/bin/sh
# Download the three public datasets into harness/data. They are not redistributed here.
set -e
cd "$(dirname "$0")" && mkdir -p data
curl -sL -o data/longmemeval_s_cleaned.json https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
curl -sL -o data/locomo10.json https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
curl -sL -o data/beam-1M.parquet https://huggingface.co/datasets/Mohammadta/BEAM/resolve/main/data/1M-00000-of-00001.parquet
python3 prepare-beam.py 1M
echo "datasets ready in harness/data"
