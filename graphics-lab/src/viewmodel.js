// graphics-lab/src/viewmodel.js
//
// FIRST-PERSON VIEW MODEL — the held-item "hand" anchored to the bottom-right
// of the screen, Minecraft style.
//
//   class FirstPersonViewModel(camera, { atlasTexture, atlas })
//     * Builds a small rig PARENTED TO THE CAMERA so it is screen-stable:
//       anchored lower-right at (0.55, -0.45, -1.1) in camera space, scaled
//       0.35. At that depth the item sits ~0.7+ units past a 0.1 near plane
//       even at full swing extension, so it can never be near-clipped.
//     * IMPORTANT: camera-children only render if the camera itself is in the
//       scene graph. The demo must do `if (!camera.parent) scene.add(camera);`
//       before the first frame.
//     * setItem('block:<id|name>') shows a textured mini voxel cube. When an
//       `atlas` helper (the object returned by textures.js createBlockAtlas —
//       needs .tileUV(name)/.faceTile(id, face), optional .texelSize/.texture)
//       is provided, the cube samples real atlas tiles per face (half-texel
//       inset against bleeding). Otherwise it falls back to flat per-face
//       colours from blocks.js (faceColor top/side/bottom).
//     * setItem('tool:pickaxe') shows a blocky procedural pickaxe (a few box
//       geometries: wood handle + stone head with angled tips).
//     * setItem(null) hides the held item.
//     * Idle bob: gentle sinusoidal position bob + slight rotational sway,
//       as if walking slowly. swing(): a ~0.35s eased down-forward arc, safe
//       to call repeatedly (rapid calls queue at most one follow-up swing, so
//       spam-clicking gives continuous swinging with no state corruption).
//     * Materials are MeshLambert (scene lights + fog apply), each with a tiny
//       emissive floor, plus a small distance-limited PointLight fill inside
//       the rig so the item never reads fully black at night. (A real
//       AmbientLight would leak into the whole scene — three.js lights are
//       global regardless of parenting — hence the short-range point fill.)
//     * Draws OVER world geometry (depthTest:false + high renderOrder) so
//       nearby walls never slice through the hand; depthWrite stays ON so the
//       later transparent passes (water etc.) still depth-test against it.
//
// Contract: update(dt, ctx), setEnabled(bool), get enabled, dispose(),
// .object3d (the rig — already added to the camera by the constructor).
// ctx = { camera, renderer, scene, elapsed, timeOfDay, sunDir, weather,
// underwater }; only ctx.sunDir is read (daylight-scaled fill) — optional.
// Zero per-frame allocations: update() only mutates existing transforms.

import * as THREE from 'three';
import { BLOCKS, faceColor, getBlock } from './blocks.js';

// Rig anchor in camera space (lower-right, comfortably past the near plane).
// Raised off the frame edge so the held block floats clear of the screen
// bottom (it used to sit ON the edge and read as world geometry) and the
// blocky arm below-right of it stays visible.
const ANCHOR_POS = { x: 0.48, y: -0.38, z: -1.1 };
const ANCHOR_SCALE = 0.3;

// Blocky first-person arm (Steve-style): skin tone + darker sleeve band.
// Deliberately dark-ish albedo: the rig is unshadowed, so mid tones here
// render about right under full sun + hemi (a "true" light skin tone washed
// out to cream-white in day shots). Sleeve is a muted denim blue-grey: the
// old saturated teal band next to the held block read as a "flat teal cube"
// instead of clothing in closeup shots.
const ARM_SKIN = [0.34, 0.22, 0.13];
const ARM_SLEEVE = [0.11, 0.14, 0.2];

// Render after all normal scene content so depthTest:false overlays cleanly.
const BASE_RENDER_ORDER = 950;

// Idle bob tuning (slow-walk feel). Units are rig-local (pre-ANCHOR_SCALE).
const BOB_SPEED = 1.7;          // rad/s base frequency
const BOB_X = 0.045;            // horizontal figure-eight sweep
const BOB_Y = 0.03;             // vertical bounce (double frequency)
const SWAY_Z = 0.025;           // roll sway (rad)
const SWAY_X = 0.015;           // pitch sway (rad)

// Swing tuning.
const SWING_DURATION = 0.35;    // seconds
const SWING_ROT_X = -1.15;      // down-forward chop (rad, peak)
const SWING_ROT_Z = -0.4;       // inward twist (rad, peak)
const SWING_PUSH_Z = -0.35;     // forward lunge (rig-local, peak)
const SWING_DROP_Y = -0.18;     // downward drop (rig-local, peak)

