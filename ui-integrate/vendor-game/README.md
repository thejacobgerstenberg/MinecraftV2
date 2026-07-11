# vendor-game

Genuine unmodified copies of the builder's UI modules from
`feat/voxel-sandbox-game@71689cf` and brand wordmark from `feature/brand`,
vendored ONLY so the proof demo can render the real HUD headless. Do NOT edit;
the real integration targets the builder's files in place.

## Source SHAs

- UI + blocks + naming + stylesheet: `feat/voxel-sandbox-game` @ `71689cf`
- Brand wordmark: `feature/brand` @ `d8f96a28c2b96fe1f6e8d79531d50cd218670a0f`

## Copied

From `feat/voxel-sandbox-game@71689cf`:

- `public/src/ui/hud.js`       -> `src/ui/hud.js`
- `public/src/ui/hotbar.js`    -> `src/ui/hotbar.js`
- `public/src/ui/inventory.js` -> `src/ui/inventory.js`
- `public/src/ui/chat.js`      -> `src/ui/chat.js`
- `public/src/ui/debug.js`     -> `src/ui/debug.js`
- `public/src/ui/menu.js`      -> `src/ui/menu.js`
- `public/src/blocks/blocks.js`   -> `src/blocks/blocks.js`
- `public/src/systems/naming.js`  -> `src/systems/naming.js`
- `public/css/style.css`       -> `css/style.css`

From `feature/brand@d8f96a2`:

- `brand/logo/wordmark-dark.svg`  -> `brand/wordmark-dark.svg`
- `brand/logo/wordmark-light.svg` -> `brand/wordmark-light.svg`

## Import closure

Verified by grep. `hotbar.js` and `inventory.js` import `getBlockDef` from
`blocks/blocks.js` and `blockDisplayName` from `systems/naming.js` (both
copied and both leaf modules with no further local imports). `hud.js`,
`chat.js`, `debug.js`, and `menu.js` are leaf DOM modules with no imports.
No module imports three.js; the closure is fully self-contained.
