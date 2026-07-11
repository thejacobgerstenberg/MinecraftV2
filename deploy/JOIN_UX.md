# Join a Server — In-Game Menu UX Spec

A concrete, implementable design for adding a **"Join a server"** flow to Loomfall's
in-game menu. This document references the real client modules and is honest about
what the current server/client already support versus what the builder must add.

> **Scope note (deploy branch rules):** everything the builder actually *writes*
> lives under `public/src/` and is the game author's code — this file only
> **specifies** it. The deploy branch itself only adds files under `deploy/`.
> This spec is the design contract; the menu/client author implements it against
> the modules cited below.

---

## 0. Current reality (from recon — do not contradict)

The client today is a **single-origin app**. There is no server-address field.

- `public/src/net/NetClient.js` — the WS wrapper.
  - `connect(url, worldId, name, dim)` (line 37) calls `normalizeWsUrl(url)`
    (line 208), opens `new WebSocket(wsUrl)` (line 55), sends
    `{ t:'join', worldId, name, dim }` on open (line 62), and resolves with the
    `welcome` payload (line 76). It **rejects** on timeout
    (`WELCOME_TIMEOUT_MS = 10000`, line 7/51), on `ws.onerror` (line 89), and on
    `ws.onclose` before welcome (line 93).
  - `normalizeWsUrl(url)` (line 208) is the **one place the WS URL is built**:
    `https://`→`wss://`, `http://`→`ws://`, bare host → `ws://host`, and it
    appends `/ws` when the URL is origin-only. So the endpoint is always
    `ws(s)://<host>/ws`. **This spec reuses that function unchanged** — the Join
    flow's whole job is to feed it a good `url`.
- `public/src/main.js` — the single caller.
  - Line 606-607:
    ```js
    const net = new NetClient();
    const welcome = await net.connect(location.origin, worldMeta.id, getPlayerName(), dim);
    ```
    The URL is hardcoded to `location.origin`. **The Join flow's core change is to
    pass a user-chosen origin here instead of always `location.origin`.**
  - REST world API, all same-origin: `apiGetWorlds()` → `GET /api/worlds`
    (line 112), `apiCreateWorld()` → `POST /api/worlds` (line 118),
    `apiGetWorld(id)` → `GET /api/worlds/:id` (line 128).
  - `getPlayerName()` (line 138) supplies the display name.
  - `initMenus({...})` is wired at `main.js:342` with `getWorlds: apiGetWorlds`
    and `onPlayWorld: (world) => startGame(world)`.
- `public/src/ui/menu.js` — the menu system.
  - `initMenus(opts)` (line 154) builds screens `main`, `worlds`, `settings`,
    `pause` (line 198). `refreshWorlds()` (line 343) renders the world list with a
    per-row **Play** button → `onPlayWorld(world)` (line 363).
  - Settings persist to `localStorage["loomfall.settings"]` via `loadSettings()`
    (line 218) / `persistSettings()` (line 228) — **the exact pattern this spec
    reuses for the recent-servers list.**
  - `setLoading(textOrNull)` (line 581) drives the `#loading` overlay used during
    `net.connect` today (`main.js:605`).

**Server facts:** health endpoint `GET /api/health` → `200 {"ok":true}`
(`server/index.js:266`, liveness-only). WS upgrade at `/ws`. Default port `3000`
via `process.env.PORT`. **There is no `MAX_PLAYERS` cap and no version handshake
today** — those failure modes are specified below as *forward-compatible* and are
gated on the builder adding them server-side (see §4).

---

## 1. Address-entry field

A new **"Join a server"** entry on the world-select screen opens a small panel
with one text input plus the recent-servers list (§2). The input accepts three
shapes, all normalized to an **origin string** that is handed to
`normalizeWsUrl` (and, before that, to `/api/health`):

| User types | Interpreted as | Resulting WS endpoint |
| --- | --- | --- |
| `play.example.com` | host only, default port | `wss://play.example.com/ws` (see port rule) |
| `192.168.1.20:3000` | host:port | `ws://192.168.1.20:3000/ws` |
| `https://abc123.trycloudflare.com` | full tunnel URL | `wss://abc123.trycloudflare.com/ws` |
| `ws://box.lan:3000/ws` | explicit ws URL | passed through unchanged |

