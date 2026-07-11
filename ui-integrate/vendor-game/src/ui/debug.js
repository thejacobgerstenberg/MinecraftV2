// Voxelheim UI — debug overlay (F3): fps / position / chunk / biome / etc.
//
// Pure DOM module: no three.js import. All DOM access happens inside
// initDebug(), so the module is safe to import under plain node.
//
// API:
//   initDebug() -> { toggle(), setVisible(b), setData(partial) }
//     setData({fps, pos, chunk, dim, biome, facing, target, mobs, tris,
//              calls, chunks})
//       — merges the given fields into the current data and re-renders.
//         pos accepts {x,y,z} or [x,y,z]; chunk accepts {cx,cz}, {x,z} or
//         [cx,cz]; facing accepts a string or a yaw number (degrees).
//   Hidden by default (top-left translucent monospace block when visible).

const ROWS = [
  ['fps', 'FPS'],
  ['pos', 'XYZ'],
  ['chunk', 'Chunk'],
  ['dim', 'Dim'],
  ['biome', 'Biome'],
  ['facing', 'Facing'],
  ['target', 'Target'],
  ['mobs', 'Mobs'],
  ['tris', 'Tris'],
  ['calls', 'Calls'],
  ['chunks', 'Chunks'],
];

function fmtNum(v, digits = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function fmtInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
}

function fmtPos(pos) {
  if (pos == null) return '—';
  if (Array.isArray(pos)) return `${fmtNum(pos[0])} / ${fmtNum(pos[1])} / ${fmtNum(pos[2])}`;
  return `${fmtNum(pos.x)} / ${fmtNum(pos.y)} / ${fmtNum(pos.z)}`;
}

function fmtChunk(c) {
  if (c == null) return '—';
  if (Array.isArray(c)) return `${fmtInt(c[0])}, ${fmtInt(c[1])}`;
  const cx = c.cx ?? c.x;
  const cz = c.cz ?? c.z;
  return `${fmtInt(cx)}, ${fmtInt(cz)}`;
}

function fmtFacing(f) {
  if (f == null) return '—';
  if (typeof f === 'number') return `${f.toFixed(1)}°`;
  return String(f);
}

const FORMATTERS = {
  fps: (v) => (v == null ? '—' : fmtInt(v)),
  pos: fmtPos,
  chunk: fmtChunk,
  dim: (v) => (v == null ? '—' : String(v)),
  biome: (v) => (v == null ? '—' : String(v)),
  target: (v) => (v == null ? '—' : String(v)),
  mobs: (v) => (v == null ? '—' : fmtInt(v)),
  facing: fmtFacing,
  tris: (v) => (v == null ? '—' : fmtInt(v)),
  calls: (v) => (v == null ? '—' : fmtInt(v)),
  chunks: (v) => (v == null ? '—' : fmtInt(v)),
};

export function initDebug() {
  let root = document.getElementById('debug');
  if (!root) {
    root = document.createElement('div');
    root.id = 'debug';
    document.body.appendChild(root);
  }
  root.classList.add('debug');
  root.textContent = '';

  const title = document.createElement('div');
  title.className = 'dbg-title';
  title.textContent = 'Loomfall 0.1.0 [debug]';
  root.appendChild(title);

  const valueEls = {};
  for (const [key, label] of ROWS) {
    const line = document.createElement('div');
    line.className = 'dbg-line';
    const k = document.createElement('span');
    k.className = 'dbg-k';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'dbg-v';
    v.textContent = '—';
    line.append(k, v);
    root.appendChild(line);
    valueEls[key] = v;
  }

  let visible = false;
  const data = {};

  function render() {
    for (const [key] of ROWS) {
      valueEls[key].textContent = FORMATTERS[key](data[key]);
    }
  }

  function setVisible(b) {
    visible = !!b;
    root.classList.toggle('debug--visible', visible);
    if (visible) render();
  }

  function toggle() {
    setVisible(!visible);
  }

  function setData(partial) {
    if (partial && typeof partial === 'object') Object.assign(data, partial);
    if (visible) render();
  }

  setVisible(false);
  return { toggle, setVisible, setData };
}
