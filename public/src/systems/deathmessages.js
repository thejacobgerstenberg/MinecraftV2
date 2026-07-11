// Loomfall — death message templating (content/deathmessages.json).
//
// Thin adapter over the shared ContentPack (systems/contentpack.js): the
// pack loads and indexes the canonical death-message table; this module
// keeps the legacy export signatures so call sites (main.js contentReady +
// killPlayer) never move. Cause ids follow deathmessages.json: 'fall',
// 'lava', 'drowning', 'explosion', 'starvation', 'fire', 'cinderloom_heat',
// 'void_unravel', and 'mob:<canonicalId>' (bestiary entity ids). Unknown
// causes fall back to canon-toned generic lines inside the pack.

import { pack } from './contentpack.js';

/** Kick off (or join) the shared ContentPack load. Idempotent. */
export function loadDeathMessages() {
  return pack.load();
}

/**
 * A random death message for `cause`, with {player} templated in.
 * @param {string} cause  e.g. 'mob:waxling', 'void_unravel', 'fall', 'lava'
 * @param {string} playerName
 */
export function deathMessageFor(cause, playerName) {
  return pack.deathMessage(cause, { player: playerName || 'A Mender' });
}