### Parse + default-port rules

`normalizeWsUrl` already handles scheme mapping and the `/ws` path suffix, so the
Join field only needs to **produce a clean origin and choose a scheme/port** when
the user was terse. Parse with the browser `URL` API, which handles hosts, ports,
IPv6 brackets, and paths for free:

```js
// public/src/net/parseServerAddress.js  (author-side, new module)
//
// Turn whatever the user typed into { origin, scheme, host, port, label }.
// `origin` is what we hand to /api/health and to NetClient.connect().
export function parseServerAddress(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new AddressError('Enter a server address.');

  // If no scheme, default one. A private/LAN host or explicit port → ws (plain);
  // anything that looks like a public hostname → wss (tunnels/reverse proxies
  // are TLS). This keeps localhost dev on ws:// and cloud deploys on wss://.
  let candidate = text;
  if (!/^[a-z]+:\/\//i.test(candidate)) {
    const looksLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i
      .test(candidate) || /:\d+$/.test(candidate) && !/\./.test(candidate.split(':')[0]);
    candidate = (looksLocal ? 'http://' : 'https://') + candidate;
  }

  let u;
  try {
    u = new URL(candidate);
  } catch {
    throw new AddressError('That does not look like a valid address.');
  }

  // Accept http(s) and ws(s); reject everything else (file:, javascript:, …).
  if (!/^(https?|wss?):$/.test(u.protocol)) {
    throw new AddressError('Use a host name or an http/https/ws address.');
  }

  // Default the port: if the user gave none, URL leaves u.port === ''.
  // Browsers dial 80/443 by scheme automatically, so we only *display* a port,
  // we don't force one into the URL. When a tunnel gives no port, that's correct.
  const scheme = /^(https|wss)/.test(u.protocol) ? 'wss' : 'ws';
  const host = u.hostname;
  const port = u.port || (scheme === 'wss' ? '443' : '80');

  // origin string fed downstream. Preserve an explicit non-default port; drop a
  // redundant default port so the origin is clean.
  const httpScheme = scheme === 'wss' ? 'https' : 'http';
  const showPort = u.port && !((scheme === 'wss' && u.port === '443') ||
                               (scheme === 'ws' && u.port === '80'));
  const origin = `${httpScheme}://${u.host}`; // u.host already includes :port when present

  return {
    origin,                       // e.g. "https://play.example.com" or "http://box.lan:3000"
    scheme,                       // "ws" | "wss"  (informational)
    host,
    port,
    label: showPort ? `${host}:${u.port}` : host,
  };
}

class AddressError extends Error {}
export { AddressError };
```

Key decisions:

- **We derive `wss://` from an `https://` tunnel URL for free** because we hand the
  `https://…` origin to `normalizeWsUrl`, which maps `https→wss` (NetClient.js:210).
  A Cloudflare/ngrok `https://…trycloudflare.com` URL therefore connects to
  `wss://…trycloudflare.com/ws` with zero extra logic. Paste-the-tunnel-URL just works.
- **Default port** is *displayed* (for the recent list label) but not *injected*:
  browsers already dial 443/80 by scheme, and tunnels expose no port. We only keep
  an explicit port when the user typed one (e.g. LAN `:3000`).
- **Scheme defaulting** keeps `localhost`/RFC-1918 hosts on plaintext `ws://`
  (dev) and public hostnames on `wss://` (prod). The user can always override by
  typing the scheme explicitly.

The panel field wiring mirrors the existing create-world input (`menu.js:304`):

```js
const addrInput = el('input', 'vx-input join-addr-input', row);
addrInput.type = 'text';
addrInput.placeholder = 'host:port or https://…tunnel URL';
addrInput.spellcheck = false;
addrInput.autocapitalize = 'off';
addrInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
```

---

## 2. Recent-servers list (localStorage)

Reuse the menu's existing localStorage pattern (`loadSettings`/`persistSettings`,
`menu.js:218`/`228`). New key, same defensive try/catch shape.

