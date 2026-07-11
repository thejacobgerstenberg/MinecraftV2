// graphics-lab/src/voxelMaterial.js
//
// createVoxelMaterial({ transparent = false, map = null, alphaTest = null })
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
// Runtime knobs (no re-mesh needed):
//   material.userData.setAoStrength(s)   // 0..1+, blends AO in/out (default 1)
//   material.userData.setAoEnabled(bool) // hard on/off (default on)
//   material.userData.aoUniforms         // { uAoStrength, uAoEnabled } uniforms
//   material.userData.setMap(tex|null)   // swap/remove the atlas at runtime
//
// The AO knobs are backed by uniform objects that are re-linked on every
// (re)compile, so changing them after the shader has been built still works.

import * as THREE from 'three';

export function createVoxelMaterial({ transparent = false, map = null, alphaTest = null } = {}) {
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

  mat.onBeforeCompile = (shader) => {
    // Re-link the shared uniform objects into this program's uniform set.
    shader.uniforms.uAoStrength = uAoStrength;
    shader.uniforms.uAoEnabled = uAoEnabled;

    // --- Vertex: declare the custom attribute + varying, forward it ----------
    // (vColor is already declared/forwarded by Three because vertexColors=true.)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float ao;\nvarying float vAo;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\tvAo = ao;'
      );

    // --- Fragment: multiply AO into diffuseColor right after vColor is applied.
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vAo;\nuniform float uAoStrength;\nuniform float uAoEnabled;'
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n\tdiffuseColor.rgb *= mix( 1.0, clamp( vAo, 0.0, 1.0 ), uAoStrength * uAoEnabled );'
      );
  };

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
