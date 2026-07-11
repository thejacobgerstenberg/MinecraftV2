// Voxelheim — voxel raycast (PURE module: no three.js import, plain
// {x,y,z} objects, runs under plain node for tests).
//
// Amanatides & Woo "A Fast Voxel Traversal Algorithm" DDA.

import { getBlockDef } from '../blocks/blocks.js';

/** Blocks the crosshair can target: anything solid (leaves and glass are
 *  solid:true so they are included) plus the portal block (id 29). Liquids
 *  and air are skipped. */
function isHittable(id) {
  const def = getBlockDef(id);
  return def.solid || def.id === 29;
}

/** Distance along the ray from `s` to the next integer boundary, in units
 *  of t (where position = s + t*ds). */
function intBound(s, ds) {
  if (ds === 0) return Infinity;
  if (ds > 0) return (Math.floor(s) + 1 - s) / ds;
  return (s - Math.floor(s)) / -ds;
}

/**
 * Cast a ray through the voxel grid and return the first hittable block.
 *
 * @param {{getBlock:(x:number,y:number,z:number)=>number}} world
 * @param {{x:number,y:number,z:number}} origin  ray start (world units)
 * @param {{x:number,y:number,z:number}} dir     ray direction (normalized internally)
 * @param {number} [maxDist=6]                   maximum distance in blocks
 * @returns {{hit:boolean, x?:number, y?:number, z?:number,
 *            nx?:number, ny?:number, nz?:number, face?:string|null}}
 *   hit        — whether a block was hit within maxDist
 *   (x,y,z)    — integer coords of the solid block hit
 *   (nx,ny,nz) — the adjacent (empty) cell for placement, i.e. hit cell +
 *                face normal
 *   face       — which face of the block was entered: '+x','-x','+y','-y',
 *                '+z','-z'. A ray travelling straight down enters the top
 *                face → '+y'.
 *
 * Origin-inside-a-solid-block behavior (documented choice): if the cell
 * containing `origin` is itself hittable, the ray returns hit:true on that
 * cell immediately with face:null, and (nx,ny,nz) is the neighboring cell
 * stepped BACKWARD along the dominant axis of `dir` (toward the viewer), so
 * placement never targets the cell ahead of a buried camera.
 */
export function raycastVoxel(world, origin, dir, maxDist = 6) {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (!(len > 0)) return { hit: false };
  const dx = dir.x / len, dy = dir.y / len, dz = dir.z / len;

  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  // Origin inside a hittable block.
  if (isHittable(world.getBlock(x, y, z))) {
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    let nx = x, ny = y, nz = z;
    if (ax >= ay && ax >= az) nx -= Math.sign(dx) || 1;
    else if (ay >= az) ny -= Math.sign(dy) || 1;
    else nz -= Math.sign(dz) || 1;
    return { hit: true, x, y, z, nx, ny, nz, face: null };
  }

  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const stepZ = Math.sign(dz);

  let tMaxX = intBound(origin.x, dx);
  let tMaxY = intBound(origin.y, dy);
  let tMaxZ = intBound(origin.z, dz);

  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dz);

  // Face normal of the last boundary crossed (points back toward the ray).
  let normX = 0, normY = 0, normZ = 0;

  for (;;) {
    // Step across the nearest boundary.
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      if (tMaxX > maxDist) return { hit: false };
      x += stepX; tMaxX += tDeltaX;
      normX = -stepX; normY = 0; normZ = 0;
    } else if (tMaxY <= tMaxZ) {
      if (tMaxY > maxDist) return { hit: false };
      y += stepY; tMaxY += tDeltaY;
      normX = 0; normY = -stepY; normZ = 0;
    } else {
      if (tMaxZ > maxDist) return { hit: false };
      z += stepZ; tMaxZ += tDeltaZ;
      normX = 0; normY = 0; normZ = -stepZ;
    }

    if (isHittable(world.getBlock(x, y, z))) {
      const face =
        normX !== 0 ? (normX > 0 ? '+x' : '-x') :
        normY !== 0 ? (normY > 0 ? '+y' : '-y') :
                      (normZ > 0 ? '+z' : '-z');
      return {
        hit: true,
        x, y, z,
        nx: x + normX, ny: y + normY, nz: z + normZ,
        face,
      };
    }
  }
}
