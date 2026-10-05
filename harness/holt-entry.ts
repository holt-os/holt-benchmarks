// Re-export Holt's real memory + prompt code. Bundle it from a Holt checkout:
//   HOLT_SRC=/path/to/holt/src npx esbuild holt-entry.ts --bundle --platform=node --format=esm --outfile=holt-lib.mjs
// The import paths below are rewritten by scripts/build-holt-lib.sh.
export { embed, recall, embeddingsAvailable, recallContext, formatMemoryContext } from 'HOLT_SRC/memory';
export { renderPrompt } from 'HOLT_SRC/brains';
