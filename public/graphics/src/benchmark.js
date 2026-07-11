// graphics-lab/src/benchmark.js
//
// Deterministic meshing/rendering benchmark harness.
//
//   runBenchmark(renderer, { scenarios, ...opts }) -> Promise<results>
//
// Compares, on the SAME generateTestWorld volume and the SAME fixed 8-second
// camera orbit (advanced by an accumulated FIXED dt — never wall clock — so
// every run renders the identical frame sequence):
//
//   a. naive   — buildChunkGeometry per chunk, no LOD, no render-distance cap
//   b. greedy  — buildGreedyChunkGeometry per chunk, no LOD, no cap
//   c. greedy+LOD+culling — ChunkManager (greedy mesher, 2 LOD levels,
//      render-distance cutoff)
//
// Measured per scenario:
//   - meshing time ms (performance.now around the geometry builds)
//   - meshed triangles (sum over built geometries / active LODs)
//   - draw calls per frame + rendered triangles per frame
//     (renderer.info with autoReset = false, info.reset() before each render)
//   - avg JS frame ms (performance.now around renderer.render, excluding the
//     first `warmup` frames) — plus scenario update() time separately
//
// Returns a plain results object AND renders a simple on-page table when a DOM
// is available. Each scenario runs inside try/catch: one failure is reported
// in results.scenarios[i].error without killing the suite. greedyMesher.js and
// chunkManager.js are loaded via dynamic import inside runBenchmark for the
// same reason — if either module is missing/broken only the scenarios that
// need it fail.
//
// HEADLESS PERF NOTE: under SwiftShader (CI) absolute fps/frame-ms numbers are
// meaningless — compare draw calls, triangle counts, meshing time and the
// RELATIVE frame-time deltas between scenarios.
//
// Hot-path discipline: the frame loop reuses one ctx object, one scratch
// Vector3 for the camera target, and preallocated typed arrays for all
// per-frame samples. The only per-frame allocation is the promise used to
// await the next animation frame (inherent to rAF pacing, outside the timed
// region).

import * as THREE from 'three';
import { generateTestWorld } from './worldgen.js';
import { buildChunkGeometry } from './voxelMesher.js';

