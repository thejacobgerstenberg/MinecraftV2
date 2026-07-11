// tests-plus/raycast.test.mjs
//
// node:test coverage for the REAL voxel raycaster (per TEST RECON):
//   public/src/gameplay/raycast.js  -> { raycastVoxel }
//
// SIGNATURE (from the real source at feat/voxel-sandbox-game):
//   raycastVoxel(world, origin, dir, maxDist = 5)
//     -> { hit, x?, y?, z?, nx?, ny?, nz?, face? }
//   world      : { getBlock(x,y,z) => number }   (integer block id; air = 0)
//   origin/dir : { x, y, z }  (dir is normalized internally)
//   hit        : whether a hittable block was met within maxDist
//   (x,y,z)    : integer coords of the block that was hit
//   (nx,ny,nz) : the ADJACENT (empty) cell for placement = hit cell + face normal
//   face       : entered face, one of '+x','-x','+y','-y','+z','-z'
//                (ray travelling straight DOWN enters the TOP face -> '+y'),
//                or null when the origin starts inside a solid.
//
// Hittability rule (raycast.js -> isHittable): getBlockDef(id).solid || id === 29.
//   solid ids used here: 3 = stone.
//   non-hittable ids used here: 0 = air, 8 = water (liquid), 28 = lava (liquid).
//   special case: 29 = portal is NON-solid but IS hittable (id === 29).
//
// FEATURE-DETECT / SKIP GUARD:
//   On the feature/ci branch the game tree (public/src/...) is absent, so we
//   dynamic-import raycast.js inside try/catch. If the import fails we register
//   a single skipped test with a TODO instead of crashing the file, keeping
//   `node --test tests-plus/` green. In the game worktree (where tests-plus/
//   sits next to public/) the real assertions below run.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Feature-detect the real raycaster -------------------------------------
let raycastVoxel = null;
let loadError = null;

try {
  const mod = await import('../public/src/gameplay/raycast.js');
  raycastVoxel = mod.raycastVoxel;
  if (typeof raycastVoxel !== 'function') {
    throw new Error('raycastVoxel export is not a function');
  }
} catch (err) {
  loadError = err;
}

// ---- Tiny synthetic world implementing the { getBlock } interface ----------
// `blocks` is a list of [x, y, z, id]; every other cell reads back as air (0).
const AIR = 0;
const STONE = 3;   // solid  -> hittable
const WATER = 8;   // liquid -> skipped
const LAVA = 28;   // liquid -> skipped
const PORTAL = 29; // non-solid but hittable (id === 29)

function makeWorld(blocks = []) {
  const cells = new Map();
  for (const [x, y, z, id] of blocks) cells.set(`${x},${y},${z}`, id);
  return {
    getBlock(x, y, z) {
      return cells.get(`${x},${y},${z}`) ?? AIR;
    },
  };
}

// Normal implied by the returned placement cell: (nx-x, ny-y, nz-z).
const impliedNormal = (r) => [r.nx - r.x, r.ny - r.y, r.nz - r.z];

