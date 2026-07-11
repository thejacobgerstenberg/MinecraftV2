# ux/captions — Loomfall sound captions (subtitles)

Caption overlay for deaf/hard-of-hearing players (and muted play). Owned
files:

| file            | what it is |
|-----------------|------------|
| `captions.json` | The caption table. Validates against `ux/schemas/captions.schema.json`. Covers **all 66 engine keys** (verified programmatically) + the 5 `music.<mode>` shell pseudo-keys + reserved boss keys (below). |
| `captions.js`   | `<lf-captions>` custom element (+ exported `matchCaption`/`fillPlaceholders` helpers). Registered via the kit's `define()`. |
| `captions.css`  | Overlay styling — theme-independent `--lf-pair-dark-*`/brand tokens only (captions are a dark loom-room card in both themes, like the kit tooltip). |
| `DIRECTIONAL.md`| Normative spec for the direction chevrons + screen-edge alignment. |
| `demo.html`     | Live demo with §4 simulation buttons. Serve over http: `python3 -m http.server` from the repo root → `http://localhost:8000/ux/captions/demo.html`. |

## Wiring (what the game builder does)

1. Link `captions.css` (after tokens.css/base.css) and import `captions.js`.
2. Mount `<lf-captions corner="bottom-left" max-lines="3">` and assign the
   table: `el.captions = await (await fetch('.../captions.json')).json()`.
3. Emit the contract §4 event alongside every `engine.play()` /
   `engine.startMusic()`:
   `window.dispatchEvent(new CustomEvent('lf-audio-event', { detail: { name, direction, volume, loop, ended } }))`
   — music as `name: "music.<mode>"`, loop handles emit `{name, ended: true}`
   on stop.
4. Options integration (§5): when `subtitles === false`, unmount the element
   entirely (`el.remove()`); re-append to re-enable. The element does not
   read options storage itself. `html[data-lf-reduced-motion]` is honored by
   both CSS and the JS fade path.

## Behavior summary

- **Matching**: schema rules — `*` replaces exactly one dot-segment; most
  literal segments wins; tie → later array entry wins (broad rules first in
  the file, flavor overrides after). Unmatched sounds are silently ignored.
- **Placeholders**: `{material}`/`{mob}` fill from the matched wildcard
  segments via `DISPLAY_NAMES` (11 materials, 5 voice archetypes, boss ids;
  capitalized fallback).
- **Line budget**: `max-lines` (default 3). When full, the lowest-priority
  line (oldest among equals) is evicted if the newcomer's priority is >= its
  own; otherwise the newcomer is dropped. Alerts therefore replace ambient,
  never vice versa.
- **Repeats**: a sound already on screen refreshes in place (timer re-armed,
  direction updated) instead of stacking duplicates — footstep spam holds one
  line.
- **Loops**: `loop: true` lines are sticky until `{name, ended: true}`
  arrives, then linger `durationMs` before fading (schema's re-arm rule).
- **`volume: 0`** events are skipped (silent play). Other volumes are
  accepted but currently unused.
- **A11y**: visible list is `aria-hidden`; a visually-hidden polite live
  region mirrors every caption with spoken direction suffixes. Category =
  glyph shape + color (never hue alone); alert adds bold + warn hem;
  direction = chevron shape + edge position (never hue at all).

## Events emitted

- `lf-show` `{sound, text, category, direction, priority, refreshed}`
- `lf-dismiss` `{sound, reason: 'timeout'|'evicted'|'api'}`

## Boss cue naming (RESERVED — not yet in the audio engine)

The engine (audio/sfx/index.js) has **no** boss sound keys today: the Last
Needle voices through `mob.groaner.*` and its defeat plays `levelup` (both
already captioned). For the moment bosses gain dedicated telegraphs, this
table reserves the naming convention

```
boss.<bossId>.<cue>     bossId ∈ { molthkin, lastneedle }   cue ∈ { telegraph, defeated }
```

and already ships dormant entries for `boss.*.telegraph`, `boss.*.defeated`
and the four literal molthkin/lastneedle keys. They match nothing today
(unknown keys no-op in the engine and the shell never emits them), so they
are forward-compatible dead weight by design — the audio builder can adopt
the keys without touching this file.