### Storage key + schema

```
localStorage key: "loomfall.recentServers"
value: JSON array, most-recent-first, capped at MAX_RECENT (8):

[
  {
    "url":           "https://play.example.com",  // the origin (§1 parse output)
    "name":          "play.example.com",           // display label; defaults to host
    "lastJoined":    1752192000000,                // Date.now() at last successful welcome
    "lastLatencyMs": 42                            // last measured ping (§3), null if unknown
  },
  ...
]
```

`url` is the canonical identity (dedupe key). `name` defaults to the parsed
`label` but is user-overridable via an inline rename. `lastJoined` sorts the list.
`lastLatencyMs` feeds the indicator's cached badge before a fresh ping resolves.

### Module

```js
// public/src/net/recentServers.js  (author-side, new module)
const KEY = 'loomfall.recentServers';
const MAX_RECENT = 8;

export function loadRecent() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter((e) => e && typeof e.url === 'string')
      .map((e) => ({
        url: e.url,
        name: typeof e.name === 'string' && e.name ? e.name : hostOf(e.url),
        lastJoined: Number.isFinite(e.lastJoined) ? e.lastJoined : 0,
        lastLatencyMs: Number.isFinite(e.lastLatencyMs) ? e.lastLatencyMs : null,
      }))
      .sort((a, b) => b.lastJoined - a.lastJoined)
      .slice(0, MAX_RECENT);
  } catch { return []; }               // corrupt/unavailable → empty, exactly like loadSettings()
}

function persist(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_RECENT))); }
  catch { /* storage unavailable — in-memory only, same as persistSettings() */ }
}

// Call on every successful welcome.
export function recordJoin(url, { name, latencyMs } = {}) {
  const list = loadRecent().filter((e) => e.url !== url);   // dedupe by url
  list.unshift({
    url,
    name: name || hostOf(url),
    lastJoined: Date.now(),
    lastLatencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
  });
  persist(list);
  return list;
}

// Call when a fresh ping resolves (updates the cached badge without a join).
export function recordLatency(url, latencyMs) {
  const list = loadRecent();
  const row = list.find((e) => e.url === url);
  if (row) { row.lastLatencyMs = latencyMs; persist(list); }
}

export function removeRecent(url) { persist(loadRecent().filter((e) => e.url !== url)); }

function hostOf(url) { try { return new URL(url).host; } catch { return url; } }
```

### Rendering

Rendered in the Join panel exactly like `refreshWorlds()` renders world rows
(`menu.js:354`): one `.world-row`-styled row per entry, a name/meta block, a
latency badge (§3), a **Join** button, and a small **✕** remove button
(→ `removeRecent`). "Never joined" entries (a server you pinged but backed out of)
still persist so the ping badge survives a reload.

---

## 3. Ping / latency indicator

Two measurable signals exist on the server today: `GET /api/health`
(`server/index.js:266`) and the `/ws` upgrade + `welcome` round-trip.

**Chosen primary probe: `/api/health` fetch timing.** It is cheap, needs no
protocol frames, and does not consume a connection slot. Use the WS round-trip
only as the *authoritative* latency captured during a real join (it's the number
that actually matters, and we already do the connect there).

```js
// public/src/net/pingServer.js  (author-side, new module)
//
// Time a GET <origin>/api/health. Returns { ok, latencyMs, reason }.
// AbortController enforces a ceiling so a dead host resolves fast.
export async function pingServer(origin, { timeoutMs = 4000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(`${origin}/api/health`, {
      method: 'GET',
      signal: ctrl.signal,
      cache: 'no-store',
      // cross-origin health checks: the server sends plain JSON with no auth,
      // so a simple GET is CORS-safe. If the deploy fronts /api/health without
      // CORS headers, fall back to the WS-join round-trip for latency.
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) return { ok: false, latencyMs, reason: `http-${res.status}` };
    const body = await res.json().catch(() => null);
    return { ok: !!(body && body.ok), latencyMs, reason: body?.ok ? 'ok' : 'bad-body' };
  } catch (err) {
    return { ok: false, latencyMs: null, reason: err.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(t);
  }
}
```

