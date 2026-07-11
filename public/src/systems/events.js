// Loomfall — tiny game event bus (PURE module: no DOM, no three.js).
//
// A single page-lifetime pub/sub channel between gameplay code (main.js
// emits) and listeners such as the achievements engine. Event names and
// payloads are documented in docs/DEV.md ("Game event bus").
//
// API:
//   bus.on(name, fn)   -> unsubscribe function
//   bus.off(name, fn)
//   bus.emit(name, detail)  — synchronous fan-out; a throwing listener is
//                             isolated (logged once, never breaks gameplay).

function createBus() {
  const listeners = new Map(); // name -> Set<fn>
  let warned = false;

  return {
    on(name, fn) {
      if (typeof fn !== 'function') return () => {};
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(fn);
      return () => this.off(name, fn);
    },

    off(name, fn) {
      const set = listeners.get(name);
      if (set) set.delete(fn);
    },

    emit(name, detail = {}) {
      const set = listeners.get(name);
      if (!set || set.size === 0) return;
      for (const fn of [...set]) {
        try {
          fn(detail, name);
        } catch (err) {
          if (!warned) {
            warned = true;
            console.warn('[loomfall] event listener failed (further failures silenced):', err);
          }
        }
      }
    },
  };
}

/** The page-lifetime game event bus. */
export const gameEvents = createBus();

export { createBus };
