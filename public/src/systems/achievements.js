// Loomfall — achievements engine (content/achievements.json, read through
// the shared ContentPack when one is passed; direct fetch is the fallback).
//
// Listens to the game event bus (public/src/systems/events.js — event names
// documented in docs/DEV.md), matches events against the canonical trigger
// strings in achievements.json, persists the unlocked set + progress
// counters PER WORLD in localStorage, raises a slide-in toast (top-right,
// with the 'achievement' fanfare) on unlock, and renders an Achievements
// screen (reachable from the pause menu).
//
// ONLY achievements whose trigger can actually fire in today's build are
// wired ("wireable"); the rest stay visibly locked with no stub triggers.
// Wireability is computed from capability sets the caller passes in (which
// entities can be killed, which canonical item ids can be obtained, which
// canonical block ids can be placed) plus the fixed set of engine-emitted
// events. `stats()` reports wired vs total.
//
// Trigger grammar handled (see achievements.json):
//   first_block_broken               <- 'block:broken'
//   kill_entity:<canonicalId>        <- 'mob:killed' / 'boss:defeated'
//   player_unpicked                  <- 'player:died'
//   enter_dimension:<canonDim>       <- 'dimension:entered'
//   survive_first_night              <- 'night:survived'
//   collect_count:<itemId>:<n>       <- 'item:collected' (counter)
//   place_block:<canonId>            <- 'block:placed'
//   place_count:<canonId>:<n>        <- 'block:placed' (counter)
//   craft_item:<itemId>              <- 'item:crafted' (survival 2x2 grid;
//                                       wired only for recipes that FIT the
//                                       personal grid — caps.craftableItemIds)
// Everything else (crafting tables/full sets, trading, biomes, anchors,
// binding, taming, smelting, endings, ...) has no engine system yet and is
// NOT wired.

const STORAGE_PREFIX = 'loomfall.achievements.';
const TOAST_SECONDS = 4.5;

function el(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}

