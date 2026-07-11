// Voxelheim — physics.js node tests (no framework).
// Run: node tests/physics.test.mjs

import { moveAndCollide, isInLiquid } from '../public/src/gameplay/physics.js';
import { getBlockDef } from '../public/src/blocks/blocks.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const approx = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

const SIZE = { x: 0.6, y: 1.8, z: 0.6 };
const GRAVITY = -24;

// Sanity: solidity really comes from getBlockDef.
check('blockdef sanity: stone solid, water liquid+nonsolid',
  getBlockDef(3).solid === true && getBlockDef(8).solid === false && getBlockDef(8).liquid === true);

// ── 1. Falling from y=20 lands on the y<10 floor ──────────────────────────
{
  const world = { getBlock: (x, y, z) => (y < 10 ? 3 : 0) };
  const pos = { x: 0.2, y: 20, z: 0.2 };
  const vel = { x: 0, y: 0, z: 0 };
  let onGround = false;
  const dt = 1 / 60;
  for (let i = 0; i < 300 && !onGround; i++) {
    vel.y += GRAVITY * dt;
    const res = moveAndCollide(world, { pos, size: SIZE }, vel, dt);
    pos.x = res.position.x; pos.y = res.position.y; pos.z = res.position.z;
    onGround = res.onGround;
  }
  check('fall: lands at pos.y ~= 10', approx(pos.y, 10), `pos.y=${pos.y}`);
  check('fall: onGround true', onGround === true);
  check('fall: velocity.y zeroed on landing', vel.y === 0, `vel.y=${vel.y}`);
}

// ── 2. Jump arc: leaves ground, then re-lands ─────────────────────────────
{
  const world = { getBlock: (x, y, z) => (y < 10 ? 3 : 0) };
  const pos = { x: 0.2, y: 10, z: 0.2 };
  const vel = { x: 0, y: 8.2, z: 0 };
  const dt = 1 / 60;
  let leftGround = false, apex = pos.y, landed = false;
  for (let i = 0; i < 300 && !landed; i++) {
    vel.y += GRAVITY * dt;
    const res = moveAndCollide(world, { pos, size: SIZE }, vel, dt);
    pos.y = res.position.y;
    apex = Math.max(apex, pos.y);
    if (pos.y > 10.05) leftGround = true;
    if (leftGround && res.onGround) landed = true;
  }
  check('jump: leaves the ground', leftGround);
  check('jump: apex clears one block (> 11)', apex > 11, `apex=${apex}`);
  check('jump: re-lands at pos.y ~= 10 with onGround', landed && approx(pos.y, 10), `pos.y=${pos.y}`);
}

// ── 3. Wall: horizontal motion stops flush against it ─────────────────────
// Wall column occupies cell x=5 for y>=10 (all z). Min-corner convention:
// a 0.6-wide box walking +x must stop at pos.x = 5 - 0.6 = 4.4 (± skin).
{
  const world = { getBlock: (x, y, z) => (y < 10 ? 3 : (x === 5 ? 3 : 0)) };
  const pos = { x: 3.0, y: 10.001, z: 0.2 };
  const vel = { x: 4.3, y: 0, z: 0 };
  const dt = 1 / 60;
  let collidedX = false;
  for (let i = 0; i < 120; i++) {
    vel.x = vel.x === 0 ? 4.3 : vel.x; // keep pushing into the wall
    vel.y += GRAVITY * dt;
    const res = moveAndCollide(world, { pos, size: SIZE }, vel, dt);
    pos.x = res.position.x; pos.y = res.position.y; pos.z = res.position.z;
    if (res.collided.x) collidedX = true;
  }
  check('wall: collided.x reported', collidedX);
  check('wall: stops flush at pos.x ~= 4.4', approx(pos.x, 4.4), `pos.x=${pos.x}`);
  check('wall: does not penetrate (pos.x + 0.6 <= 5)', pos.x + SIZE.x <= 5 + 1e-9, `pos.x=${pos.x}`);
}

// ── 4. High speed no-tunneling: vx=50, dt=0.05, 1-block wall ──────────────
// From x=3.5 a single unsubstepped step would land the box at [6.0, 6.6],
// entirely past the wall cell x=5. Substepping must catch it at 4.4.
{
  const world = { getBlock: (x, y, z) => (y < 10 ? 3 : (x === 5 ? 3 : 0)) };
  const pos = { x: 3.5, y: 10.001, z: 0.2 };
  const vel = { x: 50, y: 0, z: 0 };
  const res = moveAndCollide(world, { pos, size: SIZE }, vel, 0.05);
  check('tunnel: blocked by 1-block wall at 50 b/s', res.collided.x === true);
  check('tunnel: stops flush at pos.x ~= 4.4', approx(res.position.x, 4.4), `pos.x=${res.position.x}`);
  check('tunnel: velocity.x zeroed (mutated)', vel.x === 0, `vel.x=${vel.x}`);
}

// ── 5. Liquid: isInLiquid true; falling through water never onGround ─────
// Stone below y=5, water in [5,10), air above.
{
  const world = { getBlock: (x, y, z) => (y < 5 ? 3 : (y < 10 ? 8 : 0)) };

  const submerged = { pos: { x: 0.2, y: 6, z: 0.2 }, size: SIZE };
  check('liquid: isInLiquid true when submerged', isInLiquid(world, submerged) === true);
  const above = { pos: { x: 0.2, y: 11, z: 0.2 }, size: SIZE };
  check('liquid: isInLiquid false above water', isInLiquid(world, above) === false);

  const pos = { x: 0.2, y: 12, z: 0.2 };
  const vel = { x: 0, y: 0, z: 0 };
  const dt = 1 / 60;
  let onGroundInWater = false, landed = false, landY = null;
  for (let i = 0; i < 600 && !landed; i++) {
    vel.y += GRAVITY * dt;
    vel.y = Math.max(vel.y, -3); // crude water terminal velocity, as Player does
    const res = moveAndCollide(world, { pos, size: SIZE }, vel, dt);
    pos.y = res.position.y;
    const inWater = isInLiquid(world, { pos, size: SIZE });
    if (res.onGround && inWater && pos.y > 5.01) onGroundInWater = true;
    if (res.onGround) { landed = true; landY = pos.y; }
  }
  check('liquid: falling through water does not set onGround', onGroundInWater === false);
  check('liquid: eventually rests on stone floor at y ~= 5', landed && approx(landY, 5), `landY=${landY}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
