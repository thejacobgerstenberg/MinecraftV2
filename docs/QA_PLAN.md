# QA_PLAN.md — Executable Acceptance-Test Program (P0 / Milestone M0+)

**Audience:** the QA-adversary agent driving a real Chromium browser with Playwright against the first playable PR (and every PR after it).
**Source of truth:** [`docs/PARITY.md`](./PARITY.md) (489-item backlog; the **51 P0 items** are the contract for M0), [`docs/UX_SPEC.md`](./UX_SPEC.md) (screens, HUD anchors, keybinding table, pointer-lock model), [`docs/MULTIPLAYER_PROTOCOL.md`](./MULTIPLAYER_PROTOCOL.md) (WS protocol v1), [`docs/ART_DIRECTION.md`](./ART_DIRECTION.md) (procedural texture packs).
**Coverage guarantee:** §4 maps **all 51 P0 items** to concrete test ids. A P0 item with no passing test is a release blocker for M0.

Result states per test: `PASS` · `FAIL` · `SKIPPED-GATED` (applicability gate unmet — see §1.8) · `BLOCKED` (a prerequisite test failed). Never report SKIPPED-GATED for an M0 fragment — only the deferred sub-check fragments enumerated in §1.8 may gate; the M0 core of every P0 row must PASS.

---

## 1. Harness Preamble — how the QA agent runs

### 1.1 Environment & launch

- **Runner:** Playwright (`playwright` npm package) + system Chromium.
- **Canonical viewport:** `1280×720`, `deviceScaleFactor: 1`. Per UX §0.2 this yields GUI scale **S = 3** (auto), virtual viewport `guiVW = 427`, `guiVH = 240` gp. All device-pixel click math below assumes this viewport; recompute if you change it (`devicePx = gp × S`).
- **Launch:**

```ts
import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true, // "new" headless; WebGL via SwiftShader
  args: [
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',       // Web Audio without extra gestures
    '--disable-frame-rate-limit', '--disable-gpu-vsync', // uncapped rAF for perf tests only
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto('http://localhost:5173/?qa=1');          // qa=1 enables window.__qa (§1.4)
```

- If `#gl-canvas` renders black in headless (WebGL init failure), rerun headed under `xvfb-run -s "-screen 0 1280x720x24"`. Perf budgets (§3) must be measured with the flags above **and** in-game `vsync=off`, `maxFramerate=Unlimited` (UX §4.2).
- **CDP access** (perf metrics, WS frame sniffing, raw input): `const cdp = await ctx.newCDPSession(page);`
- **Client dev server** at `http://localhost:5173`; **game server** for S9 at `ws://localhost:25565` (UX §9 default port). Exact launch commands, readiness probes, and teardown are **normative** — see §1.10; the builder MUST keep those entry points working verbatim.
- **One browser config serves the entire suite** — the uncap flags above stay on for the §2 functional scenarios too. This is safe because every §2 behavioral assertion is either tick-based (1 game tick = 50 ms wall clock, independent of frame pacing) or wall-clock-based (e.g. QA-S5-10's fade poll, QA-S1-02's 500 ms diff); none depend on the frame regime. Do NOT relaunch with different flags between §2 and §3. §3 perf numbers additionally require in-game `vsync=off` / `maxFramerate=Unlimited` and the §3 uncap sanity check.

### 1.2 Pointer lock & input synthesis

- **Capture:** gameplay input requires Pointer Lock on `#gl-canvas` (UX §10.1). Click the canvas center to capture, then verify:

```ts
await page.mouse.click(640, 360);
await page.waitForFunction(() => document.pointerLockElement?.id === 'gl-canvas');
```

- Opening any screen (`Esc`, `KeyE`, chat `KeyT`) releases lock; closing it re-requests lock — **but under automation the re-request usually fails**: Chromium grants `requestPointerLock` only during transient user activation, and an `Escape` keydown does not confer activation. Always run this recovery helper after closing any screen, before synthesizing look/movement:

```ts
async function ensureLocked(page) {                    // call after EVERY screen close
  for (let i = 0; i < 5; i++) {
    if (await page.evaluate(() => __qa.isPointerLocked())) return;
    await page.mouse.click(640, 360);                  // click = user activation → lock re-request
    try {
      await page.waitForFunction(() => document.pointerLockElement?.id === 'gl-canvas',
                                 null, { timeout: 1500 });
      lookHome();                                      // §1.2 lookDelta: re-home virtual cursor on (re)lock
      return;
    } catch { await page.waitForTimeout(1600); }       // absorb Chromium's pointer-lock re-entry cooldown (~1.25 s)
  }
  throw new Error('pointer lock unrecoverable — file as harness blocker');
}
```
- **Keyboard:** `page.keyboard.down/up/press('<KeyboardEvent.code>')` — Playwright accepts `code` values (`KeyW`, `Space`, `ShiftLeft`, `ControlLeft`, `Digit1`…`Digit9`, `KeyE`, `KeyQ`, `KeyF`, `KeyT`, `Slash`, `Tab`, `F1`, `F3`, `F5`, `Escape`) exactly as in the UX §11 keybinding table. Hold durations are given in ms; **1 game tick = 50 ms** (PARITY global constants).
- **Mouse buttons:** `page.mouse.down({ button: 'left'|'middle'|'right' })` ⇄ UX `Mouse0/Mouse1/Mouse2` (attack / pickBlock / use).
- **Relative look (pointer-locked):** while locked, Chromium synthesizes `movementX/Y` from the coordinate deltas of successive `mouseMoved` events. Playwright's `page.mouse.move(x, y, { steps })` works, but for exact deltas use CDP `Input.dispatchMouseEvent`:

```ts
// The virtual cursor MUST persist across calls: while pointer-locked, Chromium synthesizes
// movementX/Y from the coordinate deltas of CONSECUTIVE mouseMoved events. Resetting to
// (640,360) inside each call would inject a spurious delta equal to the previous call's
// total travel and blow the ±1.5–2° tolerances of QA-S3-01 / QA-S10-07.
let vcx = 640, vcy = 360;                                // module-level virtual cursor
function lookHome() { vcx = 640; vcy = 360; }            // ONLY on (re)acquiring pointer lock —
                                                         // lock re-entry resets Chromium's delta baseline
async function lookDelta(cdp, dxPx, dyPx, steps = 10) {  // deltas sum to dxPx/dyPx
  await rehomeIfNearEdge(cdp);                           // see below
  for (let i = 0; i < steps; i++) {
    vcx += dxPx / steps; vcy += dyPx / steps;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vcx, y: vcy, buttons: 0 });
  }
}
// Edge clamping: if the NEXT sweep could leave [64..1216]×[64..656], re-home first. A jump
// while locked injects a real look delta, so snapshot the camera and restore it via setLook:
async function rehomeIfNearEdge(cdp) {
  if (Math.abs(vcx - 640) < 400 && Math.abs(vcy - 360) < 250) return;
  const { yaw, pitch } = await page.evaluate(() => __qa.getYawPitch());
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 360, buttons: 0 });
  vcx = 640; vcy = 360;
  await page.evaluate(([y, p]) => __qa.setLook(y, p), [yaw, pitch]); // undo the spurious delta
}
```

  Expected yaw change per pixel at sensitivity 100% (UX §10.2): `f = 1.0*0.6+0.2 = 0.8`, `factor = 0.8³·8 = 4.096`, `degPerPixel = 4.096·0.15 = 0.6144°`. Mouse right (+x) ⇒ yaw increases; mouse down (+y, invertY off) ⇒ pitch increases (look down), pitch clamped ±89.9°.
- **Deterministic aiming** — do NOT chase pixels; use the `__qa.setLook` hook, then confirm the target:

```ts
function aimAt(qaEye, tx, ty, tz) {           // block coords; aims at cell center
  const dx = tx + 0.5 - qaEye.x, dy = ty + 0.5 - qaEye.y, dz = tz + 0.5 - qaEye.z;
  const yaw = (Math.atan2(-dx, dz) * 180 / Math.PI + 360) % 360;   // 0=south(+Z), 90=west(−X)
  const pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI; // + = down
  return { yaw, pitch };
}
// await page.evaluate(([y,p]) => __qa.setLook(y,p), [yaw, pitch]);
// assert __qa.getTargetedBlock()?.pos deep-equals [tx,ty,tz] BEFORE pressing a mouse button
```

### 1.3 Reading game state

Three channels, in order of preference:

1. **`window.__qa` test hook** (§1.4) — numeric truth (positions, blocks, light, net stats).
2. **DOM overlay** (UX §0.1): `#app > #gl-canvas / #hud-root / #screen-root / #toast-root`, plus `#overlay-root` (UX §5.15). Screens are `section.screen` inside `#screen-root`; exactly 0 or 1 active. Buttons/fields are real DOM — select by accessible text (`page.getByRole('button', { name: 'Singleplayer' })`) using the **exact labels from UX §§1–9** (`Singleplayer`, `Multiplayer`, `Options...`, `Create New World`, `Play Selected World`, `Done`, `Cancel`, `Direct Connection`, `Join Server`, `Reset Keys`, tab names `Game|World|More`, …). World rows are `.world-row` in `#world-list`; server rows `.server-row`; pack cards `.pack-card`; text fields `.ui-textfield`.
3. **F3 debug overlay** (UX §5.14) — toggle with `F3`; parse the left-column monospace lines: `FPS:`, `C: <renderedSections>/<totalSections>` (UX §5.14 line 4), `E: <renderedEntities>/<totalEntities>` (line 5), `XYZ: <x> / <y> / <z>` (3 decimals), `Block: <bx> <by> <bz>`, `Chunk: <cx> <cy> <cz> in <rx> <ry> <rz>`, `Facing: <cardinal> (<axis>) (<yaw> / <pitch>)`, `Biome: <id>`, the `(Day <n>)` suffix of the `Local Difficulty:` line (line 14; regex `/\(Day (\d+)\)/`), `Light: <total> (<sky> sky, <block> block)`, server `ms tick / TPS`, a line matching `/^Seed: (.+)$/` (dev builds surface the world seed in F3 — PARITY §27 requires it; parse by prefix anywhere in the overlay), and the right-column `Mem:` + Targeted Block section. Every state-bearing screenshot must include F3 in frame.

### 1.4 The `window.__qa` test-hook contract (builder MUST implement)

Exposed only when the page URL has `?qa=1` **and** the build is a dev build. Mutators route through the normal server-authoritative paths (they are dev commands, not client-side hacks) and are enabled as follows — **multiplayer:** the dedicated server was started with `--qa`; **singleplayer:** the world has **Allow Cheats ON** *and* the page URL has `?qa=1` — the integrated singleplayer sim treats cheats-ON + `?qa=1` as its `--qa` equivalent. WORLD_A/WORLD_B (§1.7) are created cheats-ON precisely to unlock mutators; all singleplayer staging in S2–S6/S8 relies on this rule. All getters are synchronous, side-effect-free snapshots of the latest client state. **Everything marked (M0) is required in the first playable PR** — several M0 tests depend on it.

```ts
interface QaHook {
  version: 1;                                                   // (M0) bump on breaking change
  getCaps(): string[];                                          // (M0) implemented-feature tokens, §1.8

  // ---- screens / input ----
  getScreen(): string | null;            // (M0) active ScreenId (UX §0.4) or null = in-world
  isPointerLocked(): boolean;            // (M0)
  setLook(yawDeg: number, pitchDeg: number): void;              // (M0) hard-set camera look

  // ---- local player ----
  getPlayerPos(): { x: number; y: number; z: number };          // (M0) feet position, doubles
  getPlayerVel(): { x: number; y: number; z: number };          // (M0) blocks/tick
  getYawPitch(): { yaw: number; pitch: number };                // (M0)
  getPose(): 'standing'|'crouching'|'swimming'|'fall_flying'|'sleeping'|'spin_attack'|'long_jumping'|'dying'|'sitting'; // (M0)
  getEyeHeight(): number;                                       // (M0) 1.62 / 1.27 / 0.4 by pose
  getAABB(): { w: number; h: number };                          // (M0) current hitbox
  onGround(): boolean; isFlying(): boolean;                     // (M0)
  isSprinting(): boolean; isSneaking(): boolean;                // (M0)
  getGameMode(): 'survival'|'creative'|'adventure'|'spectator'|'hardcore'; // (M0)

  // ---- world ----
  getBlock(x: number, y: number, z: number): string;            // (M0) block id; 'air' for y outside [-64,319].
                                                                //   For a column whose sections are NOT loaded it also
                                                                //   returns 'air' — callers MUST gate on isColumnLoaded
                                                                //   first (see the §1.7 post-tp wait recipe)
  isColumnLoaded(x: number, z: number): boolean;                // (M0) true iff the chunk column at (x,z) has streamed in
  getBlockState(x: number, y: number, z: number): { block: string; props: Record<string, string|number|boolean> }; // (M0)
  getBlockDef(id: string): Record<string, unknown>;             // (M0) the shared BlockDef record
  getItemDef(id: string): Record<string, unknown>;              // (M0) the shared ItemDef record
  getLight(x: number, y: number, z: number): { sky: number; block: number }; // (M0)
  getBiome(x: number, y: number, z: number): string;            // (M0)
  getHeightmapAt(x: number, z: number): number;                 // (M0) highest non-air y
  getSeed(): string;                                            // (M0) world_info.seed string
  getWorldTime(): number; getGameTick(): number;                // (M0)
  getDimension(): { id: string } & Record<string, unknown>;     // (M0) DimensionType record
  getLoadedSectionCount(): number;                              // (M0)
  getSection(cx: number, sy: number, cz: number): { paletteSize: number; nonAirCount: number } | null; // (M0)
  prngSample(kind: 'legacy'|'xoroshiro', seed: string, n: number): string[]; // (M0) known-answer probe: first n raw
    // outputs as decimal strings. kind 'legacy' = java.util.Random(seed).nextInt() sequence (signed 32-bit,
    // PARITY §1.2 constants); kind 'xoroshiro' = xoroshiro128++ next() u64 sequence. For 'xoroshiro', seed
    // 'state:<s0>,<s1>' bypasses seed expansion and sets the raw 128-bit state (tests the core algorithm
    // independent of the world-seed→state derivation); a plain seed uses the engine's normal derivation.

  // ---- inventory / HUD ----
  getHeldItem(): { id: string; count: number } | null;          // (M0)
  getSelectedSlot(): number;                                    // (M0) 0..8
  getHotbar(): ({ id: string; count: number } | null)[];        // (M0) length 9
  getInventorySlot(key: string): { id: string; count: number } | null; // (M0) key space of §1.5
  getCursorStack(): { id: string; count: number } | null;       // (M0) GUI carried stack
  getTargetedBlock(): { pos: [number, number, number]; face: string } | null; // (M0)
  getBreakProgress(): number;                                   // (M0) 0..1 while mining
  getAttackCooldown(): number;                                  // (M0) 0..1 attack-charge progress — the same
                                                                //   attackCooldownProgress that drives the UX §5.7 arc

  // ---- entities ----
  getEntities(type?: string): { id: number; type: string; pos: {x:number;y:number;z:number}; vel: {x:number;y:number;z:number}; ageTicks?: number }[]; // (M0; 'item' type at minimum)
    // Coverage: every entity the client currently knows of — singleplayer: all entities in loaded sections;
    // multiplayer: the server's interest set for this client (entities inside their tracking range).
    // An empty result outside those bounds is NOT evidence of despawn — keep probes inside coverage.
  getRemotePlayers(): { entityId: number; name: string; pos: {x:number;y:number;z:number}; pose: string; sneaking: boolean; sprinting: boolean; swinging: boolean }[]; // (M0)
    // swinging mirrors Snapshot flags2 bit 0x0008 swingArm (protocol §4.4.2); true while a swing anim plays
  getHealth(): { health: number; absorption: number; food: number; air: number; armor: number } | null; // (gate: damage, ≥ M1)
    // mirrors the latest protocol `set_health` (msg 50); null before the first update
  getLastHurt(): { tick: number; sourceType: string } | null;   // (gate: damage, ≥ M1) last `entity_hurt`
    // (msg 53) received for the LOCAL player; tick = getGameTick() at receipt

  // ---- perf / net ----
  getFps(): number;                                             // (M0) 1s EMA
  getFrameTimesMs(n: number): number[];                         // (M0) last n frame durations
  getNetStats(): { connected: boolean; rttMs: number | null; lastPingAtMs: number | null;
                   bytesInPerSec: number; bytesOutPerSec: number } | null; // (M0; null in singleplayer)
  getServerTps(): number | null; getMspt(): number | null;      // (M0) mirrors F3 line 3
  getLastEditResult(): { editId: number; status: 'applied'|'rejected'; code?: string; rttMs: number } | null; // (M0)
  getChatLog(n: number): { text: string; system: boolean; from?: string }[]; // (M0)

  // ---- rendering / packs ----
  getCameraFov(): number;                                       // (M0)
  getActiveTexturePack(): string;                               // (gate: texturePacks)
  getAtlasHash(): string;                                       // (gate: texturePacks) sha of atlas canvas pixels
  getAtlasTile(blockId: string): number[];                      // (gate: texturePacks) 16*16*4 RGBA of a tile
  getAudio(): { ctxState: string; gains: Record<string, number> } | null;   // (gate: audio)
  getAudioRms(): number;                                        // (gate: audio) AnalyserNode RMS at destination

  // ---- recorder (M0) — per-tick sampling without RTT noise ----
  recordTicks(n: number): Promise<{ tick: number; pos: {x:number;y:number;z:number};
    vel: {x:number;y:number;z:number}; onGround: boolean; pose: string;
    breakProgress: number; targetBlock: string | null;
    heldCount: number | null;                                   // count of the held stack (null if empty hand)
    itemEntities: { id: number; itemId: string; count: number;  // all 'item' entities in coverage this tick —
                    pos: {x:number;y:number;z:number} }[] }[]>; // tick-resolution channel for QA-S4-02/QA-S4-20

  // ---- settings (client-side; dev build + ?qa=1 only, no --qa needed) ----
  setSetting(key: string, value: number|string|boolean): void;  // (M0) set any settings value by its storage key
    // (e.g. 'video.renderDistance', 'video.fov', 'video.brightness', 'video.guiScale', 'video.smoothLighting',
    // 'mouse.sensitivity', 'audio.master', 'audio.blocks'); applies EXACTLY as if changed via its UI control
    // (live-apply + persistence included). This is the only sanctioned way to set slider widgets to exact values.

  // ---- dev mutators (M0; server-validated, gated per the preamble above) ----
  tp(x: number, y: number, z: number): Promise<void>;
  give(itemId: string, count: number): Promise<void>;
  setBlock(x: number, y: number, z: number, blockId: string): Promise<void>; // triggers normal neighbor updates/light/fluid
  setGameMode(mode: 'survival'|'creative'): Promise<void>;
  setTime(worldTime: number): Promise<void>;
  setTestCollider(x: number, y: number, z: number, height: number): Promise<void>; // (M0) place an invisible
    // collision-only test box filling the cell's footprint from its floor up to `height` blocks (0 < height ≤ 1);
    // height 0 removes it. QA staging only (step-up/collision probes, QA-S3-07); never persisted, never rendered.
}
```