// BoxGeometry emits faces in the order +x,-x,+y,-y,+z,-z (4 verts each).
const BOX_FACE_KIND = ['side', 'side', 'top', 'bottom', 'side', 'side'];

// Slight per-face brightness for the held mini-cube so it reads as a 3D block
// even under the flat overlay lighting (depthTest:false rig, no shadows):
// lit top, two side pairs a notch apart, dark underside. Applied as material
// tints in BOTH the atlas-textured and flat-colour paths.
const FACE_SHADE = { top: 0.9, sideX: 0.78, sideZ: 0.68, bottom: 0.55 };

// Pickaxe palette (wood handle ~ plank tones, stone head ~ stone tones).
const PICK_WOOD = [0.62, 0.45, 0.26];
const PICK_WOOD_DARK = [0.5, 0.36, 0.2];
const PICK_STONE = [0.5, 0.5, 0.53];
const PICK_STONE_DARK = [0.43, 0.43, 0.46];

function makeLambert(rgb, { map = null, emissive = null, emissiveScale = 0.05 } = {}) {
  const mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(rgb[0], rgb[1], rgb[2]),
    map,
  });
  // Tiny self-illumination floor so the item never goes pitch black.
  if (emissive) {
    mat.emissive.setRGB(emissive[0], emissive[1], emissive[2]);
    mat.emissiveIntensity = 0.55; // real emitters (glowstone) glow properly
  } else {
    mat.emissive.setRGB(rgb[0], rgb[1], rgb[2]).multiplyScalar(emissiveScale);
  }
  // Overlay behaviour: never depth-clipped by world geometry. NOTE: with
  // depthTest:false WebGL disables depth WRITES too (GL semantics — depth
  // mask only applies while DEPTH_TEST is enabled), so the water plane, drawn
  // later in the transparent pass, used to blend OVER the held item. Flagging
  // the material transparent moves the item into the transparent queue where
  // its high renderOrder (950+) makes it draw AFTER water/particles, restoring
  // the intended always-on-top overlay.
  mat.depthTest = false;
  mat.depthWrite = true;
  mat.transparent = true;
  mat.fog = false; // screen-attached prop — distance fog would double-dim it
  return mat;
}

function markOverlay(mesh, orderOffset) {
  mesh.renderOrder = BASE_RENDER_ORDER + orderOffset;
  mesh.frustumCulled = false;      // corner-of-screen items must never pop out
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.noShadow = true;   // respected by ShadowController.applyToScene
  return mesh;
}

export class FirstPersonViewModel {
  /**
   * @param {THREE.Camera} camera  Rig parent. The camera itself must be in the
   *   scene graph for its children to render (demo: scene.add(camera)).
   * @param {Object}  opts
   * @param {THREE.Texture|null} opts.atlasTexture  Atlas texture for block
   *   items. If omitted but `atlas.texture` exists, that is used.
   * @param {Object|null} opts.atlas  Helper as returned by
   *   textures.js createBlockAtlas(): { tileUV(name), faceTile(id, face),
   *   texelSize?, texture? }. Required for textured UVs; without it block
   *   items use flat blocks.js colours.
   */
  constructor(camera, { atlasTexture = null, atlas = null } = {}) {
    this._camera = camera;
    this._atlas = atlas;
    this._atlasTexture = atlasTexture || (atlas && atlas.texture) || null;

    this._enabled = true;
    this._time = 0;

    // Swing state machine.
    this._swinging = false;
    this._swingT = 0;
    this._swingQueued = false;

    // Rig hierarchy: rig (anchor) -> bob (idle motion) -> swingPivot (arc)
    //                -> holder (cached item variants, one visible at a time).
    this.object3d = new THREE.Group();
    this.object3d.name = 'fp-viewmodel';
    this.object3d.position.set(ANCHOR_POS.x, ANCHOR_POS.y, ANCHOR_POS.z);
    this.object3d.scale.setScalar(ANCHOR_SCALE);
    this.object3d.userData.noShadow = true;

    this._bob = new THREE.Group();
    this._bob.name = 'fp-viewmodel-bob';
    this.object3d.add(this._bob);

    this._swingPivot = new THREE.Group();
    this._swingPivot.name = 'fp-viewmodel-swing';
    this._bob.add(this._swingPivot);

    this._holder = new THREE.Group();
    this._holder.name = 'fp-viewmodel-holder';
    this._swingPivot.add(this._holder);

    // Blocky first-person ARM reaching in from the lower-right screen corner
    // to the held item, so the shot reads as first-person at a glance. Swings
    // with the item (child of the swing pivot).
    this._arm = this._buildArm();
    this._swingPivot.add(this._arm);

    // Very short-range warm fill so the item never goes 100% black in a cave.
    // Deliberately faint — the item is lit by the SCENE (sun/moon + hemi +
    // torch lights), and update() scales this fill DOWN with the sun so the
    // held block never reads as an emissive lantern at night.
    this._fill = new THREE.PointLight(0xfff1da, 0.09, 2.0, 2);
    this._fill.position.set(0, 0.5, 0.9); // rig-local: above + camera-side
    this._fill.castShadow = false;
    this._fillBase = this._fill.intensity;
    this.object3d.add(this._fill);

    // spec string -> built THREE.Object3D (kept as hidden holder children).
    this._cache = new Map();
    this._currentSpec = null;
    this._currentItem = null;

    camera.add(this.object3d);
    this._syncVisibility();
  }

