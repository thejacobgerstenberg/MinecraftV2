# Vendored builder modules — provenance

Source branch: `origin/feat/voxel-sandbox-game`
Branch head at vendoring time: **`98c7ea912c0241e5672d42750735f10010c7747a`**
Vendoring method: `git show origin/feat/voxel-sandbox-game:<path> > graphics-lab/integration/builder/<path>`
— **byte-exact, zero modifications** (git blob SHAs verified identical below).

| Vendored file (relative to `builder/`) | git blob SHA (branch == copy) |
| --- | --- |
| `public/src/constants.js` | `3037effdea699034ef4ee9e0ea48594982e917b8` |
| `public/src/blocks/blocks.js` | `f0d735c4eb73331d5d75a5c57834b64ffaec339a` |
| `public/src/world/noise.js` | `e38678f768438aae0715039360d45b82456a4b38` |
| `public/src/world/TerrainGenerator.js` | `85a671fef507b71b55fa81b74447559705834c2c` |

These four files are the full transitive import closure of the builder's world
generator: `TerrainGenerator.js` imports `../constants.js`, `../blocks/blocks.js`
and `./noise.js`; none of them import `three` or any other bare specifier
(the generator is documented as a "PURE module ... must run under plain node").
The original `public/src/` directory layout is preserved under `builder/` so
every relative import resolves unchanged — no importmap entries and no adapter
shims were needed for the vendored code.

Do not edit these files. To refresh them, re-run the `git show` commands above
against a newer branch head and update the SHAs in this table.