### Badge

Color-coded, thresholds in ms of the `/api/health` timing:

| Latency | Badge | Class |
| --- | --- | --- |
| `< 80` | green ● + `42 ms` | `.ping--good` |
| `80–200` | amber ● + `130 ms` | `.ping--ok` |
| `> 200` | red ● + `310 ms` | `.ping--slow` |
| `timeout`/`unreachable` | grey ● + `offline` | `.ping--down` |
| in-flight | pulsing ● + `…` | `.ping--probing` |

```js
function renderPing(badgeEl, result) {
  badgeEl.className = 'ping-badge';
  if (!result) { badgeEl.classList.add('ping--probing'); badgeEl.textContent = '● …'; return; }
  if (!result.ok) { badgeEl.classList.add('ping--down'); badgeEl.textContent = '● offline'; return; }
  const ms = result.latencyMs;
  const tier = ms < 80 ? 'ping--good' : ms <= 200 ? 'ping--ok' : 'ping--slow';
  badgeEl.classList.add(tier);
  badgeEl.textContent = `● ${ms} ms`;
}
```

Probe behavior:
- On opening the Join panel, fire `pingServer` for **every** recent entry in
  parallel; render each badge as it resolves; `recordLatency(url, ms)` on success.
- Re-probe the address field (debounced ~500 ms) as the user types a valid-parsing
  address, so they see reachability before clicking Join.
- The **authoritative** latency is captured on a real join: measure
  `Date.now()` immediately before `net.connect(...)` and on `welcome`; store that
  via `recordJoin(url, { latencyMs })`. That's the round-trip through `/ws` and is
  what the recent-list shows after a successful session.

---

## 4. Connect-failure UX

`NetClient.connect` already surfaces every failure as a rejected promise with a
distinguishable `Error` (`NetClient.js:44-104`). The Join flow maps those (plus
the pre-connect health probe and the join `error` frame) to user-facing messages
and a retry affordance. **Do not swallow errors into a generic "failed" — classify.**

### Failure taxonomy

| Case | How detected (today) | User-facing message | Retry |
| --- | --- | --- | --- |
| **Bad address** | `parseServerAddress` throws `AddressError` (§1) | *"That does not look like a valid address."* (the thrown text) | Fix field |
| **Host unreachable / DNS / refused** | `pingServer` → `unreachable`, or `ws.onerror` (NetClient.js:89) rejects `websocket error connecting to …` | *"Can't reach that server. Check the address and that it's online."* | Retry button |
| **Timeout** | `pingServer` → `timeout`, or `WELCOME_TIMEOUT_MS` fires (NetClient.js:51) → `timed out waiting for welcome` | *"The server didn't respond in time. It may be starting up or overloaded."* | Retry button |
| **Wrong URL / not a Loomfall server** | health 200 but body not `{ok:true}` (`bad-body`), or WS opens then closes pre-welcome (NetClient.js:93 → `socket closed before welcome`) | *"That address answered, but it isn't a Loomfall server."* | Fix field |
| **Closed before welcome (proxy 502, `/ws` not upgraded)** | `ws.onclose` before welcome (NetClient.js:93), close code surfaced | *"The connection dropped before joining. The server may be misconfigured (no `/ws` upgrade)."* | Retry button |
| **Server full** *(forward-compat)* | server sends `{t:'error', code:'server_full'}` on join, closing the socket → close-before-welcome path | *"This server is full. Try again in a moment."* | Retry button |
| **Version mismatch** *(forward-compat)* | server sends `{t:'error', code:'version_mismatch', message}` | *"Your client is out of date for this server. Reload to update."* | Reload |

> **Honesty gate:** *Server full* and *version mismatch* are **not implemented on
> the server today** (recon: no `MAX_PLAYERS`, no version handshake — the only
> server-emitted error frame is dispatched at `NetClient.js:115`, which merely
> `console.warn`s and does not reject the connect promise). To deliver these
> messages the builder must (a) have the server send a `{t:'error', code}` frame
> and **close** the socket during join, and (b) teach `NetClient` to reject
> `connect()` with a coded error when an `error` frame arrives before `welcome`.
> Until then these two rows are dead code paths and the flow degrades to the
> generic "connection dropped before joining" message.

