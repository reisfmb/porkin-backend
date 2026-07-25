# porkin-backend

Managed PDF-extraction backend for [Porkin](../porkin-app). Holds one server-side OpenAI
key, gates access with per-user license keys, and exposes a PDF → transactions endpoint that
reuses the desktop app's extraction logic.

## Stack

Node + TypeScript · [Hono](https://hono.dev) · better-sqlite3 · Vercel AI SDK (`ai` +
`@ai-sdk/openai`) + zod.

## Project layout

Layered — a request flows: **middleware → route → service → llm/db**, with one central error
handler. Each layer has a single job (see `CLAUDE.md` for the full rationale).

```
src/
  index.ts        bootstrap + listen
  app.ts          createApp(): mounts middleware, routes, onError
  config.ts       env parsing (fail-fast on missing PROVIDER_API_KEY)
  errors.ts       ApiError + errorHandler (the only place errors → HTTP)
  crypto.ts       key hashing + generation
  middleware/     auth (bearer key) · admin (ADMIN_KEY) · rateLimit (token bucket)
  routes/         health · extract · admin (thin HTTP handlers)
  services/       extraction · users (business logic; framework-agnostic)
  llm/            extractor (AI SDK call; ported from porkin-app)
  db/             client · migrations · users · usage (repositories)
Dockerfile        multi-stage build; what Railway deploys
railway.json      builder + /health healthcheck + single replica
```

## Local development

```bash
npm install
cp .env.example .env        # then set a real PROVIDER_API_KEY
npm run dev                 # tsx watch, listens on $PORT (default 8787)
```

Health check:

```bash
curl localhost:8787/health          # {"status":"ok"}
```

## API

### `GET /health`
Unauthenticated. `200 {"status":"ok"}`.

### `POST /v1/extract`
Auth required: `Authorization: Bearer <license-key>`.

- Body: `multipart/form-data`, field `file` = the PDF.
- Success: `200 { "transactions": ExtractedTransaction[] }`.
- Errors: `{ "error": { "kind", "message" } }` with status
  `400` bad input · `401` missing/invalid key · `403` inactive key ·
  `413` file too large · `422` extraction/schema failure · `429` rate-limited ·
  `504` provider timeout · `500` internal.

`ExtractedTransaction`: `{ date, rawName, amount, currency, sourceFile }`
(ISO date, signed amount — debit negative, credit positive).

```bash
curl -X POST localhost:8787/v1/extract \
  -H "Authorization: Bearer <key>" \
  -F file=@statement.pdf
```

### Admin — `/v1/admin/*`

Auth: `Authorization: Bearer $ADMIN_KEY`. The admin key is env-only (no `users` row) and
grants access to these routes **only** — it is not accepted on `/v1/extract`. If `ADMIN_KEY`
is unset, every admin route returns `401`.

| Route | Body | Response |
|-------|------|----------|
| `POST /v1/admin/users` | `{ "name": "Bruno" }` | `201 { id, name, key }` |
| `GET /v1/admin/users` | — | `200 { users: [{ id, name, active, createdAt }] }` |
| `PATCH /v1/admin/users/:id` | `{ "active": false }` | `200 { id, active }` |

`POST` returns the plaintext license `key` **once** — store it immediately, only its SHA-256
hash is saved. `GET` never returns key hashes. `PATCH` toggles a key: a deactivated user's next
request gets `403`. Unknown id → `404`.

```bash
curl -X POST localhost:8787/v1/admin/users \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"Bruno"}'

curl localhost:8787/v1/admin/users -H "Authorization: Bearer $ADMIN_KEY"

curl -X PATCH localhost:8787/v1/admin/users/1 \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"active":false}'
```

## Environment

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `8787` | Railway injects this. |
| `DB_PATH` | `./data/porkin.db` | Point at a mounted volume in prod. |
| `PROVIDER` | `openai` | Informational; only openai is wired. |
| `MODEL` | `gpt-5.1` | |
| `PROVIDER_API_KEY` | — | **Required.** Boot fails without it. |
| `ADMIN_KEY` | — | Optional; gates `/v1/admin/*`. Min 24 chars. Unset ⇒ admin routes always `401`. |
| `MAX_UPLOAD_MB` | `15` | |
| `RATE_LIMIT_PER_MIN` | `20` | Per user key. |

## Build & run (production)

```bash
npm run build      # tsc → dist/
npm start          # node dist/index.js
```

Or via the image that Railway builds (`Dockerfile`, multi-stage, `node:24-trixie-slim`):

```bash
docker build -t porkin-backend .
docker run --rm -p 8788:8787 \
  -e PROVIDER_API_KEY=sk-... -e ADMIN_KEY=... \
  -e DB_PATH=/data/porkin.db -v "$PWD/.docker-data:/data" \
  porkin-backend
```

The base image tag is load-bearing: better-sqlite3's prebuilt binaries need `GLIBC_2.38+`, so
bookworm (`node:24-slim`) fails at runtime. Install uses `--ignore-scripts` to skip a
`node-gyp` postinstall that would otherwise demand python3/make/g++ just to find the prebuild
that already ships in the tarball.

## Deploy — Railway

The repo root is the **monorepo** root (`porkin-backend/` + the untracked `porkin-app/`), so
Railway must be pointed at the subdirectory.

1. **New Project → Deploy from GitHub repo** → this repo.
2. **Settings → Source**: Root Directory = `porkin-backend`, branch `master`. Railway then
   finds `railway.json` + `Dockerfile` and uses the Dockerfile builder.
3. **Settings → Volumes**: add a volume mounted at `/data`, and set `DB_PATH=/data/porkin.db`.
   Do this *before* creating users — without a volume, redeploys wipe all users/keys.
4. **Variables**: `PROVIDER_API_KEY`, `ADMIN_KEY` (≥24 chars, else boot fails), `DB_PATH`,
   optionally `MODEL` / `MAX_UPLOAD_MB` / `RATE_LIMIT_PER_MIN`. Leave `PORT` unset — Railway
   injects it. `ADMIN_KEY` is the only way to mint license keys.
5. **Settings → Networking → Generate Domain** → base URL for the desktop client.
6. Logs should show `porkin-backend listening on :<port>`; the `/health` healthcheck
   (`railway.json`) goes green.
7. **Keep replicas at 1.** SQLite has one writer and the rate-limit buckets live in process
   memory, so a second replica doubles the effective limit (`railway.json` sets
   `numReplicas: 1`).
8. Create the first user: `POST https://<app>/v1/admin/users` (see [Admin](#admin--v1admin)).
9. Backups (it's real money): enable a volume backup schedule, or
   `sqlite3 $DB_PATH ".backup '/data/backup.db'"` (WAL-safe).
