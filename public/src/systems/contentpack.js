/**
 * ContentPack — the Loomfall content/UX loader facade.
 *
 * Vendored VERBATIM from feature/content-integrate `content-integrate/loader.js`
 * (frozen API — see that branch's LOADER_API.md), with three builder-side
 * adaptations, each marked "BUILDER EXTENSION" below:
 *   1. UX files resolve to this repo's real layout (ux-access is already
 *      integrated under subdirectories): `ux/captions/captions.json`,
 *      `ux/keybinds/bindings.default.json`, `ux/onboarding/tutorial.json`.
 *   2. `GAME_GUIDE.md` is additionally loaded as raw text — `guide()` getter
 *      (the frozen API leaves .md files to the help panel; the builder routes
 *      the guide through the pack so ALL content reads one loaded snapshot).
 *   3. `naming()` getter exposing the indexed naming.json (the loader already
 *      parsed it but the frozen getter surface never handed it out).
 * A `pack` page-lifetime singleton is exported for module-scope consumers
 * (menu.js, deathmessages.js, naming.js); main.js joins `pack.load()` into
 * its `contentReady` barrier.
 *
 * Loader contract (unchanged):
 *   - one class, one idempotent async `load()`, synchronous getters after load
 *   - framework-free, zero dependencies, works in node >= 18 and the browser
 *   - all returned objects/arrays are deep-frozen
 *   - getters never throw — unknown ids return `null` (or `[]` / fallback
 *     strings where specified) and are recorded in `pack.warnings`
 *
 * Data sources (verbatim canon):
 *   `<baseUrl>/`  achievements.json, bestiary.json, books.json, boss.json,
 *                 molthkin.json, deathmessages.json, dialogue.json,
 *                 items.json, naming.json, splashes.json, structures.json,
 *                 tips.json (+ GAME_GUIDE.md, builder extension)
 *   `<uxUrl>/`    captions.json, bindings.default.json, tutorial.json
 *
 * Usage (browser):
 *   const pack = new ContentPack();            // '/content' + '/ux'
 *   await pack.load();
 *   pack.bestiary('spoolmare').husbandry.mountRequires; // 'saddle_frame'
 *
 * Usage (node / tests):
 *   const pack = new ContentPack({ basePath: './content' });   // fs-backed
 *   // or: new ContentPack({ baseUrl: dirA, uxUrl: dirB })     // fs-backed
 *   // or: new ContentPack({ files: { 'items.json': {...}, ... } })
 */

/** Content JSON basenames fetched from `baseUrl`. */
const CONTENT_FILES = [
  'achievements.json',
  'bestiary.json',
  'books.json',
  'boss.json',
  'molthkin.json',
  'deathmessages.json',
  'dialogue.json',
  'items.json',
  'naming.json',
  'splashes.json',
  'structures.json',
  'tips.json',
];

/** Raw-text content files fetched from `baseUrl` (BUILDER EXTENSION). */
const TEXT_FILES = ['GAME_GUIDE.md'];

/** UX JSON basenames fetched from `uxUrl`. */
const UX_FILES = ['captions.json', 'bindings.default.json', 'tutorial.json'];

/** BUILDER EXTENSION: basename -> actual path under `uxUrl` (this repo keeps
 *  the ux-access files in their original subdirectories). */
const UX_FILE_PATHS = {
  'captions.json': 'captions/captions.json',
  'bindings.default.json': 'keybinds/bindings.default.json',
  'tutorial.json': 'onboarding/tutorial.json',
};

/** Canon-toned inline fallback splashes (used before load / on failure). */
const FALLBACK_SPLASHES = Object.freeze([
  'The Loom keeps weaving!',
  'Every thread was somewhere first.',
  'Mind the fray.',
]);

/** Canon-toned fallback death lines (unknown cause / unloaded). */
const FALLBACK_DEATH_LINES = Object.freeze([
  '{player} came apart at a seam no one had thought to check.',
  'The Loom took {player} back into the weave, unfinished.',
]);