  // -- item management ------------------------------------------------------

  /**
   * Show a held item. Accepts:
   *   'block:<id>'  numeric id or block name from blocks.js (e.g. 'block:1',
   *                 'block:grass') -> textured/coloured mini voxel cube
   *   'tool:pickaxe' -> procedural blocky pickaxe
   *   null / ''      -> hide
   */
  setItem(spec) {
    if (!spec) {
      if (this._currentItem) this._currentItem.visible = false;
      this._currentItem = null;
      this._currentSpec = null;
      this._syncVisibility();
      return;
    }
    if (spec === this._currentSpec) return;

    let item = this._cache.get(spec);
    if (!item) {
      item = this._buildItem(spec);
      if (!item) return; // unknown spec: keep current item
      this._cache.set(spec, item);
      this._holder.add(item);
    }

    if (this._currentItem) this._currentItem.visible = false;
    item.visible = true;
    this._currentItem = item;
    this._currentSpec = spec;
    this._syncVisibility();
  }

  _buildItem(spec) {
    if (spec.startsWith('block:')) {
      const id = this._resolveBlockId(spec.slice(6));
      if (id === null) return null;
      return this._buildBlockItem(id);
    }
    if (spec === 'tool:pickaxe') return this._buildPickaxe();
    return null;
  }

  _resolveBlockId(token) {
    const n = parseInt(token, 10);
    if (Number.isFinite(n) && n > 0 && n < BLOCKS.length) return n;
    for (let i = 1; i < BLOCKS.length; i++) {
      if (BLOCKS[i].name === token) return i;
    }
    return null;
  }

  _buildBlockItem(id) {
    const group = new THREE.Group();
    group.name = 'fp-item-block-' + id;

    // ~15% smaller than the old 0.72 cube and pulled toward the arm below —
    // sized/placed so the near corner sits inside the cubic hand and the
    // whole thing reads as one held unit, not a block floating by the arm.
    const geo = new THREE.BoxGeometry(0.61, 0.61, 0.61);
    const block = getBlock(id);
    let mesh;

    if (this._atlas && this._atlasTexture &&
        typeof this._atlas.tileUV === 'function' &&
        typeof this._atlas.faceTile === 'function' &&
        this._remapBoxUVs(geo, id)) {
      // Textured path: shared atlas map, one material per box-face slot so
      // each face carries its FACE_SHADE tint (grass shows the grass-top tile
      // up top, grass-side tiles around, dirt below — with a directional
      // shade so the cube reads 3D). All tints sit below white: world voxels
      // carry baked AO the unshadowed rig lacks, so a full-white tint
      // rendered noticeably paler than the same block in the terrain.
      const mk = (shade) => makeLambert([shade, shade, shade], {
        map: this._atlasTexture,
        emissive: block.emissive || null,
        emissiveScale: 0.06,
      });
      const sideX = mk(FACE_SHADE.sideX);
      const sideZ = mk(FACE_SHADE.sideZ);
      mesh = new THREE.Mesh(geo,
        [sideX, sideX, mk(FACE_SHADE.top), mk(FACE_SHADE.bottom), sideZ, sideZ]);
    } else {
      // Flat-colour fallback (no atlas): per-face blocks.js colours — grass =
      // green top / dirt-toned sides, never a uniform cube. faceColor()
      // already bakes top/side/bottom shading; the second side pair gets an
      // extra dim step so adjacent faces never merge into one silhouette.
      const opts = { emissive: block.emissive || null };
      const dim = (rgb, k) => [rgb[0] * k, rgb[1] * k, rgb[2] * k];
      const top = makeLambert(faceColor(id, 'top'), opts);
      const bottom = makeLambert(faceColor(id, 'bottom'), opts);
      const sideX = makeLambert(faceColor(id, 'side'), opts);
      const sideZ = makeLambert(dim(faceColor(id, 'side'), 0.85), opts);
      mesh = new THREE.Mesh(geo, [sideX, sideX, top, bottom, sideZ, sideZ]);
    }

    markOverlay(mesh, 0);
    group.add(mesh);

    // Held pose: top tipped toward the viewer, two side faces visible.
    // Position pulled down-right toward the hand/forearm so the block's near
    // corner overlaps the hand cube (was centred at (0, 0.05, 0), detached).
    group.rotation.set(0.3, 0.62, 0);
    group.position.set(0.08, -0.07, 0.05);
    group.visible = false;
    return group;
  }

