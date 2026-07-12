// Loomfall — main bootstrap (integration phase).
//
// Wires every verified subsystem into the playable game:
//   menus -> world select -> game session (world, chunks, player, controls,
//   sky, HUD, chat, inventory, debug overlay, multiplayer peers), with live
//   settings, texture-pack hot-swap, and a clean teardown back to the title.
//
// QA hooks: window.__game (see docs/DEV.md).

import * as THREE from 'three';
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, SEA_LEVEL } from './constants.js';
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
// Survival inventory stack (this stage): the 41-slot stack model, the
// items.json recipe matcher (2x2 personal grid) and the local item-entity
// manager for drops. Creative sessions keep the original Inventory above.
import { InventoryModel } from './gameplay/InventoryModel.js';
import { Crafting } from './gameplay/Crafting.js';
import { ItemEntities, drawSackIcon } from './gameplay/ItemEntities.js';
import { PortalSystem, PORTAL_BLOCK, FRAME_TARGETS } from './gameplay/portals.js';
import { DIMENSIONS } from './dimensions/dimensions.js';
import { prngSample } from './qa/prng.js';
import { NetClient } from './net/NetClient.js';
// PlayerStack facade (avatars-integrate): single owner of the NetClient's
// single-slot peer/chat/disconnect callbacks. Replaces the old PeerAvatars
// boxes with skinned animated avatars + nameplates and fans every net event
// out to the social layer (presence roster, hold-Tab player list, whisper /
// mute, join/leave toasts, spectator cam) and the third-person camera rig.
import { PlayerStack } from '../avatars-integrate/integrate.js';
import { createAvatarPlus } from '../avatars-plus/avatar-plus.js';
import {
  encodeDescriptor, decodeDescriptor, normalizeDescriptor, THEME_IDS,
} from '../avatars-plus/skin-descriptor.js';
import { EMOTES } from '../avatars-plus/emotes.js';
import { isInLiquid } from './gameplay/physics.js';
// GraphicsStack facade (graphics-lab): single owner of the PostFX chain,
// distance fog, particles, animated water and the pooled torch lights.
// Cracks / view model / biome grading remain direct module wiring below.
import { GraphicsStack } from '../graphics/integrate.js';
import { registerEmitterLights } from '../graphics/emitters.js';
import { BlockCracks } from '../graphics/src/blockcrack.js';
import { FirstPersonViewModel } from '../graphics/src/viewmodel.js';
import { BiomeGrading } from '../graphics/src/biomelut.js';
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
import { pack } from './systems/contentpack.js';
import { initAchievements } from './systems/achievements.js';
import {
  loadNaming, blockDisplayName, biomeDisplayName, canonBlockIdFor, CANON_BLOCK_ID,
  prettyName,
} from './systems/naming.js';
import { loadDeathMessages, deathMessageFor } from './systems/deathmessages.js';
import { initDeathScreen } from './ui/deathscreen.js';
import { initHelp } from './ui/help.js';
// HUD/audio integration facades: HudKit (ui-kit brand palette + ux-access
// captions) and AudioStack (the lf-audio-event caption bridge). Both are
// additive adapters — neither imports three nor touches the render loop.
import HudKit from '../ui-integrate/integrate.js';
import { AudioStack } from '../audio-integrate/integrate.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = '0.1.0';
const NAME_KEY = 'loomfall.name';
// Survival inventory persistence (per world, localStorage; server-side
// inventory sync is a documented follow-up — see docs/DEV.md).
const INV_KEY_PREFIX = 'loomfall.inv.';
const INV_SAVE_DEBOUNCE_MS = 400;
// Q-drop toss: forward speed + upward pop, and the delay before the thrown
// stack can be walked back over (so a drop doesn't insta-return).
const DROP_TOSS_SPEED = 4.5;
const DROP_TOSS_UP = 2.2;
const DROP_PICKUP_DELAY_S = 1.2;
const DAY_LENGTH_S = 600; // full day/night cycle: 10 minutes
const START_TIME_OF_DAY = 0.42; // late morning, so new worlds open in daylight
const REACH = 6.0; // block interaction raycast distance — unified with the
                   // server's MAX_REACH = 6 (spec EDIT_REACH_BLOCKS)

// Timed block breaking (hold left mouse). Hardness -> seconds mapping:
//   seconds = min(1.5, 0.15 + 0.5 * hardness); hardness < 0 = unbreakable.
// So: 0.5 -> 0.4s, 1.5 -> 0.9s, hardness >= 2.7 hits the 1.5s cap ("3+ ->
// 1.5s"). Flight mode breaks instantly (creative-feel concession).
const BREAK_TIME_BASE_S = 0.15;
const BREAK_TIME_PER_HARDNESS_S = 0.5;
const BREAK_TIME_MAX_S = 1.5;

/** Seconds of held left-click needed to break a block def (Infinity = never). */
function breakTimeFor(def) {
  if (def.hardness < 0) return Infinity;
  return Math.min(BREAK_TIME_MAX_S,
    BREAK_TIME_BASE_S + BREAK_TIME_PER_HARDNESS_S * def.hardness);
}
const BASE_SENSITIVITY = 0.002; // radians per pixel at settings.sensitivity=1
const MAX_DT = 0.05; // clamp frame gaps to 50 ms
const QA_TICK_S = 0.05; // __qa tick length (20 ticks/s, matches the QA plan)
const FADE_MS = 400; // dimension-travel fade to/from black
const DRY_SPAWN_RADIUS = 24; // spiral scan radius for a dry (non-liquid) spawn
const STEP_DISTANCE = 2.2; // blocks of ground travel between footstep sounds
const WEATHER_ROLL_S = DAY_LENGTH_S / 12; // weather machine rolls every ~2 game hours
const SNOW_BIOMES = new Set(['Snowfield', 'Snowcap']); // biomeAt() display names

// Environmental hazards (canon death causes beyond mobs/void — see
// content/deathmessages.json). Flying (creative concession) skips all three.
const LAVA_TICK_S = 0.5;    // molten-skein contact: LAVA_DAMAGE every 0.5 s
const LAVA_DAMAGE = 4;
const AIR_SECONDS = 10;     // breath while the eyes are under water…
const DROWN_TICK_S = 1.0;   // …then DROWN_DAMAGE per second ('drowning')
const DROWN_DAMAGE = 2;
const FALL_SAFE_BLOCKS = 3; // landing beyond this deals (blocks − 3) 'fall' damage

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