### Suggested small NetClient enhancement (author-side)

To carry a machine-readable code and honor a server error frame during join, add a
`code` to the rejection and reject on a pre-welcome `error` frame. This is additive
and backward-compatible:

```js
// inside connect()'s ws.onmessage, before _dispatch, add:
if (msg.t === 'error' && !settled) {
  const e = new Error(msg.message || msg.code || 'join rejected');
  e.code = msg.code || 'join_error';           // 'server_full' | 'version_mismatch' | …
  return fail(e);
}
// and give the timeout / onerror / onclose failures codes too:
//   timeout  → e.code = 'timeout'
//   onerror  → e.code = 'unreachable'
//   onclose  → e.code = 'closed_before_welcome'
```

Then the UI maps `err.code` → message via a lookup table instead of string-matching.

### Failure panel

Rendered inline in the Join panel (reuse `.world-error` styling, `menu.js:337`):

```js
function showJoinError(container, { title, detail, retry }) {
  container.textContent = '';
  el('div', 'join-error-title', container, title);
  if (detail) el('div', 'join-error-detail', container, detail);
  if (retry) button('Retry', 'vx-btn vx-btn--small', container, retry);
  container.classList.add('world-error--show');
}
```

Retry re-runs the **connect state machine** (§5) from `resolving` for the same
address; "Fix field" just refocuses the input and clears the error.

---

## 5. Connect state machine

States: **idle → resolving → connecting → joining → connected** (happy path), with
any of the middle states able to transition to **failed** (→ retry → resolving).
Mapped onto the real functions:

| State | What runs | Real code | UI |
| --- | --- | --- | --- |
| `idle` | Join panel open, field editable | menu panel (new, sibling of `worlds`, `menu.js:198`) | input + recent list |
| `resolving` | `parseServerAddress(raw)` then `pingServer(origin)` | §1 + §3 modules | field shows spinner; on `AddressError`→`failed` |
| `connecting` | `new NetClient(); net.connect(origin, …)` opens the socket | `NetClient.connect` opens `new WebSocket` (NetClient.js:55); origin passed instead of `location.origin` (cf. `main.js:607`) | `setLoading('Connecting…')` (`menu.js:581`) |
| `joining` | socket open, `{t:'join'}` sent, awaiting `welcome` | `ws.onopen` sends join (NetClient.js:62); promise pending until `welcome` (NetClient.js:76) | `setLoading('Joining world…')` (matches `main.js:605`) |
| `connected` | `welcome` resolved → hand off to `startGame` | resolve at NetClient.js:83; then existing `main.js` post-welcome flow (line 608+) | `setLoading(null)`; menu hides |
| `failed` | classify error (§4), `setLoading(null)`, show panel | rejection from `connect` (NetClient.js:44) or `pingServer` | error panel + Retry |

### Transitions

```
idle --submit/pick--> resolving
resolving --parse+ping ok--> connecting
resolving --AddressError | ping down--> failed
connecting --socket open--> joining
connecting --onerror|onclose|WebSocket ctor throw--> failed
joining --welcome--> connected
joining --timeout|error-frame|close-before-welcome--> failed
failed --Retry--> resolving
failed --Fix field--> idle
connected --(session ends / Quit to Title)--> idle
```

### Reference driver (author-side, lives in `main.js` alongside `startGame`)

This is the concrete glue: it swaps the hardcoded `location.origin` at
`main.js:607` for a user-chosen origin, records the join, and captures the
authoritative round-trip latency.

