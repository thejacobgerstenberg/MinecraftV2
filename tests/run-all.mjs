// Loomfall test runner: executes every tests/*.test.mjs sequentially as a
// child process (sequential because the server suites bind fixed ports),
// then runs the adopted deep suite tests-plus/*.test.mjs under `node --test`
// (the tests-plus files are node:test modules that self-register — they are
// NOT plain scripts, so they get Node's runner with an explicit file list,
// per docs/TEST_ADOPTION.md). Streams output, prints a summary table, and
// exits non-zero if any suite fails. Wired to `npm test`.

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TESTS_DIR, '..');
const TESTS_PLUS_DIR = path.join(ROOT, 'tests-plus');

// Documented deliberate skips inside tests-plus (kept as skipped tests, not
// deleted — see docs/TEST_ADOPTION.md). Printed with the summary so the skip
// count is never mistaken for rot.
const KNOWN_SKIPS = [
  'tests-plus/physics.test.mjs — "fly speed: SPEC DELTA — spec SPEED_FLY 10.89": ' +
  'flight speeds intentionally stay 10/20 b/s (product decision); the spec value is 10.89.',
];

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

// ── tests-plus/ (node:test suites) ──────────────────────────────────────────
// Run with an explicit file list (NOT a bare directory) and concurrency 1:
// the save/load + anticheat suites each spawn a server on a fixed port.
const plusFiles = (await readdir(TESTS_PLUS_DIR).catch(() => []))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(TESTS_PLUS_DIR, f));
if (plusFiles.length > 0) {
  console.log('\n=== tests-plus/ (node --test) ===');
  const plus = await new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', ...plusFiles],
      { cwd: ROOT, stdio: 'inherit' },
    );
    child.on('exit', (code, signal) => {
      resolve({ file: 'tests-plus/ (node --test)', code: signal ? 1 : (code ?? 1), ms: Date.now() - started });
    });
    child.on('error', () => {
      resolve({ file: 'tests-plus/ (node --test)', code: 1, ms: Date.now() - started });
    });
  });
  results.push(plus);
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

if (KNOWN_SKIPS.length > 0) {
  console.log('Known deliberate skips (documented, not failures):');
  for (const k of KNOWN_SKIPS) console.log(`  KNOWN-SKIP: ${k}`);
}

const failed = results.filter((r) => r.code !== 0);
console.log(failed.length === 0
  ? `All ${results.length} suites passed.`
  : `${failed.length} of ${results.length} suites FAILED: ${failed.map((r) => r.file).join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);