### 1.5 QA DOM contract (additive `data-` attributes; not a UX change)

So slot interactions are clickable without pixel math, the builder MUST stamp:

- Every interactive inventory/container slot: `data-slot="<key>"` where key ∈ `hotbar0..hotbar8`, `main9..main35`, `armor.head|armor.chest|armor.legs|armor.feet`, `offhand`, `craft0..craft3` (2×2) / `craft0..craft8` (3×3), `craftResult`, and container slots `c0..c{N-1}` (window-scoped). Same key space as `__qa.getInventorySlot`.
- Creative screen (UX §6.3): source-grid slots `data-slot="creative0".."creative44"` (9×5 visible grid, row-major from top-left), the destroy/trash slot `data-slot="creativeDestroy"` (bottom-right of the grid), and every tab button `data-tab="<name>"` with name = the exact UX §6.3 tab label (`Building Blocks`, …, `Search`, `Survival Inventory`, `Saved Hotbars`).
- The active screen section: `data-screen="<ScreenId>"` (UX §0.4 ids).
- HUD hotbar slots: `data-hotbar-slot="0".."8"` on the 9 hotbar cells inside `#hud-root`; the hotbar **container** element (the 182×22 gp sprite, UX §5.1) gets `data-hud="hotbar"`.
- HUD item-name popup (UX §5.13): id `#hud-itemname` on the fading item-name element.
- Title screen: id `#splash-text` on the splash-text element (UX §2.1).
- Tab player-list overlay (UX §5.17): panel id `#tab-list`; one `.tab-row[data-name="<displayName>"]` per player; the 5-bar ping icon inside each row carries `data-ping-bars="0".."5"` (lit-bar count).
- Settings controls: every control row (slider/toggle/cycle) gets `data-setting="<key>"` using the same key space as `__qa.setSetting` (e.g. `data-setting="video.renderDistance"`). Tests SET values via `__qa.setSetting` and use `[data-setting]` only to assert the UI reflects the value — never drag slider knobs.
- Texture-pack switcher (UX §7): inside each `.pack-card`, real (always-in-DOM, hover-revealed) buttons `[data-pack-action="move"]` (shift between Available/Selected), `[data-pack-action="up"]`, `[data-pack-action="down"]` (reorder within Selected); the live-preview canvas has id `#pack-preview-canvas`.

Click helper: `const b = await page.locator('[data-slot="main9"]').boundingBox()` → click its center. Cross-check geometry against UX §6.0 (`guiLeft = floor((427−W)/2)`, slot centers at `(guiLeft+sx+9, guiTop+sy+9) gp × S` — for the 176×166 survival inventory at S=3: `guiLeft=125`, `guiTop=37`).

### 1.6 Screenshot conventions

- Format: **PNG**, viewport capture (`page.screenshot()` — never `fullPage`), saved to **`qa/<scenario-id>/<test-id>-<slug>.png`** (e.g. `qa/S4/QA-S4-04-stone-wood-pick.png`). Lowercase-hyphen slugs; one file per named screenshot; retakes overwrite.
- Every state-bearing screenshot must have the **F3 overlay open** and the stated subject centered (aim with `setLook` first). Screens/GUI screenshots must show the full `section.screen`.
- **Determinism:** before visual comparisons, `__qa.setTime(6000)` (noon) and use a world created with `doDaylightCycle=false` (fixture WORLD_B). Never assert whole-image pixel equality on world views (water/lava animate per ART §5.32); assert on **regions** or on numbers from `__qa`.

### 1.7 Fixtures

| Fixture | Definition |
|---|---|
| `WORLD_A` | Singleplayer world: name `qa-main`, seed `8675309`, Game Mode **Survival**, Difficulty Normal, Allow Cheats **ON**, World Type Default. |
| `WORLD_B` | name `qa-vis`, seed `8675309`, **Creative**, cheats ON, Game Rules → `doDaylightCycle=false`. For visual/physics staging. |
| `SERVER_1` | Dev game server on `ws://localhost:25565`, seed `8675309`, default gamemode survival, view distance 8, **simulation distance 6**, started with `--qa`. Launch/readiness/teardown per §1.10. |
| `PROBES` | Column set `{(0,0), (37,−12), (100,100), (−64,64), (255,−255), (1024,0)}`. Column **signature** = for each (x,z): `h=getHeightmapAt(x,z)` plus block ids at `(x,h−1,z), (x,h−5,z), (x,0,z), (x,−30,z), (x,−64,z)`. **Load-wait rule (mandatory):** distant probe columns are not streamed in at read time and `getBlock` would silently record `'air'` — after each `__qa.tp(x, 200, z)` run `await page.waitForFunction(([x,z]) => __qa.isColumnLoaded(x,z), [x,z], { timeout: 15000 })` (equivalently wait for `getSection(⌊x/16⌋, 0, ⌊z/16⌋) !== null`) **before** sampling the signature. |
| `RUNWAY` | In WORLD_B creative: `__qa.tp(0,120,0)`, then `setBlock` a stone strip `y=99`, `x∈[−5..60]`, `z∈[−1..1]`, clear 3 air above. Physics tests stand at `(0,100,0)` facing east (yaw 270). |

### 1.8 Applicability gates

Each scenario/test declares a gate. Evaluate gates mechanically via `__qa.getCaps()` tokens (builder maintains the list): `slabs`, `ice`, `torch`, `sapling`, `bucket`, `waterlogging`, `audio`, `subtitles`, `texturePacks`, `commands`, `commands.tick`, `crafting`, `mobs`, `nether`, `enderChest`, `stack16Items`, `damage` (hurt/health feedback: `set_health`/`entity_hurt` wired to `getHealth`/`getLastHurt`), `savedToolbars` (creative Saved Hotbars tab + `C`/`X` keys). Every gate in this plan names a cap token — a bare "milestone ≥ M1" with no token is a plan bug; if you hit one, treat the test as gated on the nearest named token and file a plan issue. A gated test whose cap is absent reports `SKIPPED-GATED` with the missing token.

Milestone tags follow PARITY §32: **M0** = the **M0 core** of every P0 matrix row (first playable PR), **M1** = +P1, **M2** = +P2. Named sub-checks of a P0 row may gate ≥ M1/M2 **only** where the §4 matrix Notes column says so. The deferred P0 fragments are **exactly** these — everything else in a P0 row is M0 and must PASS:

- row 2 — "Nether lava sea y=31" (`nether`, ≥ M2); "End sea y=0" (untestable until P3 End — annotate, never FAIL).
- row 13 — Nether DimensionType record via QA-S7-02 (`nether`, ≥ M2); the shared-type/overworld half is M0.
- row 18 — runtime instant break (`torch`/`sapling`, ≥ M1); see the row note for what M0 actually proves.
- row 21 — waterlogging via QA-S4-14 (`slabs`+`waterlogging`, ≥ M1).
- row 24 — 16-cap stack items via QA-S5-08 (`stack16Items`, ≥ M1).
- row 29 — ice slipperiness via QA-S3-10(b) (`ice`, ≥ M1).
- row 31 — the **slab** step-up variant QA-S3-07(b) (`slabs`, ≥ M1) — the positive step-up behavior itself is verified at M0 via the QA-S3-07(a2) test collider.
- row 34 — entity-interaction half via QA-S9-11 (`damage`, ≥ M1).
- row 42/44 — creative toolbar save/load only (`savedToolbars`, ≥ M1).
- row 43 — ender-chest 27-slot sub-check (`enderChest`, ≥ M1).
- row 48 — the `/tick` command family via QA-S9-09/QA-S9-12 (`commands.tick`).

A QA agent must never report SKIPPED-GATED for any fragment not on this list.

### 1.9 Common measurement recipes

- **Tick-accurate motion:** `const s = await page.evaluate(() => __qa.recordTicks(100))` → speed b/s = `hypot(Δx,Δz) / (ticks/20)`.
- **Break timing:** start `recordTicks`, then `page.mouse.down()`; ticks-to-break = count of samples from first `breakProgress > 0` until `getBlock(target)==='air'`. Expected ticks = `ceil(30·hardness/speed)` if harvestable else `ceil(100·hardness/speed)` (PARITY §4.1; bare hand speed 1.0).
- **Frame timing:** in-page rAF sampler (§3) or `__qa.getFrameTimesMs`.
- **WS frames:** `cdp.send('Network.enable')`, listen `Network.webSocketFrameSent/Received`; text frames = JSON (`t` discriminator), binary frames arrive base64 — decode first byte = opcode (protocol §2.2).

### 1.10 SUT launch & teardown (normative)

The builder MUST provide these exact entry points from the repo root and keep them working on every PR; the QA agent runs them verbatim:

- **Client dev server:**
  `npm run dev` → serves the client at `http://localhost:5173`.
  **Readiness probe:** `curl -sf -o /dev/null http://localhost:5173/` returns HTTP 200 within **60 s** of launch; retry at 1 s intervals.
- **Game server (SERVER_1):**
  `npm run server -- --qa --port 25565 --seed 8675309 --gamemode survival --view-distance 8 --sim-distance 6`
  → authoritative WS server on `ws://localhost:25565`. Flag syntax is normative (long flags, `--flag value`).
  **Readiness probe:** a WebSocket client completes the open handshake against `ws://localhost:25565` within **30 s** (e.g. `node -e "const ws=new (require('ws'))('ws://localhost:25565'); ws.on('open',()=>{ws.close();process.exit(0)}); ws.on('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),30000)"`); retry at 1 s intervals.
- **Teardown (reverse order):** close all Playwright contexts/browser → send `SIGTERM` to the game server (it must flush world state before exit) → `SIGTERM` the dev server. Wait up to 10 s per process, then `SIGKILL`. Singleplayer persistence (S8) lives in the browser's IndexedDB and is unaffected by teardown order.

---
## 2. Scenario Walkthroughs (ordered as a playthrough)

Test ids are `QA-S<k>-<nn>`. "Verifies" quotes the PARITY P0 line fragment(s) the test discharges (see matrix §4).

---

### S1 — First launch & title screen

**Purpose:** boot sanity, title screen per UX §2.1, harness self-check.
**Applicability:** milestone ≥ M0.
**Setup:** fresh browser context (empty IndexedDB/localStorage), `page.goto('http://localhost:5173/?qa=1')`.

- **QA-S1-01 — boot & title layout.**
  **Steps:** wait for `section.screen[data-screen="title"]`. Assert buttons `Singleplayer`, `Multiplayer` (200×20 gp ⇒ 600×60 device px ±2), half-row `Options...`, `Quit Game`, version string bottom-left matching `/^MinecraftV2 v\d+\.\d+\.\d+$/`.
  **Pass:** all elements present; no console errors of severity error during boot (capture `page.on('console')`).
  **Screenshot:** `qa/S1/QA-S1-01-title.png` — full title screen: logo band, splash, both button rows, version footer.
- **QA-S1-02 — panorama + splash animate.**
  **Steps:** two screenshots 500 ms apart; diff the canvas region behind `#screen-root`. Read `page.locator('#splash-text').boundingBox()` (§1.5 id) at the same two instants.
  **Pass:** >0.5% of canvas pixels changed (rotating panorama, UX §2.1); splash scale oscillates — the `#splash-text` bounding-box width or height differs by **≥ 2 device px** between the two reads (UX §2.1 scale swing is 5%; if the two reads land on the same oscillation phase, retry once at +300 ms).
  **Screenshots:** `qa/S1/QA-S1-02-panorama-t0.png` and `qa/S1/QA-S1-02-panorama-t500.png` (one per capture).
- **QA-S1-03 — `__qa` hook contract.**
  **Steps:** `page.evaluate(() => ({ v: __qa.version, caps: __qa.getCaps(), screen: __qa.getScreen() }))`.
  **Pass:** `version === 1`; `screen === 'title'`; every (M0) member of §1.4 is a function (enumerate and typecheck). **FAIL here blocks the entire run — file as P0 blocker.**
- **QA-S1-04 — settings round-trip from title.**
  **Steps:** click `Options...` → `data-screen="settings"`; click `Done` → back to `title` (UX §1 flow: Settings pops to whichever pushed it).
  **Pass:** screen stack returns to `title`; `Esc` on title does not crash.
  **Screenshot:** `qa/S1/QA-S1-04-settings-root.png`.

---

### S2 — Create world (name/seed/gamemode) & enter

**Purpose:** create-world flow (UX §2.3), seed handling, worldgen P0s, F3 overlay, dimension/section model.
**Applicability:** milestone ≥ M0.
**Setup:** from title: `Singleplayer` → `worldSelect` → `Create New World`.

- **QA-S2-01 — create-world form defaults.**
  **Steps:** on `data-screen="createWorld"`: read `World Name` field (default `New World`); Game tab: `Game Mode` cycle shows `Survival`, `Difficulty` `Normal`, `Allow Cheats` `OFF`; World tab: `Seed` placeholder `Leave blank for a random seed`, `World Type: Default`, `Generate Structures: ON`, `Bonus Chest: OFF`. Cycle Game Mode → Creative → Hardcore (Difficulty locks to Hard, cheats forced OFF+disabled) → back to Survival.
  **Pass:** all defaults per UX §2.3; Hardcore lock behavior observed.
  **Screenshot:** `qa/S2/QA-S2-01-createworld-tabs.png` (Game tab visible).
