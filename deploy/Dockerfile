# syntax=docker/dockerfile:1
#
# Loomfall — container image (multi-stage)
# Build context: the REPO ROOT.  Build with:
#     docker build -f deploy/Dockerfile -t loomfall .
#
# Stage 1 (builder): installs production node_modules only.
# Stage 2 (runtime): slim base, non-root user, copies just what the
#                    server needs at runtime.

# ---------------------------------------------------------------------------
# Stage 1 — builder: resolve production dependencies
# ---------------------------------------------------------------------------
FROM node:20-slim AS builder

WORKDIR /app

# Copy only manifest(s) first so this layer is cached unless deps change.
# package-lock.json is optional in the build context; the "*" glob keeps the
# COPY from failing when the lockfile is absent.
COPY package.json package-lock.json* ./

# Install PRODUCTION dependencies only.
# Prefer a reproducible install from the lockfile (npm ci); fall back to
# npm install when no package-lock.json is present in the context.
RUN if [ -f package-lock.json ]; then \
        npm ci --omit=dev; \
    else \
        npm install --omit=dev; \
    fi

# ---------------------------------------------------------------------------
# Stage 2 — runtime: minimal image that actually runs the server
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime

# Production defaults.
ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Create an unprivileged user/group to run the app (never run as root).
RUN groupadd --system --gid 1001 loomfall \
    && useradd --system --uid 1001 --gid loomfall --home-dir /app loomfall

# Bring in resolved dependencies from the builder stage.
COPY --from=builder /app/node_modules ./node_modules

# Copy only what the runtime needs: the server code, the static client
# assets it serves, and the manifest (for metadata / "type": "module").
COPY package.json ./
COPY server/ ./server/
COPY public/ ./public/

# The server persists worlds to /app/saves (server/index.js resolves
# SAVES_DIR to <repo>/saves === /app/saves inside the container).
# Pre-create it, hand ownership to the non-root user, and expose it as a
# volume so world data survives container recreation.
RUN mkdir -p /app/saves && chown -R loomfall:loomfall /app
VOLUME ["/app/saves"]

# Drop privileges.
USER loomfall

# Document the listening port (overridable via the PORT env var).
EXPOSE 3000

# Liveness probe against the built-in health endpoint. Uses node's global
# fetch (Node 18+) rather than curl, which the slim base does not ship.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start the server.
CMD ["node", "server/index.js"]
