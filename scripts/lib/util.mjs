/**
 * util.mjs — shared, dependency-free utilities for the load/chaos harness.
 *
 * Node builtins ONLY (node:fs, node:path, node:perf_hooks). No third-party deps.
 * Target runtime: Node 20 (CI) and Node 22 (local).
 *
 * ---------------------------------------------------------------------------
 * WHAT LIVES HERE
 *   - parseArgs(argv, defs)                CLI parsing with env + default fallbacks
 *   - envNum / envStr / envBool            typed environment-variable readers
 *   - class Stats                          streaming values -> percentiles (sorted copy)
 *   - startProcSampler(pid, intervalMs)    Linux /proc CPU% + RSS sampler
 *   - nowMs()                              monotonic high-res clock (perf_hooks)
 *   - printReport(title, obj)              human-readable console report
 *   - writeJsonReport(path, obj)           machine-readable JSON report to disk
 *
 * DESIGN CONTRACT: every function here is DEFENSIVE. Bad input never throws out
 * of a utility — numeric coercion falls back to a supplied default, the /proc
 * sampler returns nulls when files are unreadable or the OS is not Linux, and the
 * report writers swallow (and log) I/O errors rather than crashing a test run.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/* =========================================================================
 * Private coercion helpers (shared by parseArgs + env readers).
 * ========================================================================= */

/** Coerce any value to a finite number, else return `def`. Bare flags (=== true) → def. */
function toNum(v, def = 0) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : def;
  if (v === true || v === undefined || v === null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Coerce any value to a boolean using common truthy/falsey strings, else `def`. */
function toBool(v, def = false) {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null) return def;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on' || s === 'y') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === 'n' || s === '') return false;
  return def;
}

/** Coerce any value to a string. `undefined`/`null` → `def`. */
function toStr(v, def = '') {
  if (v === undefined || v === null) return def;
  if (typeof v === 'string') return v;
  try {
    return String(v);
  } catch {
    return def;
  }
}

