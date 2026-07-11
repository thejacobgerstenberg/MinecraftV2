# graphics-lab/settings — Graphics Settings Panel

A self-contained, dependency-free settings drawer (gear button + right-side
panel) for the MinecraftV2 graphics stack. Pure DOM ES module — **no three.js
import, no webfonts, no network**. State persists to `localStorage` and every
change is broadcast so renderer modules can react without ever touching the UI.

```
settings/
  settings.js    # ES module: createSettingsPanel(...)
  settings.css   # scoped styles (.mc2gs*) — load once per page
  preview.html   # standalone demo + live event log (screenshot/test target)
  README.md      # this file
```

Try it: serve `graphics-lab/` (`npm run serve`) and open
`http://localhost:8099/settings/preview.html`.

## Embedding

```html
<link rel="stylesheet" href="./settings/settings.css" />
```

```js
import { createSettingsPanel } from './settings/settings.js';

const panel = createSettingsPanel({
  mount: document.body,          // element or selector (default document.body)
  initial: { fov: 80 },          // seeds ONLY keys not yet in storage
  storageKey: 'mc2.graphics',    // default; JSON blob in localStorage
  onChange: (d) => applySetting(d.key, d.value, d.settings), // optional
  // startOpen: true,            // optional: open the drawer on create
});
```

Returned handle:

| member | behaviour |
|---|---|
| `element` | root `HTMLElement` (gear + drawer) |
| `get()` | shallow copy of the current settings object |
| `set(patch, { silent })` | apply + persist a patch; `silent: true` skips the event/callback. `set({ preset: 'high' })` expands the preset's toggle profile |
| `open()` / `close()` / `toggle()` | drawer control (Escape also closes) |
| `destroy()` | removes DOM + window listeners |

Also exported: `DEFAULTS`, `PRESETS`, `PRESET_ORDER`, `TOGGLE_KEYS`,
`FPS_CAPS`, `EVENT_NAME`.

### Subscribing to changes

Two equivalent paths — pick either (both always fire unless `silent`):

```js
window.addEventListener('graphics-settings-change', (e) => {
  const { key, value, settings } = e.detail;
  applySetting(key, value, settings);
});
```

On boot, replay the hydrated state once so the renderer matches storage:

```js
const s = panel.get();
for (const [key, value] of Object.entries(s)) applySetting(key, value, s);
```

### Preset semantics

Choosing Low/Medium/High/Ultra applies that preset's **effect-toggle profile**
(one change event per key that actually changed, plus `preset` itself).
Individually overriding a toggle afterwards flips the readout to **Custom**;
if the toggles come to match a preset exactly again it snaps back. Sliders,
FPS cap and VSync are never touched by presets.

| toggle | low | medium | high | ultra |
|---|---|---|---|---|
| ao (vertex) | on | on | on | on |
| ssao | — | on | on | on |
| shadows | — | on | on | on |
| water | — | on | on | on |
| bloom | — | on | on | on |
| godRays | — | on | on | on |
| windSway | — | on | on | on |
| particles | — | on | on | on |
| fog | on | on | on | on |
| biomeGrading | — | on | on | on |
| portalFx | — | on | on | on |

## Settings → graphics-lab hook mapping

`ctx`/module APIs per `graphics-lab/README.md`. "demo" rows are the
`window.demo` shims where they already exist.

