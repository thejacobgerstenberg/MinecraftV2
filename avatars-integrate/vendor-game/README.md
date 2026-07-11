# vendor-game

Genuine, unmodified copies of the builder's modules from `feat/voxel-sandbox-game@71689cf`, vendored ONLY so the proof demo can import the real code headless. Do NOT edit these; the real integration targets the builder's files in place.

Source SHA: `71689cf` (branch `feat/voxel-sandbox-game`)

Copied (preserving the `public/src/` layout under `src/`):

- `public/src/net/NetClient.js`   -> `src/net/NetClient.js`
- `public/src/ui/chat.js`         -> `src/ui/chat.js`
- `public/src/engine/World.js`    -> `src/engine/World.js`
- `public/src/engine/Chunk.js`    -> `src/engine/Chunk.js`
- `public/src/constants.js`       -> `src/constants.js`
- `public/src/blocks/blocks.js`   -> `src/blocks/blocks.js`

Import closure: `World.js` imports `../constants.js` and `./Chunk.js`; `Chunk.js` imports `../constants.js`; `NetClient.js`, `chat.js`, `blocks.js`, and `constants.js` are leaf modules with no local imports. All six are three-free (no `three` import), so they run under plain node.
