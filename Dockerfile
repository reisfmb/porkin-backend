# syntax=docker/dockerfile:1

# Base image is pinned deliberately, and BOTH parts of the tag matter:
#  - node:24  = current LTS, satisfies package.json engines (>=20).
#  - -trixie- = glibc 2.41. better-sqlite3 v13's prebuilt binaries need
#    GLIBC_2.38+, so the bookworm-based `node:24-slim` fails at runtime with
#    "libm.so.6: version `GLIBC_2.38' not found". Don't "simplify" this tag.
FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts skips better-sqlite3's node-gyp postinstall, which would need
# python3/make/g++ just to discover the prebuilt binary it already ships
# (node_modules/better-sqlite3/prebuilds/linux-{x64,arm64}.node, Node-API so
# version-independent). Revisit if a dependency ever needs a real install script.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# → dist/index.js (tsconfig rootDir is src)

FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# Runs as root deliberately: Railway mounts volumes root-owned, so a non-root
# process would EACCES on DB_PATH (/data/porkin.db) — db/client.ts also mkdirs
# the parent directory on boot.
EXPOSE 8787
CMD ["node", "dist/index.js"]