```js
async function joinServer(rawAddress) {
  let phase = 'resolving';
  const setPhase = (p) => { phase = p; };

  // resolving
  let parsed;
  try {
    parsed = parseServerAddress(rawAddress);           // §1  → { origin, label, ... }
  } catch (err) {
    return fail('resolving', err);                     // AddressError → §4 "bad address"
  }
  const health = await pingServer(parsed.origin);      // §3
  if (!health.ok) return fail('resolving', codedError(health.reason));

  // connecting + joining  (the real connect; note origin, not location.origin)
  ui.menus.setLoading('Connecting…');
  setPhase('connecting');
  const net = new NetClient();
  const t0 = Date.now();
  let welcome;
  try {
    setPhase('joining');
    ui.menus.setLoading('Joining world…');
    // worldId can be omitted / a default on a remote host; the server picks or
    // creates per its own rules. Reuse getPlayerName() and the current dim.
    welcome = await net.connect(parsed.origin, /*worldId*/ undefined, getPlayerName(), dim);
  } catch (err) {
    ui.menus.setLoading(null);
    return fail(phase, err);                            // §4 taxonomy by err.code
  }

  // connected
  const latencyMs = Date.now() - t0;                   // authoritative /ws round-trip
  recordJoin(parsed.origin, { name: parsed.label, latencyMs });  // §2
  ui.menus.setLoading(null);
  return handoffToGame(net, welcome);                  // existing post-welcome path (main.js:608+)
}

function fail(phase, err) {
  const map = {
    bad_address:          { title: 'Invalid address', detail: err.message },
    unreachable:          { title: "Can't reach that server", detail: 'Check the address and that it is online.' },
    timeout:              { title: 'No response', detail: 'The server may be starting up or overloaded.' },
    bad_body:             { title: 'Not a Loomfall server', detail: 'That address answered, but not with a game.' },
    closed_before_welcome:{ title: 'Connection dropped', detail: 'The server may be misconfigured (no /ws upgrade).' },
    server_full:          { title: 'Server full', detail: 'Try again in a moment.' },        // forward-compat (§4 gate)
    version_mismatch:     { title: 'Client out of date', detail: 'Reload to update.' },       // forward-compat (§4 gate)
  };
  const key = err instanceof AddressError ? 'bad_address' : (err.code || 'unreachable');
  const spec = map[key] || map.unreachable;
  showJoinError(joinErrorEl, { ...spec, retry: () => joinServer(lastRawAddress) });
  return null;
}
```

`handoffToGame(net, welcome)` is the existing sequence at `main.js:608+`
(`normalizeEditRecord`, `TerrainGenerator`, `World`, `Player`, `net.onState/…`
callbacks) refactored to accept an already-connected `NetClient` instead of
constructing one inline. That refactor is the **only** change required to
`main.js`'s existing join path; everything else in this spec is additive.

---

## 6. What "just works" vs. what the builder must add

**Works today, no server change:**
- Single-origin deploy: open the deployed URL, pick/create a world, click Play.
  `net.connect(location.origin, …)` (`main.js:607`) auto-targets `wss://<host>/ws`.
- Address entry + `wss://` derivation from an `https://` tunnel URL — pure client,
  rides on the existing `normalizeWsUrl` (`NetClient.js:208`).
- Recent-servers localStorage list — pure client, mirrors the settings-persistence
  pattern already in `menu.js`.
- `/api/health` ping timing — endpoint exists (`server/index.js:266`).

**Requires the game author to add code (client-side, under `public/src/`):**
- The Join panel + the four new modules (`parseServerAddress`, `recentServers`,
  `pingServer`, and the `joinServer` driver).
- Refactor `main.js`'s inline `new NetClient(); await net.connect(location.origin…)`
  (line 606) into `handoffToGame(net, welcome)` so a pre-connected client can be
  passed in.
- The additive `NetClient.connect` error-code enhancement (§4) if coded messages
  are desired.

**Requires a server change (out of scope for this branch's `deploy/` rules; noted
for honesty):**
- **Server full** messaging needs a `MAX_PLAYERS` cap — *not present today* (recon:
  `rooms`/`clients` are unbounded) — plus a `{t:'error', code:'server_full'}` frame
  emitted during join.
- **Version mismatch** messaging needs a version field in the `join`/`welcome`
  handshake and a `{t:'error', code:'version_mismatch'}` frame — *no handshake
  today*.
- **Cross-origin health pings** require `/api/health` to send permissive CORS
  headers if the game is served from a different origin than the target server;
  otherwise fall back to the WS-join round-trip for latency (which is same-origin
  to the WS host and unaffected).
