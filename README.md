# porkin-backend

Managed AI backend for [Porkin](../porkin-app). Holds one server-side OpenAI key, gates access
with per-user license keys, and exposes two endpoints: PDF → transactions extraction (reusing
the desktop app's logic) and natural-language Q&A over the user's local database.

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
  pricing.ts      token prices → USD cost of one model call
  period.ts       the quota period (UTC calendar month), defined once
  middleware/     auth (bearer key) · admin (ADMIN_KEY) · rateLimit (token bucket) · quota (monthly USD cap)
  routes/         health · license · usage · extract · ask · admin (thin HTTP handlers)
  services/       extraction · ask · users · usage (business logic; framework-agnostic)
  llm/            extractor (ported from porkin-app) · asker · sqlGuard
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

### `GET /v1/license`
Auth required: `Authorization: Bearer <license-key>`.

Checks whether a license key is usable — no LLM call, no usage row, not rate-limited.
The app calls it when the user saves a key in Settings.

- Success: `200 { "valid": true, "name": "<user name>" }`.
- Errors: `401` missing/unknown key (`kind: "unauthorized"`) · `403` revoked key
  (`kind: "inactive"`). There is no `valid: false` body — the status *is* the verdict.

```bash
curl -i localhost:8787/v1/license -H "Authorization: Bearer <key>"
```

### `GET /v1/usage`
Auth required: `Authorization: Bearer <license-key>`.

This month's spend against the user's cap. No LLM call, no usage row, not rate-limited, and
**not** subject to the quota itself — it has to answer once the cap is hit. Amounts are USD of
provider cost (unrelated to the app's display currency). Powers the desktop app's `/usage` page.

- Success: `200 { periodStart, periodEnd, limitUsd, spentUsd, remainingUsd, byEndpoint, daily, tokens }`
  — dates are `YYYY-MM-DD`, `periodEnd` is exclusive and is the day the allowance resets,
  `remainingUsd` is clamped at 0, `byEndpoint` is `[{ endpoint, calls, usd }]` and `daily` is
  `[{ date, usd }]`.
- Errors: `401` unknown key · `403` inactive key.

```bash
curl localhost:8787/v1/usage -H "Authorization: Bearer <key>"
```

### `POST /v1/extract`
Auth required: `Authorization: Bearer <license-key>`.

- Body: `multipart/form-data`, field `file` = the PDF.
- Success: `200 { "transactions": ExtractedTransaction[] }`.
- Errors: `{ "error": { "kind", "message" } }` with status
  `400` bad input · `401` missing/invalid key · `402` monthly usage limit reached
  (`kind: "quota_exceeded"`) · `403` inactive key · `413` file too large ·
  `422` extraction/schema failure · `429` rate-limited · `504` provider timeout · `500` internal.

`ExtractedTransaction`: `{ date, rawName, amount, currency, sourceFile }`
(ISO date, signed amount — debit negative, credit positive).

```bash
curl -X POST localhost:8787/v1/extract \
  -H "Authorization: Bearer <key>" \
  -F file=@statement.pdf
```

### `POST /v1/ask`
Auth required: `Authorization: Bearer <license-key>`.

Answers questions about the user's finances. **We never see their database** — we emit SQL, the
client runs it locally and posts the rows back. The client drives the loop; each call is
stateless, so the full history travels in `steps` (max 3).

- Body: `{ question, context, steps }` where
  `context = { schema, today, currency, locale, categories, accounts }` (`schema` is the client's
  live `sqlite_master` DDL) and each step is `{ sql, rows, truncated, error? }`.
- Success: `200 { status, sql, answer }` — `status: "sql"` ⇒ run `sql` and call again with a new
  step; `status: "answer"` ⇒ done, the unused field is `""`.
- Errors: same `{ "error": { "kind", "message" } }` shape, with
  `400` bad body / step budget exceeded · `401`/`403` key · `402 quota_exceeded` monthly limit
  reached (checked per turn, so a question can hit it mid-loop) · `413` body too large ·
  `422 ask_failed` couldn't answer or generated unsafe SQL · `429` rate-limited ·
  `504` provider timeout.

```bash
curl -X POST localhost:8787/v1/ask \
  -H "Authorization: Bearer <key>" -H 'Content-Type: application/json' \
  -d '{"question":"How much came in during 2024?",
       "context":{"schema":"CREATE TABLE transactions(id INTEGER PRIMARY KEY, date TEXT, raw_name TEXT, name TEXT, amount REAL);",
                  "today":"2026-07-27","currency":"BRL","locale":"en","categories":[],"accounts":[]},
       "steps":[]}'
```

Generated SQL is validated (`llm/sqlGuard.ts`) to be a single read-only SELECT/WITH before it
leaves the server; the client re-validates before executing. A rejected query gets one inline
correction attempt.

### Admin — `/v1/admin/*`

Auth: `Authorization: Bearer $ADMIN_KEY`. The admin key is env-only (no `users` row) and
grants access to these routes **only** — it is not accepted on `/v1/extract` or `/v1/ask`. If
`ADMIN_KEY` is unset, every admin route returns `401`.

| Route | Body | Response |
|-------|------|----------|
| `POST /v1/admin/users` | `{ "name": "Bruno", "monthlyLimitUsd": 5 }` | `201 { id, name, key, monthlyLimitUsd }` |
| `GET /v1/admin/users` | — | `200 { users: [{ id, name, active, monthlyLimitUsd, spentUsd, createdAt }] }` |
| `PATCH /v1/admin/users/:id` | `{ "active": false }` and/or `{ "monthlyLimitUsd": 5 }` | `200 { id, active?, monthlyLimitUsd? }` |

`POST` returns the plaintext license `key` **once** — store it immediately, only its SHA-256
hash is saved. `monthlyLimitUsd` is optional there and defaults to `DEFAULT_MONTHLY_LIMIT_USD`;
it is >0 and ≤1000. `GET` never returns key hashes, and reports each user's month-to-date
`spentUsd` next to their cap. `PATCH` takes either field (at least one; sending neither is a
`400`): `active: false` revokes a key — that user's next request gets `403` — and
`monthlyLimitUsd` moves their cap, effective on their next request. Unknown id → `404`.

```bash
curl -X POST localhost:8787/v1/admin/users \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"Bruno","monthlyLimitUsd":5}'

curl localhost:8787/v1/admin/users -H "Authorization: Bearer $ADMIN_KEY"

curl -X PATCH localhost:8787/v1/admin/users/1 \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"active":false}'

curl -X PATCH localhost:8787/v1/admin/users/1 \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"monthlyLimitUsd":10}'
```

## Usage quota

Every user has a monthly spend cap in **USD of provider cost** (`users.monthly_limit_usd`,
default `DEFAULT_MONTHLY_LIMIT_USD` = $1.00). Each LLM call is priced at insert time from
`src/pricing.ts` and stored on its `usage` row; `middleware/quota.ts` sums the current UTC
calendar month before `/v1/extract` and `/v1/ask` and returns `402 quota_exceeded` once spend
reaches the cap. Users see their own numbers at `GET /v1/usage`; operators see everyone's in the
admin list.

Two deliberate imprecisions: the check runs *before* a call whose cost isn't yet known, so a
month can end slightly over the cap (~one call), and a call that fails before reporting usage
logs `$0`. Rough gpt-5.1 costs: ~$0.05 per statement, ~$0.02 per ask turn, so $1 ≈ 20 statements.

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
| `DEFAULT_MONTHLY_LIMIT_USD` | `1.00` | Spend cap given to **new** users. Existing users keep their row's value. |
| `PRICE_INPUT_PER_MTOK` | from `pricing.ts` | Optional override for `MODEL`, USD per 1M tokens. |
| `PRICE_CACHED_INPUT_PER_MTOK` | from `pricing.ts` | Optional. |
| `PRICE_OUTPUT_PER_MTOK` | from `pricing.ts` | Optional. |

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
   optionally `MODEL` / `MAX_UPLOAD_MB` / `RATE_LIMIT_PER_MIN` / `DEFAULT_MONTHLY_LIMIT_USD`.
   Leave `PORT` unset — Railway injects it. `ADMIN_KEY` is the only way to mint license keys.
5. **Settings → Networking → Generate Domain** → base URL for the desktop client.
6. Logs should show `porkin-backend listening on :<port>`; the `/health` healthcheck
   (`railway.json`) goes green.
7. **Keep replicas at 1.** SQLite has one writer and the rate-limit buckets live in process
   memory, so a second replica doubles the effective limit (`railway.json` sets
   `numReplicas: 1`).
8. Create the first user: `POST https://<app>/v1/admin/users` (see [Admin](#admin--v1admin)).
9. Backups (it's real money): enable a volume backup schedule, or
   `sqlite3 $DB_PATH ".backup '/data/backup.db'"` (WAL-safe).
