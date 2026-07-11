// graphics-lab/src/voxelMaterial.js
//
// createVoxelMaterial({ transparent = false, map = null, alphaTest = null,
//                       tiled = false, atlasInfo = null })
//   -> THREE.MeshStandardMaterial
//
// A standard PBR material tuned for the voxel chunk: rough, non-metallic, driven
// by the geometry's per-vertex `color` attribute. It is patched via
// onBeforeCompile to read the mesher's custom `ao` attribute and MULTIPLY it
// into the diffuse albedo (affecting both the direct and indirect diffuse terms)
// so crevices darken. Because it stays a MeshStandardMaterial, Three.js shadows
// and fog keep working — the injection only touches diffuseColor right after the
// vertex color is applied.
//
// Texturing: pass `map` = the atlas texture from textures.js createBlockAtlas().
// The shader multiplies map * vertexColor * AO (map_fragment runs before
// color_fragment, and our AO line is appended to color_fragment), so with an
// atlas the vertex color acts as the neutral tint the mesher bakes in atlas
// mode. With `transparent: true` (leaves) AND a map, the material switches to
// classic alpha-CUTOUT foliage: alphaTest 0.5 against the tile's transparent
// holes, fully opaque otherwise, depth-written, double-sided — no sorting
// artifacts. Untextured behavior is unchanged (backward compatible).
//
// TILED mode (Phase 3, for src/greedyMesher.js geometry): `tiled: true` makes
// the material repeat one atlas tile across greedy-merged WxH quads. The
// greedy mesher emits `uv` as LOCAL tile-space coords (0..W / 0..H, one unit
// per block) plus a `tileOrigin` vec2 attribute holding the RAW (un-inset)
// atlas rect origin of that face's tile (it also emits `tileSpan`, which this
// shader does not need — the span is implicit in the local uv range). The
// fragment stage then computes, per fragment:
//     sampleUV = tileOrigin + halfTexelInset
//              + fract(localUV) * (tileSizeUV - 2.0 * halfTexelInset)
// which reproduces exactly the half-texel-inset tile rect that voxelMesher
// bakes into its absolute UVs — same anti-bleed guarantee, but wrapping per
// block so a merged quad tiles instead of stretching. `atlasInfo` supplies the
// dimensions ({ tileSizePx, atlasSizePx, texelSize } — the createBlockAtlas()
// result itself qualifies); omitted fields default to the demo atlas (16px
// tiles in a 64px atlas). Tiled materials REQUIRE geometry with the
// `tileOrigin` attribute (greedy geometry always has it) and, when a map is
// bound, should not be mixed with voxelMesher.js geometry (whose uv is
// absolute). The non-tiled path is byte-identical to Phase 1/2 — same shader
// strings, same userData surface, same (default) program cache key.
//
// Composition with windsway.js: applyWindSway wraps the CURRENT
// onBeforeCompile, runs it first, then appends its sway chunk after
// "#include <begin_vertex>". Every replacement below keeps the include marker
// in place, so the sway chunk lands between <begin_vertex> and our varying
// assignments — sway only touches `transformed`, we only read attributes, so
// both patches survive in either mode (verified against windsway.js's
// patch/replace targets). For tiled materials we set an explicit
// customProgramCacheKey (the hook's source no longer identifies the program —
// tiled vs non-tiled differ only via a closed-over flag); windsway detects an
// own cache key and extends it, so swayed/tiled/plain variants never collide
// in the program cache. Non-tiled materials keep the prototype default cache
// key exactly as before.
//
// Runtime knobs (no re-mesh needed):
//   material.userData.setAoStrength(s)   // 0..1+, blends AO in/out (default 1)
//   material.userData.setAoEnabled(bool) // hard on/off (default on)
//   material.userData.aoUniforms         // { uAoStrength, uAoEnabled } uniforms
//   material.userData.setMap(tex|null)   // swap/remove the atlas at runtime
// Tiled-only knobs:
//   material.userData.setAtlasInfo(info) // retune tile/atlas dimensions live
//   material.userData.tileUniforms       // { uTileSizeUV, uTileInset }
//
// The AO/tile knobs are backed by uniform objects that are re-linked on every
// (re)compile, so changing them after the shader has been built still works.

import * as THREE from 'three';