if (loadError) {
  test('raycast: real module not importable — skipped (TODO)', { skip: true }, () => {
    // TODO: runs for real only in the game worktree
    // (origin/feat/voxel-sandbox-game) where public/src/gameplay/raycast.js is
    // present. On feature/ci the game tree is absent, so this file self-skips.
    // Import error was: ${loadError && loadError.message}
  });
} else {
  // =========================================================================
  // HIT + FACE / NORMAL
  // =========================================================================

  test('hit: +x ray hits the expected block and enters its -x face', () => {
    // Origin at (0.5, 0.5, 0.5) firing straight +x; stone at (5,0,0).
    const world = makeWorld([[5, 0, 0, STONE]]);
    const r = raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 });

    assert.equal(r.hit, true, 'ray should hit the block on the +x axis');
    assert.deepEqual([r.x, r.y, r.z], [5, 0, 0], 'hit the expected block cell');
    assert.equal(r.face, '-x', 'entered the face pointing back toward the origin');
    assert.deepEqual(impliedNormal(r), [-1, 0, 0], 'face normal points -x');
    // Placement (adjacent) cell is the face-neighbour and must be empty.
    assert.deepEqual([r.nx, r.ny, r.nz], [4, 0, 0], 'placement cell = hit + normal');
    assert.equal(world.getBlock(r.nx, r.ny, r.nz), AIR, 'placement cell is empty');
  });

  test('hit: a downward ray enters the TOP face and reports +y', () => {
    // Straight down from y=10.5; stone at (0,7,0) -> top plane at y=8.
    const world = makeWorld([[0, 7, 0, STONE]]);
    const r = raycastVoxel(world, { x: 0.5, y: 10.5, z: 0.5 }, { x: 0, y: -1, z: 0 });

    assert.equal(r.hit, true);
    assert.deepEqual([r.x, r.y, r.z], [0, 7, 0], 'hit the block below');
    assert.equal(r.face, '+y', 'a ray going down enters the top (+y) face');
    assert.deepEqual(impliedNormal(r), [0, 1, 0], 'normal points +y (upward)');
    assert.deepEqual([r.nx, r.ny, r.nz], [0, 8, 0], 'placement cell sits on top');
  });

  test('hit: a negative-direction ray enters the +x face and reports it', () => {
    // Fire -x from (5.5,...) into a stone at the origin cell (0,0,0).
    const world = makeWorld([[0, 0, 0, STONE]]);
    const r = raycastVoxel(world, { x: 5.5, y: 0.5, z: 0.5 }, { x: -1, y: 0, z: 0 });

    assert.equal(r.hit, true);
    assert.deepEqual([r.x, r.y, r.z], [0, 0, 0]);
    assert.equal(r.face, '+x', 'travelling -x, we enter the block from its +x side');
    assert.deepEqual(impliedNormal(r), [1, 0, 0]);
    assert.deepEqual([r.nx, r.ny, r.nz], [1, 0, 0], 'placement cell is on the +x side');
  });

  test('hit: a +z ray enters the -z face', () => {
    const world = makeWorld([[0, 0, 4, STONE]]);
    const r = raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 0, y: 0, z: 1 });

    assert.equal(r.hit, true);
    assert.deepEqual([r.x, r.y, r.z], [0, 0, 4]);
    assert.equal(r.face, '-z');
    assert.deepEqual(impliedNormal(r), [0, 0, -1]);
    assert.deepEqual([r.nx, r.ny, r.nz], [0, 0, 3]);
  });

  // =========================================================================
  // NO HIT: empty space + zero direction
  // =========================================================================

  test('miss: a ray through empty space returns hit:false and no coords', () => {
    const world = makeWorld([]); // all air
    const r = raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 });

    assert.equal(r.hit, false, 'nothing solid within reach -> no hit');
    assert.equal(r.x, undefined, 'no hit coordinate is reported');
    assert.equal(r.face, undefined, 'no face is reported on a miss');
  });

  test('miss: a zero-length direction returns hit:false', () => {
    const world = makeWorld([[1, 0, 0, STONE]]); // block is right there...
    const r = raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 0, y: 0, z: 0 });

    assert.equal(r.hit, false, 'a degenerate (zero) direction cannot hit anything');
  });

  // =========================================================================
  // REACH (maxDist) IS RESPECTED
  // =========================================================================

  test('reach: a block within maxDist is hit; the same block beyond it is not', () => {
    // Stone at (4,0,0): entered at t = 4 - 0.5 = 3.5 blocks from origin.
    const world = makeWorld([[4, 0, 0, STONE]]);
    const origin = { x: 0.5, y: 0.5, z: 0.5 };
    const dir = { x: 1, y: 0, z: 0 };

    const within = raycastVoxel(world, origin, dir, 5);
    assert.equal(within.hit, true, 'block at distance 3.5 is inside reach 5');
    assert.deepEqual([within.x, within.y, within.z], [4, 0, 0]);

    const beyond = raycastVoxel(world, origin, dir, 3);
    assert.equal(beyond.hit, false, 'the same block at 3.5 is out of reach 3');
    assert.equal(beyond.x, undefined, 'nothing is targeted beyond max reach');
  });

  test('reach: a far block is never targeted even though the ray points at it', () => {
    // Block far down the +x axis; default maxDist = 5 must not reach it.
    const world = makeWorld([[20, 0, 0, STONE]]);
    const r = raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 });
    assert.equal(r.hit, false, 'a block 19.5 blocks away is past the default reach');

    // Extending reach past it should now target it (sanity: the block exists).
    const far = raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 25);
    assert.equal(far.hit, true);
    assert.deepEqual([far.x, far.y, far.z], [20, 0, 0]);
  });

  // =========================================================================
  // ADJACENT-PLACEMENT CELL is the face-neighbour and is empty
  // =========================================================================

  test('placement: adjacent cell = hit cell + face normal, and is air', () => {
    const world = makeWorld([[5, 0, 0, STONE]]);
    const r = raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 });

    assert.equal(r.hit, true);
    // Placement cell equals the hit cell offset by the entered face's normal.
    const [nx, ny, nz] = impliedNormal(r);
    assert.deepEqual([r.nx, r.ny, r.nz], [r.x + nx, r.y + ny, r.z + nz]);
    // And it is the cell just before the block along the ray -> guaranteed air.
    assert.equal(world.getBlock(r.nx, r.ny, r.nz), AIR,
      'a newly-placed block would go into an empty cell');
  });

  // =========================================================================
  // NON-HITTABLE BLOCKS (liquids) ARE SKIPPED; PORTAL IS HITTABLE
  // =========================================================================

  test('skip: the ray passes through water and lava and hits the stone behind', () => {
    // +x ray: water at 2, lava at 3, stone at 5. Only the stone is hittable.
    const world = makeWorld([
      [2, 0, 0, WATER],
      [3, 0, 0, LAVA],
      [5, 0, 0, STONE],
    ]);
    const r = raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 8);

    assert.equal(r.hit, true, 'liquids are transparent to targeting');
    assert.deepEqual([r.x, r.y, r.z], [5, 0, 0], 'hit the stone, not the water/lava');
    assert.equal(r.face, '-x');
  });

  test('portal: the non-solid portal block (id 29) is still hittable', () => {
    const world = makeWorld([[3, 0, 0, PORTAL]]);
    const r = raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 });

    assert.equal(r.hit, true, 'portal is special-cased as hittable despite solid:false');
    assert.deepEqual([r.x, r.y, r.z], [3, 0, 0]);
    assert.equal(r.face, '-x');
  });

  // =========================================================================
  // ORIGIN INSIDE A SOLID: immediate hit, face null, backward placement
  // =========================================================================

  test('buried: origin inside a solid returns face:null with a backward placement cell', () => {
    // Camera buried in the stone at (5,0,0); looking +x (dominant axis x).
    const world = makeWorld([[5, 0, 0, STONE]]);
    const r = raycastVoxel(world, { x: 5.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 });

    assert.equal(r.hit, true, 'the containing cell is hit immediately');
    assert.deepEqual([r.x, r.y, r.z], [5, 0, 0]);
    assert.equal(r.face, null, 'no entered face when starting inside the block');
    // Placement steps BACKWARD along the dominant axis (toward the viewer),
    // never into the cell ahead of a buried camera.
    assert.deepEqual([r.nx, r.ny, r.nz], [4, 0, 0], 'placement is backward on +x view');
  });
}
