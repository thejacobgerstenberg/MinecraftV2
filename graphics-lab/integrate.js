// graphics-lab/integrate.js
//
// GraphicsStack — ONE facade over the entire graphics-lab rendering stack, so
// a game builder integrates sky/shadows/water/fog/post/particles/etc. in ~10
// lines instead of re-deriving the wiring in src/demo.js.
//
//   import { GraphicsStack } from './integrate.js';
//   const gfx = new GraphicsStack({ quality: 'medium', texturePack: 'default' });
//   await gfx.init({ domElement: document.body, volumeProvider: { volume } });
//   gfx.start();                       // or: per frame  gfx.update(dt); gfx.render();
//
// Design rules (see the task/API_CONTRACT.md):
//  - NO behaviour changes to existing modules — this file only composes them.
//  - Degrade gracefully: any feature whose init throws logs ONE console.warn
//    and is skipped; the rest of the stack keeps working.
//  - Zero per-frame allocation in update(): the shared ctx object (identical
//    shape to API_CONTRACT.md + the demo's skyColor extension) is mutated in
//    place, scratch colours/vectors are prebuilt.
//  - Per-frame order is the PROVEN demo.js order: sky -> dimensionSky ->
//    fog-colour sync -> shadows -> water -> underwater overlay -> underwaterfx
//    -> ambient -> fog -> particles -> torches -> viewmodel -> wind -> biome
//    -> post (auto night boost) -> post.render().
//
// Texture pipeline: the pack system's buildAtlas (textures/atlas.js) bridged
// into the lab atlas contract via textures/labAdapter.js (raw-rect UVs +
// square 256x256 re-blit), then extended here so faceTile ALSO resolves the
// builder's native block ids 0-29 (textures/atlas.js BLOCK_TILES with the
// builder's face-fallback semantics). Volumes may speak either id space:
//  - a worldgen-style Volume ({ get, isSolid, isOpaque, sx, sy, sz }) is used
//    as-is (lab ids 0-10, src/blocks.js);
//  - a builder-style provider ({ getBlock(x,y,z), size:{sx,sy,sz} }) is
//    adapted into the mesher volume contract; its ids default to the builder
//    palette 0-29 and are remapped to lab semantics at the volume boundary
//    (BUILDER_TO_LAB below) exactly as the README prescribes, so water/leaves
//    handling, the leaf-band scan and the caustic scan all work natively.
//    Pass { ids: 'lab' } on the provider to skip the remap.
//
// EMISSIVE MATERIAL PATH (FINDINGS.md 3/6): blocks whose builder `emissive`
// level is 1-15 (glowstone 24, lava 28, portal 29) are lifted OUT of the
// solid remap and meshed into a THIRD geometry group rendered with an
// emissive tiled material — meshChunk()/the facade world mesh now return/add
// { solid, transparent, emissive }. Lava gets an animated warm UV-scrolled
// glow (update() drives the scroll), glowstone/portal keep their tile look
// but self-illuminate, and PostFX bloom halos all of them at night. Emissive
// info comes from the provider: `emissiveOf(id) -> 0..15` (e.g. reading the
// builder block registry), or an `emissiveMap` { id: level } object, or — for
// `ids: 'builder'` providers — the DEFAULT_BUILDER_EMISSIVE map automatically
// (opt out with `emissive: false`). Without any emissive info the old lossy
// lava(28) -> glowstone(9) remap remains the documented fallback.

import * as THREE from 'three';

import { buildGreedyChunkGeometry } from './src/greedyMesher.js';
import { buildChunkGeometry } from './src/voxelMesher.js';
import { createVoxelMaterial } from './src/voxelMaterial.js';
import { DynamicSky } from './src/sky.js';
import { DimensionSky, DIMENSIONS } from './src/dimensionSky.js';
import { ShadowController } from './src/shadows.js';
import { Water, UnderwaterOverlay } from './src/water.js';
import { UnderwaterFX } from './src/underwaterfx.js';
import { DistanceFog } from './src/fog.js';
import { PostFX } from './src/postprocessing.js';
import { Particles } from './src/particles.js';
import { AmbientLife } from './src/ambientLife.js';
import { TorchLightManager, QUALITY_LIGHTS } from './src/torchlights.js';
import { applyWindSway, WindController } from './src/windsway.js';
import { BiomeGrading } from './src/biomelut.js';
import { FirstPersonViewModel } from './src/viewmodel.js';
import { PhotoMode } from './src/photomode.js';
import { AIR, WATER, LEAVES, isSolidId, isOpaqueId } from './src/blocks.js';
import { createPackAtlas, PACK_REGISTRY } from './textures/labAdapter.js';
import { BLOCK_TILES, tileForFace } from './textures/atlas.js';
import { createSettingsPanel } from './settings/settings.js';
import { DEFAULT_BUILDER_EMISSIVE } from './emitters.js';

export { DEFAULT_BUILDER_EMISSIVE };

// ---------------------------------------------------------------------------
// Constants (mirrors of demo.js's proven preset fan-outs).
// ---------------------------------------------------------------------------
const QUALITIES = ['low', 'medium', 'high', 'ultra'];
const REFLECTION_BY_QUALITY = { low: 'off', medium: 'medium', high: 'high', ultra: 'high' };
const AMBIENT_DENSITY = { low: 0.3, medium: 0.6, high: 0.85, ultra: 1 };
const DIMENSION_BIOME = { warpwold: 'plains', cinderloom: 'cinder', nevermend: 'tundra' };

// Builder block ids (0-29, textures/atlas.js BLOCK_TILES) -> lab ids
// (src/blocks.js 0-10). Nearest visual equivalent; the meshers/effects only
// understand the lab palette, so builder volumes are remapped at the volume
// boundary (README: "a game with a different palette remaps ids to this one
// at the volume boundary"). Glass(12)/portal(29) have no lab analogue and map
// to air; lava(28) maps to glowstone (emissive solid).
// NOTE: when emissive info is available (the default for builder providers,
// see DEFAULT_BUILDER_EMISSIVE) glowstone/lava/portal bypass this table and
// take the emissive material path instead — the lava->glowstone entry below
// is only the documented fallback for `emissive: false` / lab-id volumes.
export const BUILDER_TO_LAB = Object.freeze([
  /* 0 air        */ 0, /* 1 grass      */ 1, /* 2 dirt       */ 2,
  /* 3 stone      */ 3, /* 4 cobble     */ 3, /* 5 sand       */ 4,
  /* 6 sandstone  */ 4, /* 7 gravel     */ 3, /* 8 water      */ 7,
  /* 9 log        */ 5, /* 10 leaves    */ 6, /* 11 planks    */ 8,
  /* 12 glass     */ 0, /* 13 coal_ore  */ 3, /* 14 iron_ore  */ 3,
  /* 15 gold_ore  */ 3, /* 16 diamond   */ 3, /* 17 bedrock   */ 3,
  /* 18 snow_blk  */ 10, /* 19 snow_grs */ 10, /* 20 cactus    */ 6,
  /* 21 red_sand  */ 4, /* 22 netherrck */ 3, /* 23 soul_sand */ 2,
  /* 24 glowstone */ 9, /* 25 obsidian  */ 3, /* 26 end_stone */ 4,
  /* 27 purpur    */ 3, /* 28 lava      */ 9, /* 29 portal    */ 0,
]);

