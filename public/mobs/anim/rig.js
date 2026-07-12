// ============================================================================
// mobs/anim/rig.js — procedural-animation helper library.
//
// THREE-FREE. This module imports nothing and touches no scene graph — it is
// pure Math in, pure numbers out. Creature modules (mobs/creatures/*.js)
// import the pieces they need and apply the returned numbers to whatever
// THREE.Object3D pivots/scales they built themselves. Because it has zero
// dependencies it can be unit-tested in isolation and safely imported from
// tooling, workers, or anywhere else that can't (or shouldn't) load 'three'.
//
// Every function here is:
//   - pure (no shared mutable state, same input -> same output)
//   - defensive (NaN/undefined/Infinity inputs are coerced to a safe 0-ish
//     fallback rather than poisoning the animation with NaN)
//
// Angle convention: radians, unless a function documents otherwise.
// Time convention: seconds, unless a function documents otherwise.
// ============================================================================

const TAU = Math.PI * 2;

/**
 * Coerce a value to a finite number, falling back to `fallback` (default 0)
 * for NaN/undefined/null/Infinity/non-numeric input. Used internally by
 * every exported function so a single bad upstream value (e.g. a not-yet
 * animated `state.hurt`) can never propagate NaN into a transform.
 * @param {*} v
 * @param {number} [fallback=0]
 * @returns {number}
 */
function num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Clamp a number into [0, 1], guarding non-finite input first.
 * @param {number} t
 * @returns {number}
 */
