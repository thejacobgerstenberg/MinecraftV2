// avatars-plus/emotes.js
// Original expressive emote registry + EmoteController that blends poses on top
// of the Animator output by lerping pivot channels toward a target by weight w.

/* -------------------------------------------------------------------------- */
/* Local helpers (defensive, no external deps, no per-frame allocations)       */
/* -------------------------------------------------------------------------- */

/** Clamp v into [0,1]; non-finite -> 0. */
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

const TWO_PI = Math.PI * 2;

/** Finite guard with fallback so bad input never poisons the clock. */
function finite(n, fallback) {
  return typeof n === "number" && n === n && n !== Infinity && n !== -Infinity
    ? n
    : fallback;
}

/** Smoothstep easing on an already-clamped [0,1] weight. */
function smooth(w) {
  return w * w * (3 - 2 * w);
}

/** Linear interpolate a -> b by w (w assumed in [0,1]). */
function lerp(a, b, w) {
  return a + (b - a) * w;
}

/* -------------------------------------------------------------------------- */
/* Weight envelope tunables (seconds)                                          */
/* -------------------------------------------------------------------------- */

const EASE_IN = 0.18; // one-shot & loop ease-in
const EASE_OUT = 0.22; // one-shot tail / loop stop() ease-out
const MAX_DT = 0.1; // clamp big frame gaps (tab refocus, hitches)

/* -------------------------------------------------------------------------- */
/* Emote registry                                                              */
/*                                                                             */
/* Each pose(t, ch) writes ONLY the channels it needs into the scratch object  */
/* `ch` and returns it. t is normalized 0..1 across one cycle. Channels:       */
/*   headX/Y/Z torsoX/Y/Z armLX armLZ armRX armRZ legLX legRX groupY           */
/* Rig sign convention: positive rotation.x swings a limb forward/up, so arms  */
/* overhead are strongly negative armRX/armLX. groupY is a small additive body */
/* yaw wiggle (delta), not an absolute facing.                                 */
/* -------------------------------------------------------------------------- */

