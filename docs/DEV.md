# Loomfall — developer / QA reference

Working title in code comments: "Voxelheim". User-facing name: **Loomfall**.

## Running

```sh
npm install
PORT=3000 node server/index.js   # serves public/ + /ws + /api/worlds
```

Open `http://localhost:3000`. Worlds persist to `saves/<id>.json`.

## Node test suites (all plain node, exit 0 = pass)

```sh
node tests/worldgen.test.mjs
node tests/mesher.test.mjs
node tests/physics.test.mjs
node tests/raycast.test.mjs
node tests/net.test.mjs
```

## QA hook: `window.__game`

`window.__game` is `null` on the title screen and an object while a game
session is active. It is re-published (same shape, some fresh references)
after a dimension switch. **Every field is a live production object — there
are no test doubles.**

| Hook | Type | Notes |
| --- | --- | --- |
| `__game.version` | string | game version, e.g. `"0.1.0"` |
| `__game.player` | `Player` | `position` (AABB min corner / feet), `velocity`, `onGround`, `flying`, `health`, `respawn()`, `toggleFlight()` |
| `__game.world` | `World` | `getBlock(x,y,z)`, `setBlock(x,y,z,id)`, `dirtyChunks`. **Replaced on dimension switch** |
| `__game.controls` | `Controls` | `yaw`, `pitch`, `sensitivity`, `input` flags, `_debugSetLocked(true)` test hook (makes `isLocked` true so mouse break/place fire headlessly), `_emit(name, ...)` fires the same production handlers the DOM events use (`'break'`, `'place'`, `'togglePause'`, `'toggleInventory'`, `'openChat'`, `'toggleDebug'`, `'selectSlot'`, `'scroll'`, `'toggleFlight'`) |
| `__game.inventory` | `Inventory` | `slots[9]`, `selected`, `selectedBlock`, `select(i)`, `cycle(dir)`, `setSlot(i,id)` |
| `__game.net` | `NetClient` | `selfId`, `connected`, `sendChat/sendEdit/sendMove`, `close()` |
| `__game.chunkRenderer` | `ChunkRenderer` | `stats` -> `{chunksLoaded, queueLength}`; `materials.opaque.map.image` is the **live atlas canvas** (sample pixels to verify texture-pack hot-swap). **Replaced on dimension switch** |
| `__game.sky` | `Sky` | `group.visible` is false in nether/end |
| `__game.peers` | `PeerAvatars` | `count`, `ids`, per-peer avatar groups in the scene (`scene.getObjectByName('peer:<id>')`) |
| `__game.setDimension(dim)` | async fn | `'overworld' \| 'nether' \| 'end'` — full dimension switch (teardown meshes, regen world, respawn, fog/sky swap, net dim notify). No user-facing entry point yet; portals come next phase |
| `__game.ui.menus` | menus API | `showMain/showWorldSelect/showSettings/showPause/hideAll/setLoading/getSettings` |
| `__game.ui.chat` | chat API | `open/close/isOpen/addMessage({name,text,system})` |
| `__game.ui.hud` | HUD API | `showCrosshair(b)/setHealth(0..20)/setBreakProgress(p\|null)` |
| `__game.ui.debugOverlay` | debug API | `toggle/setVisible/setData` (F3 overlay) |
| `__game.ui.inventoryUI` | inventory screen API | `toggle/open/close/isOpen/setBlocks(ids)` |
| `__game.ui.hotbar` | hotbar API | `setSlots(ids)/setSelected(i)` |
| `__game.settings` | object | live settings `{renderDistance, fov, sensitivity, texturePack}` — **same reference for the whole page lifetime**; mutate via the settings menu, not directly |

### Recipes

```js
// Wait for the spawn area to be meshed
await page.waitForFunction(() => window.__game?.chunkRenderer.stats.chunksLoaded >= 9);

// Headless input: enable mouse handlers without real pointer lock
window.__game.controls._debugSetLocked(true);

// Aim the camera (Controls owns rotation; angles are radians)
const c = window.__game.controls;
c.yaw = 0; c.pitch = -0.8; c._applyCameraRotation();

// Break / place through the production path (same handlers as mousedown)
window.__game.controls._emit('break');
window.__game.controls._emit('place');

// Open the pause menu through the production path
window.__game.controls._emit('togglePause');

// Sample the live atlas canvas (texture-pack hot-swap check)
const img = window.__game.chunkRenderer.materials.opaque.map.image;
const px = img.getContext('2d').getImageData(0, 0, 1, 1).data.join(',');

// Switch dimension (QA/debug only until portals land)
await window.__game.setDimension('nether');
```

### Local storage keys

- `loomfall.settings` — persisted settings JSON.
- `loomfall.name` — multiplayer display name (default `Wanderer` + 3 digits,
  generated and persisted on first join).

### Notes for test authors

- Keyboard `KeyT` opens chat on a `setTimeout(0)` so the "t" keystroke is not
  typed into the input — `await` a frame before typing.
- Real pointer lock needs a user gesture; headless tests should use
  `_debugSetLocked(true)` and drive `page.mouse` / `_emit` instead.
- The day cycle is 10 real minutes starting at ~0.42 (late morning), so
  fresh worlds are in daylight for screenshots.