- **QA-S2-02 — seed parsing (numeric / string-hash / blank). Verifies:** *"World seed = signed 64-bit long; numeric string→parse long; non-numeric→Java `String.hashCode()`"*.
  **Steps:** create three worlds: (a) name `qa-main`, seed `8675309`, survival, cheats ON (= WORLD_A); (b) name `qa-strseed`, seed `qa-seed`; (c) name `qa-randseed`, seed blank. Enter each, read `__qa.getSeed()`, quit to title.
  **Pass:** (a) `"8675309"`. (b) equals `String(javaHash('qa-seed'))` where `javaHash(s) = s.split('').reduce((h,c)=>(Math.imul(31,h)+c.charCodeAt(0))|0, 0)` (sign-extended 32-bit int as decimal string). (c) non-empty, parses as integer, ≠ (a) and ≠ (b).
- **QA-S2-03 — enter world; default terrain is noise terrain. Verifies:** *"**Default** (`minecraft:normal`)"* + chunk-streaming spiral (initial load).
  **Steps:** in `worldSelect` double-click row `qa-main`. Time from double-click → `__qa.getScreen()===null && isPointerLocked()===false` (in-world, click-to-play state) and `getLoadedSectionCount() ≥ 100`. Then sample `getHeightmapAt` over the 32×32 columns around spawn.
  **Pass:** in-world ≤ 10 s (cross-ref PERF-01); heightmap has ≥ 3 distinct values and range ≥ 2 (not superflat).
  **Screenshot:** `qa/S2/QA-S2-03-first-spawn.png` — in-world, hotbar + crosshair visible.
- **QA-S2-04 — F3 debug overlay content. Verifies:** *"Debug F3 overlay: XYZ, chunk-relative, facing/yaw/pitch, biome, light … FPS, chunk/entity counts, memory, seed, targeted block"* and chunk math of *"Chunk = 16×16 … 16×16×16 sections"*.
  **Steps:** click canvas (pointer lock), press `F3`. Parse left column; cross-check every line against `__qa`: `XYZ` == `getPlayerPos()` (3 decimals), `Block` == floor of pos, `Chunk: cx cy cz` where `cx=floor(x/16)`, `cy=floor(y/16)` ∈ [−4,19], `rx=((bx%16)+16)%16`; `Facing` matches `getYawPitch()`; `Biome` == `getBiome(feet)`; `Light: total (sky sky, block block)` == `getLight(feet)`; `FPS` within ±20% of `getFps()`. Also (per the §1.3 parse contract): the `(Day <n>)` suffix of the `Local Difficulty:` line — `n === Math.floor(getWorldTime()/24000)`; the `E: <rendered>/<total>` line — `total === getEntities().length` and `rendered ≤ total`; the `C: <renderedSections>/<totalSections>` line — `totalSections === getLoadedSectionCount()` (±0 — same snapshot; re-read both in one `page.evaluate` if they race) and `renderedSections ≤ totalSections`; the `Seed:` line — its value `=== getSeed()` (`'8675309'`). Aim at a block → right column shows Targeted Block id + state props. Right column shows `Mem:` line.
  **Pass:** every listed line present and numerically consistent, including Day, `E:`, `C:`, and `Seed:`.
  **Screenshot:** `qa/S2/QA-S2-04-f3-overlay.png` — both F3 columns legible.
- **QA-S2-05 — sea level & open water. Verifies:** *"Sea level **y=63** overworld"* and *"Overworld water at/below y63 in open low terrain"*.
  **Steps:** scan a **deterministic square spiral** centered on the spawn column — ring by ring outward, step 16, cells within each ring visited in reading order (west→east, then north→south) — until a column with `getHeightmapAt(x,z) ≤ 63` and `getBlock(x,63,z)==='water'` is found (≤ 2000 columns; wait on `isColumnLoaded(x,z)` after any `tp` before sampling). At that column: assert `getBlock(x,64,z)==='air'`, `getBlock(x,63,z)==='water'`. Also assert across **50 seeded-random columns**: draw `x,z = Math.floor((rng()*2−1)*256)` pairs from `mulberry32(8675309)` (`function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}`), skipping duplicates, waiting on `isColumnLoaded` per column; a column is **open** iff `getBlock(x,h,z)!=='air'` and `getBlock(x,h+1,z)==='air'` for `h=getHeightmapAt(x,z)` (sky-exposed surface; skip non-open draws and draw again). In each: for y from 64 up to h, no cell with `getBlock(x,y,z)==='water'` and `getBlock(x,y+1,z)==='air'` (no floating sea). This selection is identical on every run — failures reproduce.
  **Pass:** water surface exactly at y=63; no open-terrain water above 63.
  **Screenshot:** `qa/S2/QA-S2-05-sea-level.png` — water body with F3 showing a targeted water cell at y=63.
- **QA-S2-06 — PRNG conformance (known-answer) + same-seed determinism. Verifies:** *"`minecraft:legacy` = `java.util.Random` LCG"* + *"`minecraft:xoroshiro` = xoroshiro128++"* — directly via golden vectors (steps a–b; same-seed-identical-terrain alone would pass with ANY seeded PRNG and proves neither), plus the observable consequence same seed ⇒ identical terrain (step c).
  **Steps & pass:**
  (a) **legacy golden vector:** `__qa.prngSample('legacy', '8675309', 4)` must equal exactly `['-1053177025', '-150178720', '-1306427041', '-1948289137']` (java.util.Random(8675309).nextInt() ×4 — PARITY §1.2 constants: mult `0x5DEECE66D`, add `0xB`, 48-bit mask, scramble `(seed^mult)&mask`).
  (b) **xoroshiro golden vector:** `__qa.prngSample('xoroshiro', 'state:1,2', 4)` must equal exactly `['393217', '669327710093319', '1732421326133921491', '11394790081659126983']` (xoroshiro128++ from raw state s0=1, s1=2; rotl constants 17/49/28, shift 21). Any deviation in either vector = FAIL of the corresponding matrix row (5 or 6) regardless of terrain determinism.
  (c) **same-seed terrain:** record the PROBES column signature (§1.7, with its load-wait rule) in `qa-main`. Save & Quit. Create world `qa-dup`, seed `8675309`, enter, `__qa.tp` to each probe column (wait `isColumnLoaded`), record signature. Signatures identical for all 6 columns (30 block ids + 6 heights).
- **QA-S2-07 — surface rules. Verifies:** *"Column top cover … grass_block+dirt over stone; underwater→dirt/gravel/sand"*.
  **Steps:** selection is deterministic — walk the same square spiral as QA-S2-05 (center spawn, step 4, reading order) and take the **first 10** columns matching each predicate, waiting on `isColumnLoaded` before testing. With `h := getHeightmapAt(x,z)+1` (first air cell above the surface): **grass-topped** = `getBlock(x,h−1,z)==='grass_block'` — then assert blocks at `h−2..h−4` == `dirt`, and `stone` appears within `h−5..h−8`. **Underwater-floor** = `getHeightmapAt(x,z) ≤ 62` and `getBlock(x,63,z)==='water'` — the **floor cell** is the first non-`water` cell scanning down from y=62; assert it ∈ {`dirt`,`gravel`,`sand`}.
  **Pass:** ≥ 9/10 columns match each rule (allow 1 outlier for beach/edge cases).
  **Screenshot:** `qa/S2/QA-S2-07-surface-column.png` — dug 1×1 shaft wall showing grass/dirt/stone stack, F3 on.
- **QA-S2-08 — build range, sections, dimension record. Verifies:** *"Overworld build range **y ∈ [−64, 319]**"*, *"16×16×16 sections (24 in overworld)"*, *"Shared TS `Section`"*, *"`DimensionType = {…}`"*, *"**Overworld:** min_y−64/h384, scale1.0, skylight yes…"*.
  **Steps:** `d = __qa.getDimension()` → (i) **full key set:** `Object.keys(d)` must include every PARITY §3.1 field: `min_y, height, logical_height, coordinate_scale, ambient_light, has_skylight, has_ceiling, ultrawarm, natural, bed_works, respawn_anchor_works, piglin_safe, has_raids, monster_spawn_light_level, infiniburn, effects` (plus `id`; `fixed_time` may be absent/undefined for the overworld — day cycle runs). (ii) **overworld values:** `id:'overworld', min_y:−64, height:384, logical_height:384, coordinate_scale:1, ambient_light:0, has_skylight:true, has_ceiling:false, ultrawarm:false, natural:true, bed_works:true, respawn_anchor_works:false, piglin_safe:false, has_raids:true`; `monster_spawn_light_level` is a uniform 0–7 record (assert `JSON.stringify` contains both bounds `0` and `7` — "spawn light uniform 0–7", PARITY §3.1); `infiniburn` and `effects` are non-empty strings (values not pinned by PARITY — assert presence/type only). `getBlock(x,−64,z)==='bedrock'` at 5 probes; `getBlock(x,319,z)==='air'`; `getBlock(x,320,z)` and `getBlock(x,−65,z)` return `'air'`/out-of-range without throwing. `getSection(cx,−4,cz)` and `getSection(cx,19,cz)` non-null with `paletteSize ≥ 1`; `getSection(cx,20,cz) === null`.
  **Pass:** all assertions hold.
- **QA-S2-09 — client tick rate. Verifies:** *"Game tick **50 ms (20 tps)**"* (client half; server half in QA-S9-10).
  **Steps:** `t0=getWorldTime()`, wait 10 000 ms wall clock, `t1=getWorldTime()`.
  **Pass:** `t1−t0 = 200 ± 4` ticks.

---

### S3 — Movement / jump / sprint / sneak physics

**Purpose:** shared-physics locomotion constants (PARITY §8A, protocol §6.3.1).
**Applicability:** milestone ≥ M0 (ice/slab sub-tests gated).
**Setup:** WORLD_B; build RUNWAY fixture (§1.7); `__qa.tp(0,100,0)`; `setLook(270, 0)` (facing east, +X); `setGameMode('survival')` for ground tests; pointer lock held; F3 open.

- **QA-S3-01 — pointer lock & look math.**
  **Steps:** click canvas → locked. Read yaw0. `lookDelta(cdp, +100, 0)` (§1.2). Read yaw1. Then `lookDelta(cdp, 0, +50)` and read pitch.
  **Pass:** `yaw1−yaw0 = +61.44° ± 2°` (sensitivity 100 default); pitch increased by `+30.72° ± 1.5°` (invertY off = mouse down looks down); pitch clamps at ±89.9 when pushed past.
  **Screenshot:** `qa/S3/QA-S3-01-look.png`.
- **QA-S3-02 — walk speed 4.317 b/s. Verifies:** *"walk **4.317**"*, *"Horizontal move: `vel = (vel + accel)·slipperiness·0.91`"* (emergent), standing AABB/eye of *"standing **0.6×1.8** eye **1.62**"*.
  **Steps:** assert `getEyeHeight()==1.62±0.01`, `getAABB()=={w:0.6,h:1.8}±0.01`. `keyboard.down('KeyW')`; discard 10 ticks (accel ramp); `recordTicks(100)`; `keyboard.up('KeyW')`.
  **Pass:** XZ distance over the 100 ticks = `21.585 blocks ± 2%` (⇒ 4.317 b/s ± 2%); path straight (|Δz| < 0.05).
- **QA-S3-03 — sprint 5.612 b/s (key + double-tap). Verifies:** *"sprint **5.612**"*.
  **Steps:** (a) hold `ControlLeft`+`KeyW`, discard 10 ticks, `recordTicks(100)`. (b) release all; double-tap: `press('KeyW')`, 100 ms gap, `down('KeyW')` and hold; assert `isSprinting()` within 5 ticks; `recordTicks(60)`.
  **Pass:** both paths `5.612 b/s ± 2%`; `isSprinting()===true` during; FOV increased vs walk (`getCameraFov()` > settings fov).
  **Screenshot:** `qa/S3/QA-S3-03-sprint.png` — F3 speed/pos visible.
- **QA-S3-04 — sneak 1.295 b/s, pose, hitbox. Verifies:** *"sneak **1.295**"*, *"sneaking **0.6×1.5** eye **1.27**"*, *"`Pose` enum … drives hitbox size, camera/eye height"*.
  **Steps:** hold `ShiftLeft`; assert `getPose()==='crouching'`, `getEyeHeight()==1.27±0.01`, `getAABB().h==1.5±0.01`. Add `KeyW`, discard 10 ticks, `recordTicks(100)`.
  **Pass:** `1.295 b/s ± 2%`; pose/eye/AABB values exact per above; releasing Shift restores `standing`/1.62/1.8.
- **QA-S3-05 — jump arc, gravity, drag order, terminal velocity. Verifies:** *"Jump: set vy = **0.42 b/t** (peak ≈ **1.252**)"*, *"Gravity: subtract **0.08** … THEN ×0.98 … terminal ≈ **3.92 b/t**"*.
  **Steps:** (a) standing still, `press('Space')` + `recordTicks(20)`; find max `pos.y − y0` and its tick index. (b) `setGameMode('creative')`; **fly-disable recipe:** if `isFlying()`, double-tap `Space` (two `press('Space')` ≤ 300 ms apart) and re-assert `isFlying()===false` before proceeding. Then `tp(0, 300, 30)` — y=300 over a column **off the RUNWAY** (z=30, open terrain far below): the integrated drop over 60 ticks is ≈96 blocks (to y≈204), so no sample can be contaminated by landing. Immediately `recordTicks(60)`. **Phase alignment (mandatory):** the recorder starts an unknown number of ticks after the tp — define sample **n=1 as the first recorded sample with `vel.y < 0`** and index the closed form from there; never assume the first array element is fall-tick 1.
  **Pass:** (a) peak `1.252 ± 0.01` blocks at tick `6 ± 1`; lands at tick `12 ± 1`. (b) `vel.y` at aligned ticks n=1–10 within `±0.005` of `vy(n) = −3.92·(1−0.98^n)` (proves gravity-then-drag order); |vy| after 50 aligned ticks = per the same closed form ± 2%.
  **Screenshot:** `qa/S3/QA-S3-05-jump-apex.png`.
- **QA-S3-06 — sprint-jump +0.2 forward impulse; air acceleration 0.02. Verifies:** *"**sprint-jump** adds a **+0.2** horizontal forward impulse"* + the airborne half of *"Horizontal move: `vel = (vel + accel)·slipperiness·0.91`; air accel ≈ 0.02"* (slip = 1.0 in air).
  **Steps:** (a) sprint east on RUNWAY; while sprinting press `Space`; `recordTicks(15)` around the jump; compute per-tick horizontal displacement. (b) **air-accel probe:** stand still on RUNWAY (no keys, XZ speed 0); `press('Space')`; poll `onGround()` per tick and hold `KeyW` only **after** `onGround()===false`; `recordTicks(12)`; compute per-tick horizontal displacement `Δh(n)` over the airborne samples (`onGround===false`).
  **Pass:** (a) max per-tick horizontal displacement within 3 ticks of the jump ∈ `[0.43, 0.52] b/t` (sprint ≈0.28 + 0.2 impulse, pre-friction decay); average speed over 5 consecutive sprint-jumps > 5.612 b/s. (b) first airborne-accelerated tick `Δh(1) = 0.018 ± 0.005 b/t` (0.02·0.91 air integration) and after 10 airborne ticks `Δh(10) = 0.123 ± 0.020 b/t` (closed form `0.2022·(1−0.91^n)`) — both far below the ground-walk 0.216 b/t a ground-accel (0.1) integration would reach by tick 10; ground accel applied in air = FAIL.