const now = () =>
  (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();

const nextFrame =
  (typeof requestAnimationFrame === 'function')
    ? () => new Promise((resolve) => requestAnimationFrame(resolve))
    : () => new Promise((resolve) => setTimeout(resolve, 0));

const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Volume slicing fallback
// ---------------------------------------------------------------------------
// Prefer chunkManager.js's sliceVolume (single source of truth); this local
// twin (same contract: out-of-slice reads land in the parent world so seam
// faces cull) keeps the naive/greedy scenarios alive if that module is broken.

function localSliceVolume(world, cx, cz, chunkSize = 16) {
  const ox = cx * chunkSize;
  const oz = cz * chunkSize;
  const sx = Math.max(0, Math.min(chunkSize, world.sx - ox));
  const sz = Math.max(0, Math.min(chunkSize, world.sz - oz));
  const wGet = world.get;
  const wOpaque = world.isOpaque || world.isSolid || (() => false);
  const wSolid = world.isSolid || world.isOpaque || (() => false);
  return {
    sx,
    sy: world.sy,
    sz,
    get: (x, y, z) => wGet(x + ox, y, z + oz),
    isSolid: (x, y, z) => wSolid(x + ox, y, z + oz),
    isOpaque: (x, y, z) => wOpaque(x + ox, y, z + oz),
    WATER_LEVEL: world.WATER_LEVEL,
    cx, cz, chunkSize,
    origin: { x: ox, y: 0, z: oz },
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function geometryTriangles(g) {
  if (!g) return 0;
  const index = g.getIndex ? g.getIndex() : null;
  if (index) return (index.count / 3) | 0;
  const pos = g.getAttribute ? g.getAttribute('position') : null;
  return pos ? (pos.count / 3) | 0 : 0;
}

// Normalize a mesher result to { solid, transparent } (bare geometry = solid).
function normalizeMeshed(res) {
  if (res && res.isBufferGeometry) return { solid: res, transparent: null };
  return {
    solid: (res && res.solid) || null,
    transparent: (res && res.transparent) || null,
  };
}

function makeMaterials() {
  // Vertex-colored Lambert for BOTH meshers (no atlas => both emit absolute
  // face colors in the `color` attribute), so material cost is identical
  // across scenarios and the deltas isolate meshing/LOD/culling.
  const solid = new THREE.MeshLambertMaterial({ vertexColors: true });
  const transparent = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  return {
    solid,
    transparent,
    dispose() { solid.dispose(); transparent.dispose(); },
  };
}

function addSceneLights(scene) {
  const hemi = new THREE.HemisphereLight(0xbfd7ff, 0x3a3226, 0.9);
  const sun = new THREE.DirectionalLight(0xfff2d0, 1.1);
  sun.position.set(0.6, 1.0, 0.35).multiplyScalar(200);
  scene.add(hemi);
  scene.add(sun);
}

// Deterministic orbit: t in 0..1 maps to one full circle around the world
// centre with a gentle double-frequency height bob.
const _lookTarget = new THREE.Vector3();
function placeCamera(camera, world, t) {
  const cx = world.sx * 0.5;
  const cz = world.sz * 0.5;
  const cy = (world.WATER_LEVEL || 10) + 8;
  const radius = Math.max(world.sx, world.sz) * 0.75;
  const a = t * Math.PI * 2;
  camera.position.set(
    cx + Math.cos(a) * radius,
    cy + 16 + Math.sin(a * 2) * 6,
    cz + Math.sin(a) * radius,
  );
  _lookTarget.set(cx, cy, cz);
  camera.lookAt(_lookTarget);
}

function summarize(arr, from, to) {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = from; i < to; i++) {
    const v = arr[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const n = Math.max(1, to - from);
  return { avg: sum / n, min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
}

function percentile95(arr, from, to) {
  const a = Array.prototype.slice.call(arr, from, to).sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
}

// ---------------------------------------------------------------------------
// Scenario setups
// ---------------------------------------------------------------------------
// Each setup(env) returns a handle:
//   { meshingMs, meshedTriangles, meshCount, update(dt, ctx)?, stats()?, dispose() }

function setupStaticMeshes(env, mesherFn, mesherLabel) {
  const { scene, world, chunkSize, slice, materials } = env;
  if (typeof mesherFn !== 'function') {
    throw new Error(mesherLabel + ' is not available');
  }
  const group = new THREE.Group();
  group.name = 'bench_' + mesherLabel;
  scene.add(group);

  const geoms = [];
  let meshingMs = 0;
  let meshedTriangles = 0;
  let meshCount = 0;

  const chunksX = Math.ceil(world.sx / chunkSize);
  const chunksZ = Math.ceil(world.sz / chunkSize);
  for (let cz = 0; cz < chunksZ; cz++) {
    for (let cx = 0; cx < chunksX; cx++) {
      const vol = slice(world, cx, cz, chunkSize);
      const t0 = now();
      const res = normalizeMeshed(mesherFn(vol, { ao: true, atlas: null }));
      meshingMs += now() - t0;

      const x0 = cx * chunkSize;
      const z0 = cz * chunkSize;
      if (res.solid) {
        geoms.push(res.solid);
        meshedTriangles += geometryTriangles(res.solid);
        const mesh = new THREE.Mesh(res.solid, materials.solid);
        mesh.position.set(x0, 0, z0);
        group.add(mesh);
        meshCount++;
      }
      if (res.transparent) {
        geoms.push(res.transparent);
        meshedTriangles += geometryTriangles(res.transparent);
        const mesh = new THREE.Mesh(res.transparent, materials.transparent);
        mesh.position.set(x0, 0, z0);
        mesh.renderOrder = 1;
        group.add(mesh);
        meshCount++;
      }
    }
  }

  return {
    meshingMs,
    meshedTriangles,
    meshCount,
    update: null,
    dispose() {
      scene.remove(group);
      for (let i = 0; i < geoms.length; i++) geoms[i].dispose();
    },
  };
}

function setupNaive(env) {
  return setupStaticMeshes(env, buildChunkGeometry, 'buildChunkGeometry');
}

function setupGreedy(env) {
  const mod = env.modules.greedy;
  if (!mod) {
    throw new Error('greedyMesher.js failed to load: ' + env.modules.greedyError);
  }
  return setupStaticMeshes(env, mod.buildGreedyChunkGeometry, 'buildGreedyChunkGeometry');
}

function setupManaged(env) {
  const { scene, world, chunkSize, materials, renderDistance, modules, slice } = env;
  if (!modules.chunkManager) {
    throw new Error('chunkManager.js failed to load: ' + modules.chunkManagerError);
  }
  if (!modules.greedy) {
    throw new Error('greedyMesher.js failed to load: ' + modules.greedyError);
  }
  const { ChunkManager } = modules.chunkManager;
  const { buildGreedyChunkGeometry } = modules.greedy;

  const cm = new ChunkManager(scene, {
    chunkSize,
    mesher: buildGreedyChunkGeometry,
    material: materials.solid,
    transparentMaterial: materials.transparent,
    // LOD 1 (ao: false) genuinely coarsens greedy output: uniform AO removes
    // the merge constraint, so far chunks collapse into bigger quads.
    lod: [
      { dist: 0, ao: true, atlas: null },
      { dist: renderDistance * 0.6, ao: false, atlas: null },
    ],
    maxDistance: renderDistance,
    hysteresis: 4,
    maxBuildsPerFrame: 4,
  });

  const chunksX = Math.ceil(world.sx / chunkSize);
  const chunksZ = Math.ceil(world.sz / chunkSize);
  const t0 = now();
  for (let cz = 0; cz < chunksZ; cz++) {
    for (let cx = 0; cx < chunksX; cx++) {
      cm.addChunk(cx, cz, slice(world, cx, cz, chunkSize));
    }
  }
  const meshingMs = now() - t0; // LOD 0 builds for every chunk

  const st = cm.stats();
  return {
    meshingMs,
    meshedTriangles: st.trianglesTotal, // active-LOD tris across visible chunks
    meshCount: st.chunks,
    update(dt, ctx) { cm.update(dt, ctx); },
    stats() { return cm.stats(); },
    dispose() { cm.dispose(); },
  };
}

/** The default a/b/c scenario set (fresh array — safe to mutate). */
export function defaultScenarios() {
  return [
    {
      name: 'naive',
      description: 'buildChunkGeometry per chunk — no LOD, no render-distance cap',
      setup: setupNaive,
    },
    {
      name: 'greedy',
      description: 'buildGreedyChunkGeometry per chunk — no LOD, no render-distance cap',
      setup: setupGreedy,
    },
    {
      name: 'greedy+LOD+culling',
      description: 'ChunkManager: greedy mesher, 2 LOD levels, render-distance cap',
      setup: setupManaged,
    },
  ];
}

// ---------------------------------------------------------------------------
// runBenchmark
// ---------------------------------------------------------------------------

export async function runBenchmark(renderer, {
  scenarios = null,
  chunksX = 6,
  chunksZ = 6,
  chunkSize = 16,
  seed = 7,
  frames = 480,          // measured frames: 8 s at the fixed 60 Hz step
  warmup = 10,           // rendered but excluded from frame-ms stats
  orbitSeconds = 8,
  renderDistance = 72,   // scenario c render-distance cap (world units)
  container = null,      // DOM element for the results table (optional)
  onProgress = null,     // (message) => void
} = {}) {
  if (!renderer || typeof renderer.render !== 'function') {
    throw new Error('runBenchmark: a THREE.WebGLRenderer (or compatible) is required');
  }
  const progress = (msg) => {
    if (typeof onProgress === 'function') { try { onProgress(msg); } catch (_e) { /* ignore */ } }
  };

  // --- world (shared by every scenario) --------------------------------------
  progress('generating test world…');
  const tWorld0 = now();
  const world = generateTestWorld({ chunksX, chunksZ, chunkSize, seed });
  const worldGenMs = now() - tWorld0;

  // --- optional modules (each scenario fails independently) ------------------
  const modules = { greedy: null, greedyError: null, chunkManager: null, chunkManagerError: null };
  try {
    modules.greedy = await import('./greedyMesher.js');
  } catch (err) {
    modules.greedyError = String((err && err.message) || err);
  }
  try {
    modules.chunkManager = await import('./chunkManager.js');
  } catch (err) {
    modules.chunkManagerError = String((err && err.message) || err);
  }
  const slice = (modules.chunkManager && modules.chunkManager.sliceVolume) || localSliceVolume;

  // --- camera + fixed timestep ------------------------------------------------
  const size = new THREE.Vector2();
  if (renderer.getSize) renderer.getSize(size); else size.set(960, 540);
  const aspect = size.y > 0 ? size.x / size.y : 16 / 9;
  const camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 600);

  const fixedDt = orbitSeconds / Math.max(1, frames); // 8s / 480 = 1/60 s
  const totalFrames = warmup + frames;

  const results = {
    meta: {
      world: { sx: world.sx, sy: world.sy, sz: world.sz, chunksX, chunksZ, chunkSize, seed },
      worldGenMs: r2(worldGenMs),
      frames,
      warmup,
      orbitSeconds,
      fixedDt: r2(fixedDt * 1000) / 1000,
      renderDistance,
      renderer: { width: size.x, height: size.y },
      modules: {
        greedyMesher: modules.greedy ? 'ok' : 'FAILED: ' + modules.greedyError,
        chunkManager: modules.chunkManager ? 'ok' : 'FAILED: ' + modules.chunkManagerError,
      },
      note: 'Headless (SwiftShader) frame-ms is not real-GPU fps. Compare draw calls, '
        + 'triangles, meshing time, and RELATIVE frame-time deltas between scenarios.',
    },
    scenarios: [],
  };

  // Per-frame sample buffers (reused across scenarios — preallocated once).
  const frameMs = new Float64Array(totalFrames);
  const updateMs = new Float64Array(totalFrames);
  const callsArr = new Float64Array(totalFrames);
  const trisArr = new Float64Array(totalFrames);

  const info = renderer.info;
  const prevAutoReset = info ? info.autoReset : true;
  if (info) info.autoReset = false;

  const list = scenarios || defaultScenarios();

  try {
    for (let s = 0; s < list.length; s++) {
      const sc = list[s];
      const entry = {
        name: sc.name || ('scenario' + s),
        description: sc.description || '',
        ok: false,
        error: null,
      };
      results.scenarios.push(entry);
      progress('scenario ' + (s + 1) + '/' + list.length + ': ' + entry.name + ' — meshing…');

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b0e14);
      addSceneLights(scene);
      const materials = makeMaterials();
      const env = {
        THREE, renderer, scene, camera, world, chunkSize, slice,
        modules, materials, renderDistance,
      };

      let handle = null;
      try {
        handle = await sc.setup(env);

        entry.meshingMs = r2(handle.meshingMs || 0);
        entry.meshedTriangles = handle.meshedTriangles | 0;
        entry.meshCount = handle.meshCount | 0;

        progress('scenario ' + (s + 1) + '/' + list.length + ': ' + entry.name
          + ' — rendering ' + totalFrames + ' frames…');

        // --- deterministic orbit loop (accumulated fixed dt, never wall clock)
        const ctx = { camera, renderer, scene, elapsed: 0 };
        const scUpdate = handle.update || null;
        let simTime = 0; // warmup holds t=0; measured frames sweep exactly one orbit

        for (let f = 0; f < totalFrames; f++) {
          if (f >= warmup) simTime += fixedDt;
          placeCamera(camera, world, simTime / orbitSeconds);
          ctx.elapsed = simTime;

          let tu = 0;
          if (scUpdate) {
            const u0 = now();
            scUpdate(fixedDt, ctx);
            tu = now() - u0;
          }
          updateMs[f] = tu;

          if (info) info.reset();
          const t0 = now();
          renderer.render(scene, camera);
          frameMs[f] = now() - t0;
          callsArr[f] = info ? info.render.calls : 0;
          trisArr[f] = info ? info.render.triangles : 0;

          await nextFrame();
        }

        // --- aggregate (warmup excluded) ------------------------------------
        const fm = summarize(frameMs, warmup, totalFrames);
        const um = summarize(updateMs, warmup, totalFrames);
        const dc = summarize(callsArr, warmup, totalFrames);
        const tr = summarize(trisArr, warmup, totalFrames);
        entry.frameMs = { avg: r2(fm.avg), min: r2(fm.min), max: r2(fm.max), p95: r2(percentile95(frameMs, warmup, totalFrames)) };
        entry.updateMs = { avg: r2(um.avg), max: r2(um.max) };
        entry.drawCalls = { avg: r2(dc.avg), min: dc.min, max: dc.max };
        entry.triangles = { avg: Math.round(tr.avg), min: tr.min, max: tr.max };
        if (handle.stats) {
          try { entry.chunkStats = handle.stats(); } catch (_e) { /* optional */ }
        }
        entry.ok = true;
      } catch (err) {
        entry.error = String((err && err.stack) || err);
        console.error('[benchmark] scenario "' + entry.name + '" failed:', err);
      } finally {
        try { if (handle && handle.dispose) handle.dispose(); } catch (_e) { /* ignore */ }
        materials.dispose();
        if (renderer.renderLists && renderer.renderLists.dispose) renderer.renderLists.dispose();
      }
    }
  } finally {
    if (info) info.autoReset = prevAutoReset;
  }

  progress('done');

  // --- on-page table -----------------------------------------------------------
  if (typeof document !== 'undefined') {
    let mount = container;
    if (!mount) {
      mount = document.getElementById('bench-results');
      if (!mount) {
        mount = document.createElement('div');
        mount.id = 'bench-results';
        document.body.appendChild(mount);
      }
    }
    try { renderResultsTable(results, mount); } catch (err) {
      console.error('[benchmark] table render failed:', err);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// On-page results table (plain DOM, inline styles, no innerHTML of user data)
// ---------------------------------------------------------------------------

export function renderResultsTable(results, container) {
  if (!container) return null;
  while (container.firstChild) container.removeChild(container.firstChild);

  const el = (tag, text, cssText) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cssText) node.style.cssText = cssText;
    return node;
  };

  const wrap = el('div', null,
    'font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;'
    + 'color:#e6edf3; padding:12px 0; overflow-x:auto;');

  const m = results.meta || {};
  const w = m.world || {};
  wrap.appendChild(el('div',
    'world ' + w.sx + 'x' + w.sy + 'x' + w.sz
    + ' (' + w.chunksX + 'x' + w.chunksZ + ' chunks of ' + w.chunkSize + ', seed ' + w.seed + ')'
    + ' | worldgen ' + m.worldGenMs + ' ms'
    + ' | ' + m.frames + ' frames @ fixed dt ' + m.fixedDt + ' s (' + m.orbitSeconds + ' s orbit, '
    + m.warmup + ' warmup excluded) | render distance ' + m.renderDistance,
    'margin-bottom:8px; color:#9aa7b5;'));

  const table = el('table', null,
    'border-collapse:collapse; min-width:720px;');
  const thead = el('thead');
  const headRow = el('tr');
  const cols = [
    'scenario', 'status', 'mesh ms', 'meshed tris', 'draw calls avg',
    'draw calls max', 'tris/frame avg', 'frame ms avg', 'frame ms p95', 'update ms avg',
  ];
  for (const c of cols) {
    headRow.appendChild(el('th', c,
      'text-align:right; padding:4px 10px; border-bottom:1px solid #39424e; color:#9aa7b5;'
      + (c === 'scenario' || c === 'status' ? 'text-align:left;' : '')));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  const cellCss = 'text-align:right; padding:4px 10px; border-bottom:1px solid #232a33;';
  const leftCss = 'text-align:left; padding:4px 10px; border-bottom:1px solid #232a33;';
  const fmt = (v) => (v == null ? '—' : (typeof v === 'number' ? v.toLocaleString('en-US') : String(v)));

  for (const s of (results.scenarios || [])) {
    const tr = el('tr');
    tr.appendChild(el('td', s.name, leftCss));
    tr.appendChild(el('td', s.ok ? 'ok' : 'FAILED',
      leftCss + (s.ok ? 'color:#6fdd8b;' : 'color:#ff7b72;')));
    tr.appendChild(el('td', fmt(s.meshingMs), cellCss));
    tr.appendChild(el('td', fmt(s.meshedTriangles), cellCss));
    tr.appendChild(el('td', fmt(s.drawCalls && s.drawCalls.avg), cellCss));
    tr.appendChild(el('td', fmt(s.drawCalls && s.drawCalls.max), cellCss));
    tr.appendChild(el('td', fmt(s.triangles && s.triangles.avg), cellCss));
    tr.appendChild(el('td', fmt(s.frameMs && s.frameMs.avg), cellCss));
    tr.appendChild(el('td', fmt(s.frameMs && s.frameMs.p95), cellCss));
    tr.appendChild(el('td', fmt(s.updateMs && s.updateMs.avg), cellCss));
    tbody.appendChild(tr);

    if (!s.ok && s.error) {
      const er = el('tr');
      const td = el('td', s.error,
        'padding:4px 10px 10px; color:#ff7b72; white-space:pre-wrap; border-bottom:1px solid #232a33;'
        + 'font-size:11px;');
      td.colSpan = cols.length;
      er.appendChild(td);
      tbody.appendChild(er);
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  wrap.appendChild(el('div', m.note || '',
    'margin-top:8px; color:#6b7684; max-width:80ch;'));

  container.appendChild(wrap);
  return wrap;
}

export default runBenchmark;
