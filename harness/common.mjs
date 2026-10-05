// Shared helpers for the Holt benchmark harnesses.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const CLEAN = join(HERE, 'clean-cwd');
mkdirSync(CLEAN, { recursive: true });
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude';

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  return out;
}

export async function pool(items, n, fn) {
  let i = 0;
  const res = [];
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}

function claudeOnce(prompt, model, system) {
  return new Promise((resolve) => {
    const p = spawn(CLAUDE_BIN, ['-p', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', '',
      '--no-session-persistence', '--model', model, '--system-prompt', system], { cwd: CLEAN });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ ok: false, text: '', err: String(e) }));
    p.on('close', (code) => resolve({ ok: code === 0, text: out.trim(), err: err.trim() }));
    p.stdin.end(prompt);
  });
}

export async function claude(prompt, model, system = 'You are a helpful assistant.') {
  // Retry quickly on blips. On a usage limit, wait it out (up to ~6h) instead of
  // recording an empty answer. Callers must not record a result when ok is false.
  let r;
  for (let attempt = 0; attempt < 40; attempt++) {
    r = await claudeOnce(prompt, model, system);
    if (r.ok && r.text) return r;
    const limited = /limit|quota|rate|overloaded|429|529/i.test(r.err + ' ' + r.text);
    const wait = limited ? 10 * 60000 : 5000 * Math.min(attempt + 1, 6);
    if (limited) console.log(`[claude] limit hit, waiting 10 min: ${(r.err || r.text).slice(0, 120)}`);
    if (!limited && attempt >= 5) return r;
    await new Promise((s) => setTimeout(s, wait));
  }
  return r;
}