export function createVoxelMaterial({
  transparent = false,
  map = null,
  alphaTest = null,
  tiled = false,
  atlasInfo = null,
} = {}) {
  // "Cutout" mode: textured leaves render as opaque geometry with alpha-tested
  // holes (classic Minecraft fancy foliage) — better depth behavior than blending.
  const cutout = !!map && transparent;

  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.95,
    metalness: 0.0,
    vertexColors: true,   // geometry provides per-vertex face color / tint
    flatShading: false,   // normals are already per-face; smooth shading is fine
    map: map || null,
    transparent: cutout ? false : transparent,
    // Leaves: without a map, keep the slightly see-through blended look; with a
    // map the tile's transparent holes carry the see-through instead.
    opacity: cutout ? 1.0 : (transparent ? 0.85 : 1.0),
    alphaTest: alphaTest ?? (transparent ? 0.5 : 0.0),
    depthWrite: transparent && !cutout ? false : true,
    side: cutout ? THREE.DoubleSide : THREE.FrontSide,
  });

  // Persistent uniform objects. The same references are injected into every
  // compiled program (see onBeforeCompile) so the setters below keep working
  // across recompiles (e.g. when scene lights change).
  const uAoStrength = { value: 1.0 };
  const uAoEnabled = { value: 1.0 };
  mat.userData.aoUniforms = { uAoStrength, uAoEnabled };

  // Tiled-atlas uniforms (created only in tiled mode so the non-tiled userData
  // surface stays exactly as in Phase 1/2).
  let uTileSizeUV = null;
  let uTileInset = null;
  if (tiled) {
    uTileSizeUV = { value: 0.25 };     // tile span in UV space (16/64 default)
    uTileInset = { value: 0.5 / 64 };  // half-texel anti-bleed inset
    const applyAtlasInfo = (info) => {
      const atlasPx = (info && info.atlasSizePx) || 64;
      const tilePx = (info && info.tileSizePx) || 16;
      const texel = (info && info.texelSize) || 1 / atlasPx;
      uTileSizeUV.value = tilePx / atlasPx;
      uTileInset.value = texel * 0.5;
    };
    applyAtlasInfo(atlasInfo);
    mat.userData.tileUniforms = { uTileSizeUV, uTileInset };
    mat.userData.setAtlasInfo = applyAtlasInfo;
  }

  mat.onBeforeCompile = (shader) => {
    // Re-link the shared uniform objects into this program's uniform set.
    shader.uniforms.uAoStrength = uAoStrength;
    shader.uniforms.uAoEnabled = uAoEnabled;
    if (tiled) {
      shader.uniforms.uTileSizeUV = uTileSizeUV;
      shader.uniforms.uTileInset = uTileInset;
    }

    // --- Vertex: declare the custom attribute + varying, forward it ----------
    // (vColor is already declared/forwarded by Three because vertexColors=true.)
    // In tiled mode also forward the greedy mesher's tileOrigin attribute.
    // Every replacement keeps the include marker so windsway (or any later
    // patcher) can still append after the same anchors.
    const vertexCommon = tiled
      ? '#include <common>\nattribute float ao;\nvarying float vAo;\nattribute vec2 tileOrigin;\nvarying vec2 vTileOrigin;'
      : '#include <common>\nattribute float ao;\nvarying float vAo;';
    const vertexBegin = tiled
      ? '#include <begin_vertex>\n\tvAo = ao;\n\tvTileOrigin = tileOrigin;'
      : '#include <begin_vertex>\n\tvAo = ao;';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', vertexCommon)
      .replace('#include <begin_vertex>', vertexBegin);

    // --- Fragment: multiply AO into diffuseColor right after vColor is applied.
    const fragmentCommon = tiled
      ? '#include <common>\nvarying float vAo;\nuniform float uAoStrength;\nuniform float uAoEnabled;\nvarying vec2 vTileOrigin;\nuniform float uTileSizeUV;\nuniform float uTileInset;'
      : '#include <common>\nvarying float vAo;\nuniform float uAoStrength;\nuniform float uAoEnabled;';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', fragmentCommon)
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n\tdiffuseColor.rgb *= mix( 1.0, clamp( vAo, 0.0, 1.0 ), uAoStrength * uAoEnabled );'
      );

    // --- Fragment (tiled only): per-block tile repeat for greedy quads -------
    // vMapUv carries the greedy mesher's LOCAL 0..W/0..H coords (mapTransform
    // is identity on the atlas texture); fract() wraps it into one tile, then
    // the half-texel inset maps it into the safe interior of the tile rect —
    // the exact rect voxelMesher would have baked per-face.
    if (tiled) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        [
          '#ifdef USE_MAP',
          '\tvec2 vxlTileUv = vTileOrigin + vec2( uTileInset ) + fract( vMapUv ) * ( uTileSizeUV - 2.0 * uTileInset );',
          '\tvec4 sampledDiffuseColor = texture2D( map, vxlTileUv );',
          '\tdiffuseColor *= sampledDiffuseColor;',
          '#endif',
        ].join('\n')
      );
    }
  };

  // Tiled materials need an explicit program cache key: the hook above has the
  // same source for tiled and non-tiled instances (the flag is closed over),
  // and Three's default customProgramCacheKey is onBeforeCompile.toString() —
  // without this, a tiled and a non-tiled material with matching state would
  // share one compiled program. Non-tiled materials deliberately keep the
  // prototype default (Phase 1/2 regression-free; windsway's "has own cache
  // key" detection also behaves exactly as before for them).
  if (tiled) {
    mat.customProgramCacheKey = function () {
      return 'graphicslab-voxel|tiled';
    };
  }

  // Runtime setters -----------------------------------------------------------
  mat.userData.setAoStrength = (s) => {
    uAoStrength.value = typeof s === 'number' ? s : 1.0;
  };
  mat.userData.setAoEnabled = (on) => {
    uAoEnabled.value = on ? 1.0 : 0.0;
  };
  mat.userData.setMap = (tex) => {
    mat.map = tex || null;
    mat.needsUpdate = true; // USE_MAP define changes -> recompile
  };

  return mat;
}

export default createVoxelMaterial;