/** kebab-case / snake_case -> camelCase, so `--duration-sec` is also reachable as `durationSec`. */
function toCamel(name) {
  return String(name).replace(/[-_]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
}

/** Infer a def's type from its declared `type` or the shape of its default value. */
function defType(def) {
  if (!def) return undefined;
  if (typeof def.type === 'string') return def.type;
  if (def.flag === true) return 'boolean';
  const d = def.default;
  if (typeof d === 'number') return 'number';
  if (typeof d === 'boolean') return 'boolean';
  if (typeof d === 'string') return 'string';
  return undefined;
}

/** Is this def a standalone boolean flag (consumes no following token)? */
function isFlagDef(def) {
  return defType(def) === 'boolean';
}

/** Coerce a raw value to a def's declared type. Unknown defs pass through untouched. */
function coerceForDef(def, val) {
  const type = defType(def);
  const dflt = def ? def.default : undefined;
  switch (type) {
    case 'number':
      return toNum(val, dflt === undefined ? 0 : dflt);
    case 'boolean':
      return toBool(val, dflt === undefined ? false : dflt);
    case 'string':
      return toStr(val, dflt === undefined ? '' : dflt);
    default:
      // No type info: keep bare-flag booleans as-is, otherwise return the string.
      return val;
  }
}

/* =========================================================================
 * parseArgs(argv, defs) -> {opts, positionals}
 *
 * Supported CLI forms:
 *   --key value      (space separated; the next token is the value)
 *   --key=value      (inline)
 *   --flag           (boolean flag; only when its def type is boolean)
 *   --no-flag        (negates a known boolean flag -> false)
 *   --               (everything after is treated as a positional)
 *
 * `defs` is a map of option-name -> descriptor:
 *   {
 *     players:  { default: 50,  env: 'GAME_BOTS',     type: 'number'  },
 *     url:      { default: '',  env: 'GAME_URL',      type: 'string'  },
 *     spawn:    { default: false, env: 'GAME_SPAWN',  type: 'boolean' },
 *   }
 * `type` is optional — if omitted it is inferred from `default`'s JS type.
 *
 * PRECEDENCE (highest first): CLI arg > env var (def.env) > def.default.
 *
 * Keys are exposed under the exact name given AND a camelCase alias, so a
 * `--duration-sec 6` flag is readable as both opts['duration-sec'] and
 * opts.durationSec regardless of how the def keyed it.
 * ========================================================================= */
export function parseArgs(argv = [], defs = {}) {
  const opts = {};
  const positionals = [];
  const provided = new Set(); // camelCase names seen on the CLI

  const tokens = Array.isArray(argv) ? argv : [];
  const D = defs && typeof defs === 'object' ? defs : {};

  // Resolve a def descriptor for a CLI key by exact or camelCase match.
  const lookupDef = (key) => {
    if (Object.prototype.hasOwnProperty.call(D, key)) return D[key];
    const camel = toCamel(key);
    if (Object.prototype.hasOwnProperty.call(D, camel)) return D[camel];
    return undefined;
  };

  // Store a value under both the literal key and its camelCase alias.
  const setOpt = (key, value) => {
    opts[key] = value;
    const camel = toCamel(key);
    if (camel !== key) opts[camel] = value;
    provided.add(camel);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (typeof tok !== 'string') continue;

    if (tok === '--') {
      // POSIX end-of-options: the rest are positionals.
      for (let j = i + 1; j < tokens.length; j++) positionals.push(tokens[j]);
      break;
    }

    if (tok.startsWith('--')) {
      let key = tok.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      }

      // --no-foo negation, only for keys whose positive form is a known flag.
      if (val === undefined && key.startsWith('no-')) {
        const positive = key.slice(3);
        if (isFlagDef(lookupDef(positive))) {
          key = positive;
          val = 'false';
        }
      }

      const def = lookupDef(key);

      if (val === undefined) {
        if (isFlagDef(def)) {
          // Declared boolean flag: presence means true, consumes no token.
          val = true;
        } else {
          // Otherwise consume the next token as the value, unless it is another
          // --option (a lone trailing flag then degrades to boolean true).
          const next = tokens[i + 1];
          if (next !== undefined && !(typeof next === 'string' && next.startsWith('--'))) {
            val = next;
            i++;
          } else {
            val = true;
          }
        }
      }

      setOpt(key, coerceForDef(def, val));
    } else {
      positionals.push(tok);
    }
  }

  // Fill env/default for any def not provided on the CLI (matched by camelCase).
  for (const name of Object.keys(D)) {
    if (provided.has(toCamel(name))) continue;
    const def = D[name] || {};
    let raw;
    if (def.env && process.env[def.env] !== undefined && process.env[def.env] !== '') {
      raw = process.env[def.env];
    } else {
      raw = def.default;
    }
    const value = coerceForDef(def, raw);
    opts[name] = value;
    const camel = toCamel(name);
    if (camel !== name) opts[camel] = value;
  }

  return { opts, positionals };
}

/* =========================================================================
 * Typed environment-variable readers.
 * An unset OR empty ("") variable yields the default (empty strings are treated
 * as "not provided" for numbers/booleans; envStr distinguishes unset from empty).
 * ========================================================================= */

/** Read process.env[name] as a finite number, else `def`. */
export function envNum(name, def = 0) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Read process.env[name] as a string. Unset -> `def` (an explicit "" is returned). */
export function envStr(name, def = '') {
  const v = process.env[name];
  return v === undefined ? def : v;
}

/** Read process.env[name] as a boolean (1/true/yes/on). Unset/empty -> `def`. */
export function envBool(name, def = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return toBool(v, def);
}

