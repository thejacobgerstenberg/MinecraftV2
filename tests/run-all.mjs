// Loomfall test runner: executes every tests/*.test.mjs sequentially as a
// child process (sequential because the server suites bind fixed ports),
// streams their output, prints a summary table, and exits non-zero if any
// suite fails. Wired to `npm test`.

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TESTS_DIR, '..');

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(TESTS_DIR, file)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
      resolve({ file, code: signal ? 1 : (code ?? 1), ms: Date.now() - started });
    });
    child.on('error', () => {
      resolve({ file, code: 1, ms: Date.now() - started });
    });
  });
}

const files = (await readdir(TESTS_DIR))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (files.length === 0) {
  console.error('No tests/*.test.mjs files found.');
  process.exit(1);
}

const results = [];
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  results.push(await runOne(file));
}

const width = Math.max(...results.map((r) => r.file.length), 5);
console.log('\n' + '-'.repeat(width + 22));
console.log(`${'suite'.padEnd(width)}  result  time`);
console.log('-'.repeat(width + 22));
for (const r of results) {
  const verdict = r.code === 0 ? 'PASS' : 'FAIL';
  console.log(`${r.file.padEnd(width)}  ${verdict.padEnd(6)}  ${(r.ms / 1000).toFixed(1)}s`);
}
console.log('-'.repeat(width + 22));

const failed = results.filter((r) => r.code !== 0);
console.log(failed.length === 0
  ? `All ${results.length} suites passed.`
  : `${failed.length} of ${results.length} suites FAILED: ${failed.map((r) => r.file).join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);