- **QA-S3-07 — auto step-up 0.6. Verifies:** *"Auto step-up: climb ledges ≤ **0.6 blocks**"*.
  **Steps:** (a1) M0 negative: place full stone block in path at foot level; walk into it 20 ticks with Space never pressed. (a2) **M0 positive** (no block in the M0 core set is ≤ 0.6 high, so use the §1.4 QA collider): `setTestCollider(6, 100, 0, 0.5)` (half-height, top at y=100.5) in the walk path; from `(0,100,0)` hold `KeyW` east, Space never pressed; `recordTicks(30)`; then `setTestCollider(6, 100, 0, 0)` to remove. (b) `[gate: slabs, milestone ≥ M1]` slab confirmation: place bottom slab (height 0.5) in path; walk into it, Space never pressed.
  **Pass:** (a1) player does not rise (Δy < 0.05) and does not cross the wall plane (1.0 > step height 0.6). (a2) player ends standing on the collider (feet `y = 100.5 ± 0.02`) within 2 ticks of contact and keeps moving east past x=6, `vel.y` never exceeds 0.25 (step, not jump) — an unimplemented step-up (step height 0) blocks the player at the box face and FAILS this. (b) same criteria as (a2) on the real slab (Δy = +0.5).
  **Screenshot:** `qa/S3/QA-S3-07-stepup.png` (variant b).
- **QA-S3-08 — survival mode caps. Verifies:** *"`SURVIVAL=0`: … no flight"* (flight/reach/drops split across S4).
  **Steps:** in survival on RUNWAY: double-tap `Space` (two presses ≤ 300 ms apart), hold second press 500 ms.
  **Pass:** `isFlying()===false` throughout; player performs a normal jump and lands; survival HUD shows hotbar+crosshair (health/hunger bars present only if vitals implemented — do not fail M0 on missing P1 bars).
- **QA-S3-09 — creative flight 10.89 / sprint-fly 21.78. Verifies:** *"`CREATIVE=1`: … double-tap flight"*, *"creative/spectator fly **10.89** (sprint-fly ≈ 21.78)"*.
  **Steps:** `setGameMode('creative')`; double-tap `Space` → `isFlying()===true`. Hold `Space` 20 ticks → y increases; hold `ShiftLeft` 20 ticks → y decreases. Level off; hold `KeyW` 100 ticks → speed. Add `ControlLeft` → speed. Descend to ground → flight cancels on landing.
  **Pass:** fly toggles on double-tap only in creative; horizontal fly `10.89 b/s ± 2%`; sprint-fly `21.78 b/s ± 5%`; landing sets `isFlying()===false`.
  **Screenshot:** `qa/S3/QA-S3-09-flying.png`.
- **QA-S3-10 — ground friction & slipperiness. Verifies:** *"`slipperiness` = friction of the block underfoot (default **0.6**, ice **0.98** …)"*.
  **Steps:** (a) walk east at full speed on stone, release `KeyW`, `recordTicks(20)`; measure slide distance until speed < 0.1 b/s. (b) `[gate: ice, milestone ≥ M1]` replace runway segment with ice via `setBlock`, repeat.
  **Pass:** (a) stone slide ≤ 1.0 block, stops within 10 ticks. (b) ice slide ≥ 3× the stone slide distance.

---

### S4 — Break & place core materials (tool gating, break times, fluids, lighting)

**Purpose:** BlockDef table, break-time formula, tool gating, core P0 block set, fluids, flood-fill lighting, item entities, reach, build-range edits.
**Applicability:** milestone ≥ M0 (gates marked per test).
**Setup:** WORLD_B at RUNWAY; F3 open. Stage via dev hooks: `give('wooden_pickaxe',1)`, `give('dirt',64)`, `give('stone',64)`, `give('oak_log',64)`, `give('sand',64)`, `give('gravel',64)`, `give('oak_planks',64)`, `give('glass',64)`. Build a test wall of each material at `(10..17, 100, 3)` via `setBlock`. Switch `setGameMode('survival')` unless a step says creative. Aim with `aimAt` + confirm `getTargetedBlock()` before every mouse action.

- **QA-S4-01 — BlockDef/ItemDef data tables. Verifies:** *"`BlockDef = {…}`"*, *"Representative hardness/blast/tool/tier table (dirt 0.5 shovel0, stone 1.5 pick1 … glass 0.3, leaves 0.2, bedrock −1)"*, *"`ItemDef = {…}`"*, plus the data half of *"`hardness==0` → instant break"*.
  **Steps:** `getBlockDef(id)` for `dirt, stone, sand, gravel, glass, oak_leaves, obsidian, bedrock, oak_log, oak_planks, grass_block, water`; `getItemDef` for `wooden_pickaxe, dirt`.
  **Pass:** every BlockDef has all PARITY §4.1 keys; `hardness`: dirt 0.5, stone 1.5, glass 0.3, leaves 0.2, obsidian 50 (blast 1200), bedrock −1; stone `requiresCorrectTool===true`, `toolClass==='pickaxe'`, `harvestTier===1`; dirt `requiresCorrectTool===false`. **Hardness-0 data half (conditional — see matrix row 18):** if the `torch` or `sapling` cap is present, `getBlockDef` for it must show `hardness === 0`; if neither is registered, this sub-check asserts **nothing** — row 18 is then a documented M0 verification hole reported as `SKIPPED-GATED (torch|sapling)`, NOT a pass. ItemDef has `maxStack` (dirt 64, wooden_pickaxe 1).
- **QA-S4-02 — dirt by hand: 15 ticks, drops. Verifies:** *"Break-time formula"*, *"ItemEntity … spawned on every block break"*, survival drops of *"`SURVIVAL=0` … drops+XP"*.
  **Steps:** aim at dirt wall block; `recordTicks(30)` + `mouse.down()`; on break `mouse.up()`. Spawn timing is read from the recorder's per-tick `itemEntities` field (§1.4), not from a post-hoc `getEntities('item')` poll.
  **Pass:** break in `15 ± 1` ticks (0.75 s); crack overlay progressed (breakProgress 0→1 monotonic); in the recorder samples, `itemEntities` gains **exactly 1** new entry (id `dirt`) within 1 tick of the sample where the target cell became air, positioned at that cell (±1 block).
  **Screenshot:** `qa/S4/QA-S4-02-dirt-cracks.png` — mid-break crack stage visible.
- **QA-S4-03 — stone by hand: 150 ticks, NO drop. Verifies:** *"`canHarvest` … wrong tool = 5× slower + no drop"*.
  **Steps:** empty hand (select empty hotbar slot); aim at stone; hold `mouse.down()` with `recordTicks(170)`.
  **Pass:** break in `150 ± 2` ticks (7.5 s); **zero** item entities spawn for this break.
- **QA-S4-04 — stone with wooden pickaxe: 23 ticks + drop. Verifies:** break-time formula with tool speed 2.0, tier gate pass.
  **Steps:** select the wooden_pickaxe hotbar slot (`Digit1`…); aim at stone; timed break as above.
  **Pass:** break in `23 ± 1` ticks (1.15 s); 1 item entity spawns (id `stone` or `cobblestone` — record which; either passes M0, file a parity note if `stone`).
  **Screenshot:** `qa/S4/QA-S4-04-stone-wood-pick.png` — post-break with dropped item entity in frame.
- **QA-S4-05 — formula conformance sweep (hand). Verifies:** break-time formula generality.
  **Steps:** for each of `sand, gravel, oak_log, oak_planks, glass`: read `h = getBlockDef(id).hardness`; expected ticks = `ceil(30·h)` (none require tools; else `ceil(100·h)`); timed break by hand.
  **Pass:** each within `±1` tick of formula (sand 15, gravel 18 for h 0.6, glass 9, log/planks per their def).
- **QA-S4-06 — place every core material. Verifies:** *"**Terrain/natural** … **[P0]** core: stone, dirt, grass_block, sand, gravel, water, log"* (+planks/glass from the M0 deliverable set).
  **Steps:** in survival, for each target cell `(20+i, 99, 0)` (i = 0..6) with material `stone, dirt, sand, gravel, oak_log, oak_planks, glass`: **first position within reach** — `__qa.tp(20+i−2, 100, 0.5)` (standing on the runway 2 blocks west of the target; eye→top-face hit point ≈ 2.9 blocks, well inside survival reach 4.5 — the cells are 20–26 blocks from the fixture stand point, so placing without repositioning is impossible). Select the material's hotbar stack, `setLook` toward the top-face aim point `(20+i+0.4, 100.0, 0.5)` (0.4 into the cell guarantees an `up`-face hit rather than clipping the west face; use the `aimAt` math with this point substituted for the cell center), confirm `getTargetedBlock()` deep-equals `{pos:[20+i,99,0], face:'up'}`, then single `mouse.click({button:'right'})` (Mouse2 = use/place).
  **Pass:** `getBlock(20+i, 100, 0)` — the cell **above** the clicked top face — returns the placed id for each i; the held stack count decremented by 1 (survival consumes); placement appears within 1 tick locally (optimistic apply per protocol §7).
  **Screenshot:** `qa/S4/QA-S4-06-core-blocks-row.png` — all 7 placed blocks in one frame, noon light.
- **QA-S4-07 — hardness==0 instant break. Verifies:** *"`hardness==0` → instant break (flowers, torches, TNT, sapling, dust)"*. `[gate: torch or sapling, milestone ≥ M1 for runtime; data half covered in QA-S4-01]`
  **Steps:** `setBlock(25,100,0,'torch')` (or sapling); aim; single `mouse.down()`+`up()` within 1 tick.
  **Pass:** block becomes air on the same tick as the first attack tick (breakProgress never renders a partial stage).
- **QA-S4-08 — bedrock floor band & unbreakable. Verifies:** *"Overworld bedrock floor: `P(bedrock)=1.0@y−64 → 0.0@y−59` … unbreakable"*.
  **Steps:** sample 256 columns (stride 4 from spawn): fraction of `bedrock` at each y ∈ {−64,−62,−59}. Then `tp` to the floor, aim at a bedrock cell (clear space via `setBlock` air above it), survival: hold attack 200 ticks; creative: click attack.
  **Pass:** y=−64 → 100%; y=−62 → 60% ± 15 pp; y=−59 → ≤ 2%. Survival: `breakProgress` stays 0 and block remains; creative instant-break does **not** remove bedrock.
  **Screenshot:** `qa/S4/QA-S4-08-bedrock.png` — bedrock targeted, F3 targeted-block panel showing `bedrock`.
- **QA-S4-09 — blockstate property registry. Verifies:** *"`blockstate = { block, props }`; property types bool/int-range/enum"*.
  **Steps:** place `oak_log` on the runway **top** face → `getBlockState(...).props.axis === 'y'`; place another against a **side** (±X) face of the first → `axis === 'x'` (server resolves orientation, protocol §3.1/§4.5). Read a flowing-water cell from QA-S4-11 → `props.level` int ∈ 1..7.
  **Pass:** props present with correct types/values; `getBlockState` on plain stone returns `{block:'stone', props:{}}` (or only defined props).
  **Screenshot:** `qa/S4/QA-S4-09-log-axis.png` — both logs, F3 targeted-state props visible.
- **QA-S4-10 — build-range edit clamps. Verifies:** *"y ∈ [−64, 319]"* enforcement on edits (protocol §0 `WORLD_MIN_Y/MAX_Y`).
  **Steps:** creative fly; build a 1×1 pillar to y=318 (place on top faces); place at 319 (click top of 318). Then click the top face of the y=319 block. Dig down at the bedrock floor and attempt any placement below −64 (click bottom face of a y=−64 cell from a carved pocket, if reachable).
  **Pass:** block exists at y=319; **no** block appears at y=320 (client refuses or `edit_reject INVALID_PLACEMENT`; `getLastEditResult()` may show `rejected`); no crash/disconnect; nothing below −64.
- **QA-S4-11 — water spread ring + downward-hole bias. Verifies:** *"Water: source (level 0/8) + flowing 1–7; horizontal spread ≤7 (−1/block); flows down infinitely; flow biases toward nearest downward hole (≤5); update every 5 ticks"* + fluids P0 *"water (source+levels 1–7)"*.
  **Steps:** (a) on a flat 20×20 stone platform at y=99 (build via `setBlock`): `setBlock(0,100,0,'water')`. Poll `getBlockState` along +X each 10 ticks for 80 ticks. Then carve a 1×1 shaft at (4,99,0) down 10 blocks. (b) **hole bias (≤5):** build a second dry 20×20 platform at y=99 centered on `(0,·,40)`; carve a single 1×1 hole at `(3,99,40)` (`setBlock(3,99,40,'air')` — 3 blocks +X of the coming source, no other holes within 7); `setBlock(0,100,40,'water')`; wait 60 ticks. (c) **out-of-range control (distance 6):** third dry platform centered `(0,·,60)`; single hole at `(6,99,60)`; `setBlock(0,100,60,'water')`; wait 60 ticks.
  **Pass:** (a) within 60 ticks: cells (1..7, 100, 0) are water with `level` = 1..7 respectively; (8,100,0) stays air (spread ≤ 7). Water pours down the shaft filling all 10 cells below (`falling`/level per §3.2). Timing consistent with 5-tick updates (ring complete in 35–60 ticks). (b) flow reaches `(3,100,40)` and pours into the hole (`getBlock(3,99,40)==='water'`); the −X arm is truncated/thinner than the +X arm (at 60 ticks, `getBlockState(−3,100,40)` is air **or** has a strictly higher `level` number than `(3,100,40)`) — pathing biased toward the hole. (c) no bias at distance 6: `level` at `(+2,100,60)` equals `level` at `(−2,100,60)` (symmetric ring), even though spread may eventually reach the hole.
  **Screenshot:** `qa/S4/QA-S4-11-water-ring.png` — top-down-ish view of the 7-cell flow, F3 on a flowing cell showing `level`.
- **QA-S4-12 — infinite water source. Verifies:** *"Infinite source: flowing cell with ≥2 orthogonal source neighbors → source"*.
  **Steps:** carve a 3×1×1 trench at y=99; `setBlock` water sources in both end cells; wait 20 ticks; read middle cell. Then break the middle cell's water by placing/removing a block (`setBlock` air) and wait 20 ticks.
  **Pass:** middle cell becomes a **source** (`level 0` / source state) both initially and after disturbance (re-forms).
- **QA-S4-13 — lava source + flow + light 15. Verifies:** fluids P0 *"lava (source+flow)"* and feeds lighting tests.
  **Steps:** on a separate platform: `setBlock(40,100,0,'lava')`; wait 80 ticks; read neighbors and `getLight`.
  **Pass:** ≥1 flowing lava neighbor exists (`level ≥ 1`); `getLight(40,100,0).block === 15`; orthogonal air neighbor `=== 14` (ART §1.7 emission table, PARITY §19).
  **Screenshot:** `qa/S4/QA-S4-13-lava.png` — lava glow at night (`setTime(18000)` for this shot, then restore 6000).
- **QA-S4-14 — waterlogging. Verifies:** fluids P0 *"waterlogging"*. `[gate: slabs+waterlogging, milestone ≥ M1]`
  **Steps:** place a bottom slab; use a water bucket (`give('water_bucket',1)`) on its cell (Mouse2).
  **Pass:** `getBlockState(cell).props.waterlogged === true`; slab still present.
