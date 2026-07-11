// graphics-lab/src/voxelMaterial.js
//
// createVoxelMaterial({ transparent = false }) -> THREE.MeshStandardMaterial
//
// A standard PBR material tuned for the voxel chunk: rough, non-metallic, driven
// by the geometry's per-vertex `color` attribute. It is patched via
// onBeforeCompile to read the mesher's custom `ao` attribute and MULTIPLY it
// into the diffuse albedo (affecting both the direct and indirect diffuse terms)
// so crevices darken. Because it stays a MeshStandardMaterial, Three.js shadows
// and fog keep working — the injection only touches diffuseColor right after the
// vertex color is applied.
//
// Runtime knobs (no re-mesh needed):
//   material.userData.setAoStrength(s)   // 0..1+, blends AO in/out (default 1)
//   material.userData.setAoEnabled(bool) // hard on/off (default on)
//   material.userData.aoUniforms         // { uAoStrength, uAoEnabled } uniforms
//
// Both are backed by uniform objects that are re-linked on every (re)compile, so
// changing them after the shader has been built still takes effect.

import * as THREE from 'three';

export function createVoxelMaterial({ transparent = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.95,
    metalness: 0.0,
    vertexColors: true,   // geometry provides per-vertex face color
    flatShading: false,   // normals are already per-face; smooth shading is fine
    transparent,
    // Leaves: keep an alpha cutout so future cutout-textured foliage works, and
    // render them slightly see-through. Solid material stays fully opaque.
    opacity: transparent ? 0.85 : 1.0,
    alphaTest: transparent ? 0.5 : 0.0,
    depthWrite: transparent ? false : true,
    side: THREE.FrontSide,
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

  return mat;
}

export default createVoxelMaterial;
