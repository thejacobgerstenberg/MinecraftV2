// Voxelheim — physics.js node tests (no framework).
// Run: node tests/physics.test.mjs

import { moveAndCollide, isInLiquid } from '../public/src/gameplay/physics.js';
import { getBlockDef } from '../public/src/blocks/blocks.js';
import { Player } from '../public/src/gameplay/Player.js';

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

// ── 2. Jump arc: leaves ground, peak ~1.25 blocks, then re-lands ──────────
// Tuned jump velocity: sqrt(2 * 24 * 1.25) ≈ 7.75 for a ~1.25-block peak
// (discretization puts the sampled apex a little either side of 1.25).
{
  const world = { getBlock: (x, y, z) => (y < 10 ? 3 : 0) };
  const pos = { x: 0.2, y: 10, z: 0.2 };
  const vel = { x: 0, y: 7.75, z: 0 };
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
  check('jump: apex peaks between 1.15 and 1.35 blocks', apex - 10 >= 1.15 && apex - 10 <= 1.35,
    `apex=${(apex - 10).toFixed(4)}`);
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

// ═══ Player-level movement tuning (Player.js is pure — no three) ══════════

const DT = 1 / 60;
function mkInput(over = {}) {
  return {
    forward: false, back: false, left: false, right: false,
    jump: false, sprint: false, sneak: false, sneakOrDescend: false,
    ...over,
  };
}
const FLAT = { getBlock: (x, y, z) => (y < 10 ? 3 : 0) };
function mkPlayer(world, spawn = { x: 0.5, z: 0.5 }) {
  const p = new Player(world, null);
  p.spawn = { ...spawn };
  p.respawn();
  return p;
}

// ── 6. Sneak: 0.3x walk speed (~1.29 b/s), cancels sprint, eye drop ───────
{
  const p = mkPlayer(FLAT);
  const z0 = p.position.z;
  check('sneak: eye height is 1.62 while standing', p.eyeHeight === 1.62);
  for (let i = 0; i < 60; i++) p.update(DT, mkInput({ forward: true, sneak: true }), 0);
  const disp = Math.abs(p.position.z - z0);
  const hvel = Math.hypot(p.velocity.x, p.velocity.z);
  check('sneak: walk speed is 0.3x (~1.29 b/s)', approx(hvel, 4.3 * 0.3, 0.02), `hvel=${hvel}`);
  check('sneak: 1s of sneaking covers ~1.29 blocks', disp > 1.2 && disp < 1.4, `disp=${disp}`);
  check('sneak: eyes drop to 1.50 while sneaking', p.eyeHeight === 1.5, `eyeHeight=${p.eyeHeight}`);

  const p2 = mkPlayer(FLAT);
  for (let i = 0; i < 60; i++) {
    p2.update(DT, mkInput({ forward: true, sneak: true, sprint: true }), 0);
  }
  const hvel2 = Math.hypot(p2.velocity.x, p2.velocity.z);
  check('sneak: sprint is canceled while sneaking', approx(hvel2, 4.3 * 0.3, 0.02), `hvel=${hvel2}`);
}

// ── 7. Sneak edge-guard: cannot walk off a 1x1 pillar; non-sneak falls ────
{
  const pillar = { getBlock: (x, y, z) => (x === 0 && z === 0 && y < 10 ? 3 : 0) };
  const p = mkPlayer(pillar); // spawns on top of the pillar at y=10
  p.onKillPlane = () => {};
  const z0 = p.position.z;
  for (let i = 0; i < 180; i++) p.update(DT, mkInput({ forward: true, sneak: true }), 0); // 3s toward -z
  check('edge-guard: sneaking at the pillar edge never falls (y stays 10)',
    approx(p.position.y, 10, 0.01) && p.onGround, `y=${p.position.y} onGround=${p.onGround}`);
  check('edge-guard: movement is clamped at the support edge (feet AABB keeps overlap)',
    p.position.z >= -0.6 - 1e-6 && p.position.z < z0 - 0.3,
    `z=${p.position.z} (started ${z0})`);

  const q = mkPlayer(pillar);
  q.onKillPlane = () => {};
  for (let i = 0; i < 120; i++) q.update(DT, mkInput({ forward: true }), 0);
  check('edge-guard: WITHOUT sneak the same walk falls off the pillar',
    q.position.y < 9, `y=${q.position.y}`);
}

// ── 8. Player jump: peak height ~1.25 blocks (1.15..1.35) ─────────────────
{
  const p = mkPlayer(FLAT);
  let apex = p.position.y;
  for (let i = 0; i < 70; i++) { // one full hop (jump held; sample first arc)
    p.update(DT, mkInput({ jump: true }), 0);
    apex = Math.max(apex, p.position.y);
    if (i > 5 && p.onGround) break;
  }
  check('player jump: peak between 1.15 and 1.35 blocks above ground',
    apex - 10 >= 1.15 && apex - 10 <= 1.35, `peak=${(apex - 10).toFixed(4)}`);
}

// ── 9. Sprint-jump: ~1.2x forward impulse on the jump tick ────────────────
{
  const p = mkPlayer(FLAT);
  for (let i = 0; i < 60; i++) p.update(DT, mkInput({ forward: true, sprint: true }), 0);
  const before = Math.hypot(p.velocity.x, p.velocity.z); // ~5.805 (sprint)
  p.update(DT, mkInput({ forward: true, sprint: true, jump: true }), 0);
  const after = Math.hypot(p.velocity.x, p.velocity.z);
  check('sprint-jump: jump tick boosts horizontal speed ~1.2x',
    approx(after, before * 1.2, 0.1) && after > 6.5,
    `before=${before.toFixed(3)} after=${after.toFixed(3)}`);
  check('sprint-jump: actually airborne after the jump tick', p.velocity.y > 0 && !p.onGround);
}

// ── 10. Terminal velocity: fall speed capped at 50 b/s ────────────────────
{
  const airWorld = { getBlock: () => 0 };
  const p = mkPlayer(airWorld); // void column -> respawns at SEA_LEVEL+1
  p.onKillPlane = () => {}; // keep falling past the kill plane
  p.onGround = false;
  let minVy = 0;
  for (let i = 0; i < 240; i++) { // 4s free fall (uncapped would hit ~96 b/s)
    p.update(DT, mkInput(), 0);
    minVy = Math.min(minVy, p.velocity.y);
  }
  check('terminal velocity: fall speed never exceeds 50 b/s', minVy >= -50 - 1e-6, `minVy=${minVy}`);
  check('terminal velocity: terminal speed is actually reached', minVy <= -49.9, `minVy=${minVy}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