/**
 * Deep-freeze a JSON-shaped value in place and return it.
 * @param {*} value
 * @returns {*} the same value, recursively frozen
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Substitute `{name}` placeholders from `vars`; unknown placeholders are
 * left verbatim.
 * @param {string} text
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function template(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (whole, key) =>
    vars != null && vars[key] != null ? String(vars[key]) : whole
  );
}

export class ContentPack {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl='/content'] dir/URL serving the canon content JSON
   * @param {string} [options.uxUrl='/ux'] dir/URL serving captions.json / bindings.default.json / tutorial.json
   * @param {string} [options.basePath] single dir containing content JSONs and the ux files
   *   (convenience for node — sets both baseUrl and uxUrl)
   * @param {Record<string, object|string>} [options.files] preloaded map of
   *   basename -> parsed JSON (or JSON text); when given, no I/O happens
   * @param {typeof fetch} [options.fetchFn] injectable fetch for node/tests;
   *   when omitted, node reads local paths via fs and everything else uses
   *   global fetch
   * @param {() => number} [options.rng=Math.random] rng in [0,1) driving
   *   splash()/tip()/deathMessage()/book()/dialogueLine() picks
   */
  constructor({ baseUrl = '/content', uxUrl = '/ux', basePath, files, fetchFn, rng } = {}) {
    this._baseUrl = basePath != null ? basePath : baseUrl;
    this._uxUrl = basePath != null ? basePath : uxUrl;
    this._files = files || null;
    this._fetchFn = fetchFn || null;
    this._rng = typeof rng === 'function' ? rng : Math.random;

    /** @type {string[]} non-fatal issues: failed files, unknown-id lookups */
    this.warnings = [];

    this._loadPromise = null;
    this._loaded = false;

    // Domain state (populated by load(); getters degrade gracefully before).
    this._achievements = [];
    this._splashes = null; // string[] | null
    this._tips = null; // Array<{id,system,text}> | null
    this._deathByCause = new Map(); // cause -> string[] messages
    this._dialogue = null; // raw dialogue.json | null
    this._tutorialNarrator = null; // Array<{event,line}> | null
    this._books = [];
    this._booksByPlacement = new Map(); // structureId -> Book[]
    this._mobs = [];
    this._mobsById = new Map();
    this._items = [];
    this._itemsById = new Map();
    this._bosses = new Map(); // 'last_needle' | 'molthkin' -> BossEntry
    this._structures = [];
    this._structuresById = new Map();
    this._captionsExact = new Map(); // sound -> Caption
    this._captionWildcards = []; // [{ segments, literals, order, caption }]
    this._bindings = null; // Record<action, Binding> | null
    this._tutorial = null; // { version, beats } | null
    this._naming = null; // raw naming.json | null
    this._guide = null; // GAME_GUIDE.md raw markdown text | null (BUILDER EXTENSION)
  }

  // ------------------------------------------------------------- loading

  /**
   * Load every content/UX file in parallel. Idempotent — repeated calls
   * return the same promise. A missing/invalid file is tolerated: its domain
   * degrades to the documented fallback and the failure is recorded in
   * `warnings` and the result.
   * @returns {Promise<{ ok: boolean, loaded: string[], failed: string[] }>}
   */
  load() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoad();
    return this._loadPromise;
  }

  /** @returns {boolean} true once load() has settled (even partially) */
  isLoaded() {
    return this._loaded;
  }

  /** @private */
  async _doLoad() {
    const jobs = [
      ...CONTENT_FILES.map((name) => ({ name, dir: this._baseUrl })),
      ...TEXT_FILES.map((name) => ({ name, dir: this._baseUrl, text: true })),
      ...UX_FILES.map((name) => ({
        name, dir: this._uxUrl, path: UX_FILE_PATHS[name] || name,
      })),
    ];
    const results = await Promise.allSettled(
      jobs.map((job) => (job.text
        ? this._readText(job.dir, job.path || job.name)
        : this._readJson(job.dir, job.path || job.name, job.name)))
    );

    const loaded = [];
    const failed = [];
    const docs = {};
    results.forEach((res, i) => {
      const { name } = jobs[i];
      if (res.status === 'fulfilled') {
        docs[name] = res.value;
        loaded.push(name);
      } else {
        failed.push(name);
        this.warnings.push(
          `load: ${name} failed (${res.reason && res.reason.message ? res.reason.message : res.reason})`
        );
      }
    });

    this._index(docs);
    this._loaded = true;
    return { ok: failed.length === 0, loaded, failed };
  }

  /**
   * Read + parse one JSON file: preloaded map, injected fetchFn, node fs
   * (for non-URL paths), or global fetch — feature-detected in that order.
   * `key` is the basename used in a preloaded `files` map (defaults to the
   * relative path, which equals the basename for content files).
   * @private
   */
  async _readJson(dir, relPath, key = relPath) {
    if (this._files) {
      const raw = this._files[key];
      if (raw == null) throw new Error(`not in files map`);
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    return JSON.parse(await this._readRaw(dir, relPath));
  }

  /** Read one file as raw text (BUILDER EXTENSION, for GAME_GUIDE.md). @private */
  async _readText(dir, relPath) {
    if (this._files) {
      const raw = this._files[relPath];
      if (raw == null) throw new Error(`not in files map`);
      return String(raw);
    }
    return this._readRaw(dir, relPath);
  }

  /** Fetch/fs read one file to a string. @private */
  async _readRaw(dir, relPath) {
    const path = `${String(dir).replace(/\/+$/, '')}/${relPath}`;
    if (this._fetchFn) {
      const res = await this._fetchFn(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    }
    const isNode =
      typeof process !== 'undefined' && process.versions && process.versions.node;
    if (isNode && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      const fs = await import('node:fs/promises');
      return fs.readFile(path, 'utf8');
    }
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  /**
   * Build all by-id maps and lookup indexes from the parsed docs, then
   * deep-freeze everything that getters hand out.
   * @private
   */
  _index(docs) {
    if (docs['achievements.json'] && Array.isArray(docs['achievements.json'].achievements)) {
      this._achievements = deepFreeze(docs['achievements.json'].achievements);
    }
    if (docs['splashes.json'] && Array.isArray(docs['splashes.json'].splashes)) {
      this._splashes = deepFreeze(docs['splashes.json'].splashes);
    }
    if (docs['tips.json'] && Array.isArray(docs['tips.json'].tips)) {
      this._tips = deepFreeze(docs['tips.json'].tips);
    }
    if (docs['deathmessages.json'] && Array.isArray(docs['deathmessages.json'].deathMessages)) {
      for (const entry of deepFreeze(docs['deathmessages.json'].deathMessages)) {
        if (entry && entry.cause && Array.isArray(entry.messages)) {
          this._deathByCause.set(entry.cause, entry.messages);
        }
      }
    }
    if (docs['dialogue.json'] && typeof docs['dialogue.json'] === 'object') {
      this._dialogue = deepFreeze(docs['dialogue.json']);
      const tn = this._dialogue.tutorialNarrator;
      if (Array.isArray(tn)) this._tutorialNarrator = tn;
    }
    if (docs['books.json'] && Array.isArray(docs['books.json'].books)) {
      this._books = deepFreeze(docs['books.json'].books);
      for (const book of this._books) {
        for (const placement of Array.isArray(book.placement) ? book.placement : []) {
          if (!this._booksByPlacement.has(placement)) this._booksByPlacement.set(placement, []);
          this._booksByPlacement.get(placement).push(book);
        }
      }
    }
    if (docs['bestiary.json'] && Array.isArray(docs['bestiary.json'].mobs)) {
      this._mobs = deepFreeze(docs['bestiary.json'].mobs);
      for (const mob of this._mobs) this._mobsById.set(mob.id, mob);
    }
    if (docs['items.json'] && Array.isArray(docs['items.json'].items)) {
      this._items = deepFreeze(docs['items.json'].items);
      for (const item of this._items) this._itemsById.set(item.id, item);
    }
    if (docs['boss.json'] && docs['boss.json'].boss) {
      const boss = deepFreeze(docs['boss.json'].boss);
      this._bosses.set(boss.id || 'last_needle', boss);
    }
    if (docs['molthkin.json'] && docs['molthkin.json'].boss) {
      const boss = deepFreeze(docs['molthkin.json'].boss);
      this._bosses.set(boss.id || 'molthkin', boss);
    }
    if (docs['structures.json'] && Array.isArray(docs['structures.json'].structures)) {
      this._structures = deepFreeze(docs['structures.json'].structures);
      for (const s of this._structures) this._structuresById.set(s.id, s);
    }
    if (docs['naming.json'] && typeof docs['naming.json'] === 'object') {
      this._naming = deepFreeze(docs['naming.json']);
    }
    if (typeof docs['GAME_GUIDE.md'] === 'string') {
      this._guide = docs['GAME_GUIDE.md']; // BUILDER EXTENSION (raw markdown)
    }
    if (docs['captions.json'] && Array.isArray(docs['captions.json'].captions)) {
      const captions = deepFreeze(docs['captions.json'].captions);
      captions.forEach((caption, order) => {
        if (!caption || typeof caption.sound !== 'string') return;
        if (caption.sound.includes('*')) {
          const segments = caption.sound.split('.');
          this._captionWildcards.push({
            segments,
            literals: segments.filter((seg) => seg !== '*').length,
            order,
            caption,
          });
        } else {
          this._captionsExact.set(caption.sound, caption);
        }
      });
    }
    if (docs['bindings.default.json'] && docs['bindings.default.json'].bindings) {
      this._bindings = deepFreeze(docs['bindings.default.json'].bindings);
    }
    if (docs['tutorial.json'] && Array.isArray(docs['tutorial.json'].beats)) {
      this._tutorial = deepFreeze({
        version: docs['tutorial.json'].version,
        beats: docs['tutorial.json'].beats,
      });
    }
  }

  /** Record an unknown-id lookup. @private */
  _warn(message) {
    this.warnings.push(message);
  }

  /** Pick a random element via the injected rng. @private */
  _pick(array) {
    return array[Math.floor(this._rng() * array.length) % array.length];
  }

  // ------------------------------------------------------------- getters

  /**
   * All 60 achievements in file order (`[]` before load / on failure).
   * @returns {ReadonlyArray<{ id: string, name: string, description: string,
   *   trigger: string, tree: string, tier: number, parent: string,
   *   hidden: boolean }>}
   */
  getAchievements() {
    return this._achievements;
  }

  /**
   * A random splash line from the 155-entry pool; canon-toned inline
   * fallback string when the pool is unavailable.
   * @returns {string}
   */
  splash() {
    const pool =
      this._splashes && this._splashes.length ? this._splashes : FALLBACK_SPLASHES;
    return this._pick(pool);
  }

  /**
   * A random tip, optionally filtered by `system` category (18 systems, e.g.
   * 'crafting', 'mounts', 'the-ravelling'). Unknown/omitted category draws
   * from all tips. `null` only when tips.json failed to load.
   * @param {string} [category]
   * @returns {{ id: string, system: string, text: string } | null}
   */
  tip(category) {
    if (!this._tips || !this._tips.length) return null;
    let pool = this._tips;
    if (category != null) {
      const filtered = this._tips.filter((t) => t.system === category);
      if (filtered.length) {
        pool = filtered;
      } else {
        this._warn(`tip: unknown category '${category}' — drawing from all`);
      }
    }
    return this._pick(pool);
  }

  /**
   * A random death message for `cause` (one of the 21 deathmessages.json
   * cause ids: 'fall', 'lava', 'drowning', 'explosion', 'starvation',
   * 'fire', 'cinderloom_heat', 'void_unravel', or 'mob:<canonicalId>'),
   * with `{player}` templated from `ctx.player` (default 'A Mender').
   * Unknown cause / unloaded returns a canon-toned fallback line, still
   * templated.
   * @param {string} cause
   * @param {{ player?: string }} [ctx]
   * @returns {string}
   */
  deathMessage(cause, ctx = {}) {
    let pool = this._deathByCause.get(cause);
    if (!pool || !pool.length) {
      if (this._loaded) this._warn(`deathMessage: unknown cause '${cause}'`);
      pool = FALLBACK_DEATH_LINES;
    }
    return template(this._pick(pool), {
      player: ctx && ctx.player != null ? ctx.player : 'A Mender',
    });
  }

  /**
   * The raw deep-frozen dialogue node for `dialogue.json[actor][event]`;
   * `null` when either key is missing.
   *   - 'wickerkin': 'greeting'|'trade'|'farewell'|'hurt' -> string[]
   *   - 'lastNeedle': 'phaseIntros' -> [{phase,name,lines}],
   *     'attackTelegraphs' -> [{attackId,lines}], 'onBound' -> string[]
   *   - 'molthkin': same shapes plus 'onFelled' -> string[]
   *   - 'tutorialNarrator': beat index '0'..'21' (string or number)
   *     -> { event, line }
   * @param {string} actor
   * @param {string|number} event
   * @returns {*} DeepFrozen<Array|Object> | null
   */
  dialogue(actor, event) {
    if (!this._dialogue) return null;
    if (actor === 'tutorialNarrator') {
      const index = Number(event);
      const beats = this._tutorialNarrator;
      if (beats && Number.isInteger(index) && index >= 0 && index < beats.length) {
        return beats[index];
      }
      this._warn(`dialogue: tutorialNarrator has no beat '${event}'`);
      return null;
    }
    const node =
      this._dialogue[actor] != null && this._dialogue[actor][event] != null
        ? this._dialogue[actor][event]
        : null;
    if (node === null) this._warn(`dialogue: no node for '${actor}'.'${event}'`);
    return node;
  }

  /**
   * Convenience: a single random line drawn from `dialogue(actor, event)`
   * when the node is (or contains only) strings; `null` otherwise.
   * @param {string} actor
   * @param {string|number} event
   * @returns {string | null}
   */
  dialogueLine(actor, event) {
    const node = this.dialogue(actor, event);
    if (node == null) return null;
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) {
      const strings = node.filter((line) => typeof line === 'string');
      return strings.length ? this._pick(strings) : null;
    }
    if (typeof node.line === 'string') return node.line; // tutorialNarrator beat
    return null;
  }

  /**
   * A random book whose `placement` array includes `structureId`;
   * `null` when none does.
   * @param {string} structureId
   * @returns {{ id: string, title: string, type: string,
   *   placement: string[], text: string } | null}
   */
  book(structureId) {
    const pool = this._booksByPlacement.get(structureId);
    if (!pool || !pool.length) {
      this._warn(`book: no books placed in '${structureId}'`);
      return null;
    }
    return this._pick(pool);
  }

  /**
   * All 21 books in file order.
   * @returns {ReadonlyArray<{ id: string, title: string, type: string,
   *   placement: string[], text: string }>}
   */
  books() {
    return this._books;
  }

  /**
   * The bestiary entry for a canonical snake_case mob id; `null` if unknown.
   * @param {string} id
   * @returns {{ id: string, name: string, dimension: string, role: string,
   *   core: string, audioArchetype: string, spawnRules: *, behavior: *,
   *   stats: { hp: number, damage: number, speed: number }, drops: *,
   *   husbandry?: { breedable: boolean, breedingFood: string|null,
   *     tameable: boolean, tameFood?: string, mountRequires?: string,
   *     note: string },
   *   visual?: { palette: string[], silhouette: string },
   *   statsNote?: string, dropsNote?: string } | null}
   */
  bestiary(id) {
    const mob = this._mobsById.get(id);
    if (!mob) {
      this._warn(`bestiary: unknown mob '${id}'`);
      return null;
    }
    return mob;
  }

  /**
   * All 17 bestiary entries in file order.
   * @returns {ReadonlyArray<object>} see {@link ContentPack#bestiary}
   */
  mobs() {
    return this._mobs;
  }

  /**
   * The item entry for `id`; `null` if unknown.
   * @param {string} id
   * @returns {{ id: string, displayName: string, tier: number,
   *   description: string, recipe: { shape: Array<string|null>,
   *   note?: string, source?: string } } | null}
   */
  item(id) {
    const item = this._itemsById.get(id);
    if (!item) {
      this._warn(`item: unknown item '${id}'`);
      return null;
    }
    return item;
  }

  /**
   * All 41 items in file order (incl. sennit_grain).
   * @returns {ReadonlyArray<object>} see {@link ContentPack#item}
   */
  items() {
    return this._items;
  }

  /**
   * `item(id)?.recipe ?? null` — the 9-slot crafting recipe for `id`.
   * @param {string} id
   * @returns {{ shape: Array<string|null>, note?: string, source?: string } | null}
   */
  recipe(id) {
    const item = this._itemsById.get(id);
    if (!item) {
      this._warn(`recipe: unknown item '${id}'`);
      return null;
    }
    return item.recipe != null ? item.recipe : null;
  }

  /**
   * The boss encounter entry: 'last_needle' (boss.json, hp 800) or
   * 'molthkin' (molthkin.json, hp 280); `null` for anything else.
   * @param {string} id
   * @returns {{ id: string, name: string, epithet: string, dimension: string,
   *   biome: string, arena: *, gauntlet: *, arenaFeatures: *,
   *   summonRequirement: *, stats: { hp: number, defense: * },
   *   phases: Array<{ index: number, name: string, hpRange: *,
   *     description: string, attacks: *, mechanics: *, transition: * }>,
   *   victoryCondition: *, onVictory: *, rewards: * } | null}
   */
  boss(id) {
    const boss = this._bosses.get(id);
    if (!boss) {
      this._warn(`boss: unknown boss '${id}'`);
      return null;
    }
    return boss;
  }

  /**
   * All 16 structures in file order.
   * @returns {ReadonlyArray<{ id: string, name: string, category: string,
   *   dimension: string, footprint: { x: number, y: number, z: number },
   *   blockPalette: string[], rarity: string, spawnRules: *, loreHook: string,
   *   description: string }>}
   */
  structures() {
    return this._structures;
  }

  /**
   * The structure entry for `id`; `null` if unknown.
   * @param {string} id
   * @returns {object | null} see {@link ContentPack#structures}
   */
  structure(id) {
    const structure = this._structuresById.get(id);
    if (!structure) {
      this._warn(`structure: unknown structure '${id}'`);
      return null;
    }
    return structure;
  }

  /**
   * Resolve a caption for a sound key. Exact `sound` match wins; otherwise
   * wildcard patterns apply, where '*' matches exactly ONE dot-segment
   * ('break.*' matches 'break.stone', 'mob.*.hurt' matches 'mob.grazer.hurt').
   * Among multiple wildcard hits the one with the most literal (non-*)
   * segments wins; ties go to the later file entry. `null` when nothing
   * matches. `{material}`/`{mob}` placeholders are returned verbatim — use
   * {@link ContentPack#captionText} to substitute.
   * @param {string} soundKey
   * @returns {{ sound: string, text: string, category: string,
   *   priority: number, durationMs: number, directional?: boolean } | null}
   */
  caption(soundKey) {
    const exact = this._captionsExact.get(soundKey);
    if (exact) return exact;
    const keySegments = String(soundKey).split('.');
    let best = null;
    for (const candidate of this._captionWildcards) {
      const { segments } = candidate;
      if (segments.length !== keySegments.length) continue;
      let matches = true;
      for (let i = 0; i < segments.length; i++) {
        if (segments[i] !== '*' && segments[i] !== keySegments[i]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      if (
        !best ||
        candidate.literals > best.literals ||
        (candidate.literals === best.literals && candidate.order >= best.order)
      ) {
        best = candidate;
      }
    }
    if (!best) {
      this._warn(`caption: no caption for '${soundKey}'`);
      return null;
    }
    return best.caption;
  }

  /**
   * Convenience over {@link ContentPack#caption}: resolve the caption and
   * substitute `{material}`/`{mob}` (any `{var}`) placeholders from `vars`.
   * @param {string} soundKey
   * @param {Record<string, string>} [vars]
   * @returns {string | null} the substituted caption text, or null when no
   *   caption matches
   */
  captionText(soundKey, vars = {}) {
    const caption = this.caption(soundKey);
    return caption ? template(caption.text, vars) : null;
  }

  /**
   * The default binding for one of the 27 actions (moveForward, moveBack,
   * moveLeft, moveRight, jump, sneak, sprint, break, place, interact, eat,
   * hotbar1..hotbar9, hotbarPrev, hotbarNext, inventory, chat, pause, debug,
   * toggleFlight); `null` if unknown. NOTE the canon fix: sneak = ShiftLeft,
   * sprint = ControlLeft.
   * @param {string} action
   * @returns {{ primary: string|null, secondary: string|null,
   *   gamepad: number|null } | null}
   */
  binding(action) {
    const binding = this._bindings ? this._bindings[action] : null;
    if (binding == null) {
      this._warn(`binding: unknown action '${action}'`);
      return null;
    }
    return binding;
  }

  /**
   * The full deep-frozen map of all 27 default bindings
   * (`{}` before load / on failure).
   * @returns {Readonly<Record<string, { primary: string|null,
   *   secondary: string|null, gamepad: number|null }>>}
   */
  bindings() {
    return this._bindings || deepFreeze({});
  }

  /**
   * The onboarding tutorial: 22 beats in canonical order, narratorLine
   * verbatim from dialogue.json tutorialNarrator; `null` when tutorial.json
   * failed to load.
   * @returns {{ version: number, beats: Array<{ id: string,
   *   narratorLine: string, coachMark: { anchor: string|null, title: string,
   *   body: string, placement: string }, gateEvent: string,
   *   skippable: boolean }> } | null}
   */
  tutorial() {
    return this._tutorial;
  }

  /**
   * BUILDER EXTENSION: the raw naming.json document (dimensions, biomes,
   * mobs, blocks, glossary, playerIdentity); `null` before load / on failure.
   * @returns {object | null}
   */
  naming() {
    return this._naming;
  }

  /**
   * BUILDER EXTENSION: GAME_GUIDE.md as raw markdown text; `null` before
   * load / on failure (the help panel keeps its own fetch fallback).
   * @returns {string | null}
   */
  guide() {
    return this._guide;
  }
}

/**
 * Page-lifetime singleton shared by every content consumer (achievements,
 * death messages, naming, splash/tips, help guide). main.js joins
 * `pack.load()` into its contentReady barrier; module-scope consumers call
 * `pack.load()` themselves (idempotent — one set of /content and /ux fetches
 * per page, every failure degrades per the loader contract).
 */
export const pack = new ContentPack();

export default ContentPack;
