#!/usr/bin/env node
/**
 * validate-content.mjs — dependency-free validator for game content JSON.
 *
 * Usage:
 *   node scripts/validate-content.mjs              # validates ./content (relative to CWD)
 *   node scripts/validate-content.mjs --dir <path> # validates the given directory
 *   node scripts/validate-content.mjs --dir=<path>
 *   node scripts/validate-content.mjs --help
 *
 * Checks:
 *   1. Every *.json file under the target dir (recursive) must JSON.parse.
 *      Parse errors report line/col (when extractable) and a short excerpt.
 *   2. Empty / whitespace-only files and files that parse to `null` are failures.
 *   3. Declared ids: any object anywhere with a string "id" property declares
 *      that id. Duplicate ids (within or across files) fail, listing every
 *      declaration location.
 *   4. References: string values whose key matches /(^|[._-])(id|ref)s?$/i
 *      (camelCase-aware, so blockId / item_ref / targetIds all match),
 *      EXCLUDING the "id" declaration key itself, plus string entries of
 *      arrays under such keys. Every reference must exist in the declared-id
 *      set. If ZERO ids are declared anywhere, unresolved references are
 *      downgraded to warnings (schema likely uses a different convention).
 *
 * Output: per-file OK/FAIL lines with indented reasons, then a summary line.
 * Exit codes: 0 = passed or skipped (no target dir), 1 = any failure, 2 = bad usage.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = 'usage: node scripts/validate-content.mjs [--dir <path>]';

function parseArgs(argv) {
  let dir = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') {
      if (i + 1 >= argv.length) usageError('--dir requires a value');
      dir = argv[++i];
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length);
    } else if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else {
      usageError(`unknown argument: ${arg}`);
    }
  }
  return { dir };
}

function usageError(message) {
  console.error(`error: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Key classification
// ---------------------------------------------------------------------------

const REF_KEY_RE = /(^|[._-])(id|ref)s?$/i;

/**
 * True when a key names an id/ref slot per the pattern. camelCase boundaries
 * are normalized to underscores first so "blockId" / "targetIds" match while
 * "grid", "valid", "href" do not.
 */
function isRefKey(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return REF_KEY_RE.test(normalized);
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function findJsonFiles(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — nothing to validate there
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        found.push(full);
      }
    }
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// Parse-error location + excerpt
// ---------------------------------------------------------------------------

