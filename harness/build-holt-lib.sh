#!/bin/sh
# Bundle Holt's memory + prompt code from a checkout: ./build-holt-lib.sh /path/to/holt
set -e
HOLT="${1:?usage: ./build-holt-lib.sh /path/to/holt}"
cd "$(dirname "$0")"
sed "s#HOLT_SRC#$HOLT/src#g" holt-entry.ts > .holt-entry.local.ts
npx --yes esbuild .holt-entry.local.ts --bundle --platform=node --format=esm --outfile=holt-lib.mjs --log-level=warning
rm .holt-entry.local.ts
echo "holt-lib.mjs built from $HOLT"
