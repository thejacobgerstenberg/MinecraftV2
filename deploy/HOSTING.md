# Hosting Loomfall — play online with your friends

Hey! This guide gets you and your friends into the same world, from "just on my
laptop" all the way to "a real server on the internet." Pick the section that
matches how far you want to go. Every command block is copy-paste ready.

A few facts that make everything simpler:

- The game runs as **one small web server** on **port 3000**.
- Friends just **open a URL in their browser** — there is nothing to install.
- The game figures out its own connection automatically. Whatever address serves
  the page, the game connects back to that same address (it uses `/ws` for the
  live multiplayer link). So **if a friend can open the page, they can play** —
  no "server address" box to fill in.

---

## 1. Run it on your own machine

You have two easy ways to start the server. Use whichever you like.

### Option A — Docker (nothing else to install but Docker)

From the project folder (`MinecraftV2`):

```bash
docker compose up
```

That's it. When it's running, open:

```
http://localhost:3000
```

To stop it, press `Ctrl+C`. To run it quietly in the background instead, use
`docker compose up -d` (and later `docker compose down` to stop it).

### Option B — Node directly

You need **Node.js 18 or newer** ([download here](https://nodejs.org)). Then,
from the project folder:

```bash
npm install
node server/index.js
```

Open:

```
http://localhost:3000
```

Stop it with `Ctrl+C`.

### Quick "is it alive?" check

Open <http://localhost:3000/api/health> in a browser (or run the command below).
A healthy server replies with `{"ok":true}`.

```bash
curl http://localhost:3000/api/health
```

Now open `http://localhost:3000`, create or pick a world, and click **Play**.
You're in!

---

## 2. Play on your LAN (same Wi‑Fi / same house)

If your friends are on the **same network** (same Wi‑Fi or same router), they can
join without any internet setup. You just share your machine's local address.

### Step 1 — Start the server

Use either option from Section 1 (`docker compose up` or `node server/index.js`).
Leave it running.

### Step 2 — Find your machine's IP address

Run the command for your operating system:

**Linux**

```bash
ip addr | grep "inet "
```

**macOS**

```bash
ipconfig getifaddr en0
```

(If that prints nothing, you're probably on Wi‑Fi via a different adapter — try
`ipconfig getifaddr en1`, or run `ifconfig` and look for your active connection.)

**Windows**

```powershell
ipconfig
```

Look for a line like **IPv4 Address**. Your LAN IP almost always looks like
`192.168.x.x` or `10.0.x.x` (for example `192.168.1.42`). That's the one you
want. Ignore `127.0.0.1` — that only means "this same computer."

### Step 3 — Share the URL

The port to share is always **3000**. Give your friends this URL, swapping in the
IP you found:

```
http://192.168.1.42:3000
```

They open it in a browser on the same network, pick a world, and play.

### If it won't connect: firewall

Your computer may block incoming connections by default. Allow **port 3000**:

**Linux (ufw)**

```bash
sudo ufw allow 3000/tcp
```

**macOS**

macOS asks with a popup the first time — click **Allow incoming connections**.
If you dismissed it, go to **System Settings → Network → Firewall** and either
turn the firewall off temporarily or add an allow rule for the app running the
server (Terminal, Node, or Docker).

**Windows**

The first time you start the server, Windows shows a **Windows Defender Firewall**
popup. Check **Private networks** and click **Allow access**. To add the rule
manually in an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Loomfall" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

> Note: LAN play only works while everyone is on the **same** network. For
> friends across town or across the world, use Section 3 (tunnel) or Section 4
> (real host).

---

## 3. Play over the internet with a tunnel (easiest way to go global)

A **tunnel** gives your locally-running server a temporary public `https://…`
address that anyone, anywhere can open — without touching your router or firewall.
This is the fastest way to play with a friend who isn't in your house.

**Start your server first** (Section 1, e.g. `docker compose up`), leave it
running, then in a **second terminal** run one of the tunnels below. All three
correctly forward the live multiplayer connection (WebSocket), so the game works
fully — you just share the `https` URL each one prints.

### Option A — Cloudflared (recommended, free, no account needed)

Install `cloudflared` ([instructions](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)),
then:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a line like `https://random-words-here.trycloudflare.com`. **That URL is
what your friends open.** Done.

### Option B — localtunnel (needs Node, no account)

```bash
npx localtunnel --port 3000
```

It prints a `https://something.loca.lt` URL. Share it. (Heads up: localtunnel may
show visitors a one-time "click to continue" page — totally normal.)

### Option C — ngrok (needs a free account + auth token)

Install ngrok and run its one-time `ngrok config add-authtoken <your-token>`
(you get the token from your free ngrok dashboard). Then:

```bash
ngrok http 3000
```

Look for the **Forwarding** line — it shows a `https://xxxx.ngrok-free.app` URL.
That's the one your friends open.

> The tunnel URL lives only as long as the tunnel command is running. Close the
> terminal and the link dies. Great for a game night; for something that stays up
> 24/7, see Section 4.

---

## 4. Put it on a real, always-on host (cheap)

Want a link that works even when your computer is off? Host it on a small server.
Here is **one simple, cheap path**: a tiny VPS (virtual server) for about **$4–6
a month** running Docker. Providers that have plans in this range include Hetzner,
DigitalOcean, Linode, and Vultr.

### Step 1 — Create the server

Sign up with a VPS provider and create the smallest **Ubuntu 22.04** (or newer)
instance. You'll get an IP address and a way to log in over SSH.

### Step 2 — Log in and install Docker

```bash
ssh root@YOUR_SERVER_IP
curl -fsSL https://get.docker.com | sh
```

### Step 3 — Get the project onto the server

If your code is on GitHub:

```bash
git clone YOUR_REPO_URL loomfall
cd loomfall
```

(Or copy the folder up with `scp -r ./MinecraftV2 root@YOUR_SERVER_IP:~/loomfall`.)

### Step 4 — Start it, and keep it running

```bash
docker compose up -d
```

The `-d` runs it in the background and it restarts automatically if the server
reboots. Open the firewall for the game's port:

```bash
ufw allow 3000/tcp
```

Your friends can now play at:

```
http://YOUR_SERVER_IP:3000
```

To update later: `git pull` then `docker compose up -d --build`. To see logs:
`docker compose logs -f`. To stop: `docker compose down`.

> **Alternative — Fly.io or Railway (no server to manage).** If you'd rather not
> babysit a VPS, both of these can deploy straight from the included
> `deploy/Dockerfile`. On **Railway**: create a project from your repo and it
> builds the Dockerfile automatically. On **Fly.io**: install `flyctl`, run
> `fly launch` in the project folder (it detects the Dockerfile), and `fly deploy`.
> Both give you a free `https://…` URL with TLS already handled — you can stop
> reading here if you go this route.

### Step 5 (nice-to-have) — Your own domain with a padlock (HTTPS)

Sharing a bare `http://1.2.3.4:3000` works, but a real domain with the little
padlock is friendlier and lets browsers do everything (some features are happier
over HTTPS). The easiest way is **Caddy**, a tiny reverse proxy that gets and
renews a free TLS certificate **automatically**.

1. Point your domain's DNS **A record** at your server's IP (do this at your
   domain registrar — GoDaddy, Namecheap, Cloudflare, etc.).
2. Install Caddy on the server
   ([instructions](https://caddyserver.com/docs/install)).
3. Create a file named `Caddyfile` with just this (swap in your domain):

```
play.example.com {
    reverse_proxy localhost:3000
}
```

4. Start Caddy:

```bash
caddy run
```

Caddy fetches the certificate for you and forwards traffic — including the
game's live multiplayer WebSocket — to the server on port 3000. Your friends now
open:

```
https://play.example.com
```

<details>
<summary>Prefer nginx instead of Caddy? Here's an equivalent config.</summary>

Nginx needs the extra `Upgrade`/`Connection` headers so the multiplayer
WebSocket passes through. After getting a cert with `certbot`, a server block
looks like:

```nginx
server {
    listen 443 ssl;
    server_name play.example.com;

    # ssl_certificate / ssl_certificate_key added by certbot

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Caddy is genuinely less fuss for this — the `Caddyfile` above needs no extra
WebSocket lines. Use nginx only if you already have it.
</details>

---

## Friends: join in 3 commands

The fastest possible way to get a link a friend can click. The **host** runs the
first two commands; the **friend** does the third.

```
┌─────────────────────────────────────────────────────────────────────┐
│  QUICKSTART — playable link in about 30 seconds (uses cloudflared)   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. HOST — start the game (in the project folder):                  │
│         docker compose up -d                                        │
│                                                                     │
│  2. HOST — open a public link:                                      │
│         cloudflared tunnel --url http://localhost:3000              │
│                                                                     │
│  3. FRIEND — open the https://…trycloudflare.com URL that           │
│     command printed, pick a world, and hit Play.                    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

That's the whole thing. Send the printed URL to as many friends as you want —
they all land in the same world. Have fun out there!

---

## Operations & verification

Once it's running, these `deploy/` tools help you prove multiplayer works, watch
it live, back up worlds, and run it responsibly.

- **Prove multiplayer end-to-end — `deploy/e2e-multiplayer.mjs`.** Boots the real
  server, opens two independent browser clients in the same world, and asserts
  that client B genuinely observes client A's MOVE, PLACE, BREAK, and CHAT (plus
  persistence across a rejoin). Run it with:

  ```bash
  node deploy/e2e-multiplayer.mjs
  ```

  Exit code is `0` only if every assertion passes; add `--report out.json` to
  save the full result. Latest run — all 12 assertions passed; B observed A's
  chat `<Alice-1750b080>e2e-hello-1750b080`, A's placed block `5` at
  `(3,45,4)`, A's break back to air `0` at `(4,45,4)`, and A's avatar move to
  `(2,45,4)` (`"ok":true`).

- **Watch it live — `deploy/status/`.** A dependency-free status sidecar that
  polls the game's public `/api/*` endpoints and shows up/down, latency, and
  per-world player counts. Run `GAME_URL=http://localhost:3000 node
  deploy/status/server.mjs` and open <http://localhost:8080>. See
  `deploy/status/README.md`.

- **Back up & restore worlds — `deploy/backup` + `deploy/BACKUP.md`.** Worlds are
  one JSON file each under `saves/`; the tool tars them (hot backups are safe —
  writes are atomic) and restores them. `deploy/backup backup`, `deploy/backup
  list`, `deploy/backup restore <archive>`. Details in `deploy/BACKUP.md`.

- **Limits & abuse runbook — `deploy/OPERATIONS.md`.** Operator reference for
  the server-enforced limits (connection, rate, name/edit validation) and how to
  respond to abuse.

---

### Good-to-know details (honest notes)

- **Port** is `3000` everywhere. You can change it by setting the `PORT`
  environment variable before starting (for example `PORT=8080 node server/index.js`),
  but then use that number in your URLs and firewall rules.
- **Worlds are saved** on the host machine, in a `saves/` folder next to the
  server. If you host in Docker and want those saves to survive a container
  rebuild, keep them on a mounted volume (the provided compose setup handles
  this) — otherwise a fresh container starts with fresh worlds.
- **Health check:** `GET /api/health` returns `{"ok":true}` — handy for
  confirming the server is up, and for hosting platforms that ping a health URL.
- There is **no player-limit, message-of-the-day, or tick-rate setting** to
  configure right now — the server keeps it simple. `PORT` is the one knob.