  /**
   * Rewrite BoxGeometry's default per-face 0..1 UVs into each face's atlas
   * tile rect (half-texel inset). Returns false if any tile lookup fails so
   * the caller can fall back to flat colours.
   */
  _remapBoxUVs(geo, id) {
    const uv = geo.getAttribute('uv');
    const inset = (this._atlas.texelSize || 0) * 0.5;
    for (let f = 0; f < 6; f++) {
      const tile = this._atlas.faceTile(id, BOX_FACE_KIND[f]);
      const rect = tile ? this._atlas.tileUV(tile) : null;
      if (!rect) return false;
      const u0 = rect.u0 + inset, u1 = rect.u1 - inset;
      const v0 = rect.v0 + inset, v1 = rect.v1 - inset;
      for (let v = 0; v < 4; v++) {
        const i = f * 4 + v;
        uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
      }
    }
    uv.needsUpdate = true;
    return true;
  }

  // Blocky forearm: a long box aimed from the lower-right screen corner up to
  // the held item, with a darker sleeve band at the shoulder end and a cubic
  // hand wrapping the held block's near corner. Rig-local; rendered as part
  // of the overlay (same depthTest:false + renderOrder rules, arm -> band ->
  // hand -> item so the block sits in the palm).
  _buildArm() {
    const group = new THREE.Group();
    group.name = 'fp-viewmodel-arm';

    // Runs from the "hand" at the block's lower-right corner out through the
    // bottom-right screen corner (far end off-frame, like a real FPS arm).
    // The shallow screen-space slope keeps the forearm band visible above
    // the frame edge instead of dipping straight below it.
    const hand = new THREE.Vector3(0.32, -0.28, 0.15);
    const dir = new THREE.Vector3(1.74, -0.35, 0.35).normalize();
    const q = new THREE.Quaternion()
      .setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);

    const skin = makeLambert(ARM_SKIN, { emissiveScale: 0.04 });
    const sleeve = makeLambert(ARM_SLEEVE, { emissiveScale: 0.04 });

