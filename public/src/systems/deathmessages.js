// Loomfall — death message templating (content/deathmessages.json).
//
// PURE-ish module (fetch only, no DOM/three). Loads the canonical death
// message table once and picks a random message for a cause id, templating
// {player}. Cause ids follow deathmessages.json: 'fall', 'lava', 'drowning',
// 'explosion', 'void_unravel', 'mob:<canonicalId>' (bestiary entity ids),
// etc. Unknown causes fall back to a canon-toned generic line.

const FALLBACK_MESSAGES = [
  '{player} was unpicked, and will be re-stitched at their knot.',
  '{player} came loose from the pattern. The Loom did not pause.',
];

let table = null; // cause -> [messages]
let loadPromise = null;

export function loadDeathMessages(url = '/content/deathmessages.json') {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      if (typeof fetch !== 'function') return false;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      const data = await res.json();
      table = {};
      for (const entry of data.deathMessages || []) {
        if (entry && entry.cause && Array.isArray(entry.messages) && entry.messages.length) {
          table[entry.cause] = entry.messages;
        }
      }
      return true;
    } catch (err) {
      console.warn('[loomfall] deathmessages.json unavailable — fallback lines used:',
        err && err.message);
      return false;
    }
  })();
  return loadPromise;
}

/**
 * A random death message for `cause`, with {player} templated in.
 * @param {string} cause  e.g. 'mob:waxling', 'void_unravel', 'fall'
 * @param {string} playerName
 */
export function deathMessageFor(cause, playerName) {
  const pool = (table && table[cause]) || FALLBACK_MESSAGES;
  const msg = pool[Math.floor(Math.random() * pool.length)] || FALLBACK_MESSAGES[0];
  return msg.replace(/\{player\}/g, String(playerName || 'A Mender'));
}
