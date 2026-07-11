// audio/sfx/index.js
// Registry aggregator — merges all sound-family modules into one registry.

import blocks from "./blocks.js";
import footsteps from "./footsteps.js";
import environment from "./environment.js";
import ui from "./ui.js";

/**
 * Default-exported registry: key -> synth(ctx, out, when, opts) => {stop, duration}
 */
export default {
  ...blocks,
  ...footsteps,
  ...environment,
  ...ui,
};
