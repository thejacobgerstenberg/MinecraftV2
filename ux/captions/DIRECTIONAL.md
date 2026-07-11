# Loomfall captions — directional indicator spec

How `<lf-captions>` renders the `direction` field of `lf-audio-event`
(`"left" | "right" | "behind" | "front" | null`). The game shell computes the
value from the sound's world position vs. the listener transform
(`engine.setListener(pos, forward)`); the overlay only ever renders it.

A direction is shown **only when both** are true:

1. the matched caption entry has `"directional": true` (captions.json), and
2. the event carried a recognized `direction` value.

Ambient beds, UI sounds and music never show chevrons (their entries are
non-directional), even if a stray `direction` arrives.

## Glyphs

Plain text chevrons (no font dependency, present in every system stack),
always wrapped in `aria-hidden="true"` spans — screen readers get words
instead (see below).

| direction | glyph | placement in the line            | line alignment in the caption column |
|-----------|-------|----------------------------------|--------------------------------------|
| `left`    | ◀     | leading (before the text)        | hugs the LEFT edge (`align-self: flex-start`) |
| `right`   | ▶     | trailing (after the text)        | hugs the RIGHT edge (`align-self: flex-end`)  |
| `behind`  | ▼     | BOTH edges (leading + trailing)  | centered (`align-self: center`)      |
| `front`   | ▲     | BOTH edges (leading + trailing)  | centered (`align-self: center`)      |

Rationale:

- **Screen-edge position doubles the cue.** The chevron shape says the
  direction; the whole line also physically nudges toward that side of the
  caption column, so direction survives small text sizes and is legible at a
  glance in peripheral vision. Two independent cues, neither of them hue.
- **behind/front are symmetric** (no left/right component), so they wear the
  chevron on both edges and stay centered. ▼ points "down/off-screen" =
  behind the camera; ▲ points "up/into the screen" = ahead.
- Non-directional lines keep the column's default alignment (the docked
  corner's edge), so directional lines visibly stand out from the stack.

## Screen readers

The visible list is `aria-hidden`; a visually-hidden `aria-live="polite"`
region mirrors each caption with a spoken suffix instead of glyphs:

| direction | spoken suffix       |
|-----------|---------------------|
| `left`    | ", to the left"     |
| `right`   | ", to the right"    |
| `behind`  | ", behind you"      |
| `front`   | ", ahead"           |

Example: `mob.exploder.idle` from the left announces as
"Hissing — it will burst!, to the left".

## Color

Chevrons render in `--lf-pair-dark-hud-fg` (theme-independent HUD foreground
on the dark caption card). They carry no category color on purpose: category
is the icon's job, direction is shape + position only.