/** @type {ReadonlyArray<{id:string,label:string,icon:string,duration:number,loop:boolean,channels:string[],pose:(t:number,ch?:object)=>object}>} */
export const EMOTES = Object.freeze([
  {
    id: "wave",
    label: "Wave",
    icon: "👋",
    duration: 1.7,
    loop: false,
    channels: ["armRX", "armRZ", "headY"],
    /** Right arm raised overhead, hand swinging side-to-side twice, head tips toward it. */
    pose(t, ch) {
      const o = ch || {};
      const osc = Math.sin(2 * TWO_PI * t); // two full waves
      o.armRX = -2.4;
      o.armRZ = 0.55 * osc;
      o.headY = 0.12 * osc;
      return o;
    },
  },
  {
    id: "nod",
    label: "Nod",
    icon: "🙂",
    duration: 1.6,
    loop: false,
    channels: ["headX", "torsoX"],
    /**
     * Three deliberate affirmative nods: the head dips DEEP, holds briefly at the
     * bottom of each nod, then rises fully back to neutral before the next — a
     * clear "yes", distinct from the shallow continuous idle head-sway. A tiny
     * torso bob rides along so the whole upper body commits to the gesture.
     */
    pose(t, ch) {
      const o = ch || {};
      const phase = t * 3; // three nods across the cycle
      const f = phase - Math.floor(phase); // 0..1 within the current nod
      let dip;
      if (f < 0.22) {
        dip = smooth(f / 0.22); // ease down to the bottom
      } else if (f < 0.5) {
        dip = 1; // brief deliberate hold at the bottom
      } else {
        dip = 1 - smooth((f - 0.5) / 0.5); // settle back up to neutral
      }
      o.headX = 0.62 * dip; // deep, committed downward nod
      o.torsoX = 0.06 * dip; // subtle complementary torso bob
      return o;
    },
  },
  {
    id: "sit",
    label: "Sit",
    icon: "🪑",
    duration: 3.0,
    loop: true,
    channels: ["legLX", "legRX", "torsoX", "armLX", "armRX", "headX"],
    /** Both legs fold forward (seated), torso reclines a touch, hands rest forward on knees; gently breathes and holds. */
    pose(t, ch) {
      const o = ch || {};
      o.legLX = 1.5;
      o.legRX = 1.5;
      o.torsoX = -0.12 + 0.02 * Math.sin(TWO_PI * t);
      o.armLX = 0.25;
      o.armRX = 0.25;
      o.headX = 0.05;
      return o;
    },
  },
  {
    id: "cheer",
    label: "Cheer",
    icon: "🙌",
    duration: 1.8,
    loop: false,
    channels: ["armLX", "armRX", "headX", "torsoX"],
    /** Both arms thrown overhead pumping in a triumphant bob, head lifted. */
    pose(t, ch) {
      const o = ch || {};
      const bob = 0.18 * Math.sin(3 * TWO_PI * t);
      o.armLX = -2.55 + bob;
      o.armRX = -2.55 + bob;
      o.headX = -0.15;
      o.torsoX = -0.05 - 0.03 * Math.cos(3 * TWO_PI * t);
      return o;
    },
  },
  {
    id: "point",
    label: "Point",
    icon: "👉",
    duration: 1.8,
    loop: false,
    channels: ["armRX", "armRZ", "torsoY", "headY", "headX"],
    /** Right arm extended forward pointing, torso and head turn to sight along it; held. */
    pose(t, ch) {
      const o = ch || {};
      o.armRX = -1.5;
      o.armRZ = 0.1;
      o.torsoY = -0.1;
      o.headY = -0.15;
      o.headX = 0.05;
      return o;
    },
  },
  {
    id: "dance",
    label: "Dance",
    icon: "🕺",
    duration: 1.2,
    loop: true,
    channels: ["armLX", "armRX", "torsoZ", "headZ", "groupY", "legLX", "legRX"],
    /** Arms punch alternately overhead, torso and head swing, hips wiggle, knees bounce foot-to-foot — loops until stopped. */
    pose(t, ch) {
      const o = ch || {};
      const s = Math.sin(TWO_PI * t);
      const c = Math.cos(TWO_PI * t);
      // Big alternating overhead arm raises (~ -2.4 .. -0.3).
      o.armLX = -1.35 - 1.05 * s;
      o.armRX = -1.35 + 1.05 * s;
      // Clearer side-to-side torso sway and head bob.
      o.torsoZ = 0.34 * s;
      o.headZ = 0.16 * s;
      // Hip wiggle at double time.
      o.groupY = 0.22 * Math.sin(2 * TWO_PI * t);
      // Knees bounce in opposition — weight shifts foot to foot.
      o.legLX = 0.34 * (0.5 - 0.5 * c);
      o.legRX = 0.34 * (0.5 + 0.5 * c);
      return o;
    },
  },
  {
    id: "bow",
    label: "Bow",
    icon: "🙇",
    duration: 2.2,
    loop: false,
    channels: ["torsoX", "headX", "armLX", "armRX"],
    /** Torso folds deeply forward, head drops, arms ease back behind; holds, then the ease-out rises. */
    pose(t, ch) {
      const o = ch || {};
      o.torsoX = 1.0;
      o.headX = 0.35;
      o.armLX = -0.28;
      o.armRX = -0.28;
      return o;
    },
  },
  {
    id: "facepalm",
    label: "Facepalm",
    icon: "🤦",
    duration: 2.0,
    loop: false,
    channels: ["headX", "armRX", "armRZ", "headY", "torsoX"],
    /**
     * The head tips well DOWN as the right arm swings up and crosses INWARD so the
     * hand plainly meets the face; the torso slumps a touch and a slow despairing
     * head shake plays under the held beat — unmistakable exasperation.
     */
    pose(t, ch) {
      const o = ch || {};
      o.headX = 0.62; // head drops down into the waiting hand
      o.armRX = -2.25; // right arm swings up to face height
      o.armRZ = -0.9; // and crosses inward onto the brow
      o.torsoX = 0.1; // slight forward slump of the shoulders
      o.headY = 0.06 * Math.sin(2 * TWO_PI * t); // slow despairing shake
      return o;
    },
  },
]);

/** Fast id -> emote lookup (built once at module load). */
const EMOTE_BY_ID = (() => {
  const m = Object.create(null);
  for (let i = 0; i < EMOTES.length; i++) m[EMOTES[i].id] = EMOTES[i];
  return m;
})();

/** Ordered list of every channel a pose may write. */
const CHANNELS = [
  "headX",
  "headY",
  "headZ",
  "torsoX",
  "torsoY",
  "torsoZ",
  "armLX",
  "armLZ",
  "armRX",
  "armRZ",
  "legLX",
  "legRX",
  "groupY",
];

/* -------------------------------------------------------------------------- */
/* EmoteController                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Blends an emote pose on top of whatever the Animator wrote this frame.
 * Run update(dt) AFTER animator.update(dt): it reads the current (post-Animator)
 * pivot rotations and lerps each channel the emote uses toward the pose target
 * by weight w, so emotes layer over walk/idle and release cleanly as w -> 0.
 * Zero per-frame allocations; never throws.
 */