function clamp01(t) {
  const n = num(t);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ----------------------------------------------------------------------------
// Easing curves
// ----------------------------------------------------------------------------

/**
 * General-purpose smoothstep easing (cubic ease-in-out), for any 0..1
 * progress value that needs a gentle acceleration/deceleration. This is the
 * default "just make it not linear" easing to reach for.
 * @param {number} t - progress, expected 0..1 (values outside are clamped)
 * @returns {number} eased 0..1
 */
export function ease(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * Quadratic ease-in-out. Slightly snappier than {@link ease} in the middle
 * of the curve — useful for windows/telegraphs that want a crisper midpoint.
 * @param {number} t - progress, expected 0..1 (values outside are clamped)
 * @returns {number} eased 0..1
 */
export function easeInOut(t) {
  const x = clamp01(t);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/**
 * Ease-out with a small overshoot past 1 before settling — the classic
 * "back" easing. Great for anticipation pull-backs and pose overshoot/snap
 * (e.g. {@link windUp}, {@link dissolve} spread).
 * @param {number} t - progress, expected 0..1 (values outside are clamped)
 * @returns {number} eased value, briefly exceeds 1 near t≈0.7-0.9
 */
export function easeOutBack(t) {
  const x = clamp01(t);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

// ----------------------------------------------------------------------------
// Idle motion
// ----------------------------------------------------------------------------

/**
 * Subtle idle breathing oscillation — a small scale/offset pulse meant to be
 * added to a torso's base scale (e.g. `1 + breathe(t)`) so a creature never
 * looks perfectly frozen while standing still.
 * @param {number} t - elapsed seconds
 * @param {number} [amp=1] - amplitude multiplier (1 = default subtle scale)
 * @param {number} [freq=1] - frequency multiplier (1 = one breath ≈ 2.85s)
 * @returns {number} small oscillating value, roughly in [-0.025*amp, 0.025*amp]
 */
export function breathe(t, amp = 1, freq = 1) {
  const T = num(t);
  const A = num(amp, 1);
  const F = num(freq, 1);
  const BASE_RATE = 2.2; // rad/s — comfortable resting breathing cadence
  const BASE_SCALE = 0.025; // subtle by design; multiply amp to exaggerate
  return Math.sin(T * BASE_RATE * F) * BASE_SCALE * A;
}

/**
 * Subtle idle sway/drift oscillation — for slow head/body/thread motion
 * that shouldn't read as a deliberate action (alert scanning, hanging
 * threads drifting, antenna drift, etc). Slower and can carry a phase
 * offset so multiple parts sway out of sync with each other.
 * @param {number} t - elapsed seconds
 * @param {number} [amp=1] - amplitude multiplier (1 = default subtle sway)
 * @param {number} [freq=1] - frequency multiplier (1 = one sway ≈ 9s)
 * @param {number} [phase=0] - phase offset in radians
 * @returns {number} small oscillating value, roughly in [-0.06*amp, 0.06*amp]
 */
export function sway(t, amp = 1, freq = 1, phase = 0) {
  const T = num(t);
  const A = num(amp, 1);
  const F = num(freq, 1);
  const P = num(phase, 0);
  const BASE_RATE = 0.7; // rad/s — slow drift cadence
  const BASE_SCALE = 0.06;
  return Math.sin(T * BASE_RATE * F + P) * BASE_SCALE * A;
}

// ----------------------------------------------------------------------------
// Locomotion (walk cycle)
// ----------------------------------------------------------------------------

/**
 * A single limb's swing angle for a given point in its stride cycle.
 * The building block {@link walkPhase} composes into a diagonal-pair gait.
 * @param {number} cyclePhase - normalized phase within the stride, 0..1
 *   (0 = neutral/mid-stance, wraps every 1.0)
 * @param {number} amp - swing amplitude in radians
 * @returns {number} leg swing angle in radians
 */
export function legSwing(cyclePhase, amp) {
  const P = num(cyclePhase);
  const A = num(amp);
  return Math.sin(P * TAU) * A;
}

/**
 * Quadruped walk/trot cycle producing diagonal-pair limb angles: front-right
 * + back-left swing together, front-left + back-right swing together and
 * exactly opposite (offset by half a stride) — a believable trotting gait
 * that also degrades gracefully to a near-stationary shuffle as speed drops
 * to 0.
 * @param {number} t - elapsed seconds
 * @param {number} [speed01=1] - normalized movement speed, 0 (idle/stopped)
 *   to 1 (full stride). Clamped to [0, 1]. Scales both amplitude and cadence
 *   so a creature doesn't march in place at full swing while standing still.
 * @param {number} [strideFreq=1.5] - base stride cadence in cycles/second at
 *   speed01 = 1.
 * @returns {{FR:number, FL:number, BR:number, BL:number, lift:number}}
 *   per-limb swing angles (radians) for front-right, front-left, back-right,
 *   back-left, plus a 0..1 `lift` value (body bob) useful for a small
 *   vertical bounce timed to footfalls.
 */
export function walkPhase(t, speed01 = 1, strideFreq = 1.5) {
  const T = num(t);
  const speed = clamp01(speed01);
  const freq = num(strideFreq, 1.5);

  // Cadence scales with speed (a creature walking slowly takes slower
  // strides, not just smaller ones), amplitude fades toward 0 at a stop.
  const cadence = freq * (0.35 + 0.65 * speed);
  const amp = 0.75 * speed;
  const phase = T * cadence; // cycles elapsed (unbounded, sin wraps it)

  const FR = legSwing(phase, amp);
  const BL = FR; // diagonal pair: front-right + back-left in phase
  const FL = legSwing(phase + 0.5, amp);
  const BR = FL; // diagonal pair: front-left + back-right in phase

  const lift = Math.abs(Math.sin(phase * TAU)) * speed;

  return { FR, FL, BR, BL, lift };
}

// ----------------------------------------------------------------------------
// Flight
// ----------------------------------------------------------------------------

/**
 * Wing-flap angle with a slightly quicker downstroke than upstroke (a small
 * second-harmonic bias), reading more like a real flap than a plain sine.
 * @param {number} t - elapsed seconds
 * @param {number} [freq=2] - flaps per second
 * @param {number} [amp=1] - amplitude in radians
 * @returns {number} wing angle in radians
 */
export function flap(t, freq = 2, amp = 1) {
  const T = num(t);
  const F = num(freq, 2);
  const A = num(amp, 1);
  const p = T * F * TAU;
  // Fundamental + a touch of 2nd harmonic biases the downstroke to feel
  // snappier than the recovery upstroke, without needing a piecewise curve.
  return A * (Math.sin(p) * 0.85 + Math.sin(2 * p) * 0.15);
}

// ----------------------------------------------------------------------------
// Interpolation / smoothing
// ----------------------------------------------------------------------------

/**
 * Interpolate between two angles (radians) along the shortest angular path,
 * so e.g. lerping from 3.0 to -3.0 rad turns the "short way" through π
 * rather than sweeping the long way around.
 * @param {number} a - start angle, radians
 * @param {number} b - target angle, radians
 * @param {number} t - interpolation factor, 0..1 (unclamped, extrapolates)
 * @returns {number} interpolated angle in radians
 */
export function lerpAngle(a, b, t) {
  const A = num(a);
  const B = num(b);
  const T = num(t);
  let diff = (B - A) % TAU;
  if (diff > Math.PI) diff -= TAU;
  if (diff < -Math.PI) diff += TAU;
  return A + diff * T;
}

/**
 * Frame-rate-independent exponential smoothing ("damping") toward a target.
 * Unlike a fixed-fraction lerp (`current += (target-current) * 0.1`), this
 * converges at the same real-world rate regardless of the caller's delta
 * time, so animation doesn't speed up/slow down with frame rate.
 * @param {number} current - current value
 * @param {number} target - target value
 * @param {number} lambda - damping rate in 1/seconds; larger = snaps faster.
 *   ~1-2 is lazy drift, ~8-15 is a brisk catch-up, ~25+ is nearly instant.
 * @param {number} dt - elapsed seconds since the last update
 * @returns {number} new value, eased a fraction of the way from current to target
 */
export function damp(current, target, lambda, dt) {
  const cur = num(current);
  const tgt = num(target);
  const lam = Math.max(0, num(lambda));
  const delta = Math.max(0, num(dt));
  const factor = 1 - Math.exp(-lam * delta);
  return cur + (tgt - cur) * factor;
}

// ----------------------------------------------------------------------------
// Attack telegraphing
// ----------------------------------------------------------------------------

/**
 * Anticipation curve: a pull-back pose that builds (and slightly overshoots)
 * as a telegraphed attack winds up, ready to snap forward into {@link strike}.
 * Drive a limb/body rotation with this during the pre-attack telegraph
 * window so the strike reads as "loaded" rather than appearing from nowhere.
 * @param {number} telegraph - telegraph progress, 0 (attack start, no
 *   pull-back) to 1 (fully wound up, about to release). Clamped to [0, 1].
 * @returns {number} pull-back amount, 0 at telegraph=0, briefly past -1
 *   near telegraph≈0.8 before settling to -1 at telegraph=1. Multiply by a
 *   per-limb amount and add to the limb's rest pose.
 */
export function windUp(telegraph) {
  return -easeOutBack(clamp01(telegraph));
}

/**
 * Fast-forward strike curve: rapid acceleration out of the wind-up into the
 * hit, decelerating into full extension right at impact (a whip-crack shape
 * rather than a linear swing). Pairs with {@link windUp} — as `attack` goes
 * 0..1 the limb should travel from its wound-up pose to its extended pose.
 * @param {number} attack - strike progress, 0 (release) to 1 (full
 *   extension/impact). Clamped to [0, 1].
 * @returns {number} 0..1 progress along the strike, front-loaded (fast)
 */
export function strike(attack) {
  const x = clamp01(attack);
  return 1 - Math.pow(1 - x, 5);
}

// ----------------------------------------------------------------------------
// Death
// ----------------------------------------------------------------------------

/**
 * Death "dissolve" / thread-unravel pose helpers. As `dying` runs 0 -> 1,
 * combine the three returned multipliers with a creature's own base scale
 * / rest Y / limb rest positions to make it shrink, sink into the ground,
 * and fling its limbs/threads outward as it comes apart.
 * @param {number} dying - death progress, 0 (alive/undamaged) to 1 (fully
 *   dissolved). Clamped to [0, 1].
 * @returns {{scale:number, drop:number, spread:number}}
 *   - `scale`: 1 -> 0 shrink multiplier (multiply the creature's base scale
 *     by this so it visibly shrinks away).
 *   - `drop`: 0 -> 1 accelerating sink multiplier (multiply by however far
 *     you want the root to sink and subtract/add to root.position.y).
 *   - `spread`: 0 -> ~1.1 -> 1 outward-fling multiplier for limbs/threads,
 *     overshooting briefly (a "fly apart" snap) before settling, so it
 *     reads as threads unraveling and flinging loose rather than a plain
 *     linear drift.
 */
export function dissolve(dying) {
  const x = clamp01(dying);
  const scale = 1 - ease(x);
  const drop = x * x; // ease-in: slow at first, accelerating sink
  const spread = easeOutBack(x);
  return { scale, drop, spread };
}

// ----------------------------------------------------------------------------
// Bundle
// ----------------------------------------------------------------------------

const rig = {
  ease,
  easeInOut,
  easeOutBack,
  breathe,
  sway,
  legSwing,
  walkPhase,
  flap,
  lerpAngle,
  damp,
  windUp,
  strike,
  dissolve,
};

export default rig;
