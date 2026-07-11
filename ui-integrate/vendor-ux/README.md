# vendor-ux

Genuine unmodified copies of the ux-access package from feature/ux-access@2f4314f
(PR #17), vendored ONLY so the proof can mount them headless. Their
`../../ui-kit/` imports are remapped to the repo-root ui-kit via an import-map
prefix in the demo — do NOT edit these files.

Source SHA: `2f4314f` (origin/feature/ux-access, PR #17)

## Import remap

From `ui-integrate/vendor-ux/ux/<sub>/mod.js` the modules import
`../../ui-kit/...`, which resolves to `ui-integrate/vendor-ux/ui-kit/`
(nonexistent by design). The demo's import map remaps the prefix
`/ui-integrate/vendor-ux/ui-kit/` -> `/ui-kit/` so they resolve to the real
ui-kit at the repo root. The distinct ui-kit specifiers used are:

- `../../ui-kit/lf-core.js`
- `../../ui-kit/components/button.js`
- `../../ui-kit/components/modal.js`
- `../../ui-kit/components/toast.js`
- `../../ui-kit/components/toggle.js`
- `../../ui-kit/components/slider.js`
- `../../ui-kit/components/dropdown.js`

## Copied

- ux/captions/captions.js
- ux/captions/captions.css
- ux/captions/captions.json
- ux/keybinds/keybinds.js
- ux/keybinds/keybinds.css
- ux/keybinds/bindings.default.json
- ux/options/access-options.js
- ux/options/access-options.css
- ux/options/options-store.js
- ux/options/colorblind.css
- ux/options/cvd.css
- ux/options/motion.css
- ux/onboarding/tutorial.js
- ux/onboarding/tutorial.css
- ux/onboarding/tutorial.json
- ux/schemas/bindings.schema.json
- ux/schemas/captions.schema.json
- ux/schemas/options.schema.json
