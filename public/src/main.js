// Loomfall — main bootstrap (integration phase).
//
// Wires every verified subsystem into the playable game:
//   menus -> world select -> game session (world, chunks, player, controls,
//   sky, HUD, chat, inventory, debug overlay, multiplayer peers), with live
//   settings, texture-pack hot-swap, and a clean teardown back to the title.
//
// QA hooks: window.__game (see docs/DEV.md).

import * as THREE from 'three';
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY } from './constants.js';
import { getBlockDef } from './blocks/blocks.js';
import { buildAtlas } from './textures/TextureAtlas.js';
import { PACKS } from './textures/texturePacks.js';
import { TerrainGenerator } from './world/TerrainGenerator.js';
import { World } from './engine/World.js';
import { ChunkRenderer } from './engine/ChunkRenderer.js';
import { Sky } from './engine/Sky.js';
import { AutoQuality } from './engine/AutoQuality.js';
import { Player } from './gameplay/Player.js';
import { Controls } from './gameplay/Controls.js';
import { raycastVoxel } from './gameplay/raycast.js';
import { Inventory } from './gameplay/Inventory.js';
import { PortalSystem, PORTAL_BLOCK, FRAME_TARGETS } from './gameplay/portals.js';
import { DIMENSIONS } from './dimensions/dimensions.js';
import { prngSample } from './qa/prng.js';
import { NetClient } from './net/NetClient.js';
import { PeerAvatars } from './net/PeerAvatars.js';
import { isInLiquid } from './gameplay/physics.js';
import { PostFX } from '../graphics/src/postprocessing.js';
import { DistanceFog } from '../graphics/src/fog.js';
import { Particles } from '../graphics/src/particles.js';
import WeatherSystem from '../weather/weather.js';
import { GameAudio } from './audio/GameAudio.js';
import { tileForFace, CREATIVE_BLOCKS } from './blocks/blocks.js';
import { makeIconFactory } from './ui/icons.js';
import { initMenus } from './ui/menu.js';
import { initHUD } from './ui/hud.js';
import { initHotbar } from './ui/hotbar.js';
import { initChat } from './ui/chat.js';
import { initInventory } from './ui/inventory.js';
import { initDebug } from './ui/debug.js';
// Mobs + content integration (this stage).
import MobManager from '../mobs/MobManager.js';
import { CANONICAL_ID } from '../mobs/spawnRules.js';
import { LOOT_TABLES } from '../mobs/lootTables.js';
import { gameEvents } from './systems/events.js';
import { initAchievements } from './systems/achievements.js';
import {
  loadNaming, blockDisplayName, biomeDisplayName, canonBlockIdFor, CANON_BLOCK_ID,
} from './systems/naming.js';
import { loadDeathMessages, deathMessageFor } from './systems/deathmessages.js';
import { initDeathScreen } from './ui/deathscreen.js';
import { initHelp } from './ui/help.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = '0.1.0';
const NAME_KEY = 'loomfall.name';
const DAY_LENGTH_S = 600; // full day/night cycle: 10 minutes
const START_TIME_OF_DAY = 0.42; // late morning, so new worlds open in daylight
const REACH = 5.0; // block interaction raycast distance (server cap stays 7)
const BASE_SENSITIVITY = 0.002; // radians per pixel at settings.sensitivity=1
const MAX_DT = 0.05; // clamp frame gaps to 50 ms
const QA_TICK_S = 0.05; // __qa tick length (20 ticks/s, matches the QA plan)
const FADE_MS = 400; // dimension-travel fade to/from black
const DRY_SPAWN_RADIUS = 24; // spiral scan radius for a dry (non-liquid) spawn
const STEP_DISTANCE = 2.2; // blocks of ground travel between footstep sounds
const WEATHER_ROLL_S = DAY_LENGTH_S / 12; // weather machine rolls every ~2 game hours
const SNOW_BIOMES = new Set(['Snowfield', 'Snowcap']); // biomeAt() display names

// Combat (mobs stage).
const ATTACK_REACH = 4; // player melee reach vs mob hitboxes (blocks)
const ATTACK_DAMAGE = 4; // hp per left-click hit
const MOB_HIT_PAD = 0.12; // hitbox forgiveness padding (blocks)
const VOICE_RADIUS = 16; // idle mob barks only within this range of the player
const VOICE_MIN_S = 5; // idle-bark throttle window
const VOICE_JITTER_S = 6;
const DAYLIGHT_DAY_THRESHOLD = 0.35; // sky.daylight above this counts as "day"

// The audio engine ships voices for the five base archetype families; the
// newer archetypes reuse their AI-family voice (unknown keys would no-op).
const VOICE_FAMILY = {
  grazer: 'grazer', bobbindeer: 'grazer',
  trader: 'trader', scaldwarden: 'trader',
  groaner: 'groaner', frayedhound: 'groaner', emberspinner: 'groaner',
  unpicked: 'groaner', needlejack: 'groaner', raveler: 'groaner',
  lastneedle: 'groaner',
  exploder: 'exploder',
  screecher: 'screecher',
};

// Engine dimension id -> canonical Loomfall dimension key (achievements'
// enter_dimension triggers are keyed by the canonical names).
const CANON_DIM = { overworld: 'warpwold', nether: 'cinderloom', end: 'nevermend' };

// Scratch colors for the per-frame sky/fog/weather grading (no allocation).
const _grey = new THREE.Color();
const RAIN_GREY = new THREE.Color(0x8b95a1);
const STORM_GREY = new THREE.Color(0x474e58);
const SNOW_GREY = new THREE.Color(0xc9d4e0);
const FLASH_TINT = new THREE.Color(0xeaf1ff);

const canvas = document.getElementById('game');

// ---------------------------------------------------------------------------
// REST API helpers
// ---------------------------------------------------------------------------

async function apiGetWorlds() {
  const res = await fetch('/api/worlds');
  if (!res.ok) throw new Error(`GET /api/worlds -> ${res.status}`);
  return res.json();
}

async function apiCreateWorld({ name, seed }) {
  const res = await fetch('/api/worlds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(seed != null ? { name, seed } : { name }),
  });
  if (!res.ok) throw new Error(`POST /api/worlds -> ${res.status}`);
  return res.json();
}