| key | type / range | hook |
|---|---|---|
| `preset` | `'low'\|'medium'\|'high'\|'ultra'\|'custom'` | `demo.setQuality(v)` — fans out to `post.setQuality(v)`, `shadows.setQuality(v)`, `torchMgr.setMaxLights(QUALITY_LIGHTS[v])`. Skip when `'custom'` (individual toggles already applied) |
| `renderDistance` | 2–32 chunks | `chunkManager.setRenderDistance(v * 16)` (world units; 1 chunk = 16). Also stretch fog to match: `fog.setRange(v * 16 * 0.6, v * 16)` or scale `density ∝ 1 / (v * 16)` |
| `fov` | 60–110° | `camera.fov = v; camera.updateProjectionMatrix()` |
| `fpsCap` | `30\|60\|120\|0` (0 = uncapped) | render-loop throttle — snippet below |
| `vsync` | bool (advisory) | browsers always vsync `requestAnimationFrame`; treat as a hint (e.g. allow a `setTimeout` fallback loop when `false` + capped). No renderer hook |
| `ao` | bool | `demo.toggle('ao', v)` → `voxelMaterial.userData.setAoEnabled(v)` (uniform flip, no re-mesh) |
| `ssao` | bool | `demo.toggle('ssao', v)` → `postFX.toggle('ssao', v)` (src/ssao.js pass; quality-gated off at low) |
| `shadows` | bool | `demo.toggle('shadows', v)` → `shadowController.setEnabled(v)` |
| `water` | bool | `demo.toggle('water', v)` → `water.setEnabled(v)` + `underwaterOverlay.setEnabled(v)` |
| `bloom` | bool | `postFX.toggle('bloom', v)` |
| `godRays` | bool | `demo.toggle('godrays', v)` → `postFX.toggle('godrays', v)` (src/godrays.js pass; quality-gated off at low) |
| `windSway` | bool | `demo.toggle('wind', v)` → `getWindController().setEnabled(v)` (eases strength to 0) |
| `particles` | bool | `demo.toggle('particles', v)` → `particles.setEnabled(v)` |
| `fog` | bool | `demo.toggle('fog', v)` → `distanceFog.setEnabled(v)` (restores displaced `scene.fog`) |
| `biomeGrading` | bool | `demo.toggle('biome', v)` → `biomeGrading.setEnabled(v)` (neutral grade when off, biome remembered) |
| `portalFx` | bool | `demo.toggle('portal', v)` → `portalGate.setEnabled(v)` |

### FPS cap: render-loop throttle example

```js
let last = 0;
let settings = panel.get();
window.addEventListener('graphics-settings-change', (e) => { settings = e.detail.settings; });

function loop(now) {
  requestAnimationFrame(loop);           // schedule first — cap only skips work
  const cap = settings.fpsCap;           // 0 = uncapped
  if (cap > 0) {
    const interval = 1000 / cap;
    if (now - last < interval - 0.1) return;      // small epsilon vs timer jitter
    last = now - ((now - last) % interval);       // keep cadence drift-free
  }
  update();
  render();
}
requestAnimationFrame(loop);
```

### Dispatcher skeleton

```js
function applySetting(key, value, settings) {
  switch (key) {
    case 'preset':      if (value !== 'custom') demo.setQuality(value); break;
    case 'renderDistance': chunkManager.setRenderDistance(value * 16); break;
    case 'fov':         camera.fov = value; camera.updateProjectionMatrix(); break;
    case 'fpsCap': case 'vsync': break;             // read by the loop directly
    case 'ao':          demo.toggle('ao', value); break;
    case 'ssao':        demo.toggle('ssao', value); break;
    case 'shadows':     demo.toggle('shadows', value); break;
    case 'water':       demo.toggle('water', value); break;
    case 'bloom':       postFX.toggle('bloom', value); break;
    case 'godRays':     demo.toggle('godrays', value); break;
    case 'windSway':    demo.toggle('wind', value); break;
    case 'particles':   demo.toggle('particles', value); break;
    case 'fog':         demo.toggle('fog', value); break;
    case 'biomeGrading': demo.toggle('biome', value); break;
    case 'portalFx':    demo.toggle('portal', value); break;
  }
}
```

## Notes

- **Hydration order:** `DEFAULTS` ← `initial` ← stored JSON. Storage wins for
  keys it already has; `initial` only seeds unstored keys. The merged state is
  sanitized (ranges clamped, enums validated) and written back on create.
- **Persistence:** every accepted change writes the full JSON blob under
  `storageKey`. `localStorage` failures (private mode/quota) are swallowed —
  the panel still works in-memory.
- **Events:** one event per key that actually changed (a preset click can emit
  several). `detail.settings` is a fresh copy — safe to keep.
- **Styling:** everything is namespaced `.mc2gs*`; z-index 9000/9001. The gear
  is `position: fixed` top-right; override via `.mc2gs-gear` if it collides
  with an existing HUD.
- **No hot-path cost:** the panel does nothing per frame — it only reacts to
  user input. Renderer code should read from its own copy of the settings (as
  in the loop snippet), not call `panel.get()` per frame.
