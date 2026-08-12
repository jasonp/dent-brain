# Dent Brain HTTP MCP server (production image for Railway)
#
# Multi-stage build: small image, reproducible, fast cold starts.

# ---- Stage 1: deps ---------------------------------------------------------
FROM oven/bun:1.3.11-alpine AS deps
WORKDIR /app

# Only copy lockfile + package.json so dep install layer is cached when only
# source code changes.
COPY package.json bun.lock ./

# scripts/postinstall.ts must be in THIS layer too. The v0.50.0.0 upstream sync
# added `"postinstall": "bun run scripts/postinstall.ts"` to package.json, and
# bun runs it as part of `bun install` — so without the file here the build dies
# with `Module not found "scripts/postinstall.ts"` and the deploy never boots.
#
# Copied rather than skipped with --ignore-scripts: that flag would also suppress
# postinstall for every DEPENDENCY, which is a silent way to break a native or
# codegen-ing package later. This is one small file that changes almost never, so
# the dep-install cache layer stays effectively as stable as before.
#
# The script itself is a no-op in a container (it looks for a `gbrain` binary on
# PATH to apply migrations after a global install, and exits 0 when absent). The
# server applies migrations on boot via initSchema, so nothing is lost.
COPY scripts/postinstall.ts ./scripts/postinstall.ts

RUN bun install --frozen-lockfile

# ---- Stage 2: runtime ------------------------------------------------------
FROM oven/bun:1.3.11-alpine
WORKDIR /app

ENV NODE_ENV=production

# Single-brain Stage B: the nightly DB→git exporter (src/dent/exporter/)
# clones/pushes the dent-brain-data mirror via git+SSH using the deploy
# key in DENT_BRAIN_DATA_DEPLOY_KEY. The bun alpine base ships neither
# tool. ca-certificates is required so SSH
# verifies github.com on first contact (StrictHostKeyChecking=accept-new).
# tini is PID 1 — reaps any zombies our SIGCHLD handler can't reach
# (e.g. native-addon child processes). Belt-and-suspenders against
# the v0.34.2 RLIMIT_NPROC exhaustion bug: serve.ts now installs a
# Node-side SIGCHLD reaper, AND tini reaps anything that escapes it.
RUN apk add --no-cache git openssh-client ca-certificates tini

# Copy installed deps
COPY --from=deps /app/node_modules ./node_modules

# Copy source (respecting .dockerignore)
COPY . .

# Railway injects PORT; we expose 3000 as the default for documentation purposes
EXPOSE 3000

# Health check (Railway uses this, and it's useful locally with `docker run`)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:${PORT:-3000}/health || exit 1

# Run the HTTP MCP server through tini as PID 1. tini forwards signals
# to bun and reaps any orphaned children (git/ssh/rev-list subprocesses
# our SIGCHLD handler in serve.ts already covers, but belt-and-suspenders
# against native-addon spawns the JS reaper can't see). sh wrapper
# interpolates $PORT from Railway, falling back to 3000 for local `docker run`.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "bun run src/dent/serve.ts --port ${PORT:-3000}"]
