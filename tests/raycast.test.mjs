// Voxelheim — raycast.js node tests (no framework).
// Run: node tests/raycast.test.mjs

import { raycastVoxel } from '../public/src/gameplay/raycast.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const fmt = (r) => JSON.stringify(r);

// Floor world: solid stone below y=10.
const floorWorld = { getBlock: (x, y, z) => (y < 10 ? 3 : 0) };

// ── 1. Straight down onto the floor ───────────────────────────────────────
{
  const r = raycastVoxel(floorWorld, { x: 0.5, y: 20.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, 20);
  check('down: hit', r.hit === true, fmt(r));
  check('down: block is (0,9,0)', r.x === 0 && r.y === 9 && r.z === 0, fmt(r));
  check('down: adjacent is (0,10,0)', r.nx === 0 && r.ny === 10 && r.nz === 0, fmt(r));
  check('down: face is +y', r.face === '+y', fmt(r));
}

// ── 2. 45-degree ray hits the expected first column ───────────────────────
// World solid for x>=3. Diagonal xz ray from (0.5, 5.5, 0.3) direction
// (1,0,1)/√2 reaches x=3 after Δx=2.5, where z = 0.3+2.5 = 2.8 → enters
// cell (3,5,2) through its -x face; adjacent placement cell (2,5,2).
{
  const wallWorld = { getBlock: (x, y, z) => (x >= 3 ? 3 : 0) };
  const inv = 1 / Math.sqrt(2);
  const r = raycastVoxel(wallWorld, { x: 0.5, y: 5.5, z: 0.3 }, { x: inv, y: 0, z: inv }, 8);
  check('45deg: hit', r.hit === true, fmt(r));
  check('45deg: first column is (3,5,2)', r.x === 3 && r.y === 5 && r.z === 2, fmt(r));
  check('45deg: face is -x', r.face === '-x', fmt(r));
  check('45deg: adjacent is (2,5,2)', r.nx === 2 && r.ny === 5 && r.nz === 2, fmt(r));
}

// ── 3. maxDist respected ──────────────────────────────────────────────────
// Floor is 10.5 blocks below the origin: default maxDist (6) must miss,
// explicit 10 must miss, 11 must hit.
{
  const origin = { x: 0.5, y: 20.5, z: 0.5 };
  const down = { x: 0, y: -1, z: 0 };
  const rDefault = raycastVoxel(floorWorld, origin, down);
  check('maxDist: default 6 misses a floor 10.5 away', rDefault.hit === false, fmt(rDefault));
  const r10 = raycastVoxel(floorWorld, origin, down, 10);
  check('maxDist: 10 still misses (entry at 10.5)', r10.hit === false, fmt(r10));
  const r11 = raycastVoxel(floorWorld, origin, down, 11);
  check('maxDist: 11 hits', r11.hit === true && r11.y === 9, fmt(r11));
}

// ── 4. Ray starting inside a solid block ──────────────────────────────────
// Documented behavior: returns hit:true on the origin cell immediately,
// face:null, and (nx,ny,nz) is the neighbor stepped BACKWARD along the
// dominant axis of dir (toward the viewer).
{
  const r = raycastVoxel(floorWorld, { x: 0.5, y: 5.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, 6);
  check('inside: hit', r.hit === true, fmt(r));
  check('inside: block is the origin cell (0,5,0)', r.x === 0 && r.y === 5 && r.z === 0, fmt(r));
  check('inside: face is null', r.face === null, fmt(r));
  check('inside: adjacent steps back along dominant axis -> (0,6,0)',
    r.nx === 0 && r.ny === 6 && r.nz === 0, fmt(r));
}

// ── 5. Extras: liquids skipped, leaves/glass hittable, zero dir safe ──────
{
  // Water layer over stone: ray must pass through water (id 8) and hit stone.
  const lake = { getBlock: (x, y, z) => (y < 5 ? 3 : (y < 10 ? 8 : 0)) };
  const r = raycastVoxel(lake, { x: 0.5, y: 12.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, 20);
  check('liquid: water skipped, stone below hit at y=4', r.hit === true && r.y === 4, fmt(r));

  // Glass (12) and leaves (10) are solid:true → hittable.
  const glassWorld = { getBlock: (x, y, z) => (y === 5 ? 12 : 0) };
  const g = raycastVoxel(glassWorld, { x: 0.5, y: 8.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, 6);
  check('glass: hittable', g.hit === true && g.y === 5, fmt(g));
  const leafWorld = { getBlock: (x, y, z) => (y === 5 ? 10 : 0) };
  const l = raycastVoxel(leafWorld, { x: 0.5, y: 8.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, 6);
  check('leaves: hittable', l.hit === true && l.y === 5, fmt(l));

  // Degenerate direction: no crash, clean miss.
  const z = raycastVoxel(floorWorld, { x: 0.5, y: 20.5, z: 0.5 }, { x: 0, y: 0, z: 0 }, 6);
  check('zero dir: returns {hit:false}', z.hit === false, fmt(z));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
