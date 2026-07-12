// Voxelheim directional face culling — skips the GPU's vertex work for
// axis-aligned faces that provably point away from the camera.
//
// Every face a chunk mesh emits is axis-aligned. A +x face (normal +1,0,0)
// can only be seen from eye.x > facePlaneX; if the eye is at or west of the
// chunk's west edge (eye.x <= chunk minX), EVERY +x face in the chunk is
// backfacing and the rasterizer would discard it — but only after paying
// full vertex-shader cost for it. Likewise a -y face (a cave ceiling) is
// only visible from below (eye.y < facePlaneY). On software rasterizers
// (SwiftShader) that vertex work dominates the frame, so we skip it up
// front with a single contiguous drawRange per chunk:
//
//   The index buffer is pre-sorted into 4 "quadrant" variants, each laid
//   out [hideable-X faces][hideable-Z faces][middle][-y faces by height,
//   highest first]. Per frame the renderer picks the variant matching the
//   eye's quadrant relative to the chunk, skips the leading segment(s), and
//   binary-searches the -y tail for the first face at or below the eye.
//   Same pixels, typically 30-45% fewer vertices submitted, zero extra draw
//   calls, zero re-uploads (all variants are uploaded once and reused).
//
// Visual equivalence: the skipped faces are exactly (a subset of) the faces
// GL back-face culling already discards, so the rendered image is identical.
// Not applicable to double-sided materials (the liquid bucket).
//
// Pure typed-array helpers — node-testable, no three.js dependency.

/**
 * Build the 4 quadrant index orderings for a chunk geometry.
 *
 * Faces are the mesher's consecutive 4-vertex groups with 6 indices each;
 * the face normal is read from the first vertex of each group.
 *
 * @param {Uint32Array|Uint16Array} index geometry index (length = faces*6)
 * @param {Float32Array} positions per-vertex positions (xyz)
 * @param {Float32Array} normals per-vertex normals (xyz)
 * @returns {{variants: Array<{index:Uint32Array|Uint16Array, xEnd:number,
 *   xzEnd:number}>, botStart:number, botYs:Float32Array}}
 *   variants[0] hides +x/+z, [1] +x/-z, [2] -x/+z, [3] -x/-z. Layout per
 *   variant: [0,xEnd) hideable X faces, [xEnd,xzEnd) hideable Z faces,
 *   [xzEnd,botStart) never-hideable middle, [botStart,length) -y faces
 *   sorted by face plane height DESCENDING (botYs holds those heights).
 */
export function buildDirectionalIndexVariants(index, positions, normals) {
  const faceCount = index.length / 6;
  // Classify: 0 +x, 1 -x, 2 +z, 3 -z, 4 +y/top, 5 -y/bottom.
  const cls = new Uint8Array(faceCount);
  const faceY = new Float32Array(faceCount); // -y face plane height
  for (let f = 0; f < faceCount; f++) {
    // The 4 vertices of a face share one normal; any index of the face
    // points into its own 4-vertex group, so the first one will do.
    const v0 = index[f * 6];
    const nx = normals[v0 * 3];
    const ny = normals[v0 * 3 + 1];
    const nz = normals[v0 * 3 + 2];
    if (nx > 0.5) cls[f] = 0;
    else if (nx < -0.5) cls[f] = 1;
    else if (nz > 0.5) cls[f] = 2;
    else if (nz < -0.5) cls[f] = 3;
    else if (ny > 0.5) cls[f] = 4;
    else {
      cls[f] = 5;
      faceY[f] = positions[v0 * 3 + 1]; // all 4 verts share the plane y
    }
  }

  // -y faces ordered by plane height, highest first (shared by variants).
  const botFaces = [];
  for (let f = 0; f < faceCount; f++) if (cls[f] === 5) botFaces.push(f);
  botFaces.sort((a, b) => faceY[b] - faceY[a]);
  const botYs = new Float32Array(botFaces.length);
  for (let i = 0; i < botFaces.length; i++) botYs[i] = faceY[botFaces[i]];
  const botStart = index.length - botFaces.length * 6;

  const variants = [];
  for (const [hx, hz] of [[0, 2], [0, 3], [1, 2], [1, 3]]) {
    const out = new index.constructor(index.length);
    let cursor = 0;
    const copyFace = (f) => {
      const src = f * 6;
      for (let i = 0; i < 6; i++) out[cursor + i] = index[src + i];
      cursor += 6;
    };
    const copyClass = (c) => {
      for (let f = 0; f < faceCount; f++) if (cls[f] === c) copyFace(f);
    };
    copyClass(hx);
    const xEnd = cursor;
    copyClass(hz);
    const xzEnd = cursor;
    for (const c of [0, 1, 2, 3, 4]) {
      if (c !== hx && c !== hz) copyClass(c);
    }
    for (const f of botFaces) copyFace(f); // height-sorted -y tail
    variants.push({ index: out, xEnd, xzEnd });
  }
  return { variants, botStart, botYs };
}

/**
 * Pick the variant + drawRange for an eye position and chunk bounds.
 *
 * @param {{variants:Array, botStart:number, botYs:Float32Array}} dir
 *   result of buildDirectionalIndexVariants
 * @param {number} eyeX @param {number} eyeY @param {number} eyeZ
 * @param {number} minX chunk west edge  @param {number} maxX east edge
 * @param {number} minZ chunk north edge @param {number} maxZ south edge
 * @param {number} indexLength total index count
 * @returns {{variant:number, start:number, count:number}}
 */
export function selectDirectionalRange(dir, eyeX, eyeY, eyeZ, minX, maxX, minZ, maxZ, indexLength) {
  // -y tail: hide faces whose plane is at or below the eye (visible only
  // from underneath). botYs is descending; find the first hidden face.
  const botYs = dir.botYs;
  let lo = 0;
  let hi = botYs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (botYs[mid] > eyeY) lo = mid + 1;
    else hi = mid;
  }
  const end = dir.botStart + lo * 6;

  // Which x/z-facing faces are provably backfacing?
  //   eye.x <= minX -> all +x faces; eye.x >= maxX -> all -x faces.
  const hideX = eyeX <= minX ? 0 : eyeX >= maxX ? 1 : -1;
  const hideZ = eyeZ <= minZ ? 2 : eyeZ >= maxZ ? 3 : -1;
  if (hideX === -1) {
    // Inside the chunk's x-slab: the hideable-X segment must be drawn, and
    // it leads the buffer, so no side segment can be skipped (Z-only
    // savings are given up — this is only the eye's own chunk row).
    return { variant: 0, start: 0, count: end };
  }
  const vi = (hideX === 1 ? 2 : 0) + (hideZ === 3 ? 1 : 0);
  const v = dir.variants[vi];
  const start = hideZ === -1 ? v.xEnd : v.xzEnd;
  return { variant: vi, start, count: end - start };
}
