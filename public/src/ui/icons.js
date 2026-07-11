// Loomfall — block icons for the hotbar / inventory UI (integration phase).
//
// makeIconFactory(atlas) returns an `iconFor(blockId) -> HTMLCanvasElement`
// function that crops the block's side (or top) tile out of the live texture
// atlas canvas into a small 32x32 canvas, cached per block id.
//
// iconFor.invalidate() clears the cache — call it after a texture-pack
// hot-swap redraws the atlas canvas, then re-set the hotbar/inventory slots
// so they re-render with fresh crops.

import { getBlockDef, tileForFace } from '../blocks/blocks.js';

const ICON_PX = 32;

export function makeIconFactory(atlas) {
  /** @type {Map<number, HTMLCanvasElement>} */
  const cache = new Map();

  function iconFor(blockId) {
    const cached = cache.get(blockId);
    if (cached) return cached;

    const def = getBlockDef(blockId);
    if (!def || def.id === 0) return null;
    const tile = tileForFace(def, 'side') ?? tileForFace(def, 'top');
    if (!tile) return null;

    const i = atlas.tileIndex(tile);
    const px = atlas.tilePx;
    const sx = (i % atlas.cols) * px;
    const sy = Math.floor(i / atlas.cols) * px;

    const canvas = document.createElement('canvas');
    canvas.width = ICON_PX;
    canvas.height = ICON_PX;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(atlas.canvas, sx, sy, px, px, 0, 0, ICON_PX, ICON_PX);

    cache.set(blockId, canvas);
    return canvas;
  }

  iconFor.invalidate = () => cache.clear();
  return iconFor;
}
