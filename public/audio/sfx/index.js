// audio/sfx/index.js
// Registry aggregator — merges all sound-family modules into one registry.

// Phase 1 families.
import blocks from "./blocks.js";
import footsteps from "./footsteps.js";
import environment from "./environment.js";
import ui from "./ui.js";
// Phase 2 families.
import weather from "./weather.js";
import mobs from "./mobs.js";
import materials2 from "./materials2.js";
import extras from "./extras.js";

/**
 * Default-exported registry: key -> synth(ctx, out, when, opts) => {stop, duration}
 */
export default {
  ...blocks,
  ...footsteps,
  ...environment,
  ...ui,
  ...weather,
  ...mobs,
  ...materials2,
  ...extras,
};
