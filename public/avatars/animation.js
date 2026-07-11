// avatars/animation.js
// Velocity-driven walk<->idle blend, look easing, and one-shot arm swing for
// the feet-origin box rig — pure scalar math, zero per-frame allocations.

/* -------------------------------------------------------------------------- */
/* Local helpers (defensive, no external deps)                                 */
/* -------------------------------------------------------------------------- */

const TWO_PI = Math.PI * 2;

/** Clamp n into [lo, hi]. */
function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Finite guard — returns fallback for NaN/Infinity so we never poison state. */
function finite(n, fallback) {
  return typeof n === "number" && n === n && n !== Infinity && n !== -Infinity
    ? n
    : fallback;
}

/* -------------------------------------------------------------------------- */
/* Tunables (module constants — never allocated per frame)                      */
/* -------------------------------------------------------------------------- */

const WALK_FULL_SPEED = 4.5; // horizontal m/s that maps to full stride amplitude
const STRIDE_FREQ = 1.7; // phase radians advanced per (m/s) of speed
const STEP_SPEED_THRESH = 0.35; // min speed (m/s) to emit footstep events

const LEG_AMP = 0.72; // max leg swing (rad) at full walk
const ARM_AMP = 0.55; // max arm counter-swing (rad) at full walk

const IDLE_FREQ = 1.6; // idle sway angular rate (rad/s)
const IDLE_TORSO_AMP = 0.03; // idle torso breathing tilt (rad)
const IDLE_ARM_AMP = 0.06; // idle arm sway (rad)

const BLEND_RATE = 8.0; // 1/s — how fast the walk amplitude eases in/out
const LOOK_RATE = 12.0; // 1/s — how fast yaw/pitch ease toward targets

const PITCH_LIMIT = 1.2; // head pitch clamp (rad)

const SWING_DUR = 0.35; // one-shot punch duration (s)
const SWING_ATTACK = 0.35; // fraction of duration spent rising
const SWING_ANGLE = 1.55; // peak forward punch angle (rad) on armR (rotation.x)
const SWING_LIFT = 0.55; // peak lateral raise (rad) on armR (rotation.z) so the
// punch reads as a raised/extended arm from more orbit angles, not a foreshortened bar

const MAX_DT = 0.1; // clamp large frame gaps (tab refocus, hitches)

/* -------------------------------------------------------------------------- */
/* Animator                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Drives a feet-origin box rig: velocity-blended walk cycle, idle sway,
 * eased look (root yaw + head pitch), and a retriggerable arm swing.
 * All per-frame work is scalar; no objects are allocated in update().
 */
export class Animator {
  /**
   * @param {THREE.Group} group - the rig root (its rotation.y carries body yaw).
   * @param {object} parts - { headPivot, torso, armL, armR, legL, legR } pivots.
   * @param {object} [opts]
   * @param {(foot: 0|1) => void} [opts.onStep] - footfall hook (foot 0 or 1).
   */
  constructor(group, parts, opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};

    this.group = group || null;
    const p = parts && typeof parts === "object" ? parts : {};
    this.headPivot = p.headPivot || null;
    this.torso = p.torso || null;
    this.armL = p.armL || null;
    this.armR = p.armR || null;
    this.legL = p.legL || null;
    this.legR = p.legR || null;

    this.onStep = typeof o.onStep === "function" ? o.onStep : null;

    // --- motion state (all scalars) ---
    this.speed = 0; // current horizontal speed (m/s)
    this.speedBlend = 0; // smoothed 0..1 walk amplitude weight
    this.phase = 0; // walk cycle phase (rad), advanced only while moving
    this.idlePhase = 0; // idle sway phase (rad), always advancing
    this.lastSegment = -1; // half-cycle index (0/1) for footstep detection

    // --- look state ---
    this.yawTarget = finite(group && group.rotation ? group.rotation.y : 0, 0);
    this.yawCurrent = this.yawTarget;
    this.pitchTarget = 0;
    this.pitchCurrent = 0;

    // --- swing state ---
    this.swingActive = false;
    this.swingT = 0;

