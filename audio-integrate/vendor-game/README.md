# Vendored builder audio wrapper + block data

Genuine unmodified copies of the builder's GameAudio + blocks from
`feat/voxel-sandbox-game@804e736`, vendored ONLY so the proof can import the
real audio wrapper headless. GameAudio's `../../audio/engine.js` import is
remapped to the repo-root `/audio/` (the latest engine on this branch) via an
import-map prefix in the proof — do NOT edit these files.

SHA: `804e736dfe462a86e91bac73447578d58511b43d`

Copied:
- `public/src/audio/GameAudio.js` -> `src/audio/GameAudio.js`
- `public/src/blocks/blocks.js`   -> `src/blocks/blocks.js`