export class EmoteController {
  /**
   * @param {object} parts - { headPivot, torso, armL, armR, legL, legR } pivots.
   * @param {THREE.Group} group - the rig root (its rotation.y carries body yaw).
   * @param {object} [opts] - reserved for future options.
   */
  constructor(parts, group, opts = {}) {
    void opts;
    const p = parts && typeof parts === "object" ? parts : {};
    this.group = group || null;

    // Resolve channel -> (node, axis) once. `delta:true` means the value is
    // added to the node's current rotation rather than lerped toward (groupY).
    const map = [
      ["headX", p.headPivot, "x", false],
      ["headY", p.headPivot, "y", false],
      ["headZ", p.headPivot, "z", false],
      ["torsoX", p.torso, "x", false],
      ["torsoY", p.torso, "y", false],
      ["torsoZ", p.torso, "z", false],
      ["armLX", p.armL, "x", false],
      ["armLZ", p.armL, "z", false],
      ["armRX", p.armR, "x", false],
      ["armRZ", p.armR, "z", false],
      ["legLX", p.legL, "x", false],
      ["legRX", p.legR, "x", false],
      ["groupY", this.group, "y", true],
    ];
    // Preallocated target descriptors (no per-frame alloc; skips null pivots).
    this._targets = [];
    for (let i = 0; i < map.length; i++) {
      const node = map[i][1];
      if (node && node.rotation) {
        this._targets.push({
          key: map[i][0],
          node,
          axis: map[i][2],
          delta: map[i][3],
        });
      }
    }

    // Scratch pose object reused every frame — pose() writes into this.
    this._pose = Object.create(null);
    for (let i = 0; i < CHANNELS.length; i++) this._pose[CHANNELS[i]] = NaN;

    /** @type {object|null} */ this._emote = null;
    this._clock = 0; // seconds since play()
    this._endAt = 0; // effective end time for one-shots (may be shortened by stop())
    this._stopping = false; // loop emote is easing out
    this._stopAt = 0; // clock time stop() was requested (loop tail start)
    /** @type {((id:string)=>void)|null} */ this._resolve = null;
  }

  /**
   * Start an emote. Any active emote is finished first (its promise resolves).
   * @param {string} id - one of the EMOTES ids.
   * @returns {Promise<string>} resolves when a one-shot finishes, or when a
   *   loop emote is stopped. Resolves immediately for an unknown id.
   */
  play(id) {
    const emote = EMOTE_BY_ID[id];
    if (!emote) return Promise.resolve(id);
    // Finish any in-flight emote cleanly before starting the new one.
    if (this._emote) this._finish();
    this._emote = emote;
    this._clock = 0;
    this._endAt = emote.loop ? Infinity : emote.duration;
    this._stopping = false;
    this._stopAt = 0;
    return new Promise((res) => {
      this._resolve = res;
    });
  }

  /** Ease the active emote out (loop tail or shortened one-shot tail). */
  stop() {
    if (!this._emote || this._stopping) return;
    this._stopping = true;
    this._stopAt = this._clock;
    // For a one-shot, collapse the remaining hold so only the ease-out remains.
    if (!this._emote.loop) {
      const soon = this._clock + EASE_OUT;
      if (soon < this._endAt) this._endAt = soon;
    }
  }

  /** @returns {boolean} true while an emote is playing (including its ease-out). */
  isActive() {
    return this._emote != null;
  }

  /** @returns {string|null} the active emote id, or null. */
  current() {
    return this._emote ? this._emote.id : null;
  }

  /**
   * Advance the emote clock and blend the pose onto the current pivots.
   * Call AFTER animator.update(dt). Scalar math + reuse only — no allocations.
   * @param {number} dt - seconds since last frame.
   */
  update(dt) {
    const emote = this._emote;
    if (!emote) return;

    const d = Math.min(MAX_DT, Math.max(0, finite(dt, 0)));
    this._clock += d;
    const clock = this._clock;

    // --- weight envelope -----------------------------------------------------
    let w;
    if (emote.loop) {
      if (this._stopping) {
        w = 1 - clamp01((clock - this._stopAt) / EASE_OUT);
        if (w <= 0) {
          this._finish();
          return;
        }
      } else {
        w = clamp01(clock / EASE_IN);
      }
    } else {
      if (clock >= this._endAt) {
        this._finish();
        return;
      }
      const wIn = clamp01(clock / EASE_IN);
      const wOut = clamp01((this._endAt - clock) / EASE_OUT);
      w = wIn < wOut ? wIn : wOut;
    }
    w = smooth(clamp01(w));

    // --- pose sample (normalized 0..1 within one cycle) ----------------------
    const dur = emote.duration > 0 ? emote.duration : 1;
    const t = emote.loop ? (clock % dur) / dur : clamp01(clock / dur);

    // Reset scratch (scalar assignments — no allocation) then let pose fill it.
    const pose = this._pose;
    for (let i = 0; i < CHANNELS.length; i++) pose[CHANNELS[i]] = NaN;
    try {
      emote.pose(t, pose);
    } catch (_e) {
      return; // never let a bad pose fn throw into the render loop
    }

    // --- blend onto the live pivots -----------------------------------------
    const targets = this._targets;
    for (let i = 0; i < targets.length; i++) {
      const tg = targets[i];
      const target = pose[tg.key];
      if (!Number.isFinite(target)) continue;
      const rot = tg.node.rotation;
      const cur = rot[tg.axis];
      if (tg.delta) {
        // groupY: add a small yaw wiggle on top of the Animator's body yaw.
        rot[tg.axis] = cur + target * w;
      } else {
        rot[tg.axis] = lerp(cur, target, w);
      }
    }
  }

  /** Clear active state and resolve the pending play() promise. */
  _finish() {
    const res = this._resolve;
    const id = this._emote ? this._emote.id : null;
    this._emote = null;
    this._resolve = null;
    this._clock = 0;
    this._endAt = 0;
    this._stopping = false;
    this._stopAt = 0;
    if (res) {
      try {
        res(id);
      } catch (_e) {
        /* swallow */
      }
    }
  }
}