/**
 * Tokenize a shell-ish command string into an argv array WITHOUT invoking a
 * shell. Honors single quotes, double quotes, and backslash escaping; collapses
 * unquoted whitespace runs. This lets callers `spawn(argv[0], argv.slice(1))`
 * directly so the owned child pid is the real program (e.g. `node`) and not a
 * `/bin/sh -c` wrapper — required for /proc sampling and precise signalling.
 * It intentionally does NOT expand env vars, globs, pipes, or redirects; a
 * command that needs those genuinely needs a shell.
 *
 * @param {string} cmd
 * @returns {string[]} argv tokens (possibly empty)
 */
export function tokenizeCommand(cmd) {
  const s = toStr(cmd, '');
  const argv = [];
  let cur = '';
  let has = false; // did the current token get any (possibly empty-quoted) content?
  let quote = null; // "'" | '"' | null
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') { quote = null; }
      else if (c === '\\' && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === '\\')) { cur += s[++i]; }
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (has) { argv.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) argv.push(cur);
  return argv;
}

/* =========================================================================
 * Stats — accumulate numeric samples and derive percentiles from a sorted copy.
 * Percentile convention (matches the harness contract):
 *   index = ceil(q * n) - 1, clamped to [0, n-1]; empty -> 0.
 * The sorted copy is cached and lazily rebuilt only after new values arrive.
 * ========================================================================= */
export class Stats {
  constructor() {
    /** @type {number[]} */
    this._values = [];
    /** @type {number[]|null} cached ascending sort of _values */
    this._sorted = null;
    this._sum = 0;
  }

  /** Add one sample. Non-finite values (NaN/Infinity) are ignored. */
  add(x) {
    const n = typeof x === 'number' ? x : Number(x);
    if (!Number.isFinite(n)) return;
    this._values.push(n);
    this._sum += n;
    this._sorted = null; // invalidate cache
  }

  /** Number of recorded samples. */
  get count() {
    return this._values.length;
  }

  /** Lazily build + cache the ascending sorted copy. */
  _ensureSorted() {
    if (this._sorted === null) {
      this._sorted = this._values.slice().sort((a, b) => a - b);
    }
    return this._sorted;
  }

  /**
   * q-quantile in [0,1] using nearest-rank on a sorted copy.
   * p(0.95) => value at index ceil(0.95*n)-1. Empty set -> 0.
   */
  p(q) {
    const n = this._values.length;
    if (n === 0) return 0;
    let qq = typeof q === 'number' && Number.isFinite(q) ? q : 0;
    if (qq < 0) qq = 0;
    if (qq > 1) qq = 1;
    const s = this._ensureSorted();
    let idx = Math.ceil(qq * n) - 1;
    if (idx < 0) idx = 0;
    if (idx > n - 1) idx = n - 1;
    return s[idx];
  }

  get p50() {
    return this.p(0.5);
  }
  get p95() {
    return this.p(0.95);
  }
  get p99() {
    return this.p(0.99);
  }

  get max() {
    const s = this._ensureSorted();
    return s.length ? s[s.length - 1] : 0;
  }
  get min() {
    const s = this._ensureSorted();
    return s.length ? s[0] : 0;
  }
  get mean() {
    const n = this._values.length;
    return n === 0 ? 0 : this._sum / n;
  }
}

/* =========================================================================
 * startProcSampler(pid, intervalMs=500)
 *
 * Periodically samples a process's CPU% and resident memory on Linux via
 *   /proc/<pid>/stat    fields 14 (utime) + 15 (stime), in clock ticks
 *   /proc/<pid>/status  VmRSS in kB
 *
 * CPU% for each interval = 100 * (deltaTicks / CLK_TCK) / deltaWallSeconds.
 * Values may exceed 100% (multi-core). Clock ticks per second is assumed to be
 * 100 (the near-universal Linux _SC_CLK_TCK), per the harness contract.
 *
 * Returns a handle: { stop() -> {cpuAvgPct,cpuPeakPct,rssAvgMB,rssPeakMB,samples} }.
 * On non-Linux, an invalid pid, or unreadable /proc, no timer starts and stop()
 * returns all-null metrics with samples:0 — it NEVER throws.
 * ========================================================================= */