    this.disposed = false;
  }

  /**
   * Store the world velocity; horizontal magnitude drives the walk blend and
   * stride cadence. Does NOT move the avatar.
   * @param {number} vx
   * @param {number} vy - vertical component (ignored for gait)
   * @param {number} vz
   */
  setVelocity(vx, vy, vz) {
    const x = finite(vx, 0);
    const z = finite(vz, 0);
    this.speed = Math.sqrt(x * x + z * z);
  }

  /**
   * Set look targets; eased toward in update(). Pitch is clamped to +/-1.2 rad.
   * @param {number} yaw - body yaw (rad).
   * @param {number} pitch - head pitch (rad).
   */
  setLook(yaw, pitch) {
    this.yawTarget = finite(yaw, this.yawTarget);
    this.pitchTarget = clamp(finite(pitch, this.pitchTarget), -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Trigger a one-shot forward arm swing on armR (retriggerable). */
  swing() {
    this.swingActive = true;
    this.swingT = 0;
  }

  /**
   * Advance the animation by dt seconds and apply all pose changes.
   * Zero allocations: scalar math and direct rotation writes only.
   * @param {number} dt - elapsed seconds.
   */
  update(dt) {
    if (this.disposed) return;
    let step = finite(dt, 0);
    if (step < 0) step = 0;
    if (step > MAX_DT) step = MAX_DT;

    // --- smoothed walk amplitude (eases in/out even as phase freezes) ---
    const blendTarget = clamp(this.speed / WALK_FULL_SPEED, 0, 1);
    const blendA = clamp(step * BLEND_RATE, 0, 1);
    this.speedBlend += (blendTarget - this.speedBlend) * blendA;
    const walkWeight = this.speedBlend;
    const idleWeight = 1 - walkWeight;

    // --- advance phases ---
    // Walk phase advances with actual speed, so it freezes when stopped
    // (freezing is what makes footstep detection quiet at rest).
    this.phase += step * this.speed * STRIDE_FREQ;
    if (this.phase >= TWO_PI) this.phase -= TWO_PI * Math.floor(this.phase / TWO_PI);
    this.idlePhase += step * IDLE_FREQ;
    if (this.idlePhase >= TWO_PI)
      this.idlePhase -= TWO_PI * Math.floor(this.idlePhase / TWO_PI);

    const swing = Math.sin(this.phase); // primary gait sinusoid
    const legSwing = swing * LEG_AMP * walkWeight;
    const armSwing = swing * ARM_AMP * walkWeight; // opposite sign vs. legs below

    const idleSway = Math.sin(this.idlePhase);
    const idleTorso = idleSway * IDLE_TORSO_AMP * idleWeight;
    const idleArm = idleSway * IDLE_ARM_AMP * idleWeight;

    // --- legs: opposite phase about the hip ---
    if (this.legL) this.legL.rotation.x = legSwing;
    if (this.legR) this.legR.rotation.x = -legSwing;

    // --- arms: counter-swing to legs, plus idle sway ---
    if (this.armL) this.armL.rotation.x = -armSwing + idleArm;

    // --- swing (punch) envelope overrides armR while active ---
    if (this.swingActive) {
      this.swingT += step;
      if (this.swingT >= SWING_DUR) {
        this.swingActive = false;
      }
    }
    if (this.armR) {
      if (this.swingActive) {
        const t = this.swingT / SWING_DUR; // 0..1
        const env =
          t < SWING_ATTACK
            ? t / SWING_ATTACK // fast rise
            : 1 - (t - SWING_ATTACK) / (1 - SWING_ATTACK); // slower decay
        this.armR.rotation.x = env * SWING_ANGLE;
        // Abduct the arm outward (armR sits at -X, so negative z lifts it away
        // from the body) — gives the punch a visible raised silhouette.
        this.armR.rotation.z = -env * SWING_LIFT;
      } else {
        this.armR.rotation.x = armSwing + idleArm;
        this.armR.rotation.z = 0;
      }
    }

    // --- torso idle breathing tilt ---
    if (this.torso) this.torso.rotation.x = idleTorso;

    // --- eased look: yaw (shortest path) + head pitch ---
    const lookA = clamp(step * LOOK_RATE, 0, 1);
    // shortest-path angular difference via atan2(sin, cos)
    const dyaw = this.yawTarget - this.yawCurrent;
    const wrapped = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.yawCurrent += wrapped * lookA;
    if (this.group && this.group.rotation) this.group.rotation.y = this.yawCurrent;

    this.pitchCurrent += (this.pitchTarget - this.pitchCurrent) * lookA;
    if (this.headPivot) this.headPivot.rotation.x = this.pitchCurrent;

    // --- footstep hook: fire on each half-cycle plant while moving ---
    const segment = this.phase < Math.PI ? 0 : 1;
    if (segment !== this.lastSegment) {
      if (
        this.lastSegment !== -1 &&
        this.onStep &&
        this.speed >= STEP_SPEED_THRESH
      ) {
        try {
          this.onStep(segment);
        } catch (_e) {
          /* never let a listener break the frame */
        }
      }
      this.lastSegment = segment;
    }
  }

  /** Release references; the model owns geometry/material/texture disposal. */
  dispose() {
    this.disposed = true;
    this.onStep = null;
    this.group = null;
    this.headPivot = null;
    this.torso = null;
    this.armL = null;
    this.armR = null;
    this.legL = null;
    this.legR = null;
  }
}

export default Animator;
