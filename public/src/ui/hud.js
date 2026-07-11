// Voxelheim UI — HUD: crosshair, health shards, block-break progress.
//
// Pure DOM module: no three.js import. All DOM access happens inside
// initHUD(), so the module is safe to import under plain node.
//
// API:
//   initHUD() -> { showCrosshair(b), setHealth(halfShards0to20), setBreakProgress(p) }
//     showCrosshair(bool)      — toggles the center crosshair.
//     setHealth(0..20)         — 10 "vitality shard" gems, 2 half-units each
//                                (original geometric crystal icons, full /
//                                half / empty states; row pulses when <= 6).
//     setBreakProgress(0..1|null) — progress bar under the crosshair;
//                                null/undefined hides it.

const SHARD_COUNT = 10;

// Original kite-shaped crystal. Facet + glint give it a gem read without
// resembling any existing game's heart sprite.
const SHARD_SVG = `
<svg viewBox="0 0 20 24" class="shard-svg" aria-hidden="true">
  <path class="shard-bg"    d="M10 1 L18 8 L10 23 L2 8 Z"/>
  <g class="shard-full-g">
    <path class="shard-body"  d="M10 1 L18 8 L10 23 L2 8 Z"/>
    <path class="shard-facet" d="M10 1 L2 8 L10 23 Z"/>
    <path class="shard-glint" d="M8 4.5 L11 6.5 L9.4 9.4 L6.6 7.4 Z"/>
  </g>
  <path class="shard-rim" d="M10 1 L18 8 L10 23 L2 8 Z"/>
</svg>`;

export function initHUD() {
  let root = document.getElementById('hud');
  if (!root) {
    root = document.createElement('div');
    root.id = 'hud';
    document.body.appendChild(root);
  }
  root.classList.add('hud');
  root.textContent = '';

  // --- Crosshair -----------------------------------------------------------
  const crosshair = document.createElement('div');
  crosshair.className = 'crosshair';
  root.appendChild(crosshair);

  // --- Break progress bar --------------------------------------------------
  const breakBar = document.createElement('div');
  breakBar.className = 'break-bar';
  const breakFill = document.createElement('div');
  breakFill.className = 'break-fill';
  breakBar.appendChild(breakFill);
  root.appendChild(breakBar);

  // --- Health shards -------------------------------------------------------
  const health = document.createElement('div');
  health.className = 'health';
  const shards = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    const s = document.createElement('span');
    s.className = 'shard shard--full';
    s.innerHTML = SHARD_SVG;
    health.appendChild(s);
    shards.push(s);
  }
  root.appendChild(health);

  function showCrosshair(b) {
    crosshair.classList.toggle('crosshair--hidden', !b);
  }

  function setHealth(halfShards) {
    const h = Math.max(0, Math.min(20, Math.round(Number(halfShards) || 0)));
    for (let i = 0; i < SHARD_COUNT; i++) {
      const s = shards[i];
      s.classList.remove('shard--full', 'shard--half', 'shard--empty');
      if (h >= (i + 1) * 2) s.classList.add('shard--full');
      else if (h === i * 2 + 1) s.classList.add('shard--half');
      else s.classList.add('shard--empty');
    }
    health.classList.toggle('health--low', h > 0 && h <= 6);
  }

  function setBreakProgress(p) {
    if (p == null || Number.isNaN(Number(p))) {
      breakBar.classList.remove('break-bar--show');
      breakFill.style.width = '0%';
      return;
    }
    const v = Math.max(0, Math.min(1, Number(p)));
    breakBar.classList.add('break-bar--show');
    breakFill.style.width = `${(v * 100).toFixed(1)}%`;
  }

  showCrosshair(true);
  setHealth(20);
  setBreakProgress(null);
  return { showCrosshair, setHealth, setBreakProgress };
}