export function startProcSampler(pid, intervalMs = 500) {
  const CLK_TCK = 100; // sysconf(_SC_CLK_TCK) assumption
  const isLinux = process.platform === 'linux';
  const validPid = Number.isInteger(pid) && pid > 0;

  const cpuSamples = [];
  const rssSamples = [];
  let prevTicks = null;
  let prevWallMs = null;
  let iterations = 0;
  let timer = null;

  // Read cumulative CPU ticks (utime+stime) for the process, or null on failure.
  function readTicks() {
    try {
      const data = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm (field 2) may contain spaces/parens; parse everything AFTER the
      // last ')'. Then index 0 == field 3 (state), so field N == index N-3.
      const rp = data.lastIndexOf(')');
      if (rp === -1) return null;
      const rest = data.slice(rp + 1).trim().split(/\s+/);
      const utime = Number(rest[11]); // field 14
      const stime = Number(rest[12]); // field 15
      if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
      return utime + stime;
    } catch {
      return null;
    }
  }

  // Read resident set size in MB, or null on failure.
  function readRssMB() {
    try {
      const data = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = data.match(/VmRSS:\s+(\d+)\s*kB/i);
      if (!m) return null;
      const kb = Number(m[1]);
      if (!Number.isFinite(kb)) return null;
      return kb / 1024;
    } catch {
      return null;
    }
  }

  function sample() {
    iterations++;
    const wallMs = nowMs();
    const ticks = readTicks();
    if (ticks !== null && prevTicks !== null && prevWallMs !== null) {
      const dTicks = ticks - prevTicks;
      const dSec = (wallMs - prevWallMs) / 1000;
      if (dSec > 0 && dTicks >= 0) {
        const pct = (100 * (dTicks / CLK_TCK)) / dSec;
        if (Number.isFinite(pct) && pct >= 0) cpuSamples.push(pct);
      }
    }
    if (ticks !== null) {
      prevTicks = ticks;
      prevWallMs = wallMs;
    }
    const rss = readRssMB();
    if (rss !== null) rssSamples.push(rss);
  }

  if (isLinux && validPid) {
    // Prime the tick baseline so the first interval produces a real delta.
    prevTicks = readTicks();
    prevWallMs = nowMs();
    const rss0 = readRssMB();
    if (rss0 !== null) rssSamples.push(rss0);

    const every = Math.max(50, Math.floor(intervalMs) || 500);
    timer = setInterval(sample, every);
    // Don't keep the event loop alive just for sampling.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return {
        cpuAvgPct: cpuSamples.length ? avgOf(cpuSamples) : null,
        cpuPeakPct: cpuSamples.length ? maxOf(cpuSamples) : null,
        rssAvgMB: rssSamples.length ? avgOf(rssSamples) : null,
        rssPeakMB: rssSamples.length ? maxOf(rssSamples) : null,
        samples: iterations,
      };
    },
  };
}

/** Arithmetic mean of a numeric array (loop-based; safe for large arrays). */
function avgOf(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return arr.length ? sum / arr.length : 0;
}

/** Max of a numeric array (loop-based; avoids Math.max(...huge) stack limits). */
function maxOf(arr) {
  let m = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > m) m = arr[i];
  }
  return m === -Infinity ? 0 : m;
}

/* =========================================================================
 * nowMs() — monotonic high-resolution time in milliseconds (perf_hooks).
 * Preferred over Date.now() for latency measurement (immune to wall-clock jumps).
 * ========================================================================= */
export function nowMs() {
  return performance.now();
}

/* =========================================================================
 * Reporting helpers.
 * ========================================================================= */

/** JSON.stringify that never throws (falls back to String()). */
function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    try {
      return String(v);
    } catch {
      return '[unserializable]';
    }
  }
}