    // Extended past the hand anchor toward the held block (2.3 long, centred
    // at 0.8 along dir => near end 0.35 BEYOND the hand point) so the forearm
    // visually plugs into the hand/block instead of stopping short of it.
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 2.3), skin);
    arm.position.copy(dir).multiplyScalar(0.8).add(hand);
    arm.quaternion.copy(q);
    markOverlay(arm, -3);
    group.add(arm);

    // Sleeve band across the mid-forearm (on-screen, so the strip clearly
    // reads as an arm rather than a wedge of terrain). Pushed down-arm from
    // the hand so it never visually merges with the held block.
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.56, 0.42), sleeve);
    band.position.copy(dir).multiplyScalar(0.72).add(hand);
    band.quaternion.copy(q);
    markOverlay(band, -2);
    group.add(band);

    // Simple cubic hand wrapping the held block's near-lower corner: drawn
    // after the arm/band and just under the item, it bridges forearm -> item
    // so the silhouette connects with no gap (the "detached block" fix).
    const handCube = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), skin);
    handCube.position.set(0.27, -0.24, 0.16);
    handCube.quaternion.copy(q);
    markOverlay(handCube, -1);
    group.add(handCube);

    return group;
  }

  _buildPickaxe() {
    const group = new THREE.Group();
    group.name = 'fp-item-pickaxe';

    const wood = makeLambert(PICK_WOOD);
    const woodDark = makeLambert(PICK_WOOD_DARK);
    const stone = makeLambert(PICK_STONE);
    const stoneDark = makeLambert(PICK_STONE_DARK);

    // Handle: long thin shaft with a darker grip band at the base.
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 1.05, 0.13), wood);
    handle.position.set(0, 0, 0);
    markOverlay(handle, 0);
    group.add(handle);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.2, 0.15), woodDark);
    grip.position.set(0, -0.44, 0);
    markOverlay(grip, 1);
    group.add(grip);

    // Head: centre block across the top of the handle...
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.18, 0.16), stone);
    head.position.set(0, 0.52, 0);
    markOverlay(head, 2);
    group.add(head);

    // ...with two angled tip blocks curving down like pick points.
    const tipL = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.15, 0.15), stoneDark);
    tipL.position.set(-0.4, 0.44, 0);
    tipL.rotation.z = 0.55;
    markOverlay(tipL, 3);
    group.add(tipL);

    const tipR = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.15, 0.15), stoneDark);
    tipR.position.set(0.4, 0.44, 0);
    tipR.rotation.z = -0.55;
    markOverlay(tipR, 4);
    group.add(tipR);

    // Held pose: handle raked toward the lower-right, head up and inward.
    group.rotation.set(0.35, -0.85, -0.4);
    group.position.set(0, 0.02, 0);
    group.visible = false;
    return group;
  }

  // -- animation ------------------------------------------------------------

  /**
   * Trigger the ~0.35s arc swing. Safe to spam: while a swing is in flight at
   * most one follow-up is queued, so repeated calls produce continuous
   * swinging and never corrupt the animation state.
   */
  swing() {
    if (!this._swinging) {
      this._swinging = true;
      this._swingT = 0;
      this._swingQueued = false;
    } else {
      this._swingQueued = true;
    }
  }

  update(dt, ctx) {
    if (!this._enabled) return;
    if (!(dt > 0)) dt = 0; // guard NaN / negative clocks
    this._time += dt;

    // Idle bob: horizontal figure-eight + vertical bounce + rotational sway.
    const t = this._time * BOB_SPEED;
    const bob = this._bob;
    bob.position.x = Math.cos(t) * BOB_X;
    bob.position.y = Math.sin(t * 2) * BOB_Y;
    bob.rotation.z = Math.cos(t) * SWAY_Z;
    bob.rotation.x = Math.sin(t * 2) * SWAY_X;

    // Swing arc.
    const pivot = this._swingPivot;
    if (this._swinging) {
      this._swingT += dt;
      let p = this._swingT / SWING_DURATION;
      if (p >= 1) {
        if (this._swingQueued) {
          this._swingQueued = false;
          this._swingT = 0;
          p = 0;
        } else {
          this._swinging = false;
          p = 1;
        }
      }
      // Smoothstep-eased half-sine: soft attack, full extension mid-swing,
      // eased return.
      const e = p * p * (3 - 2 * p);
      const s = Math.sin(e * Math.PI);
      pivot.rotation.x = SWING_ROT_X * s;
      pivot.rotation.z = SWING_ROT_Z * s;
      pivot.position.z = SWING_PUSH_Z * s;
      pivot.position.y = SWING_DROP_Y * s;
    } else if (pivot.rotation.x !== 0) {
      pivot.rotation.x = 0;
      pivot.rotation.z = 0;
      pivot.position.z = 0;
      pivot.position.y = 0;
    }

    // Scene-matched fill: the faint warm fill follows the SUN, so the held
    // item is lit like the world around it. At night it drops to near zero
    // (the moon/hemi rig takes over) instead of boosting — the old night
    // boost made the block glow like a lantern in night screenshots.
    if (ctx && ctx.sunDir) {
      const day = Math.min(Math.max(ctx.sunDir.y * 3 + 0.25, 0.05), 1);
      this._fill.intensity = this._fillBase * day;
    }
  }

  // -- contract plumbing ----------------------------------------------------

  setEnabled(on) {
    this._enabled = !!on;
    this._syncVisibility();
  }

  get enabled() {
    return this._enabled;
  }

  _syncVisibility() {
    const show = this._enabled && this._currentItem !== null;
    this.object3d.visible = show;
    this._fill.visible = show;
  }

  dispose() {
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    const seenMats = new Set();
    for (const item of this._cache.values()) {
      item.traverse((node) => {
        if (node.isMesh) {
          if (node.geometry) node.geometry.dispose();
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          for (const m of mats) {
            if (m && !seenMats.has(m)) {
              seenMats.add(m);
              m.dispose(); // note: does NOT dispose the shared atlas texture
            }
          }
        }
      });
    }
    this._cache.clear();
    this._currentItem = null;
    this._currentSpec = null;
    if (this._arm) {
      this._arm.traverse((node) => {
        if (node.isMesh) {
          node.geometry.dispose();
          node.material.dispose();
        }
      });
      this._arm = null;
    }
    if (this._fill.dispose) this._fill.dispose();
  }
}

export default FirstPersonViewModel;