async function apiCreateWorld({ name, seed, mode }) {
  const body = { name };
  if (seed != null) body.seed = seed;
  if (mode === 'survival' || mode === 'creative') body.mode = mode;
  const res = await fetch('/api/worlds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

const SKIN_KEY = 'loomfall.skin';

/** FNV-1a 32-bit string hash (the same family the avatar packages seed with). */
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The local player's skin descriptor. A persisted `loomfall.skin` JSON wins
 * (future customizer hook); otherwise it is derived DETERMINISTICALLY from
 * the player name, so the same player renders the same look every session —
 * and, because the encoded string rides the join frame and is echoed by the
 * server, identically on every peer's screen.
 */
function getLocalSkinDescriptor() {
  let desc = null;
  try {
    const raw = localStorage.getItem(SKIN_KEY);
    if (raw) desc = normalizeDescriptor(JSON.parse(raw));
  } catch { /* corrupt/absent — derive from the name */ }
  if (!desc) {
    const h = fnv1a(getPlayerName());
    desc = normalizeDescriptor({
      theme: THEME_IDS[h % THEME_IDS.length],
      threadHue: h % 360,
      weave: (h >>> 4) % 6,
      accent: (h >>> 8) % 360,
      accentStrength: ((h >>> 16) & 0xff) / 255,
    });
  }
  // Round-trip through the wire encoding so the LOCAL render uses byte-exact
  // the same descriptor peers decode (accentStrength quantizes to 1/100).
  return decodeDescriptor(encodeDescriptor(desc));
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

// ---------------------------------------------------------------------------
// Item id helpers (numeric engine block ids + string content item ids)
// ---------------------------------------------------------------------------

/** Page-lifetime icon cache for STRING item ids (hash-tinted sack canvas —
 *  same art the item entities carry; numeric block ids crop the atlas via
 *  the per-session icon factory). */
const itemIconCache = new Map();
function itemIconFor(id) {
  let icon = itemIconCache.get(id);
  if (!icon) {
    icon = drawSackIcon(id);
    itemIconCache.set(id, icon);
  }
  return icon;
}

/** Icon for any inventory id: block ids crop the live atlas; string content
 *  item ids use the procedural sack icon. */
function iconForAny(id) {
  if (typeof id === 'number') return G ? G.iconFor(id) : null;
  return itemIconFor(id);
}

/** Display name for any inventory id (canon naming for blocks, items.json
 *  displayName for content items). */
function displayNameFor(id) {
  if (typeof id === 'number') return blockDisplayName(getBlockDef(id).name);
  for (const it of pack.items() || []) {
    if (it && it.id === id) return it.displayName || prettyName(String(id));
  }
  return prettyName(String(id));
}

/** Re-render the hotbar from the active inventory (stacks in survival,
 *  bare block ids in creative — the hotbar shows counts only for stacks). */
function refreshHotbarUI(S = G) {
  if (!S) return;
  if (S.mode === 'survival') {
    ui.hotbar.setSlots(S.invModel.slots.slice(0, 9));
    ui.hotbar.setSelected(S.invModel.selected);
  } else {
    ui.hotbar.setSlots(S.inventory.slots);
    ui.hotbar.setSelected(S.inventory.selected);
  }
}

/** Persist the survival inventory for its world (localStorage v1). */
function saveSurvivalInventory(S) {
  if (!S || S.mode !== 'survival' || !S.invModel) return;
  try {
    localStorage.setItem(
      INV_KEY_PREFIX + S.worldMeta.id, JSON.stringify(S.invModel.serialize()));
  } catch { /* storage unavailable — session-only inventory */ }
}

let renderer = null; // one WebGLRenderer for the page (context is per-canvas)
let quality = null; // AutoQuality — adaptive resolution + fast-lighting flag

const ui = {}; // menus, hud, hotbar, chat, inventoryUI, debug — initialized at boot

/** Procedural audio (page lifetime). Engine + context are created lazily;
 *  resume() runs on the first user gesture (browser autoplay policy). */
const audio = new GameAudio();
window.addEventListener('pointerdown', () => audio.resume(), { once: true });
window.addEventListener('keydown', () => audio.resume(), { once: true });

/** AudioStack caption bridge: decorates GameAudio (non-invasive, revertible
 *  via audioStack.detach()) so every sound — one-shots, ambient loops and
 *  music — also dispatches window "lf-audio-event" {name, direction, volume,
 *  loop, ended} with real positional direction for the caption layer. */
const audioStack = new AudioStack();
audioStack.attach(audio);

// ---------------------------------------------------------------------------
// Content + achievements (page lifetime)
// ---------------------------------------------------------------------------

/** Shared ContentPack + the naming/death-message adapters over it (all
 *  degrade gracefully offline; pack.load() is idempotent so the adapters
 *  join the same underlying load). */
const contentReady = Promise.all([pack.load(), loadNaming(), loadDeathMessages()])
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
  pack, // shared ContentPack — achievements read the same loaded snapshot
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
    // Late-bound (resolved inside achievements.load(), after the ContentPack
    // recipes arrive): items whose recipe fits the survival 2x2 personal
    // grid can actually be crafted -> their craft_item triggers wire.
    craftableItemIds: () => new Set(new Crafting({ items: pack.items() }).craftableWithin(2)),
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
  onCreateWorld: async ({ name, seed, mode }) => {
    try {
      const world = await apiCreateWorld({ name, seed, mode });
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
  // Audio settings dock: the <volume-settings> widget (public/audio/) replaces
  // the three bespoke volume sliders. It binds the live engine and persists to
  // localStorage "audio.volumes" (menu.js migrates the legacy loomfall.settings
  // volume keys into that store once at load).
  mountVolumeControl: (host) => {
    audioStack.mountVolumeSettings(host, { engine: audio.engine }).then((widget) => {
      if (!widget) return;
      // Mirror the widget into GameAudio so its QA-visible state
      // (audio.state.volumes — docs/DEV.md) stays truthful: once for the
      // persisted values it just applied, then on every slider input.
      const sync = () => {
        const v = widget.volumes;
        audio.setVolumes({ volumeMaster: v.master, volumeSfx: v.sfx, volumeMusic: v.music });
      };
      sync();
      widget.addEventListener('input', sync);
    });
  },
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
ui.hotbar = initHotbar({
  iconFor: (id) => iconForAny(id),
  nameFor: (id) => displayNameFor(id),
});
ui.chat = initChat({
  onSend: (text) => {
    handleChatSend(text); // whisper//emote command routing (PlayerStack)
    gameEvents.emit('chat:sent', { length: text.length });
  },
});

/**
 * Chat submit routing. `/emote <id>` plays + broadcasts an emote; `/w`,
 * `/msg`, `/r`, `/mute`, `/unmute`, `/block`, `/unblock` route through the
 * PlayerStack whisper controller (which renders DM/status lines itself and
 * sends directed whispers over the net); anything else goes out as public
 * chat and renders when the server echo returns.
 */
function handleChatSend(text) {
  const S = G;
  if (!S) return;
  if (!S.stack) { S.net.sendChat(text); return; }
  const em = /^\/(?:e|emote)\s+(\S+)\s*$/i.exec(text);
  if (em) {
    const id = em[1].toLowerCase();
    if (EMOTES.some((e) => e.id === id)) {
      S.stack.emote(id); // plays on the local avatar + net.sendEmote
      ui.chat.addMessage({ system: true, text: `* You ${id}` });
    } else {
      ui.chat.addMessage({
        system: true,
        text: `Unknown emote — try: ${EMOTES.map((e) => e.id).join(', ')}`,
      });
    }
    return;
  }
  const r = S.stack.whisper.handleInput(text);
  if (r && r.type === 'chat' && typeof r.text === 'string') S.net.sendChat(r.text);
}

// PlayerStack/SocialLayer expect an addEventListener-capable chat handle
// (they normally bind an lf-chat element's 'lf-send' event). Our chat is a
// plain module API and submits through handleChatSend above instead, so the
// listener hooks are inert no-ops — addMessage is the live render path.
const chatForStack = {
  addMessage: (m) => ui.chat.addMessage(m),
  addEventListener: () => {},
  removeEventListener: () => {},
};
ui.inventoryUI = initInventory({
  iconFor: (id) => iconForAny(id),
  nameFor: (id) => displayNameFor(id),
  onPick: (id) => {
    if (!G || G.mode === 'survival') return; // palette is creative-only
    G.inventory.setSlot(G.inventory.selected, id);
    refreshHotbarUI();
    audioStack.pickup(); // gap-fill: 'pop' on an inventory palette pick
  },
});
ui.debug = initDebug();

// UI buttons: every click is a user gesture (resume audio) + ui.click.
// Document-level delegation on .vx-btn covers every panel that uses the
// shared button style — menus, pause, help, achievements, death screen —
// not just #menu-root (ui.click coverage gap-fill).
document.addEventListener('click', (e) => {
  if (e.target && e.target.closest && e.target.closest('button.vx-btn')) {
    audio.resume();
    audio.ui();
  }
});
audio.setVolumes(ui.menus.getSettings());

// ---------------------------------------------------------------------------
// HudKit — Tier-1 brand palette + <lf-captions> (page lifetime)
// ---------------------------------------------------------------------------

/** Tier-1 theming: links ui-kit tokens/base + the brand overlay AFTER the
 *  bespoke stylesheet, so every existing widget re-skins with zero markup
 *  change (revert: hudKit.removeTheme()). */
const hudKit = HudKit.init({
  ui,
  assetBase: './',
  themeHref: './ui-integrate/brand-theme.css',
  // Absolute path: HudKit dynamic-imports ux modules relative to ITS OWN
  // module URL (/ui-integrate/), so a page-relative './ux/' would miss.
  uxBase: '/ux/',
});
hudKit.applyTheme();

/** Sound-captions overlay (deaf/HoH accessibility). Mounted only while the
 *  "Sound Captions" settings toggle (default OFF) is on; it renders the
 *  window "lf-audio-event" stream produced by the AudioStack bridge. */
let captionsHandle = null;
let captionsDocPromise = null;
function applyCaptionsSetting(on) {
  if (on && !captionsHandle) {
    captionsDocPromise = captionsDocPromise
      || fetch('./ux/captions/captions.json').then((r) => r.json()).catch(() => null);
    captionsHandle = hudKit.adoptCaptions({ corner: 'bottom-right' });
    const el = captionsHandle && captionsHandle.element;
    if (el) {
      captionsDocPromise.then((doc) => {
        if (!doc) return;
        customElements.whenDefined('lf-captions')
          .then(() => { el.captions = doc; })
          .catch(() => {});
      });
    }
  } else if (!on && captionsHandle) {
    captionsHandle.revert();
    captionsHandle = null;
  }
}
applyCaptionsSetting(!!settings.captions);

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
  audio.setVolumes(settings); // volume keys now live in the widget; this is a
                              // no-op for them (kept for any legacy callers)
  applyCaptionsSetting(!!settings.captions);
  if (!G) return;
  G.camera.fov = settings.fov;
  G.camera.updateProjectionMatrix();
  G.controls.sensitivity = BASE_SENSITIVITY * settings.sensitivity;
  updateFog();
  applyGraphicsQuality(settings.graphicsQuality);
  if (settings.texturePack !== G.pack) hotSwapTexturePack(settings.texturePack);
  // renderDistance is read live by the loop's chunkRenderer.update call.
}

/** Dimension -> brand biome grade (graphics/src/biomelut.js BIOMES keys). */
const DIM_GRADE = {
  overworld: 'sennmeadows',
  nether: 'emberwarp',
  end: 'the_fraying',
};

/**
 * Graphics Quality tier -> the GraphicsStack facade. 'off' bypasses the
 * PostFX chain; every other tier fans out through gfx.setQuality (PostFX
 * preset incl. SSAO/god-rays for high/ultra, water reflection quality,
 * pooled torch-light budget). The default 'medium' tier keeps SSAO/god rays
 * off (same policy as the pre-facade wiring).
 */
function applyGraphicsQuality(q) {
  if (!G || !G.gfx) return;
  const tier = (q === 'off' ? 'medium' : q) || 'medium';
  G.gfx.setQuality(tier);
  G.gfx.toggle('post', q !== 'off');
  if (q !== 'off' && tier === 'medium' && G.fx.post) {
    G.fx.post.toggle('ssao', false);
    G.fx.post.toggle('godrays', false);
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
  refreshHotbarUI();
  if (G.mode !== 'survival') ui.inventoryUI.setBlocks(G.inventory.creativeBlocks);
  // Pack-swap hook: keep the GraphicsStack's pack atlas + tiled materials on
  // the same pack. No-op when the swap ORIGINATED from gfx.setTexturePack
  // (its wrapper set G.pack before routing here — see bootSession).
  G.gfx?.setTexturePack(packId);
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

  // --- Graphics FX ------------------------------------------------------------
  // The GraphicsStack facade (constructed after the world exists, below) owns
  // the post chain, distance fog, particles, animated water and torch lights.
  // Cracks + view model are direct wiring (the facade has no equivalents).
  const gq = settings.graphicsQuality || 'medium';

  // Progressive crack decals driven by the hold-to-break accumulator
  // (updateMining: stage = floor(progress * 5)). blend 'normal': three.js
  // warns every frame on MultiplyBlending without premultiplied alpha.
  const cracks = new BlockCracks(scene, { blend: 'normal' });

  // First-person view model (held block + swing on break/place). Parented to
  // the camera — the camera must itself be in the scene graph to render its
  // children.
  scene.add(camera);
  const viewmodel = new FirstPersonViewModel(camera, {
    atlasTexture: atlas.texture,
    // tileUV rects already carry the half-texel inset, so texelSize is left
    // unset (0) — the viewmodel would add its own inset on top otherwise.
    atlas: {
      tileUV: atlas.tileUV,
      faceTile: (id, face) => {
        const def = getBlockDef(id);
        return def ? tileForFace(def, face) : null;
      },
    },
  });
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
  // The encoded skin rides the join frame; the server validates + echoes it
  // on welcome.peers / peer-join so every client renders this player's look.
  const localSkinDesc = getLocalSkinDescriptor();
  const welcome = await net.connect(
    location.origin, worldMeta.id, getPlayerName(), dim, encodeDescriptor(localSkinDesc));
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

  // --- GraphicsStack facade (graphics-lab integrate.js, INTEGRATION.md) ------
  // Single owner of PostFX / DistanceFog / Particles / Water / TorchLights.
  // Our game keeps: the client-owned day/night Sky (facade sky OFF), the
  // adversarially-verified ChunkRenderer meshes (worldMesh OFF), the weather
  // package precip (facade ctx.weather stays 'clear' so its particles never
  // double-spawn rain/snow), and the brand biome grading (facade biome OFF —
  // wired directly onto the facade's PostFX below).
  const GFX_REGION = 96; // provider window (world coords -48..47, spawn-centred)
  const gfxOx = -GFX_REGION / 2;
  const gfxOz = -GFX_REGION / 2;
  const volumeProvider = {
    // World.getBlock is WORLD-space; the provider contract is LOCAL
    // 0..size-1, so offset by the slice origin. Reads follow the live
    // session world across dimension travel (G.world is replaced there).
    getBlock: (x, y, z) => (G && G.world ? G.world : world).getBlock(gfxOx + x, y, gfxOz + z),
    size: { sx: GFX_REGION, sy: CHUNK_SY, sz: GFX_REGION },
    ids: 'builder',
    waterLevel: SEA_LEVEL, // 40 — NOT the lab default 10 (INTEGRATION finding 10)
    emissiveOf: (id) => getBlockDef(id).emissive, // exact registry levels
  };
  const gfx = new GraphicsStack({
    quality: gq === 'off' ? 'medium' : gq,
    texturePack: settings.texturePack,
    dimension: 'warpwold',
    enable: {
      worldMesh: false, // ChunkRenderer streams the chunk meshes
      sky: false, dimensionSky: false, shadows: false, // game Sky owns the light rig
      underwater: false, underwaterfx: false, // no underwater camera path in this build
      ambient: false, // no ambient-life field (kept deterministic for QA)
      biome: false,   // brand grading wired directly below (DIM_GRADE keys)
      wind: false,    // facade materials are unused (our own mesher/materials)
      // water, fog, post, particles, torchlights stay ON
    },
  });
  await gfx.init({
    scene, camera, renderer, volumeProvider,
    // Our chunk water tops render lowered at SEA_LEVEL + 0.9 (ChunkMesher
    // liquid rule); the facade's ANIMATED plane sits a hair above so it is
    // the visible ocean surface, while dry beach columns (terrain top faces
    // at >= SEA_LEVEL + 1) still occlude it.
    waterLevel: SEA_LEVEL + 0.95,
  });
  // The facade's fog defaults to exp2 haze; this game pairs LINEAR fog with
  // the ChunkRenderer fog-culling wall (see updateFog), same as before.
  if (gfx.exposes.fog) gfx.exposes.fog.setMode('linear');
  // Graphics Quality dropdown parity with the pre-facade wiring: 'off'
  // bypasses the chain; the default 'medium' tier keeps SSAO/god rays off
  // (they remain preset-on in high/ultra via PostFX.setQuality).
  if (gq === 'off') gfx.toggle('post', false);
  if ((gq === 'off' ? 'medium' : gq) === 'medium' && gfx.exposes.post) {
    gfx.exposes.post.toggle('ssao', false);
    gfx.exposes.post.toggle('godrays', false);
  }

  // Pack-swap hook, both directions (INTEGRATION Step 3e adapted): the
  // settings-drawer path (hotSwapTexturePack) notifies the facade at its
  // tail; external callers of gfx.setTexturePack (e.g. the acceptance gate)
  // also hot-swap the game's own atlas — ONE call swaps every consumer.
  const facadeSetPack = gfx.setTexturePack.bind(gfx);
  gfx.setTexturePack = (id) => {
    facadeSetPack(id);
    const packId = id == null || id === '' ? 'default' : String(id);
    if (G && G.gfx === gfx && PACKS[packId] && G.pack !== packId) {
      settings.texturePack = packId;
      lastPackSeen = packId; // keep applySettings' pack edge detector coherent
      hotSwapTexturePack(packId);
    }
  };

  // Per-dimension atmosphere: a one-call post-tonemap color grade (it lives
  // entirely inside the facade's PostFX composite — Sky/fog stay untouched).
  const grading = new BiomeGrading(gfx.exposes.post);
  grading.setBiome(DIM_GRADE[dim] || 'sennmeadows');

  const fx = {
    post: gfx.exposes.post,
    fog: gfx.exposes.fog,
    particles: gfx.exposes.particles,
    cracks, viewmodel, grading,
  };

  const chunkRenderer = new ChunkRenderer(scene, world, atlas, {
    fastLighting: quality.fastLighting,
  });

  // --- Game mode + inventory ---------------------------------------------------
  // The world's mode rides the welcome payload (server world meta; older
  // saves default to creative). Creative keeps the original 9-id-slot
  // palette inventory + flight + instant-break-in-flight EXACTLY as before;
  // survival gets the 41-slot stack model, item-entity drops, timed breaking
  // always, and no flight.
  const mode = welcome.world.mode === 'survival' ? 'survival' : 'creative';
  let inventory; // the ACTIVE inventory (published as __game.inventory)
  let invModel = null; // InventoryModel (survival only)
  let crafting = null; // items.json recipe book (survival only)
  let itemEntities = null; // local drop entities (survival only)
  if (mode === 'survival') {
    invModel = new InventoryModel({ items: pack.items() });
    crafting = new Crafting({ items: pack.items() });
    // Restore the per-world snapshot (localStorage v1 — see docs/DEV.md).
    try {
      const raw = localStorage.getItem(INV_KEY_PREFIX + welcome.world.id);
      if (raw) invModel.deserialize(JSON.parse(raw));
    } catch { /* corrupt/unavailable — start empty */ }
    itemEntities = new ItemEntities(scene, {
      getWorld: () => (G && G.world ? G.world : world),
      atlas,
    });
    inventory = invModel;
  } else {
    inventory = new Inventory();
  }
  const iconFor = makeIconFactory(atlas);

  // --- PlayerStack facade (public/avatars-integrate/integrate.js) -----------
  // Replaces `new PeerAvatars(scene)`. Single owner of the NetClient's
  // single-slot onState/onPeerJoin/onPeerLeave/onPeerMove/onChat/onDisconnect
  // callbacks; fans them out to the avatar renderer (PeerAvatarsPlus) AND the
  // social layer (presence roster, hold-Tab list, whisper/mute, toasts,
  // spectator). Built AFTER net.connect (its isSolid needs the live world),
  // so the already-resolved welcome is replayed through the stack's own
  // onState fan-out in the network-handlers section below (the documented
  // INTEGRATION.md fallback path).
  const stack = PlayerStack.init({
    net, scene, camera,
    chat: chatForStack,
    // Live world proxy: S.world is REPLACED on dimension travel, and the
    // facade derives isSolid as getBlockDef(world.getBlock(...)).solid —
    // the exact physics.js formula (camera-block collision oracle).
    world: { getBlock: (x, y, z) => (G && G.world ? G.world : world).getBlock(x, y, z) },
    getBlockDef,
    mount: document.body,
    canvas,
    localName: getPlayerName(),
    localSkin: localSkinDesc,
    getLocalFeet: () => ({ x: S.player.position.x, y: S.player.position.y, z: S.player.position.z }),
    getLocalLook: () => ({ yaw: S.controls.yaw, pitch: S.controls.pitch }),
    getLocalDim: () => S.dim,
    sendWhisper: ({ to, text }) => net.sendWhisper(to, text), // /w -> private relay
  });
  stack.onEmoteTransport((id) => net.sendEmote(id)); // OUTGOING emote wire
  const peers = stack.peersManager; // PeerAvatarsPlus — superset of PeerAvatars

  // Local avatar: hidden in first person, rendered by the F5 third-person rig;
  // plays our own /emote gestures so peers and self see the same motion.
  const localAvatar = createAvatarPlus({
    name: getPlayerName(), descriptor: localSkinDesc, self: true,
  });
  localAvatar.group.name = 'player:self';
  scene.add(localAvatar.group);
  stack.setLocalAvatar(localAvatar);

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
      const prev = S.world.getBlock(x, y, z);
      S.world.setBlock(x, y, z, id);
      recordEdit(S.dim, x, y, z, id);
      S.net.sendEdit(x, y, z, id);
      emittersMarkDirty(prev, id); // portal fills/collapses move light sources
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
    mode, // 'creative' | 'survival' (world meta; QA hook __game.mode)
    inventory, // active inventory: creative Inventory OR the InventoryModel
    invModel, // InventoryModel (null in creative)
    crafting, // Crafting recipe book (null in creative)
    itemEntities, // ItemEntities manager (null in creative)
    invSaveTimer: null, // debounced survival-inventory persistence
    lastFlightHintAt: -Infinity, // survival "no flight" chat-hint throttle
    iconFor,
    stack, // PlayerStack facade (peer avatars + social layer + 3rd-person cam)
    peers, // = stack.peersManager (PeerAvatarsPlus) — kept for QA-hook parity
    localAvatar, // own body: third-person view + local emote playback
    onViewKeys: null, // session F5/F6 keydown handler (assigned below)
    portals,
    outline,
    fx,
    fxCtx,
    gfx,
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
    // Hold-to-break state: held while the left button is down; key/progress
    // track the block being mined (see updateMining / breakTimeFor).
    mining: { held: false, key: null, progress: 0 },
    vmHeld: undefined, // last hotbar block mirrored into the viewmodel
    dead: false, // death screen up; player sim + damage suspended
    // Environmental-hazard state (see environmentTick): fall tracking +
    // lava/drowning damage cadence accumulators.
    fallStartY: null, // highest airborne y since last grounded (null = grounded)
    lavaAcc: 0,
    airLeft: AIR_SECONDS,
    drownAcc: 0,
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
    // Dynamic emitter-light tracker state (graphics-lab emitters — see the
    // rescanEmitters block below). `dirty` forces a rescan on the next frame.
    emitters: {
      handle: null, cx: 0, cz: 0, dirty: true, lastScanAt: -Infinity, lastChunks: -1,
    },
  };
  G = S;

  // --- Dynamic emitter lights (graphics-lab emitters.js, EMITTERS.md) ---------
  // Every EXPOSED emissive block near the player (torch 30 / lantern 31 /
  // glowstone 24 / lava 28 / portal 29) gets a pooled flickering point light
  // in its best ADJACENT AIR cell (the adjacent-air rule — a light registered
  // inside the opaque emitter would illuminate nothing). The scan runs over a
  // sliding window centred on the player; registerEmitterLights speaks LOCAL
  // volume coords, so the register() boundary offsets them back to world
  // space. Rescans: emissive edits (dirty flag), player recentering, and
  // chunk streaming, throttled below.
  const EMITTER_SCAN_XZ = 64;       // scan window edge, blocks
  const EMITTER_SCAN_MIN_S = 2.5;   // min seconds between passive rescans
  const EMITTER_RECENTER_DIST = 16; // player travel that re-centres the window
  const EMITTER_MAX_LIGHTS = 160;   // registration budget (pool draws nearest N)

  function rescanEmitters() {
    const tm = S.gfx.exposes.torches;
    if (!tm) return;
    const px = Math.floor(S.player.position.x + S.player.size.x / 2);
    const pz = Math.floor(S.player.position.z + S.player.size.z / 2);
    const ox = px - EMITTER_SCAN_XZ / 2;
    const oz = pz - EMITTER_SCAN_XZ / 2;
    if (S.emitters.handle) S.emitters.handle.unregister();
    S.emitters.handle = registerEmitterLights({
      volume: {
        // Unloaded chunks read as air (World.getBlock never generates).
        getBlock: (x, y, z) => S.world.getBlock(ox + x, y, oz + z),
        size: { sx: EMITTER_SCAN_XZ, sy: CHUNK_SY, sz: EMITTER_SCAN_XZ },
      },
      // Local scan coords -> world coords at the register boundary.
      torchManager: {
        register: (pos, opts) => tm.register({ x: pos.x + ox, y: pos.y, z: pos.z + oz }, opts),
        unregister: (id) => tm.unregister(id),
      },
      emissiveOf: (id) => getBlockDef(id).emissive,
      minLevel: 8,
      maxLights: EMITTER_MAX_LIGHTS,
    });
    S.emitters.cx = px;
    S.emitters.cz = pz;
    S.emitters.dirty = false;
    S.emitters.lastScanAt = S.elapsed;
    S.emitters.lastChunks = S.chunkRenderer.stats.chunksLoaded;
  }

  /** Flag a rescan when any of the given block ids is an emissive emitter. */
  function emittersMarkDirty(...ids) {
    if (S.emitters.dirty) return;
    for (const id of ids) {
      if (getBlockDef(id).emissive > 0) { S.emitters.dirty = true; return; }
    }
  }

  /** Per-frame emitter upkeep (cheap; the actual scan is throttled). */
  function emittersTick() {
    const em = S.emitters;
    const since = S.elapsed - em.lastScanAt;
    if (em.dirty) {
      if (since >= 0.15 || em.lastScanAt === -Infinity) rescanEmitters();
      return;
    }
    if (since < EMITTER_SCAN_MIN_S) return;
    const px = S.player.position.x + S.player.size.x / 2;
    const pz = S.player.position.z + S.player.size.z / 2;
    const moved = Math.hypot(px - em.cx, pz - em.cz) >= EMITTER_RECENTER_DIST;
    const streamed = S.chunkRenderer.stats.chunksLoaded !== em.lastChunks;
    if (moved || streamed) rescanEmitters();
  }

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
  // PlayerStack owns onState / onPeerJoin / onPeerLeave / onPeerMove / onChat
  // / onDisconnect (the NetClient callbacks are SINGLE-SLOT — re-binding any
  // of them here would clobber the facade; read roster state from
  // stack.presence instead). The welcome resolved before the stack existed,
  // so replay it once through the stack's own onState fan-out (seeds both
  // the avatar renderer and the presence roster), then pin our own dim.
  stack._netCbs.onState(welcome);
  stack.social.presence.setSelfDim(S.dim);

  // Emote / whisper / presence wire additions (docs/PROTOCOL.md §4–5).
  net.onEmote((msg) => stack.receivePeerEmote(msg.id, msg.emote));
  net.onWhisper((msg) => {
    if (msg.echo) return; // our own delivery confirmation — already rendered
    stack.whisper.receiveWhisper({ from: msg.from, text: msg.text });
  });
  net.onPresence((msg) => {
    for (const p of msg.players || []) {
      // Reconcile the roster (covers any missed peer-join) + live pings.
      if (p.id !== net.selfId && !stack.presence.get(p.id)) stack.presence.upsertPeer(p);
      if (Number.isFinite(p.ping)) stack.presence.setPing(p.id, p.ping);
    }
  });

  net.onEdit((msg) => {
    recordEdit(msg.dim, msg.x, msg.y, msg.z, msg.block);
    if (msg.dim === S.dim) {
      const prev = S.world.getBlock(msg.x, msg.y, msg.z);
      S.world.setBlock(msg.x, msg.y, msg.z, msg.block);
      emittersMarkDirty(prev, msg.block);
    }
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
  // (onChat / onDisconnect are PlayerStack-owned: public chat renders through
  // the whisper block-list into our chat module; an unintentional disconnect
  // raises the warn toast + the same system chat line as before.)

  // --- Controls events ---------------------------------------------------------
  controls.on('break', onBreak); // per-click instant actions (attack/portal/fly)
  controls.on('breakStart', () => { S.mining.held = true; });
  controls.on('breakEnd', () => { S.mining.held = false; resetMining(); });
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
  controls.on('toggleFlight', () => {
    if (!gameplayActive()) return;
    if (S.mode === 'survival') {
      // Flight is woven out of survival — the double-space path no-ops with
      // a throttled chat hint instead.
      const now = performance.now();
      if (now - S.lastFlightHintAt >= 3000) {
        S.lastFlightHintAt = now;
        ui.chat.addMessage({
          system: true, text: 'Flight is woven out of survival mode.',
        });
      }
      return;
    }
    S.player.toggleFlight();
  });
  // Q / Ctrl+Q: drop the selected stack as an item entity (survival only;
  // creative has nothing to drop). The E-screen has its own hover-Q path.
  controls.on('drop', (opts) => {
    if (!gameplayActive() || S.mode !== 'survival') return;
    const stack = S.invModel.dropSelected(!!(opts && opts.all));
    if (stack) dropStackAsEntity(stack, { toss: true });
  });
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

  // --- View keys (PlayerStack) ------------------------------------------------
  // F5 cycles first -> third-back -> third-front (rig ray-marches the boom
  // against our isSolid, so the camera never clips into blocks). F6 toggles
  // the free-fly spectator camera (WASD + Space/Ctrl, Shift boost; collides
  // with blocks via the same isSolid oracle). Hold Tab (SocialLayer-owned)
  // shows the player list.
  S.onViewKeys = (e) => {
    if (G !== S || S.paused || S.dead || ui.chat.isOpen() || ui.inventoryUI.isOpen()) return;
    if (e.code === 'F5') {
      e.preventDefault();
      if (S.stack.social.isSpectating()) return; // spectator owns the camera
      S.stack.cycleViewMode();
    } else if (e.code === 'F6') {
      e.preventDefault();
      const on = S.stack.social.toggleSpectator();
      if (on) {
        // Take off from the current eye pose instead of a stale/zero pose.
        S.stack.social.spectator.enable(camera.position, S.controls.yaw, S.controls.pitch);
        clearMovementInput();
      }
      ui.chat.addMessage({
        system: true,
        text: on ? 'Spectator camera on — F6 to return.' : 'Spectator camera off.',
      });
    }
  };
  window.addEventListener('keydown', S.onViewKeys);

  // --- UI per-session state ----------------------------------------------------
  if (mode === 'survival') {
    // Inventory screen session: the full stack UI over the model + the 2x2
    // recipe book. Drops from the screen (hover-Q, overflow on close) spawn
    // item entities; crafting fires the achievement events.
    ui.inventoryUI.setSession({
      mode: 'survival',
      model: invModel,
      crafting,
      onDropStack: (stack) => dropStackAsEntity(stack, { toss: true }),
      onCraft: (result) => {
        audioStack.pickup();
        gameEvents.emit('item:crafted', { itemId: result.id, count: result.count });
        gameEvents.emit('item:collected', { itemId: result.id, count: result.count });
      },
      onSound: () => audio.ui(),
    });
    // Hotbar mirror + debounced per-world persistence on every model change.
    invModel.onChange(() => {
      if (G !== S) return;
      refreshHotbarUI(S);
      if (S.invSaveTimer) clearTimeout(S.invSaveTimer);
      S.invSaveTimer = setTimeout(() => {
        S.invSaveTimer = null;
        saveSurvivalInventory(S);
      }, INV_SAVE_DEBOUNCE_MS);
    });
  } else {
    ui.inventoryUI.setSession({
      mode: 'creative',
      getSlots: () => S.inventory.slots,
      getSelected: () => S.inventory.selected,
      onSelectSlot: (i) => {
        S.inventory.select(i);
        ui.hotbar.setSelected(S.inventory.selected);
      },
    });
    ui.inventoryUI.setBlocks(inventory.creativeBlocks);
  }
  refreshHotbarUI(S);
  ui.hud.setHealth(player.health);
  ui.hud.showCrosshair(true);
  ui.chat.addMessage({
    system: true,
    text: mode === 'survival'
      ? `Joined "${welcome.world.name}" (Survival) — E inventory, Q drop, T chat, F3 debug`
      : `Joined "${welcome.world.name}" — T to chat, E for blocks, F3 for debug`,
  });
  // Server MOTD (deploy env), shown once as a system line on join.
  if (typeof welcome.motd === 'string' && welcome.motd) {
    ui.chat.addMessage({ system: true, text: welcome.motd });
  }

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
    // Any UI takeover (chat/inventory/pause/death) also releases the hold-
    // to-break (the eventual real mouseup still emits a harmless breakEnd).
    S.mining.held = false;
    resetMining();
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

  /** Block id in the player's hand, or null (survival: numeric-id stacks
   *  only — string content items are not placeable blocks). */
  function heldBlockId() {
    if (S.mode === 'survival') {
      const stack = S.invModel.selectedStack;
      return stack && typeof stack.id === 'number' ? stack.id : null;
    }
    return S.inventory.selectedBlock || null;
  }

  /** Spawn a dropped stack as an item entity (survival). `toss` throws it
   *  forward from the eyes (Q-drop); otherwise it pops out at the feet. */
  function dropStackAsEntity(stack, { toss = false } = {}) {
    if (S.mode !== 'survival' || !S.itemEntities || !stack) return;
    const eye = S.player.eyePosition;
    if (toss) {
      const dir = S.camera.getWorldDirection(S.tmpDir);
      S.itemEntities.spawn(stack.id, stack.count,
        { x: eye.x + dir.x * 0.5, y: eye.y - 0.2 + dir.y * 0.5, z: eye.z + dir.z * 0.5 },
        {
          vel: {
            x: dir.x * DROP_TOSS_SPEED,
            y: Math.max(0.5, dir.y * DROP_TOSS_SPEED) + DROP_TOSS_UP,
            z: dir.z * DROP_TOSS_SPEED,
          },
          pickupDelay: DROP_PICKUP_DELAY_S,
        });
    } else {
      S.itemEntities.spawn(stack.id, stack.count,
        { x: eye.x, y: S.player.position.y + 0.6, z: eye.z },
        { pickupDelay: DROP_PICKUP_DELAY_S });
    }
  }

  /** Walk-over pickup callback: route into the stack model; pop + hotbar
   *  flash + "+N" toast + collect events for what actually fit.
   *  @returns {number} how many were taken */
  function tryPickupEntity(id, count) {
    const leftover = S.invModel.add(id, count);
    const taken = count - leftover;
    if (taken > 0) {
      audioStack.pickup();
      const hot = S.invModel.slots.findIndex(
        (slot, i) => i < 9 && slot && slot.id === id);
      if (hot !== -1) ui.hotbar.flash(hot);
      ui.hotbar.showPickup(`+${taken} ${displayNameFor(id)}`);
      // Achievements: numeric block drops collect their canonical material;
      // string ids (mob loot, crafted drops) are already canonical.
      const itemId = typeof id === 'number'
        ? canonBlockIdFor(getBlockDef(id).name)
        : id;
      if (itemId) gameEvents.emit('item:collected', { itemId, count: taken });
    }
    return taken;
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
        if (S.mode === 'survival' && S.itemEntities && pos) {
          // Survival: the loot lands as an item entity (string content id —
          // sack cube); 'item:collected' fires when it is walked over.
          S.itemEntities.spawn(detail.itemId, detail.count || 1,
            { x: pos.x, y: pos.y + 0.4, z: pos.z }, { pickupDelay: 0.4 });
        } else {
          // Creative: instant auto-collect, as before.
          audioStack.pickup(pos || undefined); // gap-fill: 'pop' on loot pickup
          gameEvents.emit('item:collected', { itemId: detail.itemId, count: detail.count });
        }
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
      case 'bossDefeated': {
        audio.levelup();
        if (pos) S.fx.particles.spawnBlockBreak(pos, [0.85, 0.8, 1.0]);
        // Canon defeat line from dialogue.json (per boss); the old hardcoded
        // string stays as the offline fallback.
        const actor = detail.canonicalId === 'molthkin' ? 'molthkin' : 'lastNeedle';
        const event = detail.canonicalId === 'molthkin' ? 'onFelled' : 'onBound';
        ui.chat.addMessage({
          system: true,
          text: pack.dialogueLine(actor, event)
            ?? 'The Last Needle is bound. For a while, it will mend.',
        });
        gameEvents.emit('boss:defeated', {
          canonicalId: detail.canonicalId,
          achievement: detail.achievement,
          victoryTrigger: detail.victoryTrigger,
        });
        break;
      }
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

  /** True when the player AABB overlaps any block with this engine name. */
  function playerOverlapsBlock(name) {
    const p = S.player.position;
    const s = S.player.size;
    const EPS = 1e-4;
    const x0 = Math.floor(p.x + EPS), x1 = Math.floor(p.x + s.x - EPS);
    const y0 = Math.floor(p.y + EPS), y1 = Math.floor(p.y + s.y - EPS);
    const z0 = Math.floor(p.z + EPS), z1 = Math.floor(p.z + s.z - EPS);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (getBlockDef(S.world.getBlock(x, y, z)).name === name) return true;
        }
      }
    }
    return false;
  }

  /**
   * Environmental hazards — the canon death causes the engine can already
   * distinguish (content/deathmessages.json): 'fall' (landing tally with a
   * 3-block grace), 'lava' (molten-skein contact, 4 dmg / 0.5 s) and
   * 'drowning' (eyes under water past a 10 s breath, 2 dmg / s). All three
   * are skipped while flying (creative concession, matching instant-break);
   * 'void_unravel' and 'mob:<id>' causes are wired elsewhere.
   */
  function environmentTick(dt) {
    if (G !== S || S.dead || S.travelInFlight) return;
    const flying = S.player.flying;
    const inLiquid = isInLiquid(S.world, { pos: S.player.position, size: S.player.size });

    // Fall damage: track the highest airborne point; landing tallies it.
    // Liquid (water or the molten skein) breaks the fall without impact.
    if (flying || inLiquid) {
      S.fallStartY = null;
    } else if (!S.player.onGround) {
      S.fallStartY = S.fallStartY == null
        ? S.player.position.y
        : Math.max(S.fallStartY, S.player.position.y);
    } else {
      if (S.fallStartY != null) {
        const dmg = Math.floor(S.fallStartY - S.player.position.y - FALL_SAFE_BLOCKS);
        if (dmg > 0) damagePlayer(dmg, 'fall');
      }
      S.fallStartY = null;
    }

    // Molten skein (engine block 'lava') contact: first touch hits at once,
    // then on a fixed cadence while contact lasts.
    if (!flying && playerOverlapsBlock('lava')) {
      S.lavaAcc -= dt;
      if (S.lavaAcc <= 0) {
        S.lavaAcc = LAVA_TICK_S;
        damagePlayer(LAVA_DAMAGE, 'lava');
      }
    } else {
      S.lavaAcc = 0;
    }

    // Drowning: eyes inside a water block drain breath; empty breath damages
    // once per second until the head surfaces.
    const eye = S.player.eyePosition;
    const eyeInWater = !flying && getBlockDef(
      S.world.getBlock(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z))).name === 'water';
    if (eyeInWater) {
      S.airLeft -= dt;
      if (S.airLeft <= 0) {
        S.drownAcc -= dt;
        if (S.drownAcc <= 0) {
          S.drownAcc = DROWN_TICK_S;
          damagePlayer(DROWN_DAMAGE, 'drowning');
        }
      }
    } else {
      S.airLeft = AIR_SECONDS;
      S.drownAcc = 0;
    }
  }

  /** Death-screen Respawn: re-stitch at the knot (spawn), reset health. */
  function respawnFromDeath() {
    if (G !== S || !S.dead) return;
    S.dead = false;
    S.fallStartY = null; // a pre-death fall never lands on the respawned body
    S.lavaAcc = 0;
    S.airLeft = AIR_SECONDS;
    S.drownAcc = 0;
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

  /**
   * Actually break the block at (x,y,z): synced edit + debris + sound +
   * achievement events + portal-frame collapse. Runs when timed mining
   * completes, or instantly while flying (creative-feel concession).
   */
  function performBlockBreak(x, y, z, id, def) {
    const center = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    S.world.setBlock(x, y, z, 0);
    recordEdit(S.dim, x, y, z, 0);
    S.net.sendEdit(x, y, z, 0);
    emittersMarkDirty(id); // breaking a torch/lantern/glowstone drops its light
    // Debris burst tinted with the broken block's atlas tile + break sound.
    S.fx.particles.spawnBlockBreak(center, blockDebrisColor(S, id));
    audio.blockBreak(id, center);
    // Achievements/events. Survival: the block drops an item entity (simple
    // 1:1 — the block id yields itself; ores yield the ore BLOCK in v1) and
    // 'item:collected' fires at PICKUP time instead. Creative keeps the
    // original instant "collect" on break.
    {
      const canonId = canonBlockIdFor(def.name);
      gameEvents.emit('block:broken', {
        blockId: id, name: def.name, canonId, dim: S.dim,
      });
      if (S.mode === 'survival') {
        S.itemEntities.spawn(id, 1, center, { pickupDelay: 0.4 });
      } else if (canonId) {
        gameEvents.emit('item:collected', { itemId: canonId, count: 1 });
      }
    }
    // Breaking a frame block (obsidian/end stone) collapses adjacent fills.
    if (id in FRAME_TARGETS) S.portals.handleFrameBreak(x, y, z);
    // Brief full-bar flash, then hide (unless a new hold is in progress).
    ui.hud.setBreakProgress(1);
    setTimeout(() => {
      if (G === S && !S.mining.key) ui.hud.setBreakProgress(null);
    }, 140);
  }

  /**
   * Legacy per-click 'break' event (mousedown; also QA's
   * controls._emit('break')). Handles the INSTANT actions only:
   * mob attack, portal collapse, and flight instant-break. Timed mining of
   * normal blocks is driven by breakStart/breakEnd + updateMining below —
   * a tap no longer breaks a block on foot.
   */
  function onBreak() {
    if (!gameplayActive()) return;
    S.fx.viewmodel.swing(); // arm swing on every break click
    // Mob hitboxes take priority over blocks (reach 4 vs block reach 6).
    if (tryAttackMob()) return;
    const t = computeTarget();
    if (!t.hit) return;
    const id = S.world.getBlock(t.x, t.y, t.z);
    const def = getBlockDef(id);
    if (id === PORTAL_BLOCK) {
      // Breaking any portal block collapses the whole connected fill
      // (each cleared cell goes through the synced edit path).
      const center = { x: t.x + 0.5, y: t.y + 0.5, z: t.z + 0.5 };
      S.portals.collapseAt(t.x, t.y, t.z);
      S.fx.particles.spawnBlockBreak(center, blockDebrisColor(S, id));
      audio.blockBreak(id, center);
      ui.hud.setBreakProgress(1);
      setTimeout(() => ui.hud.setBreakProgress(null), 140);
      return;
    }
    if (def.hardness < 0) return; // bedrock & co are unbreakable
    // Creative-feel concession (documented): flight mode breaks instantly.
    if (S.player.flying) performBlockBreak(t.x, t.y, t.z, id, def);
  }

  /** Reset the hold-to-break accumulator (release / retarget / interrupt). */
  function resetMining() {
    if (S.mining.key !== null) {
      S.mining.key = null;
      S.mining.progress = 0;
      ui.hud.setBreakProgress(null);
      S.fx.cracks.clearAll();
    }
  }

  /**
   * Hold-to-break: per-frame progress accumulation while the left button is
   * held (breakStart..breakEnd). Retargeting or releasing resets progress;
   * completion runs performBlockBreak. Skipped entirely while flying (the
   * 'break' click already broke instantly). Hardness -> seconds mapping:
   * breakTimeFor() below.
   */
  function updateMining(dt) {
    if (!S.mining.held || S.player.flying || !gameplayActive()) {
      resetMining();
      return;
    }
    const t = computeTarget();
    if (!t.hit) { resetMining(); return; }
    const id = S.world.getBlock(t.x, t.y, t.z);
    const def = getBlockDef(id);
    const need = breakTimeFor(def);
    if (id === 0 || id === PORTAL_BLOCK || !Number.isFinite(need)) {
      resetMining(); // air, portal (click-collapses), or unbreakable
      return;
    }
    const key = `${t.x},${t.y},${t.z}`;
    if (S.mining.key !== key) { // fresh target (or first frame of the hold)
      S.mining.key = key;
      S.mining.progress = 0;
      S.fx.cracks.clearAll(); // drop the decal left on a previous target
    }
    S.mining.progress += dt / need;
    if (S.mining.progress >= 1) {
      performBlockBreak(t.x, t.y, t.z, id, def);
      S.mining.key = null; // keep holding to start on the next block behind
      S.mining.progress = 0;
      S.fx.cracks.clearAll();
    } else {
      ui.hud.setBreakProgress(S.mining.progress);
      // Progressive crack decal + continuous arm swing while mining.
      S.fx.cracks.showCrack(t.x, t.y, t.z,
        Math.min(4, Math.floor(S.mining.progress * 5)));
      S.fx.viewmodel.swing();
    }
  }

  function onPlace() {
    if (!gameplayActive()) return;
    S.fx.viewmodel.swing(); // arm swing on every place click
    const t = computeTarget();
    if (!t.hit || t.nx == null) return;
    const { nx, ny, nz } = t;
    if (ny < 0 || ny >= CHUNK_SY) return;
    const id = heldBlockId();
    if (!id) return; // empty hand (or a non-block item in survival)
    // Portal blocks never place directly: inside a valid obsidian/end-stone
    // frame they light the whole interior, anywhere else they do nothing
    // but hint (see gameplay/portals.js).
    if (id === PORTAL_BLOCK) {
      if (S.portals.handlePortalPlacement(nx, ny, nz)) {
        gameEvents.emit('portal:lit', { dim: S.dim });
        if (S.mode === 'survival') S.invModel.consumeSelected(1);
      }
      return;
    }
    // Only into air or liquid.
    const curDef = getBlockDef(S.world.getBlock(nx, ny, nz));
    if (!(curDef.id === 0 || curDef.liquid)) return;
    // Torch placement rule: needs solid, non-liquid ground directly below
    // (kept simple per the emitter-blocks spec — no wall mounting).
    if (getBlockDef(id).name === 'torch') {
      const below = getBlockDef(S.world.getBlock(nx, ny - 1, nz));
      if (!below.solid || below.liquid) return;
    }
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
    // Survival: placing consumes one from the selected stack.
    if (S.mode === 'survival') S.invModel.consumeSelected(1);
    emittersMarkDirty(id); // placed torch/lantern/glowstone casts light
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
      pose: S.player.sneaking ? 'sneaking' : 'standing',
      breakProgress: S.mining.progress, // hold-to-break accumulator (0..1)
      targetBlock,
      // Survival: real stack count of the selected slot; creative keeps the
      // original 1/null convention (no stack counts).
      heldCount: S.mode === 'survival'
        ? (S.invModel.selectedStack ? S.invModel.selectedStack.count : null)
        : (S.inventory.selectedBlock ? 1 : null),
      itemEntities: S.itemEntities ? S.itemEntities.list() : [],
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
      // While the spectator free-cam flies (F6), the player body is frozen —
      // the SpectatorCamera owns WASD and the camera until toggled back.
      if (!S.dead && !S.stack.social.isSpectating()) {
        S.player.update(dt, S.controls.input, S.controls.yaw);
        environmentTick(dt); // fall / lava / drowning hazards (canon causes)
        S.portals.update(dt); // dwell-to-travel charging + cooldown
        updateMining(dt); // hold-to-break progress (see breakTimeFor)
        // Survival drops: physics + walk-over pickup (LOCAL-ONLY entities —
        // see docs/PROTOCOL.md "Item entities" v1 note).
        if (S.itemEntities) {
          S.itemEntities.update(dt, {
            x: S.player.position.x + S.player.size.x / 2,
            y: S.player.position.y + S.player.size.y * 0.5,
            z: S.player.position.z + S.player.size.z / 2,
          }, tryPickupEntity);
        }
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

    // Game-owned ctx (cracks/viewmodel; also the source for the facade sync).
    S.fxCtx.elapsed = S.elapsed;
    S.fxCtx.timeOfDay = S.dim === 'overworld' ? timeOfDay : 0.5;
    S.fxCtx.weather = (S.wx.presented === 'rain' || S.wx.presented === 'storm')
      ? 'rain' : S.wx.presented === 'snow' ? 'snow' : 'clear';
    S.fx.cracks.update(dt, S.fxCtx);

    // Dynamic emitter lights: throttled rescan on edits/recenter/streaming.
    emittersTick();
    // View model: keep the held item in sync with the hotbar selection.
    {
      const held = heldBlockId();
      if (held !== S.vmHeld) {
        S.vmHeld = held;
        S.fx.viewmodel.setItem(held ? `block:${held}` : null);
      }
      S.fx.viewmodel.update(dt, S.fxCtx);
    }

    // Crosshair target outline.
    const target = computeTarget();
    if (target.hit) {
      S.outline.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
      S.outline.visible = true;
    } else {
      S.outline.visible = false;
    }

    // Peers + social layer + third-person camera (PlayerStack), then our own
    // third-person body — position/gait mirror the player exactly like a
    // peer's avatar mirrors its move frames (feet min-corner + 0.3 centering).
    S.stack.update(dt);
    {
      const p = S.player.position;
      const v = S.player.velocity;
      S.localAvatar.setPosition(p.x + 0.3, p.y, p.z + 0.3);
      S.localAvatar.setLook(S.controls.yaw, 0);
      S.localAvatar.setVelocity(v.x, v.y, v.z);
      S.localAvatar.update(dt, camera.position);
    }
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

    // GraphicsStack frame: sync the game-owned state into the facade's shared
    // ctx (skyColor exact-tracks our Sky/weather grading so fog matches the
    // horizon; ctx.weather deliberately stays 'clear' — precip visuals belong
    // to the weather package, and syncing it would make the facade Particles
    // double-spawn rain/snow). Then advance every facade-owned module
    // (water waves/reflection, fog, particles, pooled torch lights, PostFX
    // night boost) in the proven demo order and render through the PostFX
    // chain — it self-bypasses to a plain render when Graphics Quality is
    // 'off'. dt 0 while the sim is frozen keeps pause behavior (no drifting
    // debris/flicker under the pause menu).
    {
      const gctx = S.gfx.exposes.ctx;
      gctx.timeOfDay = S.fxCtx.timeOfDay;
      gctx.skyColor.copy(S.fxCtx.skyColor); // water/fog read ctx.skyColor live
      S.gfx.update(simActive ? dt : 0);
      S.gfx.render();
    }

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

  // PlayerStack first (before net.close): dispose noop-swaps its net
  // callbacks, so the intentional close raises no disconnect toast/line.
  // stack.dispose() also disposes the peer avatars (peersManager) and the
  // social layer; the overlay elements it mounted on document.body are
  // removed explicitly (SocialLayer leaves them detached-but-present).
  window.removeEventListener('keydown', S.onViewKeys);
  S.stack.social.playerList?.remove();
  document.querySelector('lf-toast-rack')?.remove();
  S.stack.dispose();
  S.localAvatar.dispose();
  S.net.close();
  S.controls.dispose();
  S.chunkRenderer.dispose();
  S.mobs.dispose();

  // Survival: return any cursor/craft-grid stacks to the model (setSession
  // closes the screen and stashes loose stacks first), then flush the
  // pending inventory save and drop the item entities.
  ui.inventoryUI.setSession(null);
  if (S.invSaveTimer) {
    clearTimeout(S.invSaveTimer);
    S.invSaveTimer = null;
  }
  saveSurvivalInventory(S);
  S.itemEntities?.dispose();

  audio.stopAll(); // music, ambience beds, rain loop, live voices
  S.weather.dispose();
  S.fx.cracks.dispose();
  S.fx.viewmodel.dispose();
  S.fx.grading.dispose(); // detach the grade before its PostFX host goes down
  if (S.emitters.handle) S.emitters.handle.unregister();
  // Facade teardown disposes everything it owns: PostFX, fog, particles,
  // water, torch lights, materials, its pack atlas, and its resize listener.
  // The renderer is page-lifetime (passed in at init) and is left alone.
  S.gfx.dispose();

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
  window.gfx = null;
}

// ---------------------------------------------------------------------------
// Dimension plumbing (portals + pause-menu Travel are the entry points;
// __game.setDimension stays available for QA)
// ---------------------------------------------------------------------------

function applyDimensionEnvironment(dimId) {
  const spec = DIMENSIONS[dimId];
  updateFog();
  // Facade water is overworld-only: the nether "sea" is lava at y~31 and the
  // end floats over void (INTEGRATION.md Step 3c). Emitter lights re-scan
  // against the rebuilt world on the next frame.
  if (G.gfx) G.gfx.toggle('water', dimId === 'overworld');
  G.emitters.dirty = true;
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
  // Item entities belong to the departed world (local-only drops).
  S.itemEntities?.clear();
  S.dim = dimId;
  // Arrival teleport must not inherit pre-travel hazard state (a fall begun
  // in the old dimension never lands on the arrival body).
  S.fallStartY = null;
  S.lavaAcc = 0;
  S.airLeft = AIR_SECONDS;
  S.drownAcc = 0;
  S.fx.grading.setBiome(DIM_GRADE[dimId] || 'sennmeadows');
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
  S.peers.setDimension(dimId); // stack.peersManager visibility filter
  S.stack.social.presence.setSelfDim(dimId); // roster dim badge + feed
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
    // Game mode ('creative' | 'survival', world meta) + the mode's inventory:
    // `inventory` is the ACTIVE inventory (creative Inventory, or the
    // InventoryModel in survival); `inventoryModel` is the survival stack
    // model (null in creative); `itemEntities` is the local drop manager
    // (null in creative); `crafting` is the items.json recipe book.
    mode: G.mode,
    inventory: G.inventory,
    inventoryModel: G.invModel,
    itemEntities: G.itemEntities,
    crafting: G.crafting,
    // DEV hook (survival): grant items straight into the stack model —
    // `__game.grant('loose_thread', 4)` / `__game.grant(2, 64)`. Returns the
    // leftover that did not fit (null in creative).
    grant: (id, count = 1) =>
      (G && G.mode === 'survival' ? G.invModel.add(id, count) : null),
    net: G.net,
    chunkRenderer: G.chunkRenderer,
    sky: G.sky,
    peers: G.peers, // PeerAvatarsPlus (stack.peersManager): count, ids, scene
    // PlayerStack facade: stack.presence (roster), stack.whisper (mute/block),
    // stack.social (player list / spectator / feed), stack.emote(id),
    // stack.cycleViewMode() / setViewMode('first'|'third-back'|'third-front').
    stack: G.stack,
    localAvatar: G.localAvatar, // own third-person body (createAvatarPlus handle)
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
    fx: G.fx, // { post: PostFX, fog: DistanceFog, particles: Particles } (facade-owned)
    gfx: G.gfx, // GraphicsStack facade (also published as window.gfx below)
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
  // INTEGRATION.md Step 1 statement 7 — the named-global convention: the
  // acceptance gate (graphics-lab/verify-integration.mjs) probes the live
  // GraphicsStack through window.gfx (PostFX RT chain, water uniforms,
  // setTexturePack). Cleared in teardownSession.
  window.gfx = G.gfx;
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