/** Format a scalar for the console report. Floats -> 2dp, integers as-is. */
function scalarStr(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'n/a';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v); // NaN / Infinity
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return String(v);
}

/** Recursively append `obj`'s key/value lines with aligned keys + indentation. */
function appendReport(obj, indent, lines) {
  if (obj === null || typeof obj !== 'object') {
    lines.push(indent + scalarStr(obj));
    return;
  }
  if (Array.isArray(obj)) {
    lines.push(indent + safeJson(obj));
    return;
  }
  const keys = Object.keys(obj);
  let pad = 0;
  for (const k of keys) if (k.length > pad) pad = k.length;
  for (const k of keys) {
    const v = obj[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${indent}${k}:`);
      appendReport(v, indent + '  ', lines);
    } else if (Array.isArray(v)) {
      lines.push(`${indent}${k.padEnd(pad)} : ${safeJson(v)}`);
    } else {
      lines.push(`${indent}${k.padEnd(pad)} : ${scalarStr(v)}`);
    }
  }
}

/**
 * Print a titled, aligned report of a (possibly nested) plain object to stdout.
 * Returns the rendered string as well (handy for logging/tests). Never throws.
 */
export function printReport(title, obj) {
  const lines = [];
  const heading = toStr(title, 'REPORT');
  const bar = '='.repeat(Math.max(8, heading.length + 4));
  lines.push(bar);
  lines.push(`  ${heading}`);
  lines.push(bar);
  try {
    appendReport(obj === undefined ? {} : obj, '  ', lines);
  } catch {
    lines.push('  <unrenderable report body>');
  }
  const out = lines.join('\n');
  try {
    console.log(out);
  } catch {
    /* ignore console failures */
  }
  return out;
}

/**
 * Write `obj` as pretty JSON to `filePath`, creating parent directories as
 * needed. Returns true on success, false on failure (errors are logged, never
 * thrown). BigInt values are serialized as strings; non-finite numbers become
 * null (standard JSON behavior).
 */
export function writeJsonReport(filePath, obj) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    const dir = path.dirname(filePath);
    if (dir && dir !== '.') {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* directory may already exist or be uncreatable; writeFileSync will report */
      }
    }
    const json = JSON.stringify(obj, jsonReplacer, 2);
    fs.writeFileSync(filePath, (json === undefined ? 'null' : json) + '\n', 'utf8');
    return true;
  } catch (err) {
    try {
      console.error(`writeJsonReport: failed to write ${filePath}: ${err && err.message}`);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** JSON replacer: make BigInt serializable; leave everything else to default. */
function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

/* ---------------------------------------------------------------------------
 * SELF-CHECK (informal — no test framework, dependency-free):
 *   parseArgs(['--players','20','--spawn','--url=ws://x','file.json'],
 *             {players:{default:50,type:'number'}, spawn:{default:false,type:'boolean'},
 *              url:{default:'',type:'string'}})
 *     -> { opts:{players:20, spawn:true, url:'ws://x'}, positionals:['file.json'] }
 *   parseArgs(['--duration-sec','6'], {durationSec:{default:30,type:'number'}})
 *     -> opts.durationSec === 6  (kebab CLI reaches camelCase def)
 *   new Stats(); s.add(10); s.add(20); s.add(30);  s.p95 -> 30, s.p50 -> 20, s.mean -> 20
 *   (new Stats()).p95 -> 0   (empty guard)
 *   startProcSampler(process.pid, 100); ...later stop() -> finite cpu/rss on Linux,
 *     all-null with samples:0 on non-Linux or a dead pid — never throws.
 *   printReport('T', {a:1, nested:{p95:1.234}})  -> aligned text, floats to 2dp
 *   writeJsonReport('/tmp/r.json', {ok:true}) -> true (file written)
 * ------------------------------------------------------------------------- */