async function apiGetWorld(id) {
  const res = await fetch(`/api/worlds/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`GET /api/worlds/${id} -> ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function getPlayerName() {
  let name = null;
  try { name = localStorage.getItem(NAME_KEY); } catch { /* storage off */ }
  if (!name) {
    name = `Wanderer${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
    try { localStorage.setItem(NAME_KEY, name); } catch { /* storage off */ }
  }
  return name;
}

/** Pointer lock without unhandled-rejection noise (needs a user gesture). */
function safeLock() {
  try {
    const p = canvas.requestPointerLock?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* not available (headless) */ }
}

function safeUnlock() {
  try { document.exitPointerLock?.(); } catch { /* not locked */ }
}

/** Compass sector from yaw (yaw 0 faces -Z = North; +yaw turns West). */
function facingFromYaw(yaw) {
  const idx = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
  return ['N', 'W', 'S', 'E'][idx];
}

/**
 * Ray vs axis-aligned box (slab method). Returns the entry distance along
 * the (normalized-enough) direction, 0 when the origin starts inside, or
 * null on a miss. Used for the player-melee raycast against mob hitboxes.
 */
function rayAabbEntry(origin, dir, min, max) {
  let tMin = 0;
  let tMax = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < min[axis] || o > max[axis]) return null;
    } else {
      let t1 = (min[axis] - o) / d;
      let t2 = (max[axis] - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }
  }
  return tMin;
}

/** Apply an edits bucket ({"x,y,z": id}) to a World via setBlock. */
function applyEdits(world, bucket) {
  if (!bucket) return;
  for (const [key, id] of Object.entries(bucket)) {
    const [x, y, z] = key.split(',').map(Number);
    if (Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z)) {
      world.setBlock(x, y, z, id);
    }
  }
}

/** Deep-copy welcome edits into a canonical {overworld,nether,end} record. */
function normalizeEditRecord(edits) {
  const out = { overworld: {}, nether: {}, end: {} };
  if (edits && typeof edits === 'object') {
    for (const dim of Object.keys(out)) {
      if (edits[dim] && typeof edits[dim] === 'object') {
        Object.assign(out[dim], edits[dim]);
      }
    }
  }
  return out;
}

/** Dispose every geometry/material/texture reachable from a THREE object. */
function deepDispose(object3d) {
  object3d.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    for (const m of mats) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Persistent pieces (created once, reused across game sessions)
// ---------------------------------------------------------------------------

/** Live settings object — same reference for the whole page lifetime. */
const settings = {};

/** Current game session (null on the title screen). */
let G = null;

let renderer = null; // one WebGLRenderer for the page (context is per-canvas)
let quality = null; // AutoQuality — adaptive resolution + fast-lighting flag

const ui = {}; // menus, hud, hotbar, chat, inventoryUI, debug — initialized at boot

/** Procedural audio (page lifetime). Engine + context are created lazily;
 *  resume() runs on the first user gesture (browser autoplay policy). */
const audio = new GameAudio();
window.addEventListener('pointerdown', () => audio.resume(), { once: true });
window.addEventListener('keydown', () => audio.resume(), { once: true });

// ---------------------------------------------------------------------------
// Content + achievements (page lifetime)
// ---------------------------------------------------------------------------

/** Canon naming + death-message tables (both degrade gracefully offline). */
const contentReady = Promise.all([loadNaming(), loadDeathMessages()])
  .catch(() => {});

/** "How to Play" panel — renders content/GAME_GUIDE.md. */
const help = initHelp();

/** Achievements engine. Capability sets tell it which canonical triggers can
 *  actually fire in this build (it wires ONLY those — no stub triggers):
 *  killable entities come from the mob roster, obtainable item ids from mob
 *  loot tables + the engine-block -> canon-block mapping (breaking a mapped
 *  block "collects" its canonical material in this creative build), and
 *  placeable canon ids from the creative palette. */
const achievements = initAchievements({
  bus: gameEvents,
  audio,
  caps: {
    killableEntityIds: new Set(Object.values(CANONICAL_ID)),
    obtainableItemIds: new Set([
      ...Object.values(CANON_BLOCK_ID),
      ...Object.values(LOOT_TABLES).flat().map((e) => e.itemId),
    ]),
    placeableCanonIds: new Set(
      CREATIVE_BLOCKS.map((id) => canonBlockIdFor(getBlockDef(id).name)).filter(Boolean),
    ),
    enterableDimensions: new Set(Object.values(CANON_DIM)),
  },
});
achievements.load();

/** Death ("unpicked") screen — Respawn routes into the live session. */
const deathScreen = initDeathScreen({
  onRespawn: () => { G?.respawnFromDeath?.(); },
});

/** Full-screen red damage flash. */
const hurtFlashEl = document.createElement('div');
hurtFlashEl.className = 'hurt-flash';
document.body.appendChild(hurtFlashEl);

function flashHurt(strength = 0.85) {
  hurtFlashEl.style.transition = 'none';
  hurtFlashEl.style.opacity = String(Math.max(0, Math.min(1, strength)));
  requestAnimationFrame(() => {
    hurtFlashEl.style.transition = '';
    hurtFlashEl.style.opacity = '0';
  });
}

// ---------------------------------------------------------------------------
// Travel overlays (fade-to-black + portal charge vignette) — page lifetime
// ---------------------------------------------------------------------------

/** Full-screen black fade used by dimension travel. */
const fadeEl = document.createElement('div');
fadeEl.id = 'dim-fade';
Object.assign(fadeEl.style, {
  position: 'fixed', inset: '0', background: '#000', opacity: '0',
  pointerEvents: 'none', transition: `opacity ${FADE_MS}ms ease`, zIndex: '50',
});
document.body.appendChild(fadeEl);

function fadeTo(opacity, ms = FADE_MS) {
  return new Promise((resolve) => {
    fadeEl.style.transitionDuration = `${ms}ms`;
    fadeEl.style.opacity = String(opacity);
    setTimeout(resolve, ms + 30);
  });
}

/** Subtle violet vignette that closes in while a portal charges. */
const vignetteEl = document.createElement('div');
vignetteEl.id = 'portal-vignette';
Object.assign(vignetteEl.style, {
  position: 'fixed', inset: '0', opacity: '0', pointerEvents: 'none',
  background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 42%, rgba(124,58,237,0.55) 100%)',
  transition: 'opacity 120ms linear', zIndex: '9',
});
document.body.appendChild(vignetteEl);

function setPortalVignette(progress) {
  vignetteEl.style.opacity = String(Math.max(0, Math.min(1, progress)));
}

// ---------------------------------------------------------------------------
// Boot: menus first
// ---------------------------------------------------------------------------

const packsList = Object.values(PACKS).map((p) => ({ id: p.id, name: p.name }));

ui.menus = initMenus({
  packsList,
  getWorlds: apiGetWorlds,
  onPlayWorld: (world) => { startGame(world); },
  onCreateWorld: async ({ name, seed }) => {
    try {
      const world = await apiCreateWorld({ name, seed });
      gameEvents.emit('world:created', { id: world.id, name: world.name });
      startGame(world);
    } catch (err) {
      console.warn('[loomfall] world creation failed:', err);
      ui.menus.setLoading(null);
      ui.menus.showWorldSelect();
    }
  },
  onHowToPlay: () => { help.open(); },
  onAchievements: () => { achievements.openScreen(); },
  onSettingsChange: (s) => applySettings(s),
  onResume: () => resumeGame(),
  onQuitToTitle: () => quitToTitle(),
  // Pause-menu Travel row (creative convenience; portals are the physical
  // route — see docs/DEV.md "Portals & dimension travel").
  travelDims: Object.values(DIMENSIONS).map((d) => ({ id: d.id, name: d.name })),
  onTravel: (dimId) => {
    if (!G) return;
    resumeGame();
    if (dimId === G.dim) {
      ui.chat.addMessage({ system: true, text: `Already in ${DIMENSIONS[dimId].name}.` });
      return;
    }
    travelToDimension(dimId);
  },
});
Object.assign(settings, ui.menus.getSettings());

ui.hud = initHUD();
ui.hotbar = initHotbar({ iconFor: (id) => (G ? G.iconFor(id) : null) });
ui.chat = initChat({
  onSend: (text) => {
    G?.net.sendChat(text);
    gameEvents.emit('chat:sent', { length: text.length });
  },
});
ui.inventoryUI = initInventory({
  iconFor: (id) => (G ? G.iconFor(id) : null),
  onPick: (id) => {
    if (!G) return;
    G.inventory.setSlot(G.inventory.selected, id);
    ui.hotbar.setSlots(G.inventory.slots);
    ui.hotbar.setSelected(G.inventory.selected);
  },
});
ui.debug = initDebug();

// Menu buttons: every click is a user gesture (resume audio) + ui.click.
document.getElementById('menu-root')?.addEventListener('click', (e) => {
  if (e.target && e.target.closest && e.target.closest('button')) {
    audio.resume();
    audio.ui();
  }
});
audio.setVolumes(ui.menus.getSettings());

ui.hud.showCrosshair(false); // hidden until a game starts
ui.menus.setLoading(null);
ui.menus.showMain();

// Clicking the canvas (re-)locks the pointer during play.
canvas.addEventListener('click', () => {
  if (G && !G.paused && !ui.inventoryUI.isOpen() && !ui.chat.isOpen()) safeLock();
});

// QoL: Escape keydown fallback. With pointer lock held the browser consumes
// Escape to exit the lock and Controls turns that pointerlockchange into
// 'togglePause'. When lock was never acquired (denied/headless/iframe) that
// path is dead — this listener drives the same production event directly.
// The 350 ms guard swallows the duplicate keydown some browsers deliver
// right after a lock exit (which already toggled the pause menu).
let lastLockChangeAt = -Infinity;
document.addEventListener('pointerlockchange', () => {
  lastLockChangeAt = performance.now();
});
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || !G) return;
  if (document.pointerLockElement) return; // Controls owns the locked path
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
  if (performance.now() - lastLockChangeAt < 350) return;
  G.controls._emit('togglePause');
});

window.addEventListener('resize', () => {
  if (!G || !renderer) return;
  G.camera.aspect = window.innerWidth / window.innerHeight;
  G.camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Live settings
// ---------------------------------------------------------------------------

let lastPackSeen = null; // pack:switched event edge detector

function applySettings(next) {
  const prevPack = lastPackSeen ?? settings.texturePack;
  Object.assign(settings, next);
  if (settings.texturePack !== prevPack) {
    gameEvents.emit('pack:switched', { packId: settings.texturePack, from: prevPack });
  }
  lastPackSeen = settings.texturePack;
  audio.setVolumes(settings);
  if (!G) return;
  G.camera.fov = settings.fov;
  G.camera.updateProjectionMatrix();
  G.controls.sensitivity = BASE_SENSITIVITY * settings.sensitivity;
  updateFog();
  applyGraphicsQuality(settings.graphicsQuality);
  if (settings.texturePack !== G.pack) hotSwapTexturePack(settings.texturePack);
  // renderDistance is read live by the loop's chunkRenderer.update call.
}

/** Post-processing tier: 'off' bypasses the chain, others map to PostFX. */
function applyGraphicsQuality(q) {
  if (!G || !G.fx) return;
  if (q === 'off') {
    G.fx.post.setEnabled(false);
  } else {
    G.fx.post.setEnabled(true);
    G.fx.post.setQuality(q || 'medium');
  }
}

/**
 * Texture-pack hot-swap: redraw the atlas canvas in place and flag the
 * CanvasTexture for re-upload. UV layout is pack-independent, so no re-mesh
 * (or material swap) is needed — every chunk picks it up next frame.
 */
function hotSwapTexturePack(packId) {
  const fresh = buildAtlas(packId);
  const ctx = G.atlas.canvas.getContext('2d');
  ctx.clearRect(0, 0, G.atlas.canvas.width, G.atlas.canvas.height);
  ctx.drawImage(fresh.canvas, 0, 0);
  G.atlas.texture.needsUpdate = true;
  fresh.texture.dispose();
  G.pack = packId;
  // Refresh UI icons (they are crops of the atlas canvas).
  G.iconFor.invalidate();
  ui.hotbar.setSlots(G.inventory.slots);
  ui.hotbar.setSelected(G.inventory.selected);
  ui.inventoryUI.setBlocks(G.inventory.creativeBlocks);
}

function updateFog() {
  if (!G) return;
  // Linear DistanceFog paired with ChunkRenderer._applyCulling: chunks past
  // `far` are hidden, so the fog wall must reach 100% there. The fog COLOR
  // tracks the live sky/horizon color per frame (ctx.skyColor in the loop),
  // which is what actually hides chunk pop-in at dawn/dusk/night.
  const far = Math.max(48, (settings.renderDistance + 0.5) * CHUNK_SX);
  G.fx.fog.setRange(Math.max(24, far * 0.55), far);
}

// ---------------------------------------------------------------------------
// Game session lifecycle
// ---------------------------------------------------------------------------

function startGame(worldMeta) {
  if (G) return;
  ui.menus.hideAll();
  ui.menus.setLoading('Weaving the world…');
  bootSession(worldMeta).catch((err) => {
    console.warn('[loomfall] failed to start game:', err);
    if (G) teardownSession();
    ui.menus.setLoading(null);
    ui.menus.showMain();
  });
}

async function bootSession(worldMeta) {
  const dim = 'overworld';

  // Canon naming/death-message data — awaited so first-render tooltips and
  // the death screen use canonical names (resolves instantly once cached;
  // resolves anyway on fetch failure with engine-name fallbacks).
  await contentReady;

  // --- Rendering core --------------------------------------------------------
  const atlas = buildAtlas(settings.texturePack);
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    // Adaptive quality: detects software rasterizers (SwiftShader/llvmpipe)
    // and scales the internal resolution to keep the frame rate playable.
    // On real GPUs it idles at scale 1 unless the machine can't keep up.
    quality = new AutoQuality(renderer);
    if (quality.software) {
      console.info('[loomfall] software rasterizer detected — fast lighting + adaptive resolution enabled');
    }
  }
  quality.reset();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // PostFX owns ACES tonemapping + sRGB encode on its HDR buffer; the plain
  // bypass path ('off') renders sRGB directly (three's default pipeline).
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const camera = new THREE.PerspectiveCamera(
    settings.fov, window.innerWidth / window.innerHeight, 0.1, 1000);
  const scene = new THREE.Scene();
  const sky = new Sky(scene);

  // --- Graphics FX (graphics package: post chain, distance fog, particles) ---
  const gq = settings.graphicsQuality || 'medium';
  const post = new PostFX(renderer, scene, camera, {
    quality: gq === 'off' ? 'medium' : gq,
  });
  if (gq === 'off') post.setEnabled(false);
  // Linear mode pairs with the chunk fog-culling wall (see updateFog); the
  // color is synced to the live sky every frame so pop-in dissolves into the
  // horizon at any time of day / weather / dimension.
  const fog = new DistanceFog(scene, { mode: 'linear', near: 60, far: 120 });
  const particles = new Particles(scene, { camera });
  particles.setWaterLevel(null); // splash rings are driven by its own rain (unused)
  const fx = { post, fog, particles };

  // --- Weather (weather package; visuals overworld-only) ---------------------
  // Our Sky owns background/lights and DistanceFog owns scene.fog, so the
  // weather package's SkyController is neutralized right away — we keep its
  // rain/snow/lightning effects and bridge the flash into our sky/lighting.
  const weather = new WeatherSystem(scene, camera);
  weather.sky.dispose(); // detaches its lights and releases scene.fog
  scene.background = null; // Sky.update() reclaims it on the next frame

  // Shared per-frame effect context (stable object, mutated in place).
  const fxCtx = {
    camera,
    renderer,
    scene,
    elapsed: 0,
    timeOfDay: START_TIME_OF_DAY,
    weather: 'clear', // 'clear' | 'rain' | 'snow' — drives fog haze
    underwater: false,
    skyColor: new THREE.Color(DIMENSIONS[dim].fog),
  };
  // Particles get a weather-less view of the ctx: precip visuals belong to
  // the weather package (Particles would spawn its own rain/snow otherwise).
  const particlesCtx = {
    camera,
    renderer,
    underwater: false,
    get elapsed() { return fxCtx.elapsed; },
  };

  // Dedicated lights for skyless dimensions (nether/end); off in overworld.
  const dimLights = {
    group: new THREE.Group(),
    ambient: new THREE.AmbientLight(0xffffff, 0.7),
    hemi: new THREE.HemisphereLight(0xffffff, 0x444444, 0.5),
  };
  dimLights.group.add(dimLights.ambient, dimLights.hemi);
  dimLights.group.visible = false;
  scene.add(dimLights.group);

  // --- World + network -------------------------------------------------------
  ui.menus.setLoading('Joining world…');
  const net = new NetClient();
  const welcome = await net.connect(location.origin, worldMeta.id, getPlayerName(), dim);
  const editsByDim = normalizeEditRecord(welcome.world.edits);

  const generator = new TerrainGenerator(welcome.world.seed, dim);
  const world = new World(generator);
  // Apply persisted edits BEFORE the first mesh build.
  applyEdits(world, editsByDim[dim]);

  ui.menus.setLoading('Weaving the world…');

  // --- Player + controls -----------------------------------------------------
  // Generate the spawn neighborhood so respawn() sees real ground.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) world.ensureChunk(dx, dz);
  }
  const player = new Player(world, camera);
  // Dry-land spawn: reject water/lava columns, spiralling out from the
  // world origin column (falls back to the origin column when nothing dry
  // is found within DRY_SPAWN_RADIUS).
  const dry = findDryLand(world, 8, 8);
  if (dry) player.spawn = { x: dry.x + 0.5, z: dry.z + 0.5 };
  player.respawn();

  const controls = new Controls(canvas, camera);
  controls.sensitivity = BASE_SENSITIVITY * settings.sensitivity;

  const chunkRenderer = new ChunkRenderer(scene, world, atlas, {
    fastLighting: quality.fastLighting,
  });
  const inventory = new Inventory();
  const iconFor = makeIconFactory(atlas);
  const peers = new PeerAvatars(scene);

  // --- Mobs (public/mobs/ package) --------------------------------------------
  // Per-world achievement bucket keys off the server world id.
  achievements.setWorld(welcome.world.id);
  // The manager's world reference is fixed at construction, but our world
  // object is REPLACED on dimension travel — hand it a live proxy instead.
  // The proxy also floors coordinates: mob AI samples with FLOAT positions
  // (the package's StubWorld floored internally) while World.getBlock
  // expects integer block coords.
  const mobWorld = {
    getBlock: (x, y, z) =>
      S.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)),
  };
  const mobs = new MobManager(scene, mobWorld, {
    getPlayerPos: () => ({
      x: S.player.position.x + S.player.size.x / 2,
      y: S.player.position.y,
      z: S.player.position.z + S.player.size.z / 2,
    }),
    getBlockDef, // OUR block registry (public/src/blocks/blocks.js)
    isDay: () => S.isDay,
    dimension: dim, // engine ids are normalized internally
    onEvent: (name, detail) => onMobEvent(name, detail),
  });

  // Physical portals: frame detection, fill/collapse, dwell-to-travel.
  const portals = new PortalSystem({
    getWorld: () => S.world,
    getDim: () => S.dim,
    player,
    applyBlock: (x, y, z, id) => {
      S.world.setBlock(x, y, z, id);
      recordEdit(S.dim, x, y, z, id);
      S.net.sendEdit(x, y, z, id);
    },
    onHint: (text) => ui.chat.addMessage({ system: true, text }),
    onCharge: (p) => setPortalVignette(p * 0.85),
    onTravel: (target) => { travelToDimension(target, { viaPortal: true }); },
  });

  // Targeted-block outline (black wireframe box).
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
    new THREE.LineBasicMaterial({ color: 0x000000 }),
  );
  outline.visible = false;
  scene.add(outline);

  // --- Session object ---------------------------------------------------------
  const S = {
    worldMeta: { id: welcome.world.id, name: welcome.world.name, seed: welcome.world.seed },
    dim,
    atlas,
    pack: settings.texturePack,
    scene,
    camera,
    sky,
    dimLights,
    net,
    editsByDim,
    generator,
    world,
    player,
    controls,
    chunkRenderer,
    inventory,
    iconFor,
    peers,
    portals,
    outline,
    fx,
    fxCtx,
    particlesCtx,
    weather,
    // Weather machine (overworld-only): `state` is the logical weather,
    // `presented` is what the WeatherSystem currently shows (snow biomes
    // present precipitation as snow; other dimensions force 'clear').
    wx: {
      state: 'clear',
      presented: 'clear',
      nextRollAt: WEATHER_ROLL_S * (0.75 + 0.5 * Math.random()),
      inSnowBiome: false,
      biomeCheckAt: 0,
    },
    mobs,
    dead: false, // death screen up; player sim + damage suspended
    isDay: true, // fed to the mob manager (spawn tables) each frame
    wasDay: true, // dawn edge detector for night:survived
    nightSeen: false, // an overworld night was witnessed since last death
    voiceTimer: 4 + Math.random() * VOICE_JITTER_S, // idle mob bark throttle
    respawnFromDeath: null, // assigned below (deathScreen Respawn routes here)
    stepAcc: 0, // ground distance since the last footstep sound
    lastFeetX: 0,
    lastFeetZ: 0,
    wasInLiquid: false,
    blockColorCache: new Map(), // `${pack}:${id}` -> [r,g,b] for debris tint
    paused: false,
    debugVisible: false,
    suppressPause: 0, // pending intentional unlocks that must not open the pause menu
    travelInFlight: false, // a fade+switchDimension is running
    tick: 0, // __qa sim-tick counter (QA_TICK_S cadence, pauses with the sim)
    tickAcc: 0,
    qaRecorders: [], // active __qa.recordTicks() collectors
    elapsed: 0,
    rafId: 0,
    lastFrame: performance.now(),
    fps: 0,
    fpsFrames: 0,
    fpsTime: 0,
    loadingShown: true,
    active: true,
    tmpDir: new THREE.Vector3(),
  };
  G = S;

  // Thunder pairs with the flash: the visible peak is ~90 ms after strike
  // start (weather/README.md "Light before sound"), so the crack lands just
  // after the light. Far strikes use the soft distant roll, non-positional.
  weather.on('lightningStrike', (e) => {
    const far = !!(e.detail && e.detail.far);
    setTimeout(() => {
      if (G !== S) return;
      audio.thunder(far, far ? null : S.player.eyePosition);
    }, 90);
  });

  // --- Network handlers -------------------------------------------------------
  for (const p of welcome.peers || []) peers.upsert(p);
  peers.setDimension(S.dim);

  net.onPeerJoin((msg) => {
    peers.upsert(msg);
    peers.setDimension(S.dim);
  });
  net.onPeerLeave((msg) => peers.remove(msg.id));
  net.onPeerMove((msg) => peers.move(msg));
  net.onEdit((msg) => {
    recordEdit(msg.dim, msg.x, msg.y, msg.z, msg.block);
    if (msg.dim === S.dim) S.world.setBlock(msg.x, msg.y, msg.z, msg.block);
  });
  // One of OUR edits was rejected (rate cap, reach, bounds, protected cell,
  // dim mismatch, invalid): roll the optimistic local change back to the
  // authoritative state. block >= 0 is the server-stored edit; -1 means the
  // cell is untouched generated terrain — recompute it from the local
  // deterministic generator (exact same output as the chunk pass).
  let lastRejectHintAt = -Infinity;
  net.onEditReject((msg) => {
    const { x, y, z, reason } = msg;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return;
    const dim = S.editsByDim[msg.dim] ? msg.dim : S.dim;
    const key = `${x},${y},${z}`;
    let authoritative = null;
    if (Number.isInteger(msg.block) && msg.block >= 0) {
      S.editsByDim[dim][key] = msg.block;
      authoritative = msg.block;
    } else {
      delete S.editsByDim[dim][key]; // back to generated terrain
      if (dim === S.dim) authoritative = S.generator.blockAt(x, y, z);
    }
    if (dim === S.dim && authoritative != null) {
      S.world.setBlock(x, y, z, authoritative);
    }
    // Subtle hint, at most once per 3 s.
    const now = performance.now();
    if (now - lastRejectHintAt >= 3000) {
      lastRejectHintAt = now;
      ui.chat.addMessage({
        system: true,
        text: reason === 'rate'
          ? 'Some changes were too fast and were undone.'
          : 'A block change was not allowed and was undone.',
      });
    }
  });
  net.onChat((msg) => ui.chat.addMessage({ name: msg.name, text: msg.text }));
  net.onDisconnect((info) => {
    if (S.active && !info.intentional) {
      ui.chat.addMessage({ system: true, text: 'Disconnected from server.' });
    }
  });

  // --- Controls events ---------------------------------------------------------
  controls.on('break', onBreak);
  controls.on('place', onPlace);
  controls.on('selectSlot', (i) => {
    if (!gameplayActive()) return;
    S.inventory.select(i);
    ui.hotbar.setSelected(S.inventory.selected);
  });
  controls.on('scroll', (dir) => {
    if (!gameplayActive()) return;
    S.inventory.cycle(dir);
    ui.hotbar.setSelected(S.inventory.selected);
  });
  controls.on('toggleFlight', () => { if (gameplayActive()) S.player.toggleFlight(); });
  controls.on('toggleDebug', () => {
    S.debugVisible = !S.debugVisible;
    ui.debug.setVisible(S.debugVisible);
  });
  controls.on('toggleInventory', () => {
    if (!G || S.paused || ui.chat.isOpen()) return;
    if (ui.inventoryUI.isOpen()) {
      ui.inventoryUI.close();
      safeLock();
    } else {
      clearMovementInput();
      if (document.pointerLockElement) S.suppressPause++;
      safeUnlock();
      ui.inventoryUI.open();
    }
  });
  controls.on('openChat', () => {
    if (!G || S.paused || ui.chat.isOpen() || ui.inventoryUI.isOpen()) return;
    clearMovementInput();
    // Defer past this keydown so the "t" itself is not typed into the input.
    setTimeout(() => { if (G && !S.paused) ui.chat.open(); }, 0);
  });
  controls.on('togglePause', () => {
    if (!G) return;
    if (S.suppressPause > 0) { S.suppressPause--; return; }
    if (ui.inventoryUI.isOpen()) { ui.inventoryUI.close(); safeLock(); return; }
    if (ui.chat.isOpen()) { ui.chat.close(); safeLock(); return; }
    if (S.paused) resumeGame();
    else pauseGame();
  });

  // --- UI per-session state ----------------------------------------------------
  ui.hotbar.setSlots(inventory.slots);
  ui.hotbar.setSelected(inventory.selected);
  ui.inventoryUI.setBlocks(inventory.creativeBlocks);
  ui.hud.setHealth(player.health);
  ui.hud.showCrosshair(true);
  ui.chat.addMessage({
    system: true,
    text: `Joined "${welcome.world.name}" — T to chat, E for blocks, F3 for debug`,
  });

  applyDimensionEnvironment(S.dim);
  publishHooks();

  // Falling past the kill plane routes through the death flow (canon cause:
  // the void picks you apart) instead of the old silent respawn.
  player.onKillPlane = () => {
    if (S.dead) return;
    S.player.health = 0;
    ui.hud.setHealth(0);
    killPlayer('void_unravel');
  };
  S.respawnFromDeath = respawnFromDeath;

  gameEvents.emit('dimension:entered', { dim: S.dim, canonDim: CANON_DIM[S.dim] });

  // --- Session helpers (close over S) -------------------------------------------

  function gameplayActive() {
    return !!G && !S.paused && !S.dead
      && !ui.chat.isOpen() && !ui.inventoryUI.isOpen();
  }

  function clearMovementInput() {
    const inp = S.controls.input;
    inp.forward = inp.back = inp.left = inp.right = false;
    inp.jump = inp.sprint = inp.sneak = inp.sneakOrDescend = false;
  }

  function recordEdit(dimId, x, y, z, id) {
    const bucket = S.editsByDim[dimId];
    if (bucket) bucket[`${x},${y},${z}`] = id;
  }

  /** Raycast from the camera center through the crosshair. */
  function computeTarget() {
    const dir = S.camera.getWorldDirection(S.tmpDir);
    const eye = S.player.eyePosition;
    return raycastVoxel(S.world, eye, { x: dir.x, y: dir.y, z: dir.z }, REACH);
  }

  // --- Combat / death / mob events ---------------------------------------------

  /** Nearest live mob under the crosshair within `reach`, or null. A solid
   *  block strictly closer than the mob occludes it (walls block swings). */
  function pickMobTarget(reach) {
    const dir = S.camera.getWorldDirection(S.tmpDir);
    const eye = S.player.eyePosition;
    let best = null;
    for (const mob of S.mobs.mobs) {
      if (mob.dead) continue;
      const hw = (mob.halfWidth ?? 0.35) + MOB_HIT_PAD;
      const h = (mob.height ?? 1) + MOB_HIT_PAD;
      const t = rayAabbEntry(eye, dir,
        { x: mob.position.x - hw, y: mob.position.y - MOB_HIT_PAD, z: mob.position.z - hw },
        { x: mob.position.x + hw, y: mob.position.y + h, z: mob.position.z + hw });
      if (t != null && t <= reach && (best == null || t < best.t)) best = { mob, t };
    }
    if (!best) return null;
    const blocked = raycastVoxel(
      S.world, eye, { x: dir.x, y: dir.y, z: dir.z }, best.t).hit;
    return blocked ? null : best;
  }

  /** Player melee (left-click): mob hitboxes take priority over blocks. */
  function tryAttackMob() {
    const hit = pickMobTarget(ATTACK_REACH);
    if (!hit) return false;
    hit.mob.hurt(ATTACK_DAMAGE); // -> mobHurt (+ mobDeath / bossDefeated) events
    return true;
  }

  /** Every MobManager event lands here (audio, particles, damage, bus). */
  function onMobEvent(name, detail) {
    if (G !== S || !detail) return;
    const pos = detail.position || detail.pos || null;
    const family = VOICE_FAMILY[detail.archetype] || 'groaner';
    switch (name) {
      case 'mobHurt':
        audio.play(`mob.${family}.hurt`, pos ? { pos, volume: 0.85 } : undefined);
        break;
      case 'mobDeath':
        audio.play(`mob.${family}.death`, pos ? { pos, volume: 0.95 } : undefined);
        if (pos) {
          // Small unravel poof: reuse the debris particles at chest height.
          S.fx.particles.spawnBlockBreak(
            { x: pos.x, y: pos.y + ((detail.mob && detail.mob.height) || 1) * 0.5, z: pos.z },
            [0.82, 0.78, 0.72]);
        }
        gameEvents.emit('mob:killed', {
          canonicalId: detail.canonicalId, archetype: detail.archetype,
        });
        break;
      case 'mobDrop':
        gameEvents.emit('mob:drop', { itemId: detail.itemId, count: detail.count });
        gameEvents.emit('item:collected', { itemId: detail.itemId, count: detail.count });
        break;
      case 'mobAttack':
        if (detail.explosion) {
          audio.play('explosion', pos ? { pos } : undefined);
          if (pos) S.fx.particles.spawnBlockBreak(pos, [1.0, 0.6, 0.25]);
          if (detail.hitPlayer) damagePlayer(detail.dmg, `mob:${detail.canonicalId}`);
        } else {
          damagePlayer(detail.dmg, `mob:${detail.canonicalId}`);
        }
        break;
      case 'bossDefeated':
        audio.levelup();
        if (pos) S.fx.particles.spawnBlockBreak(pos, [0.85, 0.8, 1.0]);
        ui.chat.addMessage({
          system: true,
          text: 'The Last Needle is bound. For a while, it will mend.',
        });
        gameEvents.emit('boss:defeated', {
          canonicalId: detail.canonicalId,
          achievement: detail.achievement,
          victoryTrigger: detail.victoryTrigger,
        });
        break;
      default:
        break; // mobSpawn / mobDespawn: quiet
    }
  }

  /** Apply damage to the player: HUD, hurt grunt, red flash, death at 0. */
  function damagePlayer(dmg, cause) {
    if (G !== S || S.dead || S.travelInFlight) return;
    const amount = Math.max(0, Math.round(Number(dmg) || 0));
    if (amount <= 0) return;
    S.player.health = Math.max(0, S.player.health - amount);
    ui.hud.setHealth(S.player.health);
    audio.hurt();
    flashHurt(0.55 + Math.min(0.35, amount * 0.05));
    if (S.player.health <= 0) killPlayer(cause);
  }

  /** Health hit 0: death screen with a templated canon death message. */
  function killPlayer(cause) {
    if (S.dead) return;
    S.dead = true;
    S.nightSeen = false; // dying mid-night forfeits survive_first_night
    clearMovementInput();
    const message = deathMessageFor(cause || 'void_unravel', getPlayerName());
    gameEvents.emit('player:died', { cause: cause || 'unknown', message });
    ui.chat.addMessage({ system: true, text: message });
    if (document.pointerLockElement) S.suppressPause++;
    safeUnlock();
    deathScreen.show(message);
  }

  /** Death-screen Respawn: re-stitch at the knot (spawn), reset health. */
  function respawnFromDeath() {
    if (G !== S || !S.dead) return;
    S.dead = false;
    S.player.respawn(); // resets position, velocity, and health
    // Announce the teleport: the server only accepts an over-budget move
    // when it lands back at the spawn anchor AND was declared as a respawn
    // (there is no unconditional resync grace — see PROTOCOL.md §7 rule 6).
    S.net.sendRespawn();
    S.net.sendMove(S.player.position, S.controls.yaw, S.controls.pitch);
    ui.hud.setHealth(S.player.health);
    gameEvents.emit('player:respawned', {});
    safeLock();
  }

  /** Throttled idle mob barks by proximity (one voice per window). */
  function mobVoiceTick(dt) {
    S.voiceTimer -= dt;
    if (S.voiceTimer > 0) return;
    S.voiceTimer = VOICE_MIN_S + Math.random() * VOICE_JITTER_S;
    const eye = S.player.eyePosition;
    const near = S.mobs.mobs.filter((m) => !m.dead
      && Math.hypot(m.position.x - eye.x, m.position.z - eye.z) <= VOICE_RADIUS);
    if (near.length === 0) return;
    const mob = near[Math.floor(Math.random() * near.length)];
    const family = VOICE_FAMILY[mob.archetype] || 'groaner';
    audio.play(`mob.${family}.idle`, { pos: { ...mob.position }, volume: 0.5 });
  }

  function onBreak() {
    if (!gameplayActive()) return;
    // Mob hitboxes take priority over blocks (reach 4 vs block reach 6).
    if (tryAttackMob()) return;
    const t = computeTarget();
    if (!t.hit) return;
    const id = S.world.getBlock(t.x, t.y, t.z);
    const def = getBlockDef(id);
    const center = { x: t.x + 0.5, y: t.y + 0.5, z: t.z + 0.5 };
    if (id === PORTAL_BLOCK) {
      // Breaking any portal block collapses the whole connected fill
      // (each cleared cell goes through the synced edit path).
      S.portals.collapseAt(t.x, t.y, t.z);
      S.fx.particles.spawnBlockBreak(center, blockDebrisColor(S, id));
      audio.blockBreak(id, center);
      ui.hud.setBreakProgress(1);
      setTimeout(() => ui.hud.setBreakProgress(null), 140);
      return;
    }
    if (def.hardness < 0) return; // bedrock & co are unbreakable
    S.world.setBlock(t.x, t.y, t.z, 0);
    recordEdit(S.dim, t.x, t.y, t.z, 0);
    S.net.sendEdit(t.x, t.y, t.z, 0);
    // Debris burst tinted with the broken block's atlas tile + break sound.
    S.fx.particles.spawnBlockBreak(center, blockDebrisColor(S, id));
    audio.blockBreak(id, center);
    // Achievements/events: breaking a canon-mapped block "collects" its
    // canonical material in this creative build (see systems/achievements.js).
    {
      const canonId = canonBlockIdFor(def.name);
      gameEvents.emit('block:broken', {
        blockId: id, name: def.name, canonId, dim: S.dim,
      });
      if (canonId) gameEvents.emit('item:collected', { itemId: canonId, count: 1 });
    }
    // Breaking a frame block (obsidian/end stone) collapses adjacent fills.
    if (id in FRAME_TARGETS) S.portals.handleFrameBreak(t.x, t.y, t.z);
    // Instant break for now: brief full-bar flash.
    ui.hud.setBreakProgress(1);
    setTimeout(() => ui.hud.setBreakProgress(null), 140);
  }

  function onPlace() {
    if (!gameplayActive()) return;
    const t = computeTarget();
    if (!t.hit || t.nx == null) return;
    const { nx, ny, nz } = t;
    if (ny < 0 || ny >= CHUNK_SY) return;
    const id = S.inventory.selectedBlock;
    if (!id) return;
    // Portal blocks never place directly: inside a valid obsidian/end-stone
    // frame they light the whole interior, anywhere else they do nothing
    // but hint (see gameplay/portals.js).
    if (id === PORTAL_BLOCK) {
      if (S.portals.handlePortalPlacement(nx, ny, nz)) {
        gameEvents.emit('portal:lit', { dim: S.dim });
      }
      return;
    }
    // Only into air or liquid.
    const curDef = getBlockDef(S.world.getBlock(nx, ny, nz));
    if (!(curDef.id === 0 || curDef.liquid)) return;
    // Reject cells intersecting the player AABB.
    const p = S.player.position;
    const sz = S.player.size;
    const overlaps =
      nx < p.x + sz.x && nx + 1 > p.x &&
      ny < p.y + sz.y && ny + 1 > p.y &&
      nz < p.z + sz.z && nz + 1 > p.z;
    if (overlaps) return;
    S.world.setBlock(nx, ny, nz, id);
    recordEdit(S.dim, nx, ny, nz, id);
    S.net.sendEdit(nx, ny, nz, id);
    audio.blockPlace(id, { x: nx + 0.5, y: ny + 0.5, z: nz + 0.5 });
    {
      const def = getBlockDef(id);
      gameEvents.emit('block:placed', {
        blockId: id, name: def.name, canonId: canonBlockIdFor(def.name), dim: S.dim,
      });
    }
  }

  /** One __qa.recordTicks sample (see docs/DEV.md — "__qa adapter"). */
  function qaSampleTick() {
    const p = S.player.position;
    const v = S.player.velocity;
    let targetBlock = null;
    const t = computeTarget();
    if (t.hit) targetBlock = getBlockDef(S.world.getBlock(t.x, t.y, t.z)).name;
    const sample = {
      tick: S.tick,
      pos: { x: p.x + S.player.size.x / 2, y: p.y, z: p.z + S.player.size.z / 2 },
      vel: { x: v.x / 20, y: v.y / 20, z: v.z / 20 }, // blocks/tick per the spec
      onGround: S.player.onGround,
      pose: 'standing', // pose system not implemented (docs/DEV.md)
      breakProgress: 0, // breaking is instant in this build
      targetBlock,
      heldCount: S.inventory.selectedBlock ? 1 : null, // creative: no stack counts
      itemEntities: [], // no item entities in this build
    };
    for (let i = S.qaRecorders.length - 1; i >= 0; i--) {
      const r = S.qaRecorders[i];
      r.samples.push(sample);
      if (r.samples.length >= r.count) {
        S.qaRecorders.splice(i, 1);
        r.resolve(r.samples);
      }
    }
  }

  // --- Main loop -----------------------------------------------------------------
  S.lastFrame = performance.now();
  const loop = (now) => {
    if (!S.active) return;
    S.rafId = requestAnimationFrame(loop);
    const rawDt = Math.max(0, (now - S.lastFrame) / 1000); // real frame time (fps)
    const dt = Math.min(MAX_DT, rawDt); // simulation dt, clamped to 50 ms
    S.lastFrame = now;

    // Adaptive internal resolution (no-op at scale 1 on capable GPUs).
    quality.update(rawDt);

    // Simulation (frozen while paused or with the inventory screen open;
    // chat leaves physics running but movement keys are cleared/guarded;
    // the death screen freezes the player but leaves the world alive).
    const simActive = !S.paused && !ui.inventoryUI.isOpen();
    if (simActive) {
      if (!S.dead) {
        S.player.update(dt, S.controls.input, S.controls.yaw);
        S.portals.update(dt); // dwell-to-travel charging + cooldown
      }
      // __qa sim ticks (50 ms cadence; recorders sample at tick resolution).
      S.tickAcc += dt;
      while (S.tickAcc >= QA_TICK_S) {
        S.tickAcc -= QA_TICK_S;
        S.tick++;
        if (S.qaRecorders.length > 0) qaSampleTick();
      }
    }

    // Chunk streaming (renderDistance applied live from settings); the eye
    // position drives exact fog-distance and directional backface culling.
    S.chunkRenderer.update(S.player.position, settings.renderDistance, S.player.eyePosition);

    // Day/night cycle + sky (overworld only; nether/end use static ambience).
    S.elapsed += dt;
    const timeOfDay = (START_TIME_OF_DAY + S.elapsed / DAY_LENGTH_S) % 1;
    if (S.dim === 'overworld') sky.update(timeOfDay, S.player.eyePosition);

    // Mobs: day/night flag feeds the spawn tables (Cinderloom/Nevermend
    // ignore it); the whole system freezes with the sim while paused.
    S.isDay = S.dim !== 'overworld' || (S.sky.daylight ?? 1) > DAYLIGHT_DAY_THRESHOLD;
    if (simActive) {
      S.mobs.setDay(S.isDay);
      S.mobs.update(dt);
      mobVoiceTick(dt);
      // survive_first_night: a full overworld night witnessed, then dawn.
      if (S.dim === 'overworld') {
        if (!S.isDay && !S.dead) S.nightSeen = true;
        if (S.isDay && !S.wasDay && S.nightSeen && !S.dead) {
          S.nightSeen = false;
          gameEvents.emit('night:survived', {});
        }
        S.wasDay = S.isDay;
      }
    }

    // Weather: machine rolls + presentation, then the effect systems
    // (frozen with the sim while paused — no weather/particle work).
    if (simActive) {
      weatherMachineTick(S);
      S.weather.update(dt);
    }
    const wxState = S.weather.getState();
    const flash = S.dim === 'overworld' ? (S.weather.lightning.getFlash() || 0) : 0;

    // Weather sky grading + lightning-flash bridge. Our Sky rewrites the
    // background color and light rig every frame, so these post-hoc tweaks
    // are self-healing (no state to restore).
    if (S.dim === 'overworld' && scene.background && scene.background.isColor) {
      if (wxState.weather !== 'clear' && wxState.intensity > 0.01) {
        const day = S.sky.daylight ?? 1;
        const base = wxState.weather === 'storm' ? STORM_GREY
          : wxState.weather === 'snow' ? SNOW_GREY : RAIN_GREY;
        _grey.copy(base).multiplyScalar(0.1 + 0.9 * day);
        scene.background.lerp(_grey, 0.7 * wxState.intensity);
        S.sky.sunLight.intensity *=
          1 - 0.55 * wxState.intensity * (wxState.weather === 'storm' ? 1 : 0.6);
      }
      if (flash > 0) {
        S.sky.sunLight.intensity += flash * 2.2;
        S.sky.hemiLight.intensity += flash * 1.4;
        S.sky.ambientLight.intensity += flash * 0.9;
        scene.background.lerp(FLASH_TINT, flash * 0.85);
      }
      S.fxCtx.skyColor.copy(scene.background);
    } else if (S.dim !== 'overworld') {
      S.fxCtx.skyColor.set(DIMENSIONS[S.dim].fog);
    }

    if (quality.fastLighting) {
      // Unlit fast materials: day/night tint (+ storm dim + flash) by hand.
      let level = S.dim === 'overworld' ? S.sky.daylight ?? 1
        : S.dim === 'nether' ? 0.9 : 0.85;
      if (S.dim === 'overworld') {
        if (wxState.weather !== 'clear') level *= 1 - 0.3 * wxState.intensity;
        level = Math.min(1, level + flash);
      }
      S.chunkRenderer.setLightLevel(level);
    }

    // Distance fog (sky-matched color, weather haze) + particle systems.
    S.fxCtx.elapsed = S.elapsed;
    S.fxCtx.timeOfDay = S.dim === 'overworld' ? timeOfDay : 0.5;
    S.fxCtx.weather = (S.wx.presented === 'rain' || S.wx.presented === 'storm')
      ? 'rain' : S.wx.presented === 'snow' ? 'snow' : 'clear';
    S.fx.fog.update(dt, S.fxCtx);
    if (simActive) S.fx.particles.update(dt, S.particlesCtx);

    // Crosshair target outline.
    const target = computeTarget();
    if (target.hit) {
      S.outline.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
      S.outline.visible = true;
    } else {
      S.outline.visible = false;
    }

    // Peers + network.
    S.peers.update(dt);
    S.net.sendMove(S.player.position, S.controls.yaw, S.controls.pitch);

    // Audio: 3D listener on the eyes/facing; footsteps + water splash.
    audio.setListener(S.player.eyePosition, S.controls.yaw);
    {
      const feetX = S.player.position.x + S.player.size.x / 2;
      const feetZ = S.player.position.z + S.player.size.z / 2;
      const moved = Math.hypot(feetX - S.lastFeetX, feetZ - S.lastFeetZ);
      S.lastFeetX = feetX;
      S.lastFeetZ = feetZ;
      const inLiq = isInLiquid(S.world, { pos: S.player.position, size: S.player.size });
      if (inLiq && !S.wasInLiquid) {
        audio.splash({ x: feetX, y: S.player.position.y + 0.5, z: feetZ });
      }
      S.wasInLiquid = inLiq;
      if (S.player.onGround && !inLiq && moved > 0 && moved < 2) {
        // Throttled by distance: ~1 step per STEP_DISTANCE blocks walked.
        S.stepAcc += moved;
        if (S.stepAcc >= STEP_DISTANCE) {
          S.stepAcc = 0;
          const under = S.world.getBlock(
            Math.floor(feetX), Math.floor(S.player.position.y - 0.01), Math.floor(feetZ));
          audio.step(under, { x: feetX, y: S.player.position.y, z: feetZ },
            S.controls.input.sprint ? 1 : 0.7);
        }
      } else if (!S.player.onGround) {
        S.stepAcc = Math.min(S.stepAcc, STEP_DISTANCE * 0.5);
      }
    }

    // HUD.
    ui.hud.setHealth(S.player.health);

    // Post chain (bloom + ACES + vignette + FXAA) or plain render when 'off'
    // (PostFX.render falls back to renderer.render internally when disabled).
    S.fx.post.update(dt, S.fxCtx);
    S.fx.post.render(dt);

    // FPS (1 s rolling, real frame time — not the clamped sim dt) + debug.
    S.fpsFrames++;
    S.fpsTime += rawDt;
    if (S.fpsTime >= 1) {
      S.fps = Math.round(S.fpsFrames / S.fpsTime);
      S.fpsFrames = 0;
      S.fpsTime = 0;
    }
    if (S.debugVisible) {
      const px = S.player.position.x + S.player.size.x / 2;
      const pz = S.player.position.z + S.player.size.z / 2;
      ui.debug.setData({
        fps: S.fps,
        pos: S.player.position,
        chunk: {
          cx: Math.floor(S.player.position.x / CHUNK_SX),
          cz: Math.floor(S.player.position.z / CHUNK_SZ),
        },
        dim: DIMENSIONS[S.dim].name,
        // Real biome in the overworld (same noise the generator used),
        // shown under its canonical Loomfall name (naming.json analog);
        // nether/end terrain has no biome field — show the dimension name.
        biome: S.dim === 'overworld'
          ? biomeDisplayName(S.generator.biomeAt(px, pz))
          : DIMENSIONS[S.dim].name,
        facing: facingFromYaw(S.controls.yaw),
        // Targeted block under its canonical display name (naming.json).
        target: target.hit
          ? blockDisplayName(getBlockDef(S.world.getBlock(target.x, target.y, target.z)).name)
          : null,
        mobs: S.mobs.mobs.length,
        tris: renderer.info.render.triangles,
        calls: renderer.info.render.calls,
        chunks: S.chunkRenderer.stats.chunksLoaded,
      });
    }

    // Drop the loading overlay once the spawn area is meshed.
    if (S.loadingShown &&
        (S.chunkRenderer.stats.chunksLoaded >= 9 || S.elapsed > 8)) {
      S.loadingShown = false;
      ui.menus.setLoading(null);
    }
  };
  S.rafId = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Pause / resume / quit
// ---------------------------------------------------------------------------

function pauseGame() {
  if (!G || G.paused) return;
  G.paused = true;
  if (document.pointerLockElement) {
    G.suppressPause++;
    safeUnlock();
  }
  ui.menus.showPause();
}

function resumeGame() {
  if (!G) return;
  G.paused = false;
  ui.menus.hideAll();
  safeLock();
}

function quitToTitle() {
  if (!G) return;
  teardownSession();
  // menu.js shows the main screen right after this callback returns; the
  // world list re-fetches whenever the world-select screen is shown.
}

function teardownSession() {
  const S = G;
  S.active = false;
  cancelAnimationFrame(S.rafId);

  S.net.close();
  S.controls.dispose();
  S.peers.dispose();
  S.chunkRenderer.dispose();
  S.mobs.dispose();

  audio.stopAll(); // music, ambience beds, rain loop, live voices
  S.weather.dispose();
  S.fx.post.dispose();
  S.fx.fog.dispose();
  S.fx.particles.dispose();

  S.outline.geometry.dispose();
  S.outline.material.dispose();
  deepDispose(S.sky.group);
  S.scene.clear();
  S.atlas.texture.dispose();
  renderer.renderLists.dispose();

  ui.debug.setVisible(false);
  ui.inventoryUI.close();
  ui.chat.close();
  ui.hud.showCrosshair(false);
  ui.hud.setBreakProgress(null);
  ui.menus.setLoading(null);
  deathScreen.hide();
  achievements.closeScreen();
  achievements.clearWorld();
  help.close();
  safeUnlock();

  // Travel overlays + pending __qa recorders die with the session.
  setPortalVignette(0);
  fadeEl.style.transitionDuration = '0ms';
  fadeEl.style.opacity = '0';
  for (const r of S.qaRecorders.splice(0)) {
    r.reject(new Error('game session ended'));
  }

  G = null;
  window.__game = null;
  window.__qa = null;
}

// ---------------------------------------------------------------------------
// Dimension plumbing (portals + pause-menu Travel are the entry points;
// __game.setDimension stays available for QA)
// ---------------------------------------------------------------------------

function applyDimensionEnvironment(dimId) {
  const spec = DIMENSIONS[dimId];
  updateFog();
  if (dimId === 'overworld') {
    G.sky.group.visible = true;
    G.dimLights.group.visible = false;
    // sky.update() reclaims scene.background on the next frame.
  } else {
    G.sky.group.visible = false;
    G.scene.background = new THREE.Color(spec.fog);
    G.dimLights.group.visible = true;
    if (dimId === 'nether') {
      G.dimLights.ambient.color.set(0xffd9c2);
      G.dimLights.ambient.intensity = 0.7;
      G.dimLights.hemi.color.set(0xff8a5c);
      G.dimLights.hemi.groundColor.set(0x54160c);
      G.dimLights.hemi.intensity = 0.55;
    } else {
      G.dimLights.ambient.color.set(0xd6ccf5);
      G.dimLights.ambient.intensity = 0.6;
      G.dimLights.hemi.color.set(0xb9a8ff);
      G.dimLights.hemi.groundColor.set(0x120b22);
      G.dimLights.hemi.intensity = 0.5;
    }
    // Fog color for skyless dimensions (the loop keeps it synced anyway).
    G.fxCtx.skyColor.set(spec.fog);
  }
  // Weather visuals are overworld-only (presentation forces 'clear'
  // elsewhere); music + ambience beds switch per dimension.
  applyWeatherPresentation(G);
  audio.setDimension(dimId, G.worldMeta.seed);
}

/** ensureChunk for the chunk containing world column (x, z). */
function ensureColumn(world, x, z) {
  world.ensureChunk(Math.floor(x / CHUNK_SX), Math.floor(z / CHUNK_SZ));
}

/**
 * Topmost non-air block of a column IF it is dry, standable land: solid and
 * not liquid. Water/lava-topped columns return -1 (never spawn the player
 * into — or onto the floor beneath — a liquid).
 */
function dryGroundY(world, x, z) {
  ensureColumn(world, x, z);
  for (let y = CHUNK_SY - 1; y >= 0; y--) {
    const id = world.getBlock(x, y, z);
    if (id === 0) continue;
    const def = getBlockDef(id);
    return (def.solid && !def.liquid) ? y : -1; // liquid/portal top = reject
  }
  return -1; // all-air column
}

/**
 * Spiral outward (rings up to DRY_SPAWN_RADIUS) from (nearX, nearZ) for the
 * closest dry column. Returns {x, y, z} of the ground block or null.
 */
function findDryLand(world, nearX, nearZ, radius = DRY_SPAWN_RADIUS) {
  for (let r = 0; r <= radius; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        const x = nearX + dx;
        const z = nearZ + dz;
        const y = dryGroundY(world, x, z);
        if (y >= 0 && y + 2 < CHUNK_SY) return { x, y, z };
      }
    }
  }
  return null;
}

/** Find a safe standing spot near (nearX, nearZ) for nether/end arrivals. */
function findSafeSpawn(world, dimId, nearX = 8, nearZ = 8) {
  const minY = dimId === 'nether' ? 33 : 1; // nether: above the lava sea (~y31)
  const maxY = dimId === 'nether' ? 100 : CHUNK_SY - 3;
  const fits = (x, y, z) =>
    getBlockDef(world.getBlock(x, y, z)).solid &&
    !getBlockDef(world.getBlock(x, y, z)).liquid &&
    world.getBlock(x, y + 1, z) === 0 &&
    world.getBlock(x, y + 2, z) === 0;
  let best = null;
  for (let r = 0; r <= 40 && !best; r += 2) {
    for (let dz = -r; dz <= r && !best; dz += 2) {
      for (let dx = -r; dx <= r && !best; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        const x = nearX + dx;
        const z = nearZ + dz;
        ensureColumn(world, x, z);
        if (dimId === 'nether') {
          // Scan UP from just above the lava sea: the first solid-with-
          // headroom match is the cavern floor (not the ceiling roof).
          for (let y = minY; y <= maxY; y++) {
            if (fits(x, y, z)) { best = { x, y: y + 1, z }; break; }
          }
        } else {
          // End: islands float over void — take the topmost surface.
          for (let y = maxY; y >= minY; y--) {
            if (fits(x, y, z)) { best = { x, y: y + 1, z }; break; }
          }
        }
      }
    }
  }
  return best;
}

/**
 * Orchestrated travel: fade to black, switch dimension (arrival spot is
 * spawn-scanned near the departure coordinates — 1:1 coordinate mapping),
 * fade back in. Portal dwell and the pause-menu Travel row both land here.
 */
async function travelToDimension(targetDim, { viaPortal = false } = {}) {
  if (!G || G.travelInFlight) return;
  const S = G;
  if (!DIMENSIONS[targetDim] || targetDim === S.dim) {
    if (viaPortal) S.portals.notifyTravelEnd();
    return;
  }
  S.travelInFlight = true;
  audio.portal(S.player.eyePosition); // otherworldly whoosh over the fade
  if (!viaPortal) S.portals.notifyTravelStart(); // latch + clear the vignette
  const near = {
    x: S.player.position.x + S.player.size.x / 2,
    z: S.player.position.z + S.player.size.z / 2,
  };
  try {
    await fadeTo(1);
    if (G !== S) return; // session ended mid-fade
    await switchDimension(targetDim, { near });
  } finally {
    if (G === S) {
      S.portals.notifyTravelEnd(); // starts the 4 s re-entry cooldown
      S.travelInFlight = false;
      fadeTo(0);
    }
  }
}

async function switchDimension(dimId, opts = {}) {
  if (!G || !DIMENSIONS[dimId] || dimId === G.dim) return;
  const S = G;
  const near = {
    x: Math.round(opts.near?.x ?? 8),
    z: Math.round(opts.near?.z ?? 8),
  };

  // Best-effort refresh of edits made in other dimensions while we were away.
  try {
    const fresh = await apiGetWorld(S.worldMeta.id);
    const record = normalizeEditRecord(fresh.edits);
    for (const d of Object.keys(record)) Object.assign(S.editsByDim[d], record[d]);
  } catch { /* offline — use the local record */ }
  if (G !== S) return; // torn down while fetching

  // Teardown current chunk meshes, then rebuild the world for the target dim.
  S.chunkRenderer.dispose();
  S.dim = dimId;
  S.generator = new TerrainGenerator(S.worldMeta.seed, dimId);
  S.world = new World(S.generator);
  applyEdits(S.world, S.editsByDim[dimId]);
  S.player.world = S.world;
  S.chunkRenderer = new ChunkRenderer(S.scene, S.world, S.atlas, {
    fastLighting: quality.fastLighting,
  });

  // Respawn appropriately for the dimension, near the departure coords.
  if (dimId === 'overworld') {
    // Dry-land arrival: spiral for a solid non-liquid column; graceful
    // fallback to the near column itself if everything within range is wet.
    const dry = findDryLand(S.world, near.x, near.z);
    const col = dry || { x: near.x, z: near.z };
    ensureColumn(S.world, col.x, col.z);
    S.player.spawn = { x: col.x + 0.5, z: col.z + 0.5 };
    S.player.respawn();
  } else {
    // Near the departure coords first; if that area is all lava sea / void,
    // fall back to the dimension origin (guaranteed terrain in the end's
    // main island and virtually always a nether cavern floor).
    const spot = findSafeSpawn(S.world, dimId, near.x, near.z)
      || findSafeSpawn(S.world, dimId, 8, 8);
    const feet = spot || { x: near.x, y: 72, z: near.z }; // fallback: drop in
    S.player.spawn = { x: feet.x + 0.5, z: feet.z + 0.5 };
    S.player.position.x = feet.x + 0.5 - S.player.size.x / 2;
    S.player.position.y = feet.y;
    S.player.position.z = feet.z + 0.5 - S.player.size.z / 2;
    S.player.velocity.x = 0; S.player.velocity.y = 0; S.player.velocity.z = 0;
    S.player.onGround = true;
    S.player.health = 20;
  }

  applyDimensionEnvironment(dimId);
  S.net.setDimension(dimId);
  // Overwrite the pending move NOW (same tick): setDimension folds the switch
  // into the next outgoing move, but the last queued position predates the
  // travel — flushing that stale position with the new dim would burn the
  // dimension-change grace on the WRONG spot and get the real arrival point
  // rejected as an over-budget move (the server has no resync grace). The
  // arrival position also becomes the server-side respawn anchor.
  S.net.sendMove(S.player.position, S.controls.yaw, S.controls.pitch);
  S.peers.setDimension(dimId);
  // Mobs: despawn everyone, switch to the destination's spawn tables (the
  // manager normalizes engine ids internally; its world proxy already
  // points at the rebuilt world).
  S.mobs.setDimension(dimId);
  gameEvents.emit('dimension:entered', { dim: dimId, canonDim: CANON_DIM[dimId] });
  publishHooks(); // world/chunkRenderer references changed
  ui.chat.addMessage({ system: true, text: `Now entering: ${DIMENSIONS[dimId].name}` });
}

// ---------------------------------------------------------------------------
// Weather machine (overworld-only) + block debris tint
// ---------------------------------------------------------------------------

const WEATHER_STATES = ['clear', 'rain', 'storm', 'snow'];

/**
 * What the WeatherSystem should currently SHOW. The machine state is the
 * logical weather; snow-biome players see precipitation as snow, and
 * non-overworld dimensions never show weather.
 */
function weatherPresentation(S) {
  if (S.dim !== 'overworld') return 'clear';
  const st = S.wx.state;
  if (st === 'clear') return 'clear';
  if ((st === 'rain' || st === 'storm') && S.wx.inSnowBiome) return 'snow';
  return st;
}

/** Push the current presentation into visuals + the paired rain-loop audio. */
function applyWeatherPresentation(S) {
  const want = weatherPresentation(S);
  if (want === S.wx.presented) return;
  S.wx.presented = want;
  S.weather.setWeather(want);
  if (want !== 'clear') {
    S.weather.setIntensity(want === 'storm' ? 0.9 : want === 'snow' ? 0.7 : 0.55, 2);
  }
  // Audio pairing (public/weather/README.md): rain loop for rain/storm with a
  // live intensity ramp; snow is visual-only; clear stops the loop.
  if (want === 'rain') audio.rainSet(S.wx.state === 'storm' ? 0.85 : 0.5, 2);
  else if (want === 'storm') audio.rainSet(0.9, 2);
  else audio.rainStop();
}

/** Force a weather state (pause-proof QA entry point: __game.weather). */
function setWeatherState(S, state) {
  if (!WEATHER_STATES.includes(state)) return;
  S.wx.state = state;
  // Hold the forced state for at least one full machine window.
  S.wx.nextRollAt = S.elapsed + WEATHER_ROLL_S;
  applyWeatherPresentation(S);
}

/**
 * Weather machine tick: mostly clear skies, occasional rain, rare storms.
 * Rolls every ~2 in-game hours (WEATHER_ROLL_S with jitter). Also refreshes
 * the player's snow-biome flag (~1 Hz) so precipitation presents as snow
 * while standing in Snowfield/Snowcap terrain.
 */
function weatherMachineTick(S) {
  if (S.dim === 'overworld') {
    if (S.elapsed >= S.wx.biomeCheckAt) {
      S.wx.biomeCheckAt = S.elapsed + 1;
      const px = S.player.position.x + S.player.size.x / 2;
      const pz = S.player.position.z + S.player.size.z / 2;
      S.wx.inSnowBiome = SNOW_BIOMES.has(S.generator.biomeAt(px, pz));
    }
    if (S.elapsed >= S.wx.nextRollAt) {
      S.wx.nextRollAt = S.elapsed + WEATHER_ROLL_S * (0.75 + 0.5 * Math.random());
      const r = Math.random();
      const st = S.wx.state;
      if (st === 'clear') {
        if (r < 0.06) S.wx.state = 'storm'; // storms are rarer
        else if (r < 0.28) S.wx.state = 'rain';
      } else if (st === 'rain') {
        if (r < 0.12) S.wx.state = 'storm';
        else if (r < 0.55) S.wx.state = 'clear';
      } else { // storm (or forced snow) winds down
        if (r < 0.45) S.wx.state = 'clear';
        else if (r < 0.75) S.wx.state = 'rain';
      }
    }
  }
  applyWeatherPresentation(S);
}

/**
 * Average color (0..1 rgb triplet) of a block's side tile in the LIVE atlas
 * canvas — debris particles match the current texture pack. Cached per
 * (pack, block id); falls back to grey chips if canvas readback fails.
 */
function blockDebrisColor(S, id) {
  const key = `${S.pack}:${id}`;
  const hit = S.blockColorCache.get(key);
  if (hit) return hit;
  let rgb = [0.6, 0.6, 0.6];
  try {
    const def = getBlockDef(id);
    const tile = tileForFace(def, 'side') ?? tileForFace(def, 'top');
    if (tile) {
      const atlas = S.atlas;
      const i = atlas.tileIndex(tile);
      const px = atlas.tilePx;
      const sx = (i % atlas.cols) * px;
      const sy = Math.floor(i / atlas.cols) * px;
      const data = atlas.canvas.getContext('2d').getImageData(sx, sy, px, px).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let o = 0; o < data.length; o += 16) { // every 4th pixel
        if (data[o + 3] < 32) continue;
        r += data[o];
        g += data[o + 1];
        b += data[o + 2];
        n++;
      }
      if (n > 0) rgb = [r / n / 255, g / n / 255, b / n / 255];
    }
  } catch { /* canvas readback unavailable — grey chips */ }
  S.blockColorCache.set(key, rgb);
  return rgb;
}

// ---------------------------------------------------------------------------
// QA hooks (documented in docs/DEV.md)
// ---------------------------------------------------------------------------

function publishHooks() {
  if (!G) return;
  window.__game = {
    version: VERSION,
    player: G.player,
    world: G.world,
    controls: G.controls,
    inventory: G.inventory,
    net: G.net,
    chunkRenderer: G.chunkRenderer,
    sky: G.sky,
    peers: G.peers,
    portals: G.portals,
    // Weather (weather package + overworld machine). setWeather forces a
    // logical state ('clear'|'rain'|'storm'|'snow'); snow biomes/dimensions
    // may present it differently (getState().presented).
    weather: {
      system: G.weather,
      setWeather: (s) => setWeatherState(G, s),
      getState: () => ({
        machine: G.wx.state,
        presented: G.wx.presented,
        ...G.weather.getState(),
      }),
      setIntensity: (v, ramp) => G.weather.setIntensity(v, ramp),
      strike: (opts) => G.weather.strike(opts),
      on: (type, handler) => G.weather.on(type, handler),
    },
    audio, // GameAudio wrapper — audio.state is the QA stub-check surface
    fx: G.fx, // { post: PostFX, fog: DistanceFog, particles: Particles }
    // Mobs (public/mobs/ MobManager): mobs.mobs snapshot, spawn(archetype,
    // pos), spawnBoss(pos), setDimension, setDay — see public/mobs/README.md.
    mobs: G.mobs,
    // Achievements engine (systems/achievements.js): openScreen/closeScreen,
    // isUnlocked(id), unlockedIds(), stats() -> {total, wired}, wiredIds().
    achievements,
    // Game event bus (systems/events.js) — event names in docs/DEV.md.
    events: gameEvents,
    deathScreen, // { show(message), hide(), isShowing() }
    help, // How to Play panel: { open(), close(), isOpen() }
    setDimension: switchDimension,
    travelTo: travelToDimension,
    getDimension: () => (G ? G.dim : null),
    ui: {
      menus: ui.menus,
      chat: ui.chat,
      hud: ui.hud,
      debugOverlay: ui.debug,
      inventoryUI: ui.inventoryUI,
      hotbar: ui.hotbar,
    },
    settings,
    quality,
  };
  window.__qa = makeQaHook();
}

/**
 * window.__qa — QA-plan adapter (design/parity-spec docs/QA_PLAN.md §1.4),
 * mapped onto __game / live session objects. Signature-compatible subset;
 * every mapping (and every impossible item) is documented in docs/DEV.md.
 */
function makeQaHook() {
  const S = G;
  const feet = () => ({
    x: S.player.position.x + S.player.size.x / 2,
    y: S.player.position.y,
    z: S.player.position.z + S.player.size.z / 2,
  });
  const DEG = 180 / Math.PI;
  return {
    version: 1,
    getCaps: () => [
      'portals', 'travel', 'dimensions', 'biome', 'recorder',
      'prng.legacy', 'prng.xoroshiro', 'prng.noise2d',
    ],

    // ---- screens / input ----
    isPointerLocked: () => !!document.pointerLockElement,
    // MC-convention degrees: yaw 0 = +Z (south), 90 = -X (west); pitch + = down.
    getYawPitch: () => ({
      yaw: (((180 - S.controls.yaw * DEG) % 360) + 360) % 360,
      pitch: -S.controls.pitch * DEG,
    }),
    setLook: (yawDeg, pitchDeg) => {
      S.controls.yaw = (180 - yawDeg) / DEG;
      S.controls.pitch = -pitchDeg / DEG;
      S.controls._applyCameraRotation();
    },

    // ---- local player ----
    getPlayerPos: () => feet(),
    getPlayerVel: () => ({ // blocks per 50 ms tick, per the spec
      x: S.player.velocity.x / 20,
      y: S.player.velocity.y / 20,
      z: S.player.velocity.z / 20,
    }),
    onGround: () => S.player.onGround,
    isFlying: () => S.player.flying,
    getEyeHeight: () => S.player.eyeHeight, // 1.62, or 1.50 while sneaking
    getAABB: () => ({ w: S.player.size.x, h: S.player.size.y }),

    // ---- world ----
    getBlock: (x, y, z) =>
      getBlockDef(G ? G.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) : 0).name,
    isColumnLoaded: (x, z) =>
      !!G && G.world.hasChunk(Math.floor(x / CHUNK_SX), Math.floor(z / CHUNK_SZ)),
    getHeightmapAt: (x, z) => {
      if (!G) return -1;
      for (let y = CHUNK_SY - 1; y >= 0; y--) {
        if (G.world.getBlock(Math.floor(x), y, Math.floor(z)) !== 0) return y;
      }
      return -1;
    },
    getBiome: (x, _y, z) => (G && G.dim === 'overworld'
      ? G.generator.biomeAt(x, z)
      : (G ? DIMENSIONS[G.dim].name : null)),
    getSeed: () => String(S.worldMeta.seed),
    getDimension: () => ({ ...DIMENSIONS[G ? G.dim : S.dim] }),

    // ---- perf ----
    getFps: () => S.fps,
    getCameraFov: () => S.camera.fov,

    // ---- recorder (samples on the sim's 50 ms tick; see docs/DEV.md) ----
    recordTicks: (n) => new Promise((resolve, reject) => {
      if (!G) { reject(new Error('no active game session')); return; }
      const count = Math.max(1, Math.min(2400, Math.floor(Number(n) || 0)));
      G.qaRecorders.push({ count, samples: [], resolve, reject });
    }),

    // ---- PRNG known-answer probes (public/src/qa/prng.js) ----
    prngSample,
  };
}