// ---------------------------------------------------------------------------
// Atlas bridge: pack atlas (buildAtlas via the labAdapter) extended so
// faceTile ALSO answers the builder's native ids 0-29. Lab ids (0-10) keep
// their labAdapter mapping (the meshers query those); ids 11-29 fall through
// to BLOCK_TILES with the builder's {all}|{top,side,bottom} fallback.
// ---------------------------------------------------------------------------
function buildStackAtlas(packId, seed) {
  const atlas = createPackAtlas(packId, seed);
  const labFaceTile = atlas.faceTile;
  const builderFaceTile = (blockId, face) => {
    const f = face === 'top' || face === 'bottom' ? face : 'side';
    return tileForFace(BLOCK_TILES[blockId], f);
  };
  atlas.faceTile = (blockId, face) =>
    labFaceTile(blockId, face) || builderFaceTile(blockId, face);
  atlas.builderFaceTile = builderFaceTile; // builder ids 0-29, always native
  atlas.BUILDER_TO_LAB = BUILDER_TO_LAB;
  return atlas;
}

// ---------------------------------------------------------------------------
// Volume adaptation: accept { volume } / a Volume / { getBlock, size } and
// return the mesher volume contract { sx, sy, sz, get, isSolid, isOpaque }
// as `this`-free closures (the meshers hoist the accessors).
//
// Emissive info (optional, drives the third geometry group):
//   provider.emissiveOf   (id) -> 0..15 in the provider's OWN id space
//   provider.emissiveMap  { id: level } plain object alternative
//   builder providers default to DEFAULT_BUILDER_EMISSIVE (glowstone 15,
//   lava 15, portal 11); pass `emissive: false` to opt out and fall back to
//   the pure BUILDER_TO_LAB remap (lava renders as glowstone again).
// When present, the adapted volume carries `_emissive = { rawGet, emissiveOf }`
// (raw, un-remapped ids) consumed by the emissive meshing pass below. The
// public accessor surface (get/isSolid/isOpaque) is unchanged.
// ---------------------------------------------------------------------------
function emissiveOfOption(provider) {
  if (typeof provider.emissiveOf === 'function') return provider.emissiveOf;
  if (provider.emissiveMap && typeof provider.emissiveMap === 'object') {
    const map = provider.emissiveMap;
    return (id) => map[id] | 0;
  }
  return null;
}