function locFromSyntaxError(err, source) {
  const message = String(err && err.message || '');
  let m = message.match(/line (\d+) column (\d+)/i);
  if (m) return { line: Number(m[1]), col: Number(m[2]) };
  m = message.match(/position (\d+)/i);
  if (m) {
    const pos = Math.min(Number(m[1]), source.length);
    let line = 1;
    let col = 1;
    for (let i = 0; i < pos; i++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return { line, col };
  }
  return null;
}

function excerptAt(source, loc) {
  const lines = source.split(/\r?\n/);
  const text = (loc ? lines[loc.line - 1] ?? '' : lines[0] ?? '').trim();
  if (text.length === 0) return '';
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

// ---------------------------------------------------------------------------
// Walk parsed JSON: collect id declarations + references
// ---------------------------------------------------------------------------

function walk(node, keyPath, file, state) {
  if (Array.isArray(node)) {
    node.forEach((value, i) => walk(value, `${keyPath}[${i}]`, file, state));
    return;
  }
  if (node === null || typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node)) {
    const path = keyPath ? `${keyPath}.${key}` : key;

    // The "id" declaration key itself — never a reference.
    if (key === 'id') {
      if (typeof value === 'string') {
        const locs = state.declarations.get(value) ?? [];
        locs.push({ file, path });
        state.declarations.set(value, locs);
        state.declarationCount++;
      } else {
        walk(value, path, file, state);
      }
      continue;
    }

    if (isRefKey(key)) {
      if (typeof value === 'string') {
        state.references.push({ value, file, path });
        continue;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, i) => {
          if (typeof entry === 'string') {
            state.references.push({ value: entry, file, path: `${path}[${i}]` });
          } else {
            walk(entry, `${path}[${i}]`, file, state);
          }
        });
        continue;
      }
      // Non-string, non-array value under a ref-shaped key: walk it normally.
    }

    walk(value, path, file, state);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { dir } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const target = resolve(cwd, dir ?? 'content');

  if (!existsSync(target) || !statSync(target).isDirectory()) {
    console.log('no content directory — skipping');
    process.exit(0);
  }

  const files = findJsonFiles(target);
  const displayPath = (abs) => {
    const rel = relative(cwd, abs);
    return rel && !rel.startsWith('..') ? rel : abs;
  };

  const state = {
    declarations: new Map(), // id -> [{ file, path }]
    declarationCount: 0,
    references: [], // { value, file, path }
  };
  const issues = new Map(); // display path -> [{ level: 'fail'|'warn', message }]
  const addIssue = (file, level, message) => {
    const list = issues.get(file) ?? [];
    list.push({ level, message });
    issues.set(file, list);
  };

  console.log(`validating content JSON under ${displayPath(target)} (${files.length} file${files.length === 1 ? '' : 's'})`);

  // Pass 1: parse every file, collect declarations and references.
  for (const abs of files) {
    const file = displayPath(abs);
    let source;
    try {
      source = readFileSync(abs, 'utf8');
    } catch (err) {
      addIssue(file, 'fail', `unreadable file: ${err.message}`);
      continue;
    }

    if (source.length === 0) {
      addIssue(file, 'fail', 'empty file');
      continue;
    }
    if (source.trim().length === 0) {
      addIssue(file, 'fail', 'file contains only whitespace');
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (err) {
      const loc = locFromSyntaxError(err, source);
      const where = loc ? ` at line ${loc.line} col ${loc.col}` : '';
      const excerpt = excerptAt(source, loc);
      const detail = excerpt ? ` — excerpt: ${JSON.stringify(excerpt)}` : '';
      const reason = String(err.message).replace(/\s+/g, ' ').trim();
      addIssue(file, 'fail', `parse error${where}: ${reason}${detail}`);
      continue;
    }

    if (parsed === null) {
      addIssue(file, 'fail', 'file parses to null');
      continue;
    }

    walk(parsed, '', file, state);
  }

  // Pass 2: duplicate ids (within or across files).
  for (const [id, locs] of state.declarations) {
    if (locs.length < 2) continue;
    const everywhere = locs.map((l) => `${l.file} (${l.path})`).join(', ');
    for (let i = 1; i < locs.length; i++) {
      addIssue(
        locs[i].file,
        'fail',
        `duplicate id ${JSON.stringify(id)} — declared ${locs.length} times: ${everywhere}`,
      );
    }
  }

  // Pass 3: references must resolve to a declared id. With zero declared ids
  // anywhere, downgrade to warnings (schema likely uses another convention).
  const anyIdsDeclared = state.declarations.size > 0;
  let unresolvedRefs = 0;
  for (const ref of state.references) {
    if (state.declarations.has(ref.value)) continue;
    unresolvedRefs++;
    addIssue(
      ref.file,
      anyIdsDeclared ? 'fail' : 'warn',
      `${anyIdsDeclared ? 'missing reference' : 'unresolved reference'}: ${ref.path} -> ${JSON.stringify(ref.value)}`,
    );
  }

  // Report: per-file OK/FAIL lines.
  let failures = 0;
  let warnings = 0;
  for (const abs of files) {
    const file = displayPath(abs);
    const list = issues.get(file) ?? [];
    const fileFails = list.filter((i) => i.level === 'fail').length;
    failures += fileFails;
    warnings += list.length - fileFails;
    console.log(`${fileFails > 0 ? 'FAIL' : 'OK'} ${file}`);
    for (const issue of list) {
      console.log(`  ${issue.level === 'warn' ? 'warn' : 'fail'}: ${issue.message}`);
    }
  }

  if (!anyIdsDeclared && unresolvedRefs > 0) {
    console.log(
      'note: zero ids declared anywhere — reference failures downgraded to warnings (schema likely uses a different id convention)',
    );
  }

  console.log(
    `summary: ${files.length} files, ${state.declarations.size} ids, ${state.references.length} refs checked, ${failures} failures, ${warnings} warnings`,
  );

  process.exit(failures > 0 ? 1 : 0);
}

main();