- **QA-S4-15 — survival reach 4.5 blocks. Verifies:** *"Reach … `block_interaction_range` base **4.5** … `entity_interaction_range` base **3.0**"* (block half; entity half in QA-S9-11).
  **Reach semantics (PARITY §9.1):** the range is the length of the ray from the **eye** to the **raycast hit point** on the block's surface — NOT to the block center. A block is targetable iff `distance(eye, hitPoint) ≤ range` (**inclusive ≤**; 4.5 survival / 5.0 creative). All probe geometry below is therefore specified as eye→near-face distance with ≥ 0.2-block margin on each side of the boundary; never place a probe exactly at the boundary (undefined). Note a low target's nearest corner can sit ~0.87 blocks closer than its center — the eye-level, face-on geometry below avoids that trap.
  **Steps:** fixed target: `setBlock(10, 101, 0, 'stone')`, isolated (no other block within 3 of it); its near (west) face plane is x=10 and its center is `(10.5, 101.5, 0.5)`. For each probe, `__qa.tp` the player so the eye `(px, 101.62, 0.5)` (feet y=100; eye height 1.62 is inside the cell's y-span 101..102, giving a face-on horizontal ray; the ≤0.01-block ray-slope correction from aiming at the cell center is inside the 0.2 margins) sits at the stated **face distance** `10 − px`: survival positive `tp(5.70, 100, 0.5)` → hit point 4.30 (≤ 4.5, margin 0.2); survival negative `tp(5.30, 100, 0.5)` → hit point 4.70 > 4.5 (center 5.20). Aim at the cell with `aimAt`; read `getTargetedBlock()`; attempt attack for 10 ticks.
  **Pass:** at hit distance 4.30: outline/target present (`getTargetedBlock()` = the cell), breakProgress > 0. At 4.70: `getTargetedBlock() === null` (no selection outline, UX §5.7) and no break progress. A correct implementation must pass BOTH — the negative sits 0.2 outside the inclusive boundary, so targeting it is a real reach bug, not boundary noise.
- **QA-S4-16 — creative: instant break, reach 5.0, infinite blocks. Verifies:** *"`CREATIVE=1`: … instant break … infinite blocks … reach **5.0 block**"*.
  **Steps:** `setGameMode('creative')`. (a) aim at stone at hit distance ~3, single click → air same tick. (b) same fixture and semantics as QA-S4-15: creative positive `tp(5.20, 100, 0.5)` → hit point 4.80 (≤ 5.0); creative negative `tp(4.80, 100, 0.5)` → hit point 5.20 > 5.0 (center 5.70 — clear of the 5.0 creative reach with 0.2 margin; a nearer negative like center 5.40 would put the face at 4.90 INSIDE reach and file a false bug). (c) note hotbar dirt count, place 3 dirt.
  **Pass:** (a) instant (≤1 tick). (b) hit 4.80 targetable/breakable; hit 5.20 not targetable. (c) count still 64 (no decrement in creative).
- **QA-S4-17 — block-light flood fill (6-neighbor). Verifies:** *"Flood-fill 6-neighbor (no diagonal); step `light − max(1, opacity(target))`"* + *"Two channels sky+block 0–15"*.
  **Steps:** build a sealed stone room at y≈120 (dev `setBlock` loop): outer shell 9×9×5 ⇒ **interior 7×7×3**, interior all air, no sky access; C = the interior center cell. Place lava (or `glowstone` if registered) at C. Add a **1-block interior wall**: `setBlock(Cx−2, Cy, Cz, 'stone')`, probe cell `(Cx−3, Cy, Cz)` directly behind it. Read `getLight` at: C (15), C+1x (14), C+2x (13), C+1x+1z **diagonal** (13 — taxicab 2, NOT 14), and the behind-wall probe `(Cx−3, Cy, Cz)` — expected block light **exactly 10**: the shortest 6-neighbor all-air path around the wall block is 5 steps (e.g. C→(−1x)→(−1x,+1z)→(−2x,+1z)→(−3x,+1z)→(−3x)) ⇒ 15−5; a reading of 12 there means light leaked **through** the wall (straight-line distance 3) = FAIL. Sky channel inside room === 0.
  **Pass:** exact values above (C 15, +1x 14, +2x 13, diagonal 13, behind-wall 10, sky 0); block channel 0 outside the room's closed wall.
  **Screenshot:** `qa/S4/QA-S4-17-lightroom.png` — interior with F3 `Light:` line at a probe cell.
- **QA-S4-18 — skylight column rule. Verifies:** *"Skylight 15 straight down through transparent columns; horizontal attenuates normally"*.
  **Steps:** outdoors at noon: dig a 1×1 shaft 6 deep; read sky light at bottom. Dig a 1-high horizontal tunnel 3 cells from the shaft bottom; read sky at tunnel cells 1,2,3.
  **Pass:** shaft bottom sky = 15 (no vertical attenuation); tunnel cells = 14, 13, 12 (−1 per horizontal step); block channel unaffected (0).
- **QA-S4-19 — incremental relight on edit. Verifies:** *"Incremental light updates on place/break/state-change; skylight on heightmap change"* + rendered `max(block, sky·timeFactor)`.
  **Steps:** cap the QA-S4-18 shaft top with stone; within 5 ticks read bottom sky (must drop to tunnel-path value or 0); remove cap; sky returns to 15. Then screenshot the same fixed outdoor viewpoint twice: once at `setTime(6000)` (noon) and once at `setTime(18000)` (midnight); restore 6000 afterwards.
  **Pass:** relight completes ≤ 5 ticks after each edit; stored sky values unchanged by time of day (still 15 at night — time scales *rendered* brightness only), midnight screenshot region mean luminance < 50% of noon's.
  **Screenshots:** `qa/S4/QA-S4-19-noon.png` and `qa/S4/QA-S4-19-night.png` (one file per capture).
- **QA-S4-20 — ItemEntity lifecycle. Verifies:** *"`ItemEntity = { stack, pickupDelay=10gt, age, despawnAge=6000gt }`"*.
  **Steps:** survival; stand ON the cell where a dirt block will drop; break it; `recordTicks(30)` and read its per-tick `itemEntities` + `heldCount` fields (§1.4 — the recorder carries these precisely so this test has a tick-resolution channel; do not poll `getEntities` cross-RTT).
  **Pass:** an `itemEntities` entry exists from the sample ≤1 tick after break; **not** picked up before 10 ticks elapse (pickupDelay: entry persists in samples 1–10 after spawn); picked up within 30 ticks (`heldCount` +1 in the same sample the entry disappears); entity has gravity (its `pos.y` decreases while airborne). **Despawn-at-6000gt:** hosted by the **PERF-04 soak (§3 — singleplayer WORLD_B, RD 12)**, not S9: at soak start drop one dirt stack (`KeyQ`) at a marked cell **≤ 20 blocks from the soak activity center** — the whole PERF-04 activity path stays within ~60 blocks, so the drop cell remains inside simulation distance (and inside `getEntities` coverage, §1.4) for the full window; item `age` only advances while ticked, so an out-of-range drop would never despawn and void the check. Assert via `getEntities('item')`: entry present at minute 4 (`ageTicks < 6000`) and gone by 5 min + 10 s (6000 gt = 5:00).

---
### S5 — Inventory & hotbar flows

**Purpose:** player inventory model, the UX §6.10 slot-interaction matrix, hotbar HUD, stack sizes, creative inventory.
**Applicability:** milestone ≥ M0 (`stack16Items`, `enderChest` sub-checks gated).
**Setup:** WORLD_A (survival, cheats ON). Stage: `give('dirt',64)`, `give('dirt',64)`, `give('stone',64)`, `give('oak_planks',17)`, `give('wooden_pickaxe',1)`. Open inventory with `KeyE`; interact via `[data-slot]` centers (§1.5); after every action assert against `getInventorySlot`/`getCursorStack`.

- **QA-S5-01 — inventory layout & model. Verifies:** *"Player inventory: 36 main (hotbar 0–8, storage 9–35), 4 armor (100–103), offhand (−106), 2×2 crafting"*.
  **Steps:** press `KeyE` → `data-screen="inventory"`, pointer lock released, browser cursor visible. Enumerate `[data-slot]`: exactly `hotbar0..8`, `main9..35`, `armor.head/chest/legs/feet`, `offhand`, `craft0..3`, `craftResult` (46 total). Verify geometry: `main9` box center ≈ `((125+8+9)·3, (37+84+9)·3) = (426, 390)` device px ± 4 (UX §6.1 at S=3). `Esc` and `KeyE` both close it. Ender chest 27 (`EnderItems`): `[gate: enderChest, ≥ M1]` open an ender chest → 27 `c*` slots.
  **Pass:** all slots present at spec coordinates; open/close via both keys.
  **Screenshot:** `qa/S5/QA-S5-01-inventory.png` — full inventory panel.
- **QA-S5-02 — LMB pick/place/swap; RMB half/one. Verifies:** *"Interactions: LMB pick/place, RMB half/one"*.
  **Steps:** LMB on the 17-planks slot → cursor 17, slot empty. LMB empty slot → placed 17. RMB on it → cursor 9 (ceil half), slot 8. RMB on a different empty slot ×3 → 3 slots with 1 each, cursor 6. LMB a dirt-64 slot while carrying planks → swap (cursor dirt 64, slot planks 6).
  **Pass:** every count exactly as listed (UX §6.10 rows 1–5).
- **QA-S5-03 — shift-click quick-move.**
  **Steps:** Shift+LMB a hotbar dirt stack → moves to first free `main` slot; Shift+LMB it back → returns to hotbar region.
  **Pass:** stack relocates whole, region-correct (hotbar↔main per §6.10); cursor stays empty.
- **QA-S5-04 — double-click gather.**
  **Steps:** split dirt into 3 slots (10/20/30 via RMB placement). Double-LMB on one dirt slot.
  **Pass:** cursor = 60 dirt (gathers matching up to max stack); source slots emptied.
- **QA-S5-05 — drag-distribute (LMB even / RMB one-each). Verifies:** *"drag-distribute (even/one-each/creative-fill)"*.
  **Steps:** with cursor 64 dirt: LMB-down on empty slot A, drag through B, C, release on C. Then with cursor 1+ stack: RMB-drag across 4 empty slots.
  **Pass:** LMB: 21/21/21 placed, cursor 1 (floor(64/3), remainder returns). RMB: exactly 1 per dragged slot.
- **QA-S5-06 — number keys + F offhand in GUI. Verifies:** *"number keys 1–9 … F offhand"* + offhand HUD slot of *"Hotbar … offhand slot"*.
  **Steps:** hover the stone stack in `main` region, press `Digit3` → swaps with `hotbar2`. Hover the wooden_pickaxe, press `KeyF` → moves to `offhand`. Close inventory.
  **Pass:** `getHotbar()[2].id==='stone'`; `getInventorySlot('offhand').id==='wooden_pickaxe'`; offhand HUD frame (22×22 gp) now rendered **left** of the hotbar (mainHand default 'right', UX §5.2).
  **Screenshot:** `qa/S5/QA-S5-06-offhand.png` — hotbar + offhand slot visible.
- **QA-S5-07 — Q / Ctrl+Q drop (GUI + in-world). Verifies:** *"Q/Ctrl+Q drop"* and *"Q-drop tosses one with forward velocity"* (ItemEntity).
  **Steps:** in GUI: hover dirt slot, press `KeyQ` (count −1, item entity spawns), then `Control+KeyQ` (slot emptied). Close GUI; in-world select dirt, press `KeyQ`.
  **Pass:** entities spawn each time; in-world drop's initial velocity has positive dot-product with the facing vector; counts exact.
- **QA-S5-08 — stack-size rules. Verifies:** *"Stack sizes: default 64; 16 (…); 1 (tools …)"*.
  **Steps:** stage a third full stack for this test: `give('dirt',64)` (call the three 64-dirt stacks A, B, C by slot). Open inventory (`KeyE`). Build the fixtures with explicit clicks, asserting `getCursorStack`/`getInventorySlot` after each: (1) LMB stack A → cursor 64, slot empty. (2) RMB ×30 onto an empty `main` slot M1 → M1 = 30, cursor 34. (3) LMB another empty slot M2 → M2 = 34, cursor empty. (4) LMB stack B → cursor 64. (5) RMB ×24 onto M2 → M2 = 58, cursor **40**. Now the merge assertions: (6) **no overfill onto a full stack:** LMB the untouched full stack C while carrying 40 → C stays 64, cursor stays 40. (7) **remainder math:** LMB M1 (the 30 stack) while carrying 40 → M1 becomes 64, cursor 6 (30+40 → 64 + 6 carried). (8) Tools: `give('wooden_pickaxe',1)` for a second pickaxe; LMB-carry one onto the other → refuse to merge (swap per UX §6.10, never count 2). (9) `[gate: stack16Items, ≥ M1]` `give('snowball',20)` → arrives as 16+4.
  **Pass:** every count exactly as listed at each numbered step; 64 cap enforced with exact remainder math; tools never stack; 16-cap items cap at 16.
- **QA-S5-09 — creative inventory + pick block. Verifies:** *"creative inventory+search+tabs+toolbar save/load, MMB pick block"* (toolbar save/load `[gate: savedToolbars, ≥ M1]` — via the `Saved Hotbars` tab + `C`/`X` keys when the cap is present).
  **Steps:** `setGameMode('creative')`, `KeyE` → `data-screen="creative"` (195×136 panel, UX §6.3). Enumerate `[data-tab]` buttons (§1.5): must include `Building Blocks`, `Search`, `Survival Inventory` (and `Saved Hotbars` iff `savedToolbars`). Click `[data-tab="Search"]`; type `dirt` → the `[data-slot^="creative"]` grid filters to dirt items. LMB `[data-slot="creative0"]` → full stack 64 on cursor. LMB `[data-slot="creativeDestroy"]` (§1.5; the UX §6.3 destroy/trash slot, bottom-right of the grid) → cursor deleted. Close; in-world aim at a stone block, press `mouse.click({button:'middle'})`.
  **Pass:** search filters; infinite source gives 64 (`getCursorStack()`); destroy slot empties the cursor (`getCursorStack()===null`, no item entity spawned); after in-world MMB pick, `getHeldItem().id==='stone'` (copied to hand, hotbar slot selected). GUI middle-click stack-clone is a **different** interaction — tested in QA-S5-11.
  **Screenshot:** `qa/S5/QA-S5-09-creative-search.png`.
- **QA-S5-10 — hotbar HUD affordances. Verifies:** *"Hotbar (9 + selection highlight + item tooltip), crosshair + attack-cooldown indicator"*.
  **Steps:** in-world: press `Digit1..Digit9` sequentially — selection highlight (24×24 gp frame) tracks; wheel `mouse.wheel(0,±120)` cycles selection. On selecting a non-empty slot, the item-name popup `#hud-itemname` (§1.5) appears centered above the hotbar and fades — poll `#hud-itemname`'s computed opacity: full (≥ 0.99) through ≥ 1.4 s, gone (≤ 0.01 or detached) by ≈ 2.2 s (40-tick fade, UX §5.13). Crosshair: 9×9 gp `+` at exact viewport center, visible in-world, hidden while inventory open. Attack indicator (default `Crosshair`): immediately after an attack click, poll `__qa.getAttackCooldown()` (§1.4) every ~50 ms — it resets to ~0 on the click and rises monotonically to 1; the sub-crosshair arc (UX §5.7, dy +8gp) renders while < 1 (screenshot evidence).
  **Pass:** all four affordances behave as stated — the popup via `#hud-itemname` opacity timings, the indicator via `getAttackCooldown()` 0→1 refill; stack counts render bottom-right of slots (count > 1 only).
  **Screenshot:** `qa/S5/QA-S5-10-hotbar-popup.png` — popup mid-fade + selection highlight.
- **QA-S5-11 — creative GUI middle-click: stack-clone + fill-drag. Verifies:** *"MMB creative copy"* and the *"creative-fill"* third of *"drag-distribute (even/one-each/creative-fill)"* — the GUI interactions QA-S5-09's in-world pick-block and QA-S5-05's LMB/RMB drags do NOT cover.
  **Steps:** creative (`setGameMode('creative')`), open the survival-layout view (`KeyE` → `[data-tab="Survival Inventory"]`) with a 17-count oak_planks stack in a `main` slot (stage via `give` if consumed earlier). (a) **MMB stack-clone:** `mouse.click({button:'middle'})` on that occupied slot → `getCursorStack()` = `{id:'oak_planks', count:64}` (full max-stack copy) while `getInventorySlot` for the source still holds 17 (source not emptied). LMB an empty slot to park the 64. (b) **MMB fill-drag:** MMB-clone again to get 64 on cursor; middle-button-down on empty slot D1, drag through empty D2, D3, release on D3.
  **Pass:** (a) counts exactly as stated. (b) D1, D2, D3 **each** hold a full 64 stack (creative fill places a full max-stack per dragged slot; cursor stack not depleted — UX §6.10 creative-fill row).
  **Screenshot:** `qa/S5/QA-S5-11-creative-fill.png` — the three filled slots + cursor stack.

---

### S6 — Texture-pack switch (default → smooth-cartoon → gritty, live preview)

**Purpose:** procedural pack presets swap the atlas live, no reload/remesh (UX §7, ART §3).
**Applicability:** `[gate: texturePacks]` (expected ≥ M1; run whenever the cap is present).
**Setup:** WORLD_B in-world at the QA-S4-06 block row; `setTime(6000)`; fixed camera via `setLook`. Open `Esc` → `Options...` → `Resource Packs...` (`data-screen="settings.texturePacks"`).

- **QA-S6-01 — pack screen inventory.**
  **Steps:** enumerate `.pack-card` in both columns.
  **Pass:** exactly the three built-ins `default`, `smooth-cartoon`, `gritty` exist with 32×32 icons + description text; `default` pinned at the bottom of Selected (fallback).
  **Screenshot:** `qa/S6/QA-S6-01-pack-screen.png`.
- **QA-S6-02 — live preview without applying.**
  **Steps:** hash `#pack-preview-canvas` pixels (§1.5; `canvas.toDataURL()` via `page.evaluate`); hover the `smooth-cartoon` `.pack-card` 500 ms; rehash `#pack-preview-canvas`; also capture `__qa.getAtlasHash()` before/after hover.
  **Pass:** preview hash changes on hover; **atlas hash unchanged** (preview does not apply).
- **QA-S6-03 — apply smooth-cartoon (hot-swap, one frame). Grounded in ART §3.2 (`satScale 1.45`, contrast 0.72).**
  **Steps:** record `perfToken = await page.evaluate(() => (window.__qaPageToken ??= Math.random()))`. Move `smooth-cartoon` to Selected top by clicking its card's `[data-pack-action="move"]` button, then its `[data-pack-action="up"]` button until the card is the first `.pack-card` in the Selected column (§1.5 selectors — never rely on hover-revealed pixels). **Arm the frame probe before clicking Done:** `page.evaluate(() => { window.__qaAtlasFrames = []; const loop = () => { __qaAtlasFrames.push(__qa.getAtlasHash()); if (__qaAtlasFrames.length < 10) requestAnimationFrame(loop); }; requestAnimationFrame(loop); })`, then immediately click `Done` (probe start and click within the same ~1–2 frames). Read `__qaAtlasFrames`. Assert `getActiveTexturePack()==='smooth-cartoon'`; `__qaPageToken` unchanged (no reload). Pull `getAtlasTile('grass_top')` for both packs (default tile captured in setup): compute mean HSV saturation and value range.
  **Pass:** in `__qaAtlasFrames`, the hash changes **within the first 3 recorded rAF samples** (≈2 frames of `Done` + 1 frame arming slack) and stays constant after — this is the in-page frame-boundary instrument; evaluate-side polling cannot resolve a 2-frame window. No navigation; cartoon tile mean saturation **>** default's; cartoon value range (Vmax−Vmin) **<** default's.
  **Screenshot:** `qa/S6/QA-S6-03-cartoon-world.png` — same viewpoint as setup shot.
- **QA-S6-04 — apply gritty.**
  **Steps:** repeat with `gritty`.
  **Pass:** gritty tile mean saturation **<** default's; value range **>** default's (ART §3.2 contrast ~0.55 vs 0.35).
  **Screenshot:** `qa/S6/QA-S6-04-gritty-world.png`.
- **QA-S6-05 — revert + F3+T + persistence.**
  **Steps:** restore `default`, `Done`. In-world hold `F3` press `KeyT` (atlas regen, UX §5.14). Compare atlas hash before/after regen. Read `localStorage['mv2:settings']` → `activeTexturePacks`. Full `page.reload()` (same context) → re-enter world → active pack still default.
  **Pass:** F3+T rebuild is byte-identical (deterministic generator, ART §6.5); ordered list persisted; survives reload.

---

### S7 — Dimension portal round-trip **[gated: milestone ≥ M2 — requires P2 Nether]**

**Purpose:** Nether DimensionType, portal ignition/traversal/linking (PARITY §3). Include in every run; report `SKIPPED-GATED (nether)` until the cap exists.
**Applicability:** `[gate: nether, milestone ≥ M2]`.
**Setup:** WORLD_B creative; flat staging area; `give('obsidian',64)`, `give('flint_and_steel',1)`. Record origin pos `O`.

- **QA-S7-01 — frame + ignition.**
  **Steps:** build a 4×5 obsidian frame (interior 2×3, corners omitted = 10 obsidian). Use flint_and_steel (Mouse2) on an interior-adjacent frame block.
  **Pass:** 6 interior cells become `nether_portal` with `axis` prop; `getLight(portalCell).block === 11` (PARITY §3.3).
  **Screenshot:** `qa/S7/QA-S7-01-lit-portal.png`.
- **QA-S7-02 — traversal timing + Nether DimensionType.**
  **Steps:** creative: step in → dimension changes near-instantly. Return, `setGameMode('survival')`, step in and stand still; record ticks from entry to dimension change (`getDimension().id` flips). In the Nether read the dimension record.
  **Pass:** survival charge `80 ± 5 gt` (4 s); portal overlay `#portal-overlay` opacity ramps 0→1 over ~20 ticks (UX §5.15.3); Nether record: `min_y 0, height 256, coordinate_scale 8, has_ceiling true, ultrawarm true, fixed_time` set.
  **Screenshot:** `qa/S7/QA-S7-02-nether-arrival.png` — F3 showing dimension + XYZ.
- **QA-S7-03 — coordinate scale ÷8 + lava sea.**
  **Steps:** compare arrival `getPlayerPos()` to `O`: expect `|nether.x − O.x/8| ≤ 16` and same for z (link search tolerance). Probe `getBlock(x,31,z)` at 10 open columns.
  **Pass:** scale holds; lava present at y=31 in open Nether terrain (sea level per PARITY §1.1).
- **QA-S7-04 — round-trip linking.**
  **Steps:** re-enter the (auto-created or same) portal back to the Overworld.
  **Pass:** exit within 128 blocks of `O` (search radius, PARITY §3.3); total round-trip displacement ≤ 16 blocks; no duplicate portal spam (≤ 2 portals within 32 blocks of O).
  **Screenshot:** `qa/S7/QA-S7-04-roundtrip.png`.

---

### S8 — Save / quit / reload persistence

**Purpose:** world + player + settings persistence; deterministic regeneration from seed (M0 exit criterion: "world reloads deterministically from disk").
**Applicability:** milestone ≥ M0.
**Setup:** WORLD_A in-world; survival.

- **QA-S8-01 — edits + player state survive reload. Verifies (indirect):** Section storage of *"Shared TS `Section`"* + chunk persistence.
  **Steps:** at a marker spot: place a 3-block pattern `stone, oak_planks, glass` at `(bx, h, bz)..(bx+2, h, bz)`; set hotbar selection to slot 4; record `getPlayerPos/getYawPitch/getHotbar`. `Esc` → `Save and Quit to Title`. From `worldSelect` re-enter `qa-main` (its row shows updated relative `lastPlayed`).
  **Pass:** the 3 blocks, player pos (±0.5), yaw (±5°), hotbar contents and `getSelectedSlot()===4` all restored.
  **Screenshot:** `qa/S8/QA-S8-01-after-reload.png` — marker pattern + F3 XYZ.
- **QA-S8-02 — worldTime persists.**
  **Steps:** note `getWorldTime()` before quit (`t0`); reload; read `t1`.
  **Pass:** `t1 ≥ t0` and `t1 − t0 < 1200` (not reset to 0/6000; singleplayer pause means little drift).
- **QA-S8-03 — Re-Create regenerates identical terrain WITHOUT edits. Verifies (indirect):** *"legacy LCG"* + *"xoroshiro128++"* determinism — same seed ⇒ identical blocks at fixed coords across two independent generations.
  **Steps:** in `worldSelect` select `qa-main` → `Re-Create` → form prefilled with seed `8675309` → create (new id). `tp` to the PROBES columns and to the QA-S8-01 marker.
  **Pass:** PROBES signatures identical to QA-S2-06's recording; the marker cells contain **generated terrain**, not the placed pattern (edits are per-world).
- **QA-S8-04 — delete world flow.**
  **Steps:** `worldSelect`: select the Re-Created world → `Delete` → confirm dialog text `Delete world '<name>'? This cannot be undone.` → `Delete`.
  **Pass:** row removed; still absent after page reload (IndexedDB purged).
- **QA-S8-05 — settings persistence (`mv2:settings`).**
  **Steps:** change FOV to 90 and rebind `sprint` to `KeyR` (S10 flow); `page.reload()`; read settings screen + `localStorage['mv2:settings']`.
  **Pass:** JSON blob contains `video.fov: 90` and `keybinds.sprint.code === 'KeyR'`; UI reflects both after reload. Restore defaults afterwards.

---

### S9 — Two-client multiplayer sync + chat

**Purpose:** WS protocol v1 join flow, snapshots/interp, block-edit propagation, chat, tick health, interest management.
**Applicability:** milestone ≥ M0.
**Setup:** start SERVER_1 (§1.10). Two isolated contexts A and B (`browser.newContext()` ×2, each 1280×720). **Display names (normative dev-build mechanism):** dev builds MUST honor a `name` query parameter that sets the protocol `login.displayName` (protocol §4.1 #4) — A loads `http://localhost:5173/?qa=1&name=qa-alice`, B loads `http://localhost:5173/?qa=1&name=qa-bob` (builder: mirror this in UX §9.3; no name field exists on the title/multiplayer/directConnect screens, so the query param is the only automatable channel). On each: title → `Multiplayer` → (dismiss first-run disclaimer via `Proceed`) → `Direct Connection` → address `ws://localhost:25565` → `Join Server`. Attach a CDP session with `Network.enable` to **both A and B before joining** — A's capture feeds QA-S9-02, B's feeds QA-S9-07; enabling after join misses frames and voids both.

- **QA-S9-01 — join flow & roster.**
  **Steps:** watch the `data-screen="connecting"` status line advance through, in order, the **prefix regexes** `/^Connecting to/` → `/^Logging in/` → `/^Joining world/` → `/^Loading terrain/` — UX §9.4 renders `"Connecting to <host>..."` (host included) with ASCII three-dot ellipses, so never exact-match a full status string or a `…` character. Then in-world. On both clients read `__qa.getNetStats().connected`, and A: `getRemotePlayers()`.
  **Pass:** both in-world ≤ 15 s; A sees exactly one remote player named `qa-bob` (and vice versa); Tab hold (`Tab`) shows `#tab-list` (§1.5) containing exactly 2 `.tab-row` elements with `data-name="qa-alice"` and `data-name="qa-bob"`, each row containing a ping icon with `data-ping-bars` ∈ `"1".."5"` (UX §5.17).
  **Screenshot:** `qa/S9/QA-S9-01-tablist.png` — Tab overlay with both names.
- **QA-S9-02 — wire protocol conformance. Verifies:** *"WebSocket packet protocol, phases … keep-alive, compression"* (against MULTIPLAYER_PROTOCOL's normative `HANDSHAKE→LOGIN→JOIN→PLAY`; PARITY's "status/configuration" phrasing maps onto this v1 state machine).
  **Steps:** from A's captured frames: parse text-frame JSON `t` sequence and binary opcodes (first byte of base64-decoded payload).
  **Pass:** order holds: `hello`(C→S) → `hello_ok` → `login` → `login_ok` → `join_world` → `world_info` → ≥1 binary `0x30` → `player_list` → `ready` → `spawned`(C→S). Every `0x30` frame has `compression` byte (offset 13) ∈ {0,1,2} and `encoding` ∈ {0..4}; `world_info.seed === "8675309"`; `join_world.viewDistance ≤ 16`.
- **QA-S9-03 — remote player visibility & interpolation.**
  **Steps:** B walks a 10-block line (hold `KeyW` 50 ticks). A samples `getRemotePlayers()[0].pos` every 20 ms plus a timestamp; B samples its own `getPlayerPos()` per tick.
  **Pass:** A renders B's model + nametag (screenshot); A's view of B updates ≥ 15 distinct positions/s (no teleport-stepping); time lag of A's-view-of-B behind B's-own-timeline ∈ **[80, 300] ms** (interp buffer 100–200 ms + one snapshot); no extrapolation freeze while moving.
  **Screenshot:** `qa/S9/QA-S9-03-remote-player.png` — B's model + nametag in A's view.
- **QA-S9-04 — pose/flag sync (server-authoritative pose). Verifies:** *"`Pose` enum … **server-authoritative**"* via remote observation.
  **Steps:** B holds `ShiftLeft` 1 s, releases; B sprints 1 s; B attacks (Mouse0) once. A polls `getRemotePlayers()[0]` every 50 ms throughout.
  **Pass:** A sees `sneaking===true` within 300 ms of B's press and false after release; `sprinting` likewise; on the attack, at least one of A's polls shows `swinging===true` within 300 ms of B's click, returning to false afterwards — `swinging` is the §1.4 hook mirror of Snapshot `flags2` bit `0x0008 swingArm` (protocol §4.4.2), so no manual delta-decoding of `0x11` frames is needed.
- **QA-S9-05 — block-edit propagation latency. Verifies:** *"Chunk streaming: … delta block updates"* + edit-ack flow (protocol §7).
  **Steps:** A and B stand at the same staging area (server world, survival — `give` dirt via `--qa`). Loop 20×: A places dirt at a fresh cell `(x_i, y, z)` (Mouse2), recording `performance.now()` at click; B runs `page.waitForFunction` polling `__qa.getBlock(x_i,y,z)==='dirt'` (raf polling), recording detection time (clock-sync the two pages via a shared `Date.now()` reading; loopback skew ≪ tolerance). Also record A's `getLastEditResult()`.
  **Pass:** every edit `status:'applied'` with echoed `editId`; B-observes-latency **p50 ≤ 120 ms, p95 ≤ 250 ms** (loopback budget: ≤1 sim tick + broadcast + poll granularity); A's optimistic apply is instant (own view <1 tick).
  **Screenshot:** `qa/S9/QA-S9-05-edit-sync.png` — B's view of A's placed row.
- **QA-S9-06 — edit rate cap & convergence.**
  **Steps:** A sends a scripted burst of ~30 place-clicks in 1 s (alternating cells). Separately, A and B click-place different blocks into the **same** cell within the same tick window.
  **Pass:** burst: some edits rejected `RATE_LIMIT` (cap 20/s, protocol §0) and A's client **rolls back** rejected cells to authoritative state (A/B `getBlock` agree on every cell after 1 s); race: both clients converge to the identical winner block (worldSeq serialization) with no ghost block on the loser.
- **QA-S9-07 — chunk streaming & unload on movement. Verifies:** *"Chunk streaming: send/unload sections by view distance"*.
  **Steps:** B creative sprint-flies +X for 30 s (~650 blocks), screenshotting every 5 s. Sample `getLoadedSectionCount()` every second; afterwards check `getSection` for the start-area chunk and for the current chunk; count `0x31` ChunkUnload frames in **B's** CDP capture (attached pre-join per the S9 setup — B, not A, is the moving client whose chunks unload).
  **Pass:** new terrain renders ahead continuously — **void-gap check, quantitative:** in each 5 s screenshot, sample the sky color at device px (640,100), then compute the fraction of pixels in the **bottom half** of the frame (y ≥ 360) within ΔRGB ≤ 10 per channel of that sky color; it must be **< 5%** in every sample (sky-through-holes below the horizon = missing chunks). Loaded-section count stays bounded (< 1.3× its steady value — hysteresis ring, not monotonic growth); start-area sections unloaded (`getSection === null`); ≥ 1 ChunkUnload frame observed in B's capture.
  **Screenshot:** `qa/S9/QA-S9-07-streaming.png` — mid-flight horizon, F3 chunk counts.
- **QA-S9-08 — interest management / tracking range. Verifies:** *"per-entity client tracking range (players ~48 … items ~32)"* (PARITY §31; simulation distance is tested separately in QA-S9-13).
  **Steps:** (a) coarse despawn/respawn: B teleports 200 blocks away (`__qa.tp`); A polls `getRemotePlayers()` for 5 s. B returns to within 20 blocks. (b) **player tracking range bracketed (~48):** from 10 blocks apart, B creative-flies +X away from A at fly speed (~10.9 b/s) while A samples `getRemotePlayers()` + own `getPlayerPos()` every 50 ms; when B first disappears from A's list, record A's distance to B's **last-seen** `pos` =: D_p. (c) **item tracking range (~32):** A drops a full dirt stack (`KeyQ`) at its feet, records the drop cell, then creative-flies +X away while sampling `getEntities('item')` + own pos every 50 ms; record A's distance from the drop cell when the item entity first leaves the list =: D_i (stay < 96 blocks total so the item's chunk remains simulated — this measures interest, not unload).
  **Pass:** (a) B disappears from A's entity list (despawn `out_of_range`) once outside range — 200 blocks only proves range < 200; (b) supplies the real number: `D_p ∈ [40, 60]` (brackets the ~48-block player tracking range; chunk/snapshot granularity tolerance) and reappears via a fresh `entity_spawn`/keyframe record on return; (c) `D_i ∈ [24, 40]` (brackets ~32 for items). Throughout all phases A's `#tab-list` still contains `.tab-row[data-name="qa-bob"]` (§1.5 — roster ≠ interest set).
- **QA-S9-09 — chat round-trip, limits, command routing.**
  **Steps:** A: `KeyT` → chat overlay (pointer lock released) → type `qa-ping-<epochms>` → `Enter`. B: `waitForFunction` on `getChatLog`. Then A sends 4 messages in <2 s. Then A types a 300-char string. Then A: `Slash` → prefilled `/` → `tick query` → Enter `[gate: commands.tick]`; fallback: send `/definitely_not_a_command`.
  **Pass:** B receives ≤ 500 ms with sender name `qa-alice` (server-stamped); 4th rapid message throttled (client block or server `RATE_LIMIT`; the 4th does NOT appear on B within 2 s); input caps at 256 chars (`CHAT_MAX_CHARS`); command produces a **system** reply only to A (`/tick query` → TPS text; unknown → `Unknown command`) and the raw `/…` text is never broadcast to B.
  **Screenshot:** `qa/S9/QA-S9-09-chat.png` — B's chat log showing A's message.
- **QA-S9-10 — server tick health & keepalive. Verifies:** *"Server tick loop 20 TPS (50 ms), MSPT metric, `/tick …`"* + *"keep-alive"* + *"Game tick 50 ms"* (server half).
  **Steps:** with both clients connected and idle 40 s: read A's F3 line 3 (`ms tick / TPS`) and `getServerTps()/getMspt()` every 5 s; watch `getNetStats().lastPingAtMs`.
  **Pass:** TPS = `20 ± 0.5` sustained; MSPT < 50 ms; no disconnect during 40 s idle; `lastPingAtMs` advances at ~15 s cadence (keepalive ping/pong, protocol §4.10); `rttMs` non-null.
- **QA-S9-11 — entity interaction reach 3.0 (survival). Verifies:** *"`entity_interaction_range` base **3.0** (creative +2.0 = **5.0**)"*. `[gate: damage, ≥ M1]` (§1.8 token — `set_health`/`entity_hurt` wired to the §1.4 `getHealth`/`getLastHurt` getters).
  **Steps:** A and B stand at measured eye-to-hitbox distances 2.8 then 3.5 (position via `tp`; aim at B's hitbox center with `setLook`, confirm no block targeted). At each distance: record B's `h0 = getHealth().health` and `getLastHurt()`; A attacks B (Mouse0) once; B polls both getters for 40 ticks. Repeat in creative at 4.8 / 5.4.
  **Pass:** survival **hit at 2.8**: within 40 ticks B's `getHealth().health < h0` AND `getLastHurt()` returns a fresh record (`tick` ≥ the attack tick, `sourceType` 'player'); **no hit at 3.5**: both getters unchanged over 40 ticks. Creative: hit at 4.8, no hit at 5.4 by the same two-getter criteria. (Damage tilt / hurt flash are corroborating screenshot evidence only — the getters are the pass channel.)
- **QA-S9-12 — `/tick` command family. Verifies:** the *"`/tick freeze|rate|step|sprint|query`"* fragment of the tick-loop P0 (query itself is exercised in QA-S9-09). `[gate: commands.tick]`
  **Steps (A's chat; each command via `Slash` → type → `Enter`; measure via `__qa.getGameTick()`/`getWorldTime()` polled every 100 ms):**
  1. `/tick rate 10` → over the next 10 s wall clock, `getGameTick()` advances `100 ± 5` (half speed); `/tick rate 20` → advances `200 ± 4` per 10 s again (restored; QA-S2-09-style counting).
  2. `/tick freeze` → over 2 s, `getGameTick()` advances 0 and `getWorldTime()` is static (frozen world renders).
  3. `/tick step 20` (while frozen) → `getGameTick()` advances **exactly 20** then halts again (no further advance over the next 2 s).
  4. `/tick sprint 100` → completes: `getGameTick()` jumps ≥ 100 in < 5 s wall clock and a **system** chat line reporting the sprint result appears in A's `getChatLog` only.
  5. Unfreeze (`/tick unfreeze`; if the build implements freeze as a toggle, `/tick freeze` again — accept either, assert the effect) → `getGameTick()` advances `40 ± 2` over the next 2 s.
  **Pass:** every numbered measurement as stated; each command produces a system reply to A only (never broadcast to B — cross-check B's `getChatLog`).
- **QA-S9-13 — simulation distance vs view distance. Verifies:** *"View distance (render chunks) vs **simulation distance (ticked)**"* — the ticking half row 50 needs (SERVER_1: view distance 8 = 128 blocks, sim distance 6 = 96 blocks, §1.7/§1.10).
  **Steps:** A at spawn, standing still. Pick two surface cells due +X of A (wait `isColumnLoaded`, use `getHeightmapAt`): `P_in` at +80 blocks (chunk distance 5 ≤ 6 — inside sim) and `P_out` at +112 blocks (chunk distance 7 > 6 — outside sim but inside view 8). Via `__qa.setBlock`, place a water source at each. Wait 60 ticks. Then A walks/flies +X 40 blocks (P_out now at chunk distance ≤ 4) and waits another 60 ticks.
  **Pass:** after the first wait: `P_in` has ≥ 1 orthogonal neighbor that is water `level ≥ 1` (fluid ticked — 5-tick updates ran), while **all 4** orthogonal neighbors of `P_out` are still non-water even though `getBlock(P_out)==='water'` reads fine (chunk streamed/rendered but NOT ticked — render ≠ simulation); after A moves within sim distance, `P_out`'s spread starts within 60 ticks (ticking resumes).

---

### S10 — Settings & audio

**Purpose:** live-apply video settings, GUI scale math, keybind rebinding + conflicts, mouse sensitivity curve, audio bus gains.
**Applicability:** milestone ≥ M0 (`audio` sub-tests gated).
**Setup:** WORLD_B in-world; `Esc` → `Options...`. **Setting exact values:** the custom slider widgets have no drag contract — every "set `<key>` to `<value>`" step below means `__qa.setSetting('<key>', <value>)` (§1.4; identical effect to the UI control, live-apply + persistence included), followed by asserting the `[data-setting="<key>"]` control (§1.5) displays the new value. Never attempt knob-drag pixel math. Run `ensureLocked(page)` (§1.2) after every return in-world.

- **QA-S10-01 — render distance live-apply. Verifies:** *"View distance (render chunks) vs simulation distance"* (client render half) + chunk send/unload.
  **Steps:** `Video Settings...`; set `video.renderDistance` to 2 (per the Setup rule); wait 5 s; read `getLoadedSectionCount()` (=: n2); screenshot. Set to 8 → n8; set to 16 → n16 (multiplayer: server clamps to its viewDistance — accept clamp, assert via `join_world.viewDistance`); screenshot.
  **Pass:** n2 < n8 < n16 (roughly ∝ (2r+1)²); applies **without reload** (page token unchanged); far terrain visibly appears/disappears between the two screenshots.
  **Screenshots:** `qa/S10/QA-S10-01-rd2.png` and `qa/S10/QA-S10-01-rd16.png` (one file per capture, same fixed `setLook` viewpoint).
- **QA-S10-02 — FOV slider live.**
  **Steps:** set `fov` 70 → 110; read `getCameraFov()`; screenshot same viewpoint at both.
  **Pass:** camera fov tracks slider exactly (70 then 110); 110 frame shows strictly more world (fixed landmark occupies smaller fraction).
- **QA-S10-03 — GUI scale. Verifies UX §0.2 algorithm.**
  **Steps:** read CSS var `--S` on `:root` (expect `3` at Auto/1280×720). Measure `page.locator('[data-hud="hotbar"]').boundingBox().width` (§1.5 — the hotbar **container** stamped on the 182×22 gp sprite; do NOT approximate by spanning the `data-hotbar-slot` cells — the slot0-left→slot8-right span is a different gp width than the 182 gp sprite). Set `video.guiScale` to 1; re-measure.
  **Pass:** Auto ⇒ S=3, `[data-hud="hotbar"]` width 546 px (182 gp × 3); guiScale 1 ⇒ 182 px; layout re-anchors bottom-center.
  **Screenshot:** `qa/S10/QA-S10-03-guiscale1.png`.
- **QA-S10-04 — smooth-lighting AO toggle. Verifies:** the *"smooth-lighting AO"* clause of the incremental-lighting P0.
  **Steps:** stand in a dug 2×2 pit corner (inner corner in view, fixed `setLook`); screenshot with `smoothLighting: Max`; set `Off`; screenshot.
  **Pass:** corner-adjacent pixel region mean luminance differs ≥ 10% between modes (vertex-AO darkening present at Max, absent at Off, ART §1.5); setting applies live (remesh, no reload).
  **Screenshots:** `qa/S10/QA-S10-04-ao-on.png` (Max) and `qa/S10/QA-S10-04-ao-off.png` (Off) — one file per capture.
- **QA-S10-05 — audio buses & sliders. `[gate: audio, ≥ M1]`**
  **Steps:** `Music & Sounds...`; read `getAudio()` — `gains.master===1.0` etc. Set `master` 50 → gain 0.5. Set `blocks` 0; in-world break a dirt block; sample `getAudioRms()` around the break. Restore 100; break again.
  **Pass:** gain nodes track sliders (effective = master×category, UX §4.4); muted-category break ⇒ RMS < 0.001; unmuted ⇒ RMS > 0.01 within 500 ms of the break.
- **QA-S10-06 — keybind rebind + conflict detection. Verifies:** *"Keybinds (rebindable, conflict detection): move WASD, jump Space, sneak LShift, sprint LCtrl … chat T, tab, F5 …"*.
  **Steps:** `Controls...` → Key Binds list. Assert default rows match UX §11 (spot-check 9: `moveForward W`, `jump Space`, `sneak Left Shift`, `sprint Left Ctrl`, `attack Left Mouse`, `openInventory E`, `dropItem Q`, `openChat T`, `togglePerspective F5`; and that `F1/F3/F11/Esc` are hardcoded/non-rebindable). Click the `sprint` rebind button → shows `> ... <` → press `KeyR`. Return in-world: hold `KeyR`+`KeyW` → sprint speed; `ControlLeft` no longer sprints. Back in Controls: rebind `jump` to `KeyR` too → both rows render in `--ui-text-err` (#FF5555) with ⚠. Click `Reset Keys` → confirm → all defaults restored.
  **F1/F5 behavior (not just their list rows):** return in-world (`ensureLocked`). (i) Press `F1` → `#hud-root` content hidden (UX §5.6: Hide GUI hides EVERYTHING in `#hud-root`) — assert `[data-hud="hotbar"]` and the crosshair are not visible, screenshot; press `F1` again → both restored. (ii) Take a first-person baseline screenshot at a fixed `setLook`; press `F5` → third-person-back: screenshot differs from baseline by ≥ 3% of pixels in the center 400×400 region (own player model now in frame; crosshair still visible per UX §5.7); press `F5` twice more (→ third-person-front → first-person): final screenshot differs from baseline by ≤ 0.5% (cycle returns to start).
  **Pass:** every step as stated, including the F1 hide/restore and the F5 three-state cycle; rebind persists across reload (cross-ref QA-S8-05).
  **Screenshots:** `qa/S10/QA-S10-06-conflict.png` — the two conflicted rows in red; `qa/S10/QA-S10-06-f1-hidden.png` — HUD hidden; `qa/S10/QA-S10-06-f5-thirdperson.png` — third-person-back view.
- **QA-S10-07 — mouse sensitivity curve + invertY.**
  **Steps:** `Mouse Settings...`: set `sensitivity` 200%. In-world `lookDelta(cdp, +10, 0)` → expect Δyaw `= 10 × ((2·0.6+0.2)³·8·0.15) = 32.93° ± 1.5°` (UX §10.2 cubic curve — NOT linear 2×). Set back to 100%. Toggle `invertY` on: `lookDelta(0, +50)` → pitch **decreases**.
  **Pass:** both measurements per formula.
- **QA-S10-08 — brightness gamma.**
  **Steps:** stand in a dim cave mouth (fixed view, night `setTime(18000)`); screenshot at `brightness` 0.0 (Moody) and 1.0 (Bright).
  **Pass:** mean luminance strictly increases 0.0 → 1.0 (≥ 15% relative) while sky region stays comparable (gamma uniform affects dark end, UX §4.2); applies live.

---
## 3. Performance Budgets (headless-measurable)

Run with the §1.1 uncapped flags, in-game `vsync=off`, `maxFramerate=Unlimited`, `graphics=Fancy`, `particles=All`. All windows follow a **30 s warm-up** after the stated setup unless noted. Report every metric with its raw sample file (`qa/PERF/<id>-samples.json`).

**Uncap sanity check (mandatory before trusting ANY fps number):** in headless "new" mode the compositor may still pace rAF at ~60 Hz despite `--disable-frame-rate-limit` — a measured median of exactly 60 is then a capped sampler, not the engine. Before PERF-02/PERF-03, open `about:blank` in a fresh page of the same browser and run toolbox (a) for 3 s: the blank-scene rAF rate must exceed **200 fps**. If it does not, frame pacing is capped — discard headless fps numbers and rerun the perf scenarios headed under `xvfb-run -s "-screen 0 1280x720x24"` (repeat the sanity check there). This is a separate trigger from the §1.1 WebGL-init fallback, which only fires on a black canvas. **Baseline:** all §3 budgets are calibrated for **SwiftShader software WebGL** on a runner with ≥ 8 hardware threads; they are floors — GPU-accelerated headed runs must meet the same numbers.

**Measurement toolbox (concrete):**

```ts
// (a) rAF frame-time sampler — median/p1 fps, hitch detection
const deltas = await page.evaluate((ms) => new Promise(res => {
  const ts = []; let stop = false; setTimeout(() => stop = true, ms);
  const loop = t => { ts.push(t); stop ? res(ts) : requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}), 60000).then(ts => ts.slice(1).map((t, i) => t - ts[i]));
// fpsMedian = 1000 / median(deltas); fpsP1 = 1000 / percentile(deltas, 99)

// (b) long-task observer — main-thread stalls ≥ 50 ms
await page.evaluate(() => {
  window.__qaLongTasks = [];
  new PerformanceObserver(l => __qaLongTasks.push(...l.getEntries().map(e => e.duration)))
    .observe({ type: 'longtask', buffered: true });
});

// (c) CDP heap + metrics (Playwright)
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
await cdp.send('HeapProfiler.collectGarbage');           // force GC before reading
const m = (await cdp.send('Performance.getMetrics')).metrics;
const heapMB = m.find(x => x.name === 'JSHeapUsedSize').value / 2**20;

// (d) WS bandwidth — sum payload bytes over a window
await cdp.send('Network.enable');
let bytesIn = 0;
cdp.on('Network.webSocketFrameReceived', e => {
  const p = e.response.payloadData;
  bytesIn += e.response.opcode === 2 ? Math.floor(p.length * 3 / 4) : p.length; // base64 → bytes
});
```

Cross-check (a) against `__qa.getFrameTimesMs()`; if they disagree > 10%, trust the rAF sampler and file a hook bug.

| id | Budget | Setup & window | Measure | Pass |
|---|---|---|---|---|
| **PERF-01** | **Load time.** Title interactive ≤ **5 s** from `goto`; **title→in-world ≤ 10 s** singleplayer (WORLD_A), ≤ **15 s** multiplayer join (SERVER_1, RD 8). "Title interactive" = `section.screen[data-screen="title"]` attached and visible ∧ `getByRole('button', { name: 'Singleplayer' })` visible and enabled ∧ `__qa.getScreen()==='title'` (all three; poll every 100 ms). "In-world" = `getScreen()===null` ∧ `getLoadedSectionCount() ≥ 100` ∧ first rendered frame (`getFps() > 0`). | Cold context, no cache. One sample per mode, 3 repeats. | `performance.now()` deltas around the `goto`/`Play`/`Join Server` actions. | All 3 repeats within budget. |
| **PERF-02** | **FPS floor.** RD 8: **median ≥ 60 fps, p1 ≥ 30 fps**. RD 16: **median ≥ 30 fps**. | WORLD_B, standing at spawn looking at horizon (fixed `setLook(270,10)`), noon. 60 s window per RD after warm-up. | Toolbox (a). | Both RD rows meet floors; report medians/p1s. |
| **PERF-03** | **Chunk-load hitch.** While flying at **sprint-fly speed (≈21.78 b/s)** in a straight line for 30 s (continuous chunk gen+mesh): target **no frame > 50 ms**; **FAIL if any frame > 100 ms or > 5 frames > 50 ms** in the window. | WORLD_B creative, y≈90, RD 8, fresh heading (unexplored +X). | Toolbox (a) deltas + (b) longtasks over the same window (attribute stalls). | Thresholds met; longtask count reported. |
| **PERF-04** | **Memory ceiling & leak.** After **5 min at RD 12** of mixed activity (fly 60 s, walk 60 s, break/place 60 s, idle 120 s): post-GC JS heap **≤ 512 MB target, > 1024 MB = FAIL**; leak check: post-GC heap at minute 5 ≤ **1.10×** post-GC heap at minute 3. This soak also hosts the QA-S4-20 item-despawn (6000 gt) check. | WORLD_B, RD 12. GC-then-read at minutes 3 and 5 (toolbox c). | `JSHeapUsedSize` after `HeapProfiler.collectGarbage`. | Ceiling + growth bound hold. |
| **PERF-05** | **Network.** (i) Initial join at RD 8: chunk egress rate ≤ **1.65 MB/s** (CHUNK_BUDGET 1.5 MB/s + 10% jitter) and total join bytes ≤ **8 MB** (~1–2 KB/section, protocol §5.1/§5.3). (ii) Steady state, 2 clients idle: S→C ≤ **10 KB/s** per client averaged over 30 s. (iii) Both clients walking: ≤ **30 KB/s**; average binary Snapshot frame ≤ **120 B** (2 entities × 16–24 B + header, protocol §6.6). | SERVER_1 + 2 contexts (S9 setup). | Toolbox (d) on each page; bucket by 1 s; separate opcode 0x30 traffic from the rest via first payload byte. | All three sub-budgets hold. |
| **PERF-06** | **Edit path latency.** 40 place/break edits at ≤ 10/s: `getLastEditResult().rttMs` **p50 ≤ 60 ms, p95 ≤ 150 ms** on loopback; zero rejects below the 20/s cap; remote-observe p95 ≤ 250 ms (= QA-S9-05 numbers, re-reported here). | SERVER_1, 2 clients at spawn. | `__qa.getLastEditResult()` per edit + S9-05 methodology. | Percentiles within budget. |

---
## 4. P0 Coverage Matrix — all 51 PARITY **[P0]** items → tests

Row text is a verbatim fragment of the PARITY checkbox line. "Indirect" = the item is server-internal; the test verifies its unique observable consequence. Gates repeat the owning test's gate; everything else is **M0**.

| # | PARITY § | P0 item (verbatim fragment) | Test id(s) | Notes |
|---|---|---|---|---|
| 1 | 1.1 | "Overworld build range **y ∈ [-64, 319]**" | QA-S2-08, QA-S4-10 | bounds + edit clamps |
| 2 | 1.1 | "Sea level **y=63** overworld; Nether lava sea **y=31**; End sea **y=0**" | QA-S2-05; QA-S7-03 (lava sea y=31 — gate: nether, ≥ M2) | M0 core = overworld y=63. **End sea y=0 has no test at any milestone** — untestable until P3 End exists; annotate this in every report (never FAIL it, never claim coverage) |
| 3 | 1.1 | "Chunk = 16×16 columns … **16×16×16 sections** (24 in overworld)" | QA-S2-08, QA-S2-04 | F3 chunk math + section probes |
| 4 | 1.2 | "World seed = signed 64-bit long; numeric… non-numeric→**Java `String.hashCode()`**; empty→random" | QA-S2-02 | |
| 5 | 1.2 | "`minecraft:legacy` = `java.util.Random` LCG" | QA-S2-06(a), QA-S8-03 | **direct**: known-answer golden vector via `prngSample` (same-seed terrain alone would pass with any seeded PRNG — insufficient); S8-03 adds cross-generation determinism |
| 6 | 1.2 | "`minecraft:xoroshiro` = xoroshiro128++" | QA-S2-06(b), QA-S8-03 | **direct**: raw-state golden vector via `prngSample`, as #5 |
| 7 | 1.11 | "Overworld bedrock floor: `P(bedrock)=1.0@y-64 → 0.0@y-59` … unbreakable" | QA-S4-08 | band statistics + unbreakable |
| 8 | 1.11 | "Overworld water at/below y63 in open low terrain" | QA-S2-05 | |
| 9 | 1.12 | "Column top cover … grass_block+dirt over stone; underwater→dirt/gravel/sand" | QA-S2-07 | |
| 10 | 1.13 | "Game tick **50 ms (20 tps)**" | QA-S2-09, QA-S9-10 | client + server halves |
| 11 | 1.13 | "Shared TS `Section = { y; blocks:Uint16Array(4096); palette… }`" | QA-S2-08, QA-S9-02, QA-S8-01 | indirect: section probes, 0x30 palette encoding, disk round-trip |
| 12 | 1.14 | "**Default** (`minecraft:normal`)" | QA-S2-03 | noise terrain, not flat |
| 13 | 3.1 | "`DimensionType = { min_y, height, … }` — shared TS type" | QA-S2-08, QA-S7-02 | S7 gated ≥ M2 |
| 14 | 3.1 | "**Overworld:** min_y-64/h384, scale1.0, skylight yes/ceiling no…" | QA-S2-08 | + day cycle via QA-S2-09/S4-19 |
| 15 | 4.1 | "`BlockDef = { id, hardness, blastResistance, toolClass, … }`" | QA-S4-01 | |
| 16 | 4.1 | "**Break-time formula:** `speed = …` breaks when accumulated ≥1" | QA-S4-02, QA-S4-03, QA-S4-04, QA-S4-05 | timed to ±1 tick vs formula |
| 17 | 4.1 | "`canHarvest = …`; wrong tool = 5× slower + no drop" | QA-S4-03, QA-S4-04 | 150 vs 23 ticks; drop present only with tool |
| 18 | 4.1 | "`hardness==0` → instant break" | QA-S4-07 (runtime, gate: torch/sapling ≥ M1), QA-S4-01 (data — conditional) | **Honest M0 scope:** no hardness-0 block is in the M0 core set, so if neither `torch` nor `sapling` is registered, QA-S4-01's data half asserts nothing and this row's M0 core is **vacuous** — report the whole row `SKIPPED-GATED (torch\|sapling)` and flag it as the plan's one known M0 verification hole (§1.8); it must NOT be counted as a pass. When a hardness-0 block IS registered at M0, the data check (hardness===0) runs unconditionally and the row's M0 core = that check |
| 19 | 4.1 | "Representative hardness/blast/tool/tier table … ship as JSON" | QA-S4-01, QA-S4-08 | bedrock −1 unbreakable |
| 20 | 4.2 | "**Terrain/natural** … **[P0]** core: stone, dirt, grass_block, sand, gravel, water, log" | QA-S4-06, QA-S4-02..05, QA-S2-07 | place + break + worldgen presence |
| 21 | 4.2 | "**Fluids:** water (source+levels 1–7), lava (source+flow), waterlogging" | QA-S4-11, QA-S4-12, QA-S4-13, QA-S4-14 | waterlogging gated ≥ M1 |
| 22 | 4.3 | "`blockstate = { block, props }`; property types bool/int-range/enum" | QA-S4-09 | log axis, water level |
| 23 | 5 | "`ItemDef = { id, maxStack:1\|16\|64, … }`" | QA-S4-01, QA-S5-01 | |
| 24 | 5 | "Stack sizes: default 64; 16 (…); 1 (tools…)" | QA-S5-08 | 16-cap gated ≥ M1 |
| 25 | 8.9 | "`ItemEntity = { stack, pickupDelay=10gt, age, despawnAge=6000gt }`" | QA-S4-20, QA-S5-07 | despawn checked in PERF-04 soak |
| 26 | 8A.1 | "Gravity: subtract **0.08 b/t²** … THEN ×0.98 … terminal ≈ **3.92 b/t**" | QA-S3-05 | closed-form vy sequence |
| 27 | 8A.1 | "Jump: set vy = **0.42 b/t** (peak ≈ **1.252**) … **sprint-jump** +0.2" | QA-S3-05, QA-S3-06 | |
| 28 | 8A.1 | "Horizontal move: `vel = (vel + accel)·slipperiness·0.91`; ground accel ≈ 0.1, air ≈ 0.02" | QA-S3-02, QA-S3-03, QA-S3-10, QA-S3-06(b) | ground half indirect via emergent speeds + stop distance; **air half direct** via the QA-S3-06(b) airborne-acceleration probe (0.018 b/t first-tick gain) |
| 29 | 8A.1 | "`slipperiness` = friction of the block underfoot (default **0.6**, ice **0.98**…)" | QA-S3-10 | ice half gated ≥ M1 |
| 30 | 8A.1 | "walk **4.317**, sprint **5.612**, sneak **1.295**, creative/spectator fly **10.89**" | QA-S3-02, QA-S3-03, QA-S3-04, QA-S3-09 | all ±2% |
| 31 | 8A.1 | "Auto step-up: climb ledges ≤ **0.6 blocks**" | QA-S3-07 | **positive AND negative both M0**: (a1) 1.0-block negative + (a2) 0.5-height `setTestCollider` positive — an unimplemented step-up fails (a2); slab variant (b) confirms on real geometry ≥ M1 (`slabs`) |
| 32 | 8A.2 | "Collision AABB … standing **0.6×1.8** eye **1.62**; sneaking **0.6×1.5** eye **1.27**…" | QA-S3-02, QA-S3-04 | |
| 33 | 8A.2 | "`Pose` enum … **server-authoritative** (client predicts)" | QA-S3-04, QA-S9-04 | local + remote-view sync |
| 34 | 9.1 | "Reach … `block_interaction_range` base **4.5** (creative … **5.0**); `entity_interaction_range` base **3.0**" | QA-S4-15, QA-S4-16, QA-S9-11 | ranges are eye→raycast-**hit-point**, compared with inclusive ≤ (see QA-S4-15 semantics); entity half gated ≥ M1 (`damage`) |
| 35 | 19 | "Two channels sky+block 0–15; rendered brightness `max(block, sky·timeFactor)` + gamma curve" | QA-S4-17, QA-S4-19, QA-S2-04, QA-S10-08 | F3 Light line + night render; gamma curve = QA-S10-08 brightness test |
| 36 | 19 | "Flood-fill 6-neighbor (no diagonal); step `light − max(1, opacity)`" | QA-S4-17 | diagonal = 13 not 14 |
| 37 | 19 | "Skylight 15 straight down through transparent columns" | QA-S4-18 | |
| 38 | 19 | "Incremental light updates on place/break…; smooth-lighting AO" | QA-S4-19, QA-S10-04 | |
| 39 | 20 | "Water: source (level 0/8) + flowing 1–7; horizontal spread ≤7 … update every 5 ticks" | QA-S4-11 | |
| 40 | 20 | "Infinite source: flowing cell with ≥2 orthogonal source neighbors → source" | QA-S4-12 | |
| 41 | 22 | "`SURVIVAL=0`: all damage, hunger, tool-gated breaking, drops+XP, … no flight; reach 4.5/3.0" | QA-S3-08, QA-S4-02..04, QA-S4-15 | damage/hunger subsystems are P1; P0 scope = gating/drops/no-flight/reach |
| 42 | 22 | "`CREATIVE=1`: invuln…, instant break, double-tap flight, infinite blocks, creative inventory…, MMB pick block, reach 5.0/5.0" | QA-S3-09, QA-S4-16, QA-S5-09, QA-S5-11 | creative toolbar save/load sub-check gated ≥ M1 (`savedToolbars`) |
| 43 | 26 | "Player inventory: 36 main (hotbar 0–8, storage 9–35), 4 armor, offhand, 2×2 crafting, ender_chest 27" | QA-S5-01 | ender chest sub-check gated ≥ M1 |
| 44 | 26 | "Interactions: LMB pick/place, RMB half/one, shift-click, double-click gather, drag-distribute, number keys 1–9, Q/Ctrl+Q, F offhand, MMB creative copy" | QA-S5-02, QA-S5-03, QA-S5-04, QA-S5-05, QA-S5-06, QA-S5-07, QA-S5-09, QA-S5-11 | full §6.10 matrix; MMB creative copy (GUI stack-clone) + creative fill-drag = QA-S5-11 (distinct from S5-09's in-world pick-block and S5-05's LMB/RMB drags) |
| 45 | 27 | "Hotbar (9 + selection highlight + item tooltip), crosshair + attack-cooldown indicator, offhand slot" | QA-S5-10, QA-S5-06 | |
| 46 | 27 | "Debug F3 overlay: XYZ, chunk-relative, facing/yaw/pitch, biome, light, day, FPS, chunk/entity counts, memory, seed, targeted block…" | QA-S2-04 | |
| 47 | 27 | "Keybinds (rebindable, conflict detection): move WASD, jump Space, … chat T, tab, F5, F1, F3" | QA-S10-06, QA-S10-07 | defaults exercised throughout S3–S5 |
| 48 | 31 | "Server tick loop 20 TPS (50 ms), MSPT metric, `/tick freeze\|rate\|step\|sprint\|query`" | QA-S9-10, QA-S9-09, QA-S9-12 | tick loop + MSPT = M0 core; the full `/tick` family gated on `commands.tick`: query in QA-S9-09, freeze/rate/step/sprint in QA-S9-12 |
| 49 | 31 | "WebSocket packet protocol, phases handshake→…→play, keep-alive, compression" | QA-S9-01, QA-S9-02, QA-S9-10 | verified against MULTIPLAYER_PROTOCOL v1 state machine (HANDSHAKE→LOGIN→JOIN→PLAY) |
| 50 | 31 | "View distance (render chunks) vs simulation distance (ticked); per-entity client tracking range (players ~48 … items ~32)" | QA-S9-08, QA-S9-13, QA-S10-01 | simulation-distance ticking halt = QA-S9-13; tracking ranges bracketed (players 40–60, items 24–40) = QA-S9-08(b,c) |
| 51 | 31 | "Chunk streaming: send/unload sections by view distance…; delta block updates; entity spawn/move/despawn packets" | QA-S2-03, QA-S9-05, QA-S9-07, QA-S9-08 | spiral load, EditApply deltas, unload, entity lifecycle |

**Matrix invariants for the QA agent:** every row above must resolve to PASS (or SKIPPED-GATED **only** for the deferred sub-check fragments exhaustively enumerated in §1.8 — that list and the Notes column are, by construction, the same set; if they ever disagree, treat it as a plan bug and follow §1.8). The **M0 core** of each row (everything in the P0 line not on the §1.8 deferred list) must PASS at M0 — with the single documented exception of row 18 when no hardness-0 block is registered (see its note: report SKIPPED-GATED + the known-hole annotation, never PASS). File one bug per failing row, titled `[P0-<#>] <fragment> — <test-id> FAIL`, attaching the test's screenshot(s) and raw samples.

---

## 5. Reporting

Emit `qa/report.json`: `{ testId, status, durationMs, screenshots[], metrics?, gateToken?, failReason? }[]` plus a markdown summary table grouped by scenario. Order bugs by matrix row number (P0 order), then perf budget violations. Re-run flaky failures once; a pass-on-retry is still reported (`flaky: true`).