export function initAchievements({ bus, audio, pack = null, url = '/content/achievements.json', caps = {} } = {}) {
  const capability = {
    killableEntityIds: caps.killableEntityIds || new Set(),
    obtainableItemIds: caps.obtainableItemIds || new Set(),
    placeableCanonIds: caps.placeableCanonIds || new Set(),
    enterableDimensions: caps.enterableDimensions || new Set(['warpwold', 'cinderloom', 'nevermend']),
    // Item ids craftable in this build (2x2 personal grid). May be passed as
    // a FUNCTION returning a Set — it is resolved at load() time, after the
    // ContentPack recipes are available.
    craftableItemIds: caps.craftableItemIds || new Set(),
  };

  let defs = []; // achievements.json entries, in file order
  let byId = new Map();
  let wired = new Map(); // id -> matcher description (for stats/debug)
  let loadPromise = null;

  // Per-world state.
  let worldId = null;
  let unlocked = {}; // id -> ISO timestamp
  let counters = {}; // counterKey -> number

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  function storageKey() {
    return worldId ? STORAGE_PREFIX + worldId : null;
  }

  function loadWorldState() {
    unlocked = {};
    counters = {};
    const key = storageKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          if (data.unlocked && typeof data.unlocked === 'object') unlocked = data.unlocked;
          if (data.counters && typeof data.counters === 'object') counters = data.counters;
        }
      }
    } catch { /* corrupt/unavailable storage — start empty */ }
  }

  function persist() {
    const key = storageKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({ unlocked, counters }));
    } catch { /* storage unavailable — session-only */ }
  }

  // ---------------------------------------------------------------------
  // Trigger parsing / wireability
  // ---------------------------------------------------------------------

  /** Parse one trigger string -> matcher record or null (not wireable). */
  function parseTrigger(trigger) {
    if (trigger === 'first_block_broken') {
      return { kind: 'event', event: 'block:broken' };
    }
    if (trigger === 'player_unpicked') {
      return { kind: 'event', event: 'player:died' };
    }
    if (trigger === 'survive_first_night') {
      return { kind: 'event', event: 'night:survived' };
    }
    let m = /^kill_entity:(.+)$/.exec(trigger);
    if (m) {
      return capability.killableEntityIds.has(m[1])
        ? { kind: 'kill', entity: m[1] }
        : null;
    }
    m = /^enter_dimension:(.+)$/.exec(trigger);
    if (m) {
      return capability.enterableDimensions.has(m[1])
        ? { kind: 'dimension', dim: m[1] }
        : null;
    }
    m = /^collect_count:([^:]+):(\d+)$/.exec(trigger);
    if (m) {
      return capability.obtainableItemIds.has(m[1])
        ? { kind: 'count', counter: `collect:${m[1]}`, need: Number(m[2]) }
        : null;
    }
    m = /^place_block:(.+)$/.exec(trigger);
    if (m) {
      return capability.placeableCanonIds.has(m[1])
        ? { kind: 'place', canonId: m[1] }
        : null;
    }
    m = /^place_count:([^:]+):(\d+)$/.exec(trigger);
    if (m) {
      return capability.placeableCanonIds.has(m[1])
        ? { kind: 'count', counter: `place:${m[1]}`, need: Number(m[2]) }
        : null;
    }
    m = /^craft_item:(.+)$/.exec(trigger);
    if (m) {
      return capability.craftableItemIds.has(m[1])
        ? { kind: 'craft', itemId: m[1] }
        : null;
    }
    return null; // full sets/trading/biome/anchor/binding/... — no engine yet
  }

  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        let list;
        if (pack) {
          // Shared ContentPack: getters are sync after load, deep-frozen,
          // never throw ([] before load / on failure).
          await pack.load();
          list = pack.getAchievements();
        } else {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
          list = (await res.json()).achievements;
        }
        defs = Array.isArray(list) && list.length ? [...list] : [];
        if (defs.length === 0) throw new Error('no achievement definitions available');
        // Late-bound capability: craftable ids depend on the loaded recipes.
        if (typeof capability.craftableItemIds === 'function') {
          try {
            capability.craftableItemIds = capability.craftableItemIds() || new Set();
          } catch {
            capability.craftableItemIds = new Set();
          }
        }
        byId = new Map(defs.map((d) => [d.id, d]));
        wired = new Map();
        for (const d of defs) {
          const matcher = parseTrigger(String(d.trigger || ''));
          if (matcher) wired.set(d.id, matcher);
        }
        return true;
      } catch (err) {
        console.warn('[loomfall] achievements.json unavailable — achievements disabled:',
          err && err.message);
        defs = [];
        byId = new Map();
        wired = new Map();
        return false;
      }
    })();
    return loadPromise;
  }

  // ---------------------------------------------------------------------
  // Unlock + toast
  // ---------------------------------------------------------------------

  const toastRoot = el('div', 'achv-toasts', document.body);
  const toastQueue = [];
  let toastActive = false;

  function showNextToast() {
    if (toastActive || toastQueue.length === 0) return;
    toastActive = true;
    const def = toastQueue.shift();
    const toast = el('div', 'achv-toast', toastRoot);
    el('div', 'achv-toast-kicker', toast, 'Thread secured — achievement');
    el('div', 'achv-toast-name', toast, def.name);
    el('div', 'achv-toast-desc', toast, def.description || '');
    // Next frame: slide in.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      toast.classList.add('achv-toast--show');
    }));
    setTimeout(() => {
      toast.classList.remove('achv-toast--show');
      setTimeout(() => {
        toast.remove();
        toastActive = false;
        showNextToast();
      }, 450);
    }, TOAST_SECONDS * 1000);
  }

  function unlock(id) {
    if (!worldId || unlocked[id]) return;
    const def = byId.get(id);
    if (!def) return;
    unlocked[id] = new Date().toISOString();
    persist();
    toastQueue.push(def);
    showNextToast();
    if (audio && typeof audio.achievement === 'function') audio.achievement();
    if (screenOpen) renderScreen();
  }

  function bumpCounter(counterKey, by = 1) {
    counters[counterKey] = (counters[counterKey] || 0) + Math.max(1, by | 0);
    persist();
    // Check counter-driven achievements.
    for (const [id, matcher] of wired) {
      if (matcher.kind === 'count' && matcher.counter === counterKey
          && !unlocked[id] && (counters[counterKey] || 0) >= matcher.need) {
        unlock(id);
      }
    }
  }

  function fireEventMatchers(predicate) {
    if (!worldId) return;
    for (const [id, matcher] of wired) {
      if (!unlocked[id] && predicate(matcher)) unlock(id);
    }
  }

  // ---------------------------------------------------------------------
  // Bus wiring
  // ---------------------------------------------------------------------

  bus.on('block:broken', () => {
    fireEventMatchers((m) => m.kind === 'event' && m.event === 'block:broken');
  });
  bus.on('block:placed', (d) => {
    if (d && d.canonId) {
      fireEventMatchers((m) => m.kind === 'place' && m.canonId === d.canonId);
      bumpCounter(`place:${d.canonId}`);
    }
  });
  bus.on('item:collected', (d) => {
    if (d && d.itemId) bumpCounter(`collect:${d.itemId}`, d.count || 1);
  });
  bus.on('mob:killed', (d) => {
    if (d && d.canonicalId) {
      fireEventMatchers((m) => m.kind === 'kill' && m.entity === d.canonicalId);
    }
  });
  bus.on('boss:defeated', (d) => {
    // The manager names the achievement directly ('taught_to_mend'), and the
    // victory trigger doubles as a kill_entity trigger.
    if (d && d.achievement && byId.has(d.achievement)) unlock(d.achievement);
    if (d && d.canonicalId) {
      fireEventMatchers((m) => m.kind === 'kill' && m.entity === d.canonicalId);
    }
  });
  bus.on('player:died', () => {
    fireEventMatchers((m) => m.kind === 'event' && m.event === 'player:died');
  });
  bus.on('dimension:entered', (d) => {
    if (d && d.canonDim) {
      fireEventMatchers((m) => m.kind === 'dimension' && m.dim === d.canonDim);
    }
  });
  bus.on('night:survived', () => {
    fireEventMatchers((m) => m.kind === 'event' && m.event === 'night:survived');
  });
  bus.on('item:crafted', (d) => {
    if (d && d.itemId) {
      fireEventMatchers((m) => m.kind === 'craft' && m.itemId === d.itemId);
    }
  });
  // Events with no wired achievement today (kept flowing for future data):
  // 'portal:lit', 'chat:sent', 'pack:switched', 'world:created',
  // 'player:respawned', 'mob:drop'.

  // ---------------------------------------------------------------------
  // Achievements screen
  // ---------------------------------------------------------------------

  let screenRoot = null;
  let screenOpen = false;
  let onCloseCb = null;

  function ensureScreen() {
    if (screenRoot) return;
    screenRoot = el('div', 'overlay achv-overlay', document.body);
    const panel = el('div', 'vx-panel achv-panel', screenRoot);
    const head = el('div', 'achv-head', panel);
    el('h2', 'menu-h2', head, 'Achievements');
    screenRoot._countEl = el('div', 'achv-count', head, '');
    screenRoot._listEl = el('div', 'achv-list', panel);
    const nav = el('div', 'menu-buttons menu-buttons--row', panel);
    const back = el('button', 'vx-btn vx-btn--primary', nav, 'Back');
    back.type = 'button';
    back.addEventListener('click', () => closeScreen());
  }

  function renderScreen() {
    ensureScreen();
    const list = screenRoot._listEl;
    list.textContent = '';
    const total = defs.length;
    const got = defs.filter((d) => unlocked[d.id]).length;
    screenRoot._countEl.textContent = total
      ? `${got} / ${total} unlocked`
      : 'Achievement data unavailable.';
    // Group by tree, keeping file order.
    const trees = [];
    const byTree = new Map();
    for (const d of defs) {
      const tree = d.tree || 'Other';
      if (!byTree.has(tree)) {
        byTree.set(tree, []);
        trees.push(tree);
      }
      byTree.get(tree).push(d);
    }
    for (const tree of trees) {
      el('h3', 'achv-tree', list, tree);
      for (const d of byTree.get(tree)) {
        const isUnlocked = !!unlocked[d.id];
        const row = el('div', `achv-row${isUnlocked ? ' achv-row--unlocked' : ''}`, list);
        const mark = el('span', 'achv-mark', row, isUnlocked ? '✦' : '◇');
        mark.setAttribute('aria-hidden', 'true');
        const body = el('div', 'achv-body', row);
        if (!isUnlocked && d.hidden) {
          el('div', 'achv-name', body, '? ? ?');
          el('div', 'achv-desc', body, 'A thread still hidden in the weave.');
        } else {
          el('div', 'achv-name', body, d.name);
          el('div', 'achv-desc', body, d.description || '');
        }
      }
    }
  }

  function openScreen(onClose) {
    ensureScreen();
    onCloseCb = typeof onClose === 'function' ? onClose : null;
    renderScreen();
    screenOpen = true;
    screenRoot.classList.add('visible');
  }

  function closeScreen() {
    if (!screenRoot) return;
    screenOpen = false;
    screenRoot.classList.remove('visible');
    const cb = onCloseCb;
    onCloseCb = null;
    if (cb) cb();
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  return {
    load,
    setWorld(id) {
      worldId = id == null ? null : String(id);
      loadWorldState();
    },
    clearWorld() {
      worldId = null;
      unlocked = {};
      counters = {};
    },
    openScreen,
    closeScreen,
    isOpen: () => screenOpen,
    isUnlocked: (id) => !!unlocked[id],
    unlockedIds: () => Object.keys(unlocked),
    stats: () => ({ total: defs.length, wired: wired.size }),
    wiredIds: () => [...wired.keys()],
    /** QA helper: force-unlock (goes through the full toast/persist path). */
    _debugUnlock: (id) => unlock(id),
  };
}