function adaptVolume(provider) {
  if (!provider) return null;
  const vol = provider.volume && typeof provider.volume.get === 'function'
    ? provider.volume
    : (typeof provider.get === 'function' ? provider : null);
  const emOpt = provider.emissive === false ? null : emissiveOfOption(provider);

  if (vol) {
    const rawGet = (x, y, z) => vol.get(x, y, z) | 0;
    if (typeof vol.isSolid === 'function' && typeof vol.isOpaque === 'function') {
      // Full worldgen-style Volume; keep it verbatim (accessors are already
      // `this`-free closures per the worldgen contract). With emissive info a
      // shallow copy carries the metadata so the caller's object stays clean.
      if (!emOpt) return vol;
      return { ...vol, _emissive: { rawGet, emissiveOf: emOpt } };
    }
    return {
      sx: vol.sx | 0,
      sy: vol.sy | 0,
      sz: vol.sz | 0,
      get: rawGet,
      isSolid: (x, y, z) => isSolidId(rawGet(x, y, z)),
      isOpaque: (x, y, z) => isOpaqueId(rawGet(x, y, z)),
      WATER_LEVEL: vol.WATER_LEVEL,
      blocks: vol.blocks,
      lights: vol.lights,
      _emissive: emOpt ? { rawGet, emissiveOf: emOpt } : null,
    };
  }

  if (typeof provider.getBlock === 'function') {
    const size = provider.size || {};
    const sx = size.sx | 0;
    const sy = size.sy | 0;
    const sz = size.sz | 0;
    const remap = (provider.ids || 'builder') === 'builder' ? BUILDER_TO_LAB : null;
    const rawGet = (x, y, z) => {
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return AIR;
      return provider.getBlock(x, y, z) | 0;
    };
    const get = (x, y, z) => {
      const id = rawGet(x, y, z);
      if (!remap) return id;
      return id >= 0 && id < remap.length ? remap[id] : AIR;
    };
    // Builder volumes get the registry's emissive levels by default — the
    // whole point of the emissive path is that real nether lava glows without
    // extra wiring. `emissive: false` restores the pure remap.
    const emissiveOf = emOpt
      || (remap && provider.emissive !== false
        ? (id) => DEFAULT_BUILDER_EMISSIVE[id] | 0
        : null);
    return {
      sx,
      sy,
      sz,
      get,
      isSolid: (x, y, z) => isSolidId(get(x, y, z)),
      isOpaque: (x, y, z) => isOpaqueId(get(x, y, z)),
      WATER_LEVEL: provider.waterLevel,
      lights: provider.lights,
      _emissive: emissiveOf ? { rawGet, emissiveOf } : null,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Emissive geometry group (FINDINGS.md 3/6).
//
// Base pass: the world volume with emissive blocks blanked to AIR (their
// faces move to the emissive group) while occlusion (isOpaque) is left
// untouched, so hidden faces stay hidden exactly as under the plain remap.
// Emissive pass: one greedy sweep PER distinct emissive id over a
// single-id sub-volume (its RAW id — the stack atlas resolves builder tiles
// natively, e.g. lava 28 -> the 'lava' tile), then the per-id geometries are
// merged into ONE BufferGeometry with an extra `emissiveParams` vec2
// attribute: x = emissive level / 15, y = UV-scroll weight (1 for lava).
// ---------------------------------------------------------------------------

// Raw ids whose tile scrolls (and takes the warm lava tint) in the emissive
// material. Builder lava only; glowstone/portal glow statically.
const EMISSIVE_SCROLL = Object.freeze({ 28: 1 });

const EMISSIVE_BOOST = 1.6;          // emissive radiance multiplier (bloom
                                     // threshold is 0.75 — level-15 tiles halo)
const EMISSIVE_LAVA_TINT = 0xffb36b; // warm tint mixed in by scroll weight
const LAVA_SCROLL_U = 0.013;         // tile-space scroll speed, u axis (per s)
const LAVA_SCROLL_V = 0.041;         // tile-space scroll speed, v axis (per s)

function makeBasePassVolume(vol) {
  const em = vol._emissive;
  if (!em) return vol;
  const { rawGet, emissiveOf } = em;
  const baseGet = (x, y, z) =>
    ((emissiveOf(rawGet(x, y, z)) | 0) > 0 ? AIR : vol.get(x, y, z));
  return {
    sx: vol.sx,
    sy: vol.sy,
    sz: vol.sz,
    get: baseGet,
    isSolid: vol.isSolid,
    isOpaque: vol.isOpaque,
    WATER_LEVEL: vol.WATER_LEVEL,
    blocks: vol.blocks,
    lights: vol.lights,
  };
}

const EMISSIVE_MERGE_ATTRS = [
  ['position', 3], ['normal', 3], ['uv', 2], ['color', 3], ['ao', 1],
  ['tileOrigin', 2], ['tileSpan', 2],
];

function mergeEmissiveParts(parts) {
  let verts = 0;
  let indices = 0;
  for (const p of parts) {
    verts += p.geom.getAttribute('position').count;
    indices += p.geom.getIndex().count;
  }
  const arrays = {};
  for (const [name, size] of EMISSIVE_MERGE_ATTRS) {
    arrays[name] = new Float32Array(verts * size);
  }
  const emParams = new Float32Array(verts * 2);
  const indexArr = verts > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const g = p.geom;
    const n = g.getAttribute('position').count;
    for (const [name, size] of EMISSIVE_MERGE_ATTRS) {
      arrays[name].set(g.getAttribute(name).array, vo * size);
    }
    for (let i = 0; i < n; i++) {
      emParams[(vo + i) * 2] = p.strength;
      emParams[(vo + i) * 2 + 1] = p.scroll;
    }
    const gi = g.getIndex().array;
    for (let i = 0; i < gi.length; i++) indexArr[io + i] = gi[i] + vo;
    io += gi.length;
    vo += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  for (const [name, size] of EMISSIVE_MERGE_ATTRS) {
    out.setAttribute(name, new THREE.BufferAttribute(arrays[name], size));
  }
  out.setAttribute('emissiveParams', new THREE.BufferAttribute(emParams, 2));
  out.setIndex(new THREE.BufferAttribute(indexArr, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

// -> merged emissive BufferGeometry (attribute superset of the greedy
// contract + emissiveParams) or null when the volume has no emissive blocks.
function buildEmissiveGeometry(vol, atlas, { ao = true } = {}) {
  const em = vol._emissive;
  if (!em) return null;
  const { rawGet, emissiveOf } = em;
  const { sx, sy, sz } = vol;

  // Distinct emissive ids present in the volume (one cheap full scan).
  const seen = new Uint8Array(256);
  const ids = [];
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const id = rawGet(x, y, z) & 255;
        if (seen[id]) continue;
        seen[id] = 1;
        if ((emissiveOf(id) | 0) > 0) ids.push(id);
      }
    }
  }
  if (!ids.length) return null;

  const parts = [];
  for (const id of ids) {
    const level = Math.max(0, Math.min(15, emissiveOf(id) | 0));
    const sub = {
      sx,
      sy,
      sz,
      get: (x, y, z) => (rawGet(x, y, z) === id ? id : AIR),
      // World occlusion PLUS same-id cells: interior faces of a lava ocean /
      // portal sheet cull against themselves, faces against air/leaves emit.
      isOpaque: (x, y, z) => vol.isOpaque(x, y, z) || rawGet(x, y, z) === id,
    };
    const g = buildGreedyChunkGeometry(sub, { ao, atlas });
    if (g.transparent) g.transparent.dispose(); // ids here never route to leaves
    if (g.solid.getAttribute('position').count === 0) {
      g.solid.dispose();
      continue;
    }
    parts.push({ geom: g.solid, strength: level / 15, scroll: EMISSIVE_SCROLL[id] || 0 });
  }
  if (!parts.length) return null;
  return mergeEmissiveParts(parts);
}

// Tiled voxel material extended with a self-illumination term:
//   totalEmissiveRadiance += tile.rgb * mix(1, lavaTint, scroll) * boost * level
// plus a per-fragment UV scroll (weighted by emissiveParams.y) through the
// greedy tile-repeat sampler, so lava crawls while glowstone holds still.
// Composes the exact same way windsway does: wraps createVoxelMaterial's
// onBeforeCompile and appends after its anchors.
function createEmissiveChunkMaterial(atlas) {
  const mat = createVoxelMaterial(atlas
    ? { transparent: false, map: atlas.texture, tiled: true, atlasInfo: atlas }
    : { transparent: false });
  const uEmScroll = { value: new THREE.Vector2(0, 0) };
  const uEmBoost = { value: EMISSIVE_BOOST };
  const uEmTint = { value: new THREE.Color(EMISSIVE_LAVA_TINT) };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    prev(shader);
    shader.uniforms.uEmScroll = uEmScroll;
    shader.uniforms.uEmBoost = uEmBoost;
    shader.uniforms.uEmTint = uEmTint;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute vec2 emissiveParams;\nvarying vec2 vEmissiveParams;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n\tvEmissiveParams = emissiveParams;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying vec2 vEmissiveParams;\nuniform vec2 uEmScroll;\nuniform float uEmBoost;\nuniform vec3 uEmTint;')
      // Scroll the LOCAL tile-space uv before the tiled sampler wraps it
      // (this exact substring is emitted by createVoxelMaterial's tiled
      // map_fragment replacement; absent in non-tiled mode -> no-op).
      .replace('fract( vMapUv )', 'fract( vMapUv + uEmScroll * vEmissiveParams.y )')
      .replace('#include <emissivemap_fragment>', [
        '#include <emissivemap_fragment>',
        '{',
        '\tvec3 vxlEmTint = mix( vec3( 1.0 ), uEmTint, clamp( vEmissiveParams.y, 0.0, 1.0 ) );',
        '#ifdef USE_MAP',
        '\ttotalEmissiveRadiance += sampledDiffuseColor.rgb * vxlEmTint * ( uEmBoost * vEmissiveParams.x );',
        '#else',
        '\ttotalEmissiveRadiance += diffuseColor.rgb * vxlEmTint * ( uEmBoost * vEmissiveParams.x );',
        '#endif',
        '}',
      ].join('\n'));
  };
  // Distinct program identity vs the plain tiled material (same rationale as
  // the tiled cache key in voxelMaterial.js).
  mat.customProgramCacheKey = function () {
    return 'graphicslab-voxel|emissive|' + (atlas ? 'tiled' : 'plain');
  };
  mat.userData.emissiveUniforms = { uEmScroll, uEmBoost, uEmTint };
  mat.userData.setEmissiveBoost = (v) => {
    uEmBoost.value = typeof v === 'number' ? v : EMISSIVE_BOOST;
  };
  return mat;
}

// ---------------------------------------------------------------------------
// GraphicsStack
// ---------------------------------------------------------------------------
export class GraphicsStack {
  /**
   * @param {object} opts
   *   quality      'low'|'medium'|'high'|'ultra'      (default 'medium')
   *   texturePack  PACK_REGISTRY id: 'default'|'smooth'|'gritty'|'woven'|
   *                'accessible'                        (default 'default')
   *   dimension    'warpwold'|'cinderloom'|'nevermend' (default 'warpwold')
   *   seed         determinism seed forwarded to the atlas builder
   *   enable       per-feature overrides, e.g. { water: false }. Keys:
   *                sky, dimensionSky, shadows, water, underwater,
   *                underwaterfx, fog, post, biome, particles, ambient,
   *                torchlights, wind, worldMesh (default true each) and the
   *                OPT-IN keys viewmodel, photomode (default false).
   */
  constructor(opts = {}) {
    this._opts = opts;
    this._quality = QUALITIES.includes(opts.quality) ? opts.quality : 'medium';
    this._texturePack = opts.texturePack || 'default';
    this._dimension = DIMENSIONS.includes(opts.dimension) ? opts.dimension : 'warpwold';
    this._seed = opts.seed ?? 0;
    this._enable = opts.enable || {};

    this._m = {};            // live modules (the `exposes` escape hatch)
    this._effects = {        // toggle state (mirrors demo.js state.effects)
      ao: true, sky: true, shadows: true, water: true, post: true,
      particles: true, fog: true, torchlights: true, wind: true, biome: true,
      underwaterfx: true, biolum: false, ambient: true, reflections: true,
      viewmodel: false,
    };
    this._ready = false;
    this._ownsRenderer = false;
    this._ownsCamera = false;
    this._raf = 0;
    this._dt = 0;
    this._fpsCap = 0;
    this._lastFrameStamp = 0;
    this._clock = new THREE.Clock();
    this._ctx = null;
    this._atlas = null;
    this._materials = null;      // tiled trio { solid, leaves, emissive }
    this._plainMats = null;      // lazy plain pair (naive-mesher fallback)
    this._emissiveUniforms = null; // emissive material scroll/boost uniforms
    this._worldMeshes = null;    // { solid, leaves, emissive, geom } when init auto-meshed
    this._volume = null;
    this._waterLevel = 10;
    this._settingsPanel = null;
    this._onResize = null;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
  }

  // Feature gate: default on, except explicit opt-ins.
  _on(name) {
    const optIn = name === 'viewmodel' || name === 'photomode';
    const v = this._enable[name];
    return optIn ? v === true : v !== false;
  }

  // Graceful degradation: one warning, feature skipped, never fatal.
  _try(name, fn) {
    if (!this._on(name)) return null;
    try {
      return fn();
    } catch (err) {
      console.warn('[GraphicsStack] feature "' + name + '" failed to init — skipped:', err);
      return null;
    }
  }

  /**
   * Build the whole stack. Everything is optional; missing pieces are created
   * (renderer/scene/camera) or skipped (volume-dependent features).
   * @param {object} p
   *   scene, camera, renderer  existing three.js objects (created if omitted)
   *   domElement               container the (created) canvas is appended to
   *   volumeProvider           { volume } | Volume | { getBlock, size, ids?,
   *                            emissiveOf?, emissiveMap?, emissive? } — the
   *                            optional emissiveOf(id)->0..15 (or map) routes
   *                            emissive blocks to the emissive material path;
   *                            builder-id providers default to
   *                            DEFAULT_BUILDER_EMISSIVE (emissive:false opts out)
   *   waterLevel               world water plane Y (default volume.WATER_LEVEL ?? 10)
   *   worldSize                { sx, sy, sz } | number (default from the volume)
   */
  async init({
    scene = null, camera = null, renderer = null, domElement = null,
    volumeProvider = null, waterLevel = null, worldSize = null,
  } = {}) {
    THREE.ColorManagement.enabled = true;

    // --- Renderer (config per the stack contract: FXAA does AA, PostFX owns
    // ACES on the HDR buffer, sRGB output) --------------------------------
    const host = domElement
      || (typeof document !== 'undefined' ? document.body : null);
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({
        antialias: false, alpha: false, stencil: false,
        powerPreference: 'high-performance',
      });
      this._ownsRenderer = true;
      const w = (host && host.clientWidth) || window.innerWidth;
      const h = (host && host.clientHeight) || window.innerHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(w, h);
      if (host) host.appendChild(renderer.domElement);
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    this.renderer = renderer;

    this.scene = scene || new THREE.Scene();

    // --- World data --------------------------------------------------------
    const volume = adaptVolume(volumeProvider);
    this._volume = volume;
    const wl = waterLevel ?? (volume && volume.WATER_LEVEL) ?? 10;
    this._waterLevel = wl;
    let sx = 48; let sy = 32; let sz = 48;
    if (volume) { sx = volume.sx; sy = volume.sy; sz = volume.sz; }
    if (typeof worldSize === 'number') { sx = worldSize; sz = worldSize; }
    else if (worldSize) {
      sx = worldSize.sx ?? sx; sy = worldSize.sy ?? sy; sz = worldSize.sz ?? sz;
    }

    // --- Camera ------------------------------------------------------------
    if (!camera) {
      const el = renderer.domElement;
      camera = new THREE.PerspectiveCamera(
        55, (el.clientWidth || el.width || 1) / (el.clientHeight || el.height || 1),
        0.1, 4000,
      );
      camera.position.set(sx / 2 - 0.8 * sx, wl + 16, sz / 2 + 0.8 * sz);
      camera.lookAt(sx / 2, wl + 6, sz / 2);
      this._ownsCamera = true;
    }
    this.camera = camera;

    // --- Atlas + tiled chunk materials --------------------------------------
    this._try('atlas', () => {
      this._atlas = buildStackAtlas(this._texturePack, this._seed);
      return this._atlas;
    });
    const atlas = this._atlas;
    this._materials = {
      solid: createVoxelMaterial(atlas
        ? { transparent: false, map: atlas.texture, tiled: true, atlasInfo: atlas }
        : { transparent: false }),
      leaves: createVoxelMaterial(atlas
        ? { transparent: true, map: atlas.texture, tiled: true, atlasInfo: atlas }
        : { transparent: true }),
      emissive: createEmissiveChunkMaterial(atlas),
    };
    this._emissiveUniforms = this._materials.emissive.userData.emissiveUniforms;

    // --- World mesh (skippable for games that stream their own chunks) ------
    if (volume && this._on('worldMesh')) {
      this._try('worldMesh', () => this._buildWorldMeshes());
    }

    const m = this._m;
    const center = new THREE.Vector3(sx / 2, wl + 2, sz / 2);

    // --- Sky (owns the sun + hemisphere rig) --------------------------------
    m.sky = this._try('sky', () => {
      const sky = new DynamicSky(renderer, { size: 4000, stars: 2200 });
      this.scene.add(sky.object3d);
      sky.setTimeOfDay(0.35);
      return sky;
    });

    // --- Dimension sky re-skin (needs the sky) ------------------------------
    m.dimSky = !m.sky ? null : this._try('dimensionSky', () => {
      const ds = new DimensionSky(m.sky, { fadeTime: 1.0 });
      if (this._dimension !== 'warpwold') ds.setDimension(this._dimension);
      return ds;
    });

    // --- Shadows (wraps the sky's sun) ---------------------------------------
    m.shadows = !m.sky ? null : this._try('shadows', () => new ShadowController(
      renderer, m.sky.sun, {
        quality: this._quality, center, groundY: wl + 3, lightDistance: 140,
      },
    ));

    // --- Water + underwater overlay + underwater FX --------------------------
    m.water = this._try('water', () => {
      const water = new Water(this.scene, {
        level: wl,
        size: Math.max(96, Math.max(sx, sz) * 5),
        center: { x: sx / 2, z: sz / 2 },
        segments: 96,
        sunRef: m.sky || null,
        reflectionQuality: REFLECTION_BY_QUALITY[this._quality],
      });
      if (m.sky) water.setSkyReflectionColor(m.sky.getFogColor());
      return water;
    });

    m.underwater = this._try('underwater', () => {
      const uw = new UnderwaterOverlay(this.scene, camera, { level: wl });
      uw.object3d.userData.noShadow = true;
      return uw;
    });

    m.underwaterFx = this._try('underwaterfx', () => {
      const ufx = new UnderwaterFX(this.scene, { waterLevel: wl });
      if (volume) ufx.setVolume(volume);
      return ufx;
    });

    // --- Fog ------------------------------------------------------------------
    m.fog = this._try('fog', () => {
      const fog = new DistanceFog(this.scene, {
        mode: 'exp2', density: 0.0016, skyRef: m.sky || null,
      });
      if (m.sky) fog.setSkyColor(m.sky.getFogColor());
      return fog;
    });

    // --- PostFX + biome grading ----------------------------------------------
    m.post = this._try('post', () => new PostFX(renderer, this.scene, camera, {
      quality: this._quality,
    }));
    m.biomes = !m.post ? null : this._try('biome', () => {
      const bg = new BiomeGrading(m.post);
      bg.setBiome(DIMENSION_BIOME[this._dimension]);
      return bg;
    });

    // --- Particles + ambient life ---------------------------------------------
    m.particles = this._try('particles', () => {
      const p = new Particles(this.scene, { camera, waterLevel: wl });
      if (volume && Array.isArray(volume.lights)) {
        for (const l of volume.lights) p.addTorch(l);
      }
      p.setWeather('clear');
      return p;
    });

    m.ambient = this._try('ambient', () => {
      const al = new AmbientLife(this.scene, { camera });
      if (volume) al.setVolume(volume);
      al.setDimension(this._dimension);
      al.setDensity(AMBIENT_DENSITY[this._quality]);
      al.setLeafDrift(this._quality === 'high' || this._quality === 'ultra');
      return al;
    });

    // --- Pooled torch lights ----------------------------------------------------
    m.torches = this._try('torchlights', () => {
      const tm = new TorchLightManager(this.scene, {
        maxLights: QUALITY_LIGHTS[this._quality] || QUALITY_LIGHTS.medium,
      });
      if (volume && Array.isArray(volume.lights)) {
        for (const l of volume.lights) tm.register(l);
      }
      return tm;
    });

    // --- Wind sway on the foliage material --------------------------------------
    m.wind = this._try('wind', () => {
      const wc = new WindController();
      applyWindSway(this._materials.leaves, { mode: 'leaves', controller: wc });
      return wc;
    });

    // --- Opt-in: first-person view model -----------------------------------------
    m.viewmodel = this._try('viewmodel', () => {
      if (!camera.parent) this.scene.add(camera); // camera children need this
      const vm = new FirstPersonViewModel(camera, {
        atlas: this._atlas, atlasTexture: this._atlas && this._atlas.texture,
      });
      vm.setItem('block:1');
      this._effects.viewmodel = true;
      return vm;
    });

    // --- Opt-in: photo mode --------------------------------------------------------
    m.photo = this._try('photomode', () => new PhotoMode(camera, renderer, {
      scene: this.scene,
      render: m.post
        ? ({ width, height }) => { m.post.setSize(width, height); m.post.render(0); }
        : undefined,
    }));

    // Shadow cast/receive flags AFTER every mesh (incl. water) is in the scene.
    if (m.shadows) m.shadows.applyToScene(this.scene);

    // --- Stable per-frame ctx (API_CONTRACT shape + the demo skyColor slot) ---
    const skyColor = new THREE.Color(0xbcd9f2);
    if (m.sky) m.sky.getFogColor(skyColor);
    this._fallbackSunDir = new THREE.Vector3(0.35, 0.8, 0.3).normalize();
    this._ctx = {
      camera,
      renderer,
      scene: this.scene,
      elapsed: 0,
      timeOfDay: 0.35,
      sunDir: m.sky ? m.sky.sunDir : this._fallbackSunDir,
      weather: 'clear',
      underwater: false,
      skyColor,
    };

    // --- Resize -----------------------------------------------------------------
    this._onResize = () => {
      const w = (host && host.clientWidth) || window.innerWidth;
      const h = (host && host.clientHeight) || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (this._ownsRenderer) renderer.setSize(w, h);
      if (m.post) m.post.setSize();
    };
    window.addEventListener('resize', this._onResize);

    this._ready = true;
    return this;
  }

  // Internal: mesh this._volume with the pack atlas and add solid+leaves(+
  // emissive) meshes to the scene (re-run on texture-pack switches).
  _buildWorldMeshes() {
    const volume = this._volume;
    const geom = buildGreedyChunkGeometry(
      makeBasePassVolume(volume), { ao: true, atlas: this._atlas },
    );
    geom.emissive = buildEmissiveGeometry(volume, this._atlas, { ao: true });
    if (this._worldMeshes) {
      const wmPrev = this._worldMeshes;
      wmPrev.solid.geometry = geom.solid;
      if (geom.transparent) {
        wmPrev.leaves.geometry = geom.transparent;
        wmPrev.leaves.visible = true;
      } else {
        wmPrev.leaves.visible = false;
      }
      if (geom.emissive) {
        wmPrev.emissive.geometry = geom.emissive;
        wmPrev.emissive.visible = true;
      } else {
        wmPrev.emissive.visible = false;
      }
      wmPrev.geom.solid.dispose();
      if (wmPrev.geom.transparent) wmPrev.geom.transparent.dispose();
      if (wmPrev.geom.emissive) wmPrev.geom.emissive.dispose();
      wmPrev.geom = geom;
      return wmPrev;
    }
    const solid = new THREE.Mesh(geom.solid, this._materials.solid);
    solid.name = 'GraphicsStackChunkSolid';
    this.scene.add(solid);
    const leaves = new THREE.Mesh(
      geom.transparent || new THREE.BufferGeometry(), this._materials.leaves,
    );
    leaves.name = 'GraphicsStackChunkLeaves';
    leaves.renderOrder = 1;
    leaves.visible = !!geom.transparent;
    this.scene.add(leaves);
    const emissive = new THREE.Mesh(
      geom.emissive || new THREE.BufferGeometry(), this._materials.emissive,
    );
    emissive.name = 'GraphicsStackChunkEmissive';
    emissive.visible = !!geom.emissive;
    this.scene.add(emissive);
    this._worldMeshes = { solid, leaves, emissive, geom };
    return this._worldMeshes;
  }

  _getPlainMats() {
    if (!this._plainMats) {
      const map = this._atlas ? this._atlas.texture : null;
      this._plainMats = {
        solid: createVoxelMaterial({ transparent: false, map }),
        leaves: createVoxelMaterial({ transparent: true, map }),
      };
      if (this._m.wind) {
        applyWindSway(this._plainMats.leaves, { mode: 'leaves', controller: this._m.wind });
      }
    }
    return this._plainMats;
  }

  /**
   * Mesh a chunk volume against the pack atlas.
   * @param {object} volume Volume | { volume } | { getBlock, size, ids?,
   *   emissiveOf?, emissiveMap?, emissive? } — see adaptVolume.
   * @param {object} opts { ao = true, greedy = true }. greedy:false uses the
   *   classic buildChunkGeometry fallback (absolute atlas UVs — pair with
   *   stack.plainMaterials, not the tiled pair; no emissive group — emissive
   *   blocks keep the BUILDER_TO_LAB remap there).
   * @returns {{ solid, transparent, emissive?, stats? }} BufferGeometries.
   *   `emissive` (greedy only) is non-null when the volume carries emissive
   *   info and contains emissive blocks; render it with stack.materials
   *   .emissive (or your own material reading the emissiveParams attribute).
   */
  meshChunk(volume, { ao = true, greedy = true } = {}) {
    const vol = adaptVolume(volume);
    if (!vol) throw new Error('[GraphicsStack] meshChunk: unrecognised volume');
    if (!greedy) return buildChunkGeometry(vol, { ao, atlas: this._atlas });
    const out = buildGreedyChunkGeometry(
      makeBasePassVolume(vol), { ao, atlas: this._atlas },
    );
    out.emissive = buildEmissiveGeometry(vol, this._atlas, { ao });
    return out;
  }

  /** Tiled material trio matching greedy meshChunk output:
   *  { solid, leaves, emissive }. */
  get materials() { return this._materials; }

  /** Plain material pair matching greedy:false (classic mesher) output. */
  get plainMaterials() { return this._getPlainMats(); }

  /** Escape hatch to the raw modules + atlas. */
  get exposes() {
    return {
      sky: this._m.sky || null,
      dimSky: this._m.dimSky || null,
      shadows: this._m.shadows || null,
      water: this._m.water || null,
      underwater: this._m.underwater || null,
      underwaterFx: this._m.underwaterFx || null,
      fog: this._m.fog || null,
      post: this._m.post || null,
      biomes: this._m.biomes || null,
      particles: this._m.particles || null,
      ambient: this._m.ambient || null,
      torches: this._m.torches || null,
      wind: this._m.wind || null,
      viewmodel: this._m.viewmodel || null,
      photo: this._m.photo || null,
      atlas: this._atlas,
      materials: this._materials,
      ctx: this._ctx,
      volume: this._volume,
    };
  }

  /**
   * Advance every module in the proven demo order. Zero per-frame allocation.
   * @param {number} [dt] seconds; derived from an internal clock when omitted.
   */
  update(dt) {
    if (!this._ready) return;
    const step = dt === undefined
      ? Math.min(this._clock.getDelta(), 0.05)
      : Math.min(Number(dt) || 0, 0.05);
    this._dt = step;
    const m = this._m;
    const ctx = this._ctx;
    ctx.elapsed += step;

    if (m.photo && m.photo.active) m.photo.update(step);

    if (m.sky) m.sky.update(step, ctx);              // 1. sun + colours
    if (m.dimSky) m.dimSky.update(step, ctx);        // 1b. dimension grade
    if (m.sky) m.sky.getFogColor(ctx.skyColor);      // 2. horizon -> skyColor
    if (ctx.underwater && m.underwater) m.underwater.getFogColor(ctx.skyColor);
    if (m.shadows) m.shadows.update(step, ctx);      // 3. frustum follow
    if (m.water) m.water.update(step, ctx);          // 4. waves + reflection RT
    if (m.underwater) m.underwater.update(step, ctx); // 5. fog/background swap
    if (m.underwaterFx) m.underwaterFx.update(step, ctx); // 5b. caustics/shafts
    if (m.ambient) m.ambient.update(step, ctx);      // 5c. dimension field
    if (m.fog) m.fog.update(step, ctx);              // 6. colour + density
    if (m.particles) m.particles.update(step, ctx);  // 7. flames/weather/debris
    if (m.torches) m.torches.update(step, ctx);      //    nearest-N pooling
    if (m.viewmodel) m.viewmodel.update(step, ctx);  //    idle bob + fill
    if (m.wind) m.wind.update(step, ctx);            //    2 uniform writes
    if (this._emissiveUniforms) {                    //    lava emissive crawl
      this._emissiveUniforms.uEmScroll.value.set(
        ctx.elapsed * LAVA_SCROLL_U, ctx.elapsed * LAVA_SCROLL_V,
      );
    }
    if (m.biomes) m.biomes.update(step, ctx);        //    no-op (post eases)
    if (m.post) m.post.update(step, ctx);            // 8. auto night boost
  }

  /** Final render: through PostFX when present (self-bypasses when disabled). */
  render() {
    if (!this._ready) return;
    if (this._m.post) this._m.post.render(this._dt);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Convenience rAF loop (update + render). Honors setFpsCap via settings. */
  start() {
    if (this._raf) return;
    const loop = (nowMs) => {
      this._raf = requestAnimationFrame(loop);
      const cap = this._fpsCap;
      if (cap > 0 && typeof nowMs === 'number') {
        const interval = 1000 / cap;
        if (nowMs - this._lastFrameStamp < interval - 0.1) return;
        this._lastFrameStamp = nowMs - ((nowMs - this._lastFrameStamp) % interval);
      }
      this.update();
      this.render();
      if (!this.firstFrameRendered) this.firstFrameRendered = true;
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  // ---------------------------------------------------------------------------
  // Scene-state controls (mirrors of the proven demo.js fan-outs).
  // ---------------------------------------------------------------------------
  setDimension(name) {
    if (!DIMENSIONS.includes(name)) {
      console.warn('[GraphicsStack] setDimension: unknown dimension "' + name + '"');
      return;
    }
    this._dimension = name;
    if (this._m.dimSky) this._m.dimSky.setDimension(name);
    if (this._m.ambient) this._m.ambient.setDimension(name);
    if (this._m.biomes) this._m.biomes.setBiome(DIMENSION_BIOME[name]);
  }

  setQuality(q) {
    const quality = QUALITIES.includes(q) ? q : 'medium';
    this._quality = quality;
    const m = this._m;
    if (m.post) m.post.setQuality(quality);
    if (m.shadows) m.shadows.setQuality(quality);
    if (m.torches) m.torches.setMaxLights(QUALITY_LIGHTS[quality] || QUALITY_LIGHTS.medium);
    if (m.water) {
      const refl = this._effects.reflections ? REFLECTION_BY_QUALITY[quality] : 'off';
      m.water.setReflectionQuality(refl);
    }
    if (m.ambient) {
      m.ambient.setDensity(AMBIENT_DENSITY[quality]);
      m.ambient.setLeafDrift(quality === 'high' || quality === 'ultra');
    }
  }

  setTexturePack(id) {
    const packId = id == null || id === '' ? 'default' : String(id);
    if (!PACK_REGISTRY[packId]) {
      console.warn('[GraphicsStack] unknown texture pack "' + packId + '" — ignored');
      return;
    }
    if (packId === this._texturePack && this._atlas) return;
    let atlas;
    try {
      atlas = buildStackAtlas(packId, this._seed);
    } catch (err) {
      console.warn('[GraphicsStack] texture pack "' + packId + '" failed to build:', err);
      return;
    }
    this._texturePack = packId;
    this._atlas = atlas;
    // Swap the atlas on every live material (tiled ones need the dims too).
    for (const key of ['solid', 'leaves', 'emissive']) {
      const mat = this._materials && this._materials[key];
      if (mat && mat.userData.setMap) {
        mat.userData.setMap(atlas.texture);
        if (mat.userData.setAtlasInfo) mat.userData.setAtlasInfo(atlas);
      }
      const pm = this._plainMats && this._plainMats[key];
      if (pm && pm.userData.setMap) pm.userData.setMap(atlas.texture);
    }
    // Re-mesh the stack-owned world (UV rects live in the geometry).
    if (this._worldMeshes) {
      try { this._buildWorldMeshes(); } catch (err) {
        console.warn('[GraphicsStack] re-mesh after pack switch failed:', err);
      }
    }
    // Keep the held-item viewmodel on the same atlas (demo-sanctioned shim
    // over FirstPersonViewModel's documented internals).
    const vm = this._m.viewmodel;
    if (vm && vm._cache) {
      vm._atlas = atlas;
      vm._atlasTexture = atlas.texture;
      const spec = vm._currentSpec;
      for (const item of vm._cache.values()) {
        vm._holder.remove(item);
        item.traverse((o) => {
          if (o.isMesh) {
            if (o.geometry) o.geometry.dispose();
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const mm of mats) if (mm) mm.dispose();
          }
        });
      }
      vm._cache.clear();
      vm._currentItem = null;
      vm._currentSpec = null;
      vm.setItem(spec || null);
    }
  }

  setWeather(w) {
    const mode = (w === 'rain' || w === 'snow') ? w : 'clear';
    this._ctx.weather = mode;
    if (this._m.particles) {
      this._m.particles.setWeather(mode, mode === 'snow' ? 0.9 : 0.7);
    }
    if (this._m.sky) {
      this._m.sky.setWeather(mode);
      this._m.sky.getFogColor(this._ctx.skyColor);
    }
  }

  setTimeOfDay(t) {
    const v = Math.max(0, Math.min(1, Number(t) || 0));
    this._ctx.timeOfDay = v;
    if (this._m.sky) {
      this._m.sky.setTimeOfDay(v);
      this._m.sky.getFogColor(this._ctx.skyColor);
    }
  }

  setUnderwater(b) {
    const on = !!b;
    this._ctx.underwater = on;
    // Submerged, the sky dome must not leak through the murk (demo rule);
    // restore per the user's sky toggle on surfacing.
    if (this._m.sky) this._m.sky.setEnabled(on ? false : this._effects.sky);
  }

  setFpsCap(n) {
    n = Math.round(Number(n));
    this._fpsCap = Number.isFinite(n) && n > 0 ? n : 0;
  }

  toggle(name, on) {
    const b = !!on;
    if (name in this._effects) this._effects[name] = b;
    const m = this._m;
    switch (name) {
      case 'ao': {
        const all = [this._materials, this._plainMats];
        for (const pair of all) {
          if (!pair) continue;
          for (const key of ['solid', 'leaves', 'emissive']) {
            const mat = pair[key];
            if (mat && mat.userData.setAoEnabled) mat.userData.setAoEnabled(b);
          }
        }
        break;
      }
      case 'sky': if (m.sky) m.sky.setEnabled(this._ctx.underwater ? false : b); break;
      case 'dimensionSky': if (m.dimSky) m.dimSky.setEnabled(b); break;
      case 'shadows': if (m.shadows) m.shadows.setEnabled(b); break;
      case 'water': if (m.water) m.water.setEnabled(b); break;
      case 'post': if (m.post) m.post.setEnabled(b); break;
      case 'particles': if (m.particles) m.particles.setEnabled(b); break;
      case 'fog': if (m.fog) m.fog.setEnabled(b); break;
      case 'torchlights': if (m.torches) m.torches.setEnabled(b); break;
      case 'wind': if (m.wind) m.wind.setEnabled(b); break;
      case 'biome': if (m.biomes) m.biomes.setEnabled(b); break;
      case 'ssao': if (m.post) m.post.toggle('ssao', b); break;
      case 'godrays': if (m.post) m.post.toggle('godrays', b); break;
      case 'bloom': if (m.post) m.post.toggle('bloom', b); break;
      case 'underwaterfx': if (m.underwaterFx) m.underwaterFx.setEnabled(b); break;
      case 'biolum': if (m.underwaterFx) m.underwaterFx.setBiolum(b); break;
      case 'ambient': if (m.ambient) m.ambient.setEnabled(b); break;
      case 'viewmodel': if (m.viewmodel) m.viewmodel.setEnabled(b); break;
      case 'reflections':
        if (m.water) {
          m.water.setReflectionQuality(b ? REFLECTION_BY_QUALITY[this._quality] : 'off');
          this._effects.reflections = m.water.reflectionQuality !== 'off';
        }
        break;
      default:
        console.warn('[GraphicsStack] toggle: unknown feature "' + name + '"');
        break;
    }
  }

  /**
   * Mount the graphics settings drawer (settings/settings.js) wired onto this
   * stack. Injects settings.css next to integrate.js if not already linked.
   * @returns settings panel handle ({ element, get, set, open, close, destroy })
   *   or null when the panel fails to mount.
   */
  attachSettingsPanel({ mount = null, storageKey = 'mc2.graphics' } = {}) {
    try {
      // CSS: the demo links settings.css from index.html; inject it here so
      // facade users get a styled drawer with zero extra steps.
      const href = new URL('./settings/settings.css', import.meta.url).href;
      if (!document.querySelector('link[href="' + href + '"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
      }
      const panel = createSettingsPanel({
        mount: mount || document.body,
        storageKey,
        onChange: (d) => this._applySetting(d.key, d.value),
      });
      // Replay hydrated state once: preset first (it fans out), then keys.
      const s = panel.get();
      this._applySetting('preset', s.preset);
      for (const key of Object.keys(s)) {
        if (key !== 'preset') this._applySetting(key, s[key]);
      }
      this._settingsPanel = panel;
      return panel;
    } catch (err) {
      console.warn('[GraphicsStack] settings panel failed to mount:', err);
      return null;
    }
  }

  _applySetting(key, value) {
    switch (key) {
      case 'preset': if (value !== 'custom') this.setQuality(value); break;
      case 'fov':
        if (this.camera && this.camera.isPerspectiveCamera) {
          this.camera.fov = Math.max(30, Math.min(120, Number(value) || 55));
          this.camera.updateProjectionMatrix();
        }
        break;
      case 'fpsCap': this.setFpsCap(value); break;
      case 'renderDistance': break;  // no chunk ring in the facade's own mesh
      case 'vsync': break;           // advisory (rAF is always vsynced)
      case 'ao': this.toggle('ao', value); break;
      case 'ssao': this.toggle('ssao', value); break;
      case 'shadows': this.toggle('shadows', value); break;
      case 'water': this.toggle('water', value); break;
      case 'reflections': this.toggle('reflections', value); break;
      case 'bloom': this.toggle('bloom', value); break;
      case 'godRays': this.toggle('godrays', value); break;
      case 'windSway': this.toggle('wind', value); break;
      case 'particles': this.toggle('particles', value); break;
      case 'fog': this.toggle('fog', value); break;
      case 'biomeGrading': this.toggle('biome', value); break;
      case 'portalFx': break;        // no portal set piece in the facade
      default: break;
    }
  }

  dispose() {
    this.stop();
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
    if (this._settingsPanel) {
      try { this._settingsPanel.destroy(); } catch (e) { /* already gone */ }
      this._settingsPanel = null;
    }
    const m = this._m;
    const order = ['photo', 'viewmodel', 'biomes', 'post', 'torches', 'ambient',
      'particles', 'fog', 'underwaterFx', 'underwater', 'water', 'shadows',
      'dimSky', 'sky', 'wind'];
    for (const key of order) {
      if (m[key]) {
        try { m[key].dispose(); } catch (err) {
          console.warn('[GraphicsStack] dispose of "' + key + '" threw:', err);
        }
        m[key] = null;
      }
    }
    if (this._worldMeshes) {
      const wm = this._worldMeshes;
      this.scene.remove(wm.solid);
      this.scene.remove(wm.leaves);
      this.scene.remove(wm.emissive);
      wm.geom.solid.dispose();
      if (wm.geom.transparent) wm.geom.transparent.dispose();
      if (wm.geom.emissive) wm.geom.emissive.dispose();
      this._worldMeshes = null;
    }
    for (const pair of [this._materials, this._plainMats]) {
      if (!pair) continue;
      for (const key of ['solid', 'leaves', 'emissive']) {
        if (pair[key]) pair[key].dispose();
      }
    }
    this._materials = null;
    this._plainMats = null;
    this._emissiveUniforms = null;
    if (this._atlas && this._atlas.texture) this._atlas.texture.dispose();
    this._atlas = null;
    if (this._ownsRenderer && this.renderer) {
      const el = this.renderer.domElement;
      this.renderer.dispose();
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    this._ready = false;
  }
}

export default GraphicsStack;
