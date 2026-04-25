# Dent Brain HTTP MCP server (production image for Railway)
#
# Multi-stage build: small image, reproducible, fast cold starts.

# ---- Stage 1: deps ---------------------------------------------------------
FROM oven/bun:1.3.11-alpine AS deps
WORKDIR /app

# Only copy lockfile + package.json so dep install layer is cached when only
# source code changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- Stage 2: runtime ------------------------------------------------------
FROM oven/bun:1.3.11-alpine
WORKDIR /app

ENV NODE_ENV=production

# Copy installed deps
COPY --from=deps /app/node_modules ./node_modules

# Copy source (respecting .dockerignore)
COPY . .

# Railway injects PORT; we expose 3000 as the default for documentation purposes
EXPOSE 3000

# Health check (Railway uses this, and it's useful locally with `docker run`)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:${PORT:-3000}/health || exit 1

# Run the HTTP MCP server directly via Bun. No build step; Bun runs TS natively.
CMD ["bun", "run", "src/dent/server/http-mcp.ts"]
