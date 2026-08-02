# CLAUDE.md — porkin-backend

Architecture and decisions, to guide future work in this repo.

## What this is

A tiny gated backend that moves Porkin off BYOK. Previously the [desktop app](../porkin-app)
held the user's LLM key and called providers directly from the Tauri webview. This backend
holds **one** server-side OpenAI key, issues **per-user license keys**, and exposes two paid
endpoints: PDF extraction and natural-language Q&A. Goal: monetize Porkin (paid desktop app)
while protecting the key. Starts for 3 trusted beta users but leaves room for quota/billing.

**Boundary:** this repo is backend-only. The porkin-app client changes (drop BYOK, call this
API) are a separate, later task — do not touch porkin-app from here.

## Relationship to porkin-app

- `src/llm/extractor.ts` is a near-verbatim port of `porkin-app/src/lib/llm.ts`. The
  **SYSTEM_PROMPT, zod schema, and `generateObject` call shape must stay in sync** with the
  app. Only two things were dropped in the port: `fetch: tauriFetch` (use default fetch) and
  neverthrow (plain throw). The API key now comes from `PROVIDER_API_KEY` env, not client
  settings.
- `src/types.ts` `ExtractedTransaction` duplicates the app's contract type, as do the `/v1/ask`
  types (`AskContext`/`AskStep`/`AskRequest`/`AskResponse`, mirrored in
  `porkin-app/src/lib/ask/types.ts`). These small JSON shapes are the entire client/server
  contract — a stable duplication, not worth a shared workspace. Keep both copies identical.
- `llm/sqlGuard.ts` is duplicated as `isReadOnlySql` in `porkin-app/src/lib/ask/model.ts`.
  Deliberate: the app holds the writable DB handle, so it must not trust us to have checked.
  Change one, change the other.

## Stack & key decisions

- **Node + TS, Hono + @hono/node-server, better-sqlite3** (sync, single file, no server).
- **Single provider: openai / gpt-5.1.** The app supports openai/anthropic/google via a
  `getModel` switch; here only openai is wired (`createOpenAI` in `llm/extractor.ts`). To add
  providers, branch in `llm/extractor.ts` on `PROVIDER` and install the matching `@ai-sdk/*` SDK.
- **better-sqlite3 pinned to v13** — v11 fails to compile on Node 25 (no prebuild); v13 ships
  Node-API prebuilds (one `.node` per platform, no ABI coupling). Don't downgrade without
  checking the runtime's Node version. Its prebuilds need **glibc ≥ 2.38** — see Deploy.
- **AI SDK v7 + zod v4**, matching the app. Schema is flat + all-required because OpenAI
  strict structured outputs reject optionals/unions.

## Layout

Layered: thin routes → services (business logic) → repos/llm, with a central error handler.
Each layer has one job; keep it that way.

```
src/
  index.ts              bootstrap: createApp() + node-server listen (thin)
  app.ts                createApp(): Hono, mounts middleware + routes + onError (no listen → testable)
  config.ts             env parse, fail-fast on missing PROVIDER_API_KEY
  types.ts              ExtractedTransaction + LicenseStatus + UsageSummary + ask contracts
  errors.ts             ApiError class + errorHandler (app.onError) — the ONLY place mapping errors→HTTP
  crypto.ts             sha256Hex + generateLicenseKey + secretEquals (constant-time)
  pricing.ts            pure: USD per 1M tokens per model → costUsd() for one call
  period.ts             pure: currentMonth() — the ONE definition of the quota period
  middleware/
    auth.ts             bearer-key middleware → throws ApiError; sets user; exports AppEnv
    admin.ts            ADMIN_KEY middleware (constant-time env compare) → throws ApiError(401)
    rateLimit.ts        in-memory per-user token bucket → throws ApiError(429); runs after auth
    quota.ts            monthly USD spend cap → throws ApiError(402); runs after rateLimit
  routes/
    health.ts           GET /health (open)
    license.ts          GET /v1/license — `auth` + an empty handler; no service, no rateLimit
    usage.ts            GET /v1/usage — `auth` only; what this month cost against the cap
    extract.ts          POST /v1/extract — thin: validate HTTP input → call service → respond
    ask.ts              POST /v1/ask — hand-validated JSON body; one turn of the text-to-SQL loop
    admin.ts            /v1/admin/users CRUD-ish (create/list/activate/set-limit) behind adminAuth
  services/
    extraction.ts       business logic: orchestrate extractor + usage; translate ExtractError→ApiError
    ask.ts              business logic: model call + SQL guard + retry + usage; MAX_STEPS lives here
    users.ts            business logic: issue license keys, list users (+ spend), toggle active, set limit
    usage.ts            business logic: this period's spend vs the user's cap → UsageSummary
  llm/
    extractor.ts        provider factory + generateObject (ported from app); throws domain ExtractError
    asker.ts            ask prompt + message replay from `steps` + generateObject; throws AskError
    sqlGuard.ts         pure: assertReadOnlySql — the model's SQL is untrusted output
  db/
    client.ts           better-sqlite3 open + pragmas + migrate-on-start (reads DB_PATH, loadEnvFile)
    migrations.ts       append-only MIGRATIONS array
    users.ts            User/UserSummary (incl. monthlyLimitUsd) + find/insert/list/setActive/setLimit
    usage.ts            UsageRow + recordUsage (best-effort) + the cost sums the quota/report read
```

**Layering rule**: routes handle HTTP only (parse/validate/respond); services hold
framework-agnostic business logic (no Hono types); `llm/` and `db/` are infrastructure.
Errors flow up as `ApiError` (HTTP-aware) or domain `ExtractError` (translated to `ApiError`
in the service). `errorHandler` is the single seam that turns them into responses.

## Conventions

- **DB migrations** (`db/migrations.ts`): append-only, integer-versioned array applied at
  startup by `db/client.ts`, tracked in `schema_migrations`, each run inside a transaction.
  Mirrors the app's Tauri migration pattern. **Never mutate an applied migration** — add a new version.
- **DB access**: prepared statements + explicit row types; snake_case columns mapped to
  camelCase in the repos (`db/users.ts`, `db/usage.ts`).
- `db/client.ts` reads `DB_PATH` directly (not via `config.ts`) so the DB layer is usable
  without `PROVIDER_API_KEY` (e.g. one-off maintenance scripts). Keep that decoupling.
- **Errors**: JSON `{ error: { kind, message } }`. Throw `ApiError(status, kind, message)`
  anywhere; `errorHandler` (in `errors.ts`, via `app.onError`) renders it. Domain
  `ExtractError` is translated to `ApiError` in `services/extraction.ts` (extraction→422,
  timeout→504). Routes/middleware never map statuses themselves.
- **API is versioned** (`/v1/*`) so shipped desktop clients don't break on API evolution.
- **`usage` is per LLM call, not per request.** One row per provider call, success *or* failure,
  written best-effort. `endpoint` ('extract'|'ask') + `model` distinguish them — a 3-step ask
  question writes 3 rows, which is the right granularity for cost-based quota. **Never store the
  question text or query results**: the whole point of the ask design is that we don't retain the
  user's financial data.
- **Sub-app middleware is NOT scoped to the sub-app.** `app.route("/", subApp)` merges the
  sub-app's `use()` handlers into the parent, so their path patterns must be specific to the
  routes they guard — `extract.ts` uses `use("/v1/extract", …)`, not `"/v1/*"`, or license-key
  `auth` would also gate `/v1/admin/*`.
- **Build layout**: `rootDir` is `src`, so output is `dist/index.js` — hence `npm start` =
  `node dist/index.js`. (Was `dist/src/…` while a `scripts/` dir existed; if you re-add
  compiled scripts outside `src/`, `rootDir` and `start` both have to move back.)

## `/v1/ask` — text-to-SQL over a database we can't see

The user's transactions live in a local SQLite file on their machine; we hold the key. So the
client drives an agent loop and we are one stateless turn of it:

```
app → { question, context, steps: [] }        ← context = live DDL + today/currency/locale
                                                + category & account NAMES
we  → { status: "sql", sql: "SELECT …" }
app runs it LOCALLY, appends { sql, rows, truncated }
app → { question, context, steps: [ … ] }
we  → { status: "answer", answer: "…" }
```

Load-bearing details:

- **Stateless.** The whole history arrives in `steps` and `asker.ts:buildMessages` replays it as
  plain user/assistant turns. No session store, no sticky routing, survives a restart mid-question.
- **`MAX_STEPS = 3`, enforced here** (`services/ask.ts`), not just in the client — a client could
  otherwise loop on our key forever. On the final turn the prompt says "no more queries"; a `sql`
  reply there is a `422 ask_failed`.
- **Flat response schema, not tool-calls.** `{status, sql, answer}` with the unused field `""`,
  same reason as `extractor.ts`: OpenAI strict structured outputs reject unions/optionals. It also
  means the conversation serializes as text, with nothing tool-call-shaped to round-trip over HTTP.
- **`assertReadOnlySql` gates every query** before it goes back. A rejection is fed to the model
  for **one** inline correction attempt (its own LLM call → its own usage row) before 422.
- **Schema comes from the client, semantics come from us.** The app sends live `sqlite_master`
  DDL so shape can't drift from its migrations; the system prompt carries what DDL can't say
  (signed amounts, `COALESCE(name, raw_name)`, the category pivot, one app-wide currency). If the
  app changes what a column *means*, `asker.ts`'s prompt has to change with it.
- **Rate limit is per loop iteration**, so a 3-step question spends 3 tokens of
  `RATE_LIMIT_PER_MIN` (~6 questions/min at the default 20).
- **The quota is checked per loop iteration too**, so a question can run out of budget
  mid-loop and 402 after its earlier turns were already paid for. See Quota.

## Quota — a monthly USD cap per user

Rate limiting bounds requests per minute; this bounds **money per month**. Both are needed:
20 extractions/min is fine as a burst and ruinous as a habit.

- **The unit is USD of provider cost, not tokens.** Tokens aren't comparable across
  input/cached/output, so a token cap would price a cheap month like an expensive one.
- **Cost is computed at WRITE time** (`pricing.ts` → `usage.cost_usd`), never derived on read.
  A price change therefore can't rewrite what past months cost, and the quota check is a single
  indexed `SUM` over `idx_usage_user`. `PRICES` in `pricing.ts` is USD per 1M tokens and must be
  checked against the provider's price page when `MODEL` changes; the configured model's rates
  can also be overridden by env (`PRICE_*_PER_MTOK`) so a repricing ships without a code edit.
  An unknown model bills at the fallback rate and warns once.
- **`cached_input_tokens` is a SUBSET of `input_tokens`** (OpenAI's `prompt_tokens_details.
  cached_tokens`), so `costUsd` subtracts it out before pricing the rest — never adds it on top.
- **`period.ts` is the only definition of "a month"**: the UTC calendar month, `[start, end)`.
  The middleware and `/v1/usage` both call it, so what's enforced and what's reported can't drift.
  UTC over per-user timezones deliberately — the reset is a date we can state ("resets on the 1st").
- **`users.monthly_limit_usd` is per user**, set explicitly at creation from
  `DEFAULT_MONTHLY_LIMIT_USD` (1.00) and movable via `PATCH /v1/admin/users/:id`. The column
  DEFAULT in migration 3 only back-fills pre-existing rows — changing the env var never
  retroactively moves anyone's allowance. `GET /v1/admin/users` returns each user's cap next to
  their month-to-date spend so a change is an informed one.
- **Enforcement is a pre-check, so it overshoots by design.** A call's cost is unknowable until
  it returns; a user at $0.99 of a $1.00 cap still gets one more call. The month lands at roughly
  `limit + one call` (~$0.05 for an extraction), or `limit + N` under concurrency, bounded by the
  rate limiter. Reserving an estimate up front would fix this and isn't worth the machinery.
- **A failed LLM call logs `cost_usd = 0`** — it threw before reporting usage, so the tokens it
  really burned are unknown. Real money the cap doesn't see. Acceptable while failures are rare;
  if they stop being rare, estimate from the prompt instead of writing 0.
- **402 `quota_exceeded`**, message carries the cap and the reset date. `/v1/license` and
  `/v1/usage` are deliberately outside the gate: checking how much is left has to work precisely
  when nothing is left.

Rough gpt-5.1 costs, for sizing a limit: ~$0.05 per statement extraction, ~$0.02 per ask turn.
So $1/month ≈ 20 statements or ~25 questions. These are estimates — the `usage` table has the
real numbers, so retune from it rather than from this paragraph.

## Guards (in place — it's real money)

Per-key rate limit (in-memory, fine for single instance), a per-user monthly USD cap (see Quota),
max upload size (Content-Length pre-check + actual size), `maxAskBytes` 1 MB cap on ask bodies
(query results ride in `steps`, so they aren't otherwise bounded), a server-side `MAX_STEPS`
budget, `assertReadOnlySql` on all generated SQL, 60s LLM-call timeout via `AbortSignal.timeout`.
**Never log** the plaintext license key, `PROVIDER_API_KEY`, or `ADMIN_KEY`.

## Auth model

Two independent credentials, both sent as `Authorization: Bearer <key>`:

- **License key** (users). Stored as SHA-256 hex (`key_hash`, unique). Incoming key is hashed
  and looked up; no match → 401, `active=0` → 403. `middleware/auth.ts` attaches the user to
  the Hono context (`c.get("user")`) for handlers + usage logging.
- **`ADMIN_KEY`** (operator). Env-only — no `users` row, no hashing at rest, compared
  constant-time via `secretEquals`. Scopes **`/v1/admin/*` only**; unset ⇒ those routes always
  401. It is deliberately **not** a bypass for `/v1/extract`: extract needs a real user row for
  the `usage.user_id` FK and the rate-limit bucket key, and faking one would mean
  special-casing usage logging. An operator who wants to extract issues themselves a normal
  license key. If that ever changes, do it with an `is_admin` column + a real seeded row, not a
  synthetic user object.

`GET /v1/license` exposes that middleware as an endpoint: it is `auth` plus a handler that
only echoes the user's name, so **reaching the handler is the verdict** — an unknown key 401s
(`unauthorized`) and a revoked one 403s (`inactive`) before any code of ours runs. There is
deliberately no `{ valid: false }` body and no `rateLimit` (it would share the paid per-user
bucket with extract/ask; the check costs one hash + one indexed SELECT). The app calls it when
the user saves a license key in Settings.

`GET /v1/usage` sits next to it under the same rule — `auth` only, no `rateLimit`, and pointedly
no `quota`: it is the endpoint that reports the quota, so it has to answer once the cap is hit.

Issuing/revoking keys and setting spend caps is HTTP-only (`POST`/`GET`/`PATCH /v1/admin/users`)
— the old `scripts/add-user.ts` CLI and the raw-SQL deactivation step are gone. `ADMIN_KEY` is
therefore the only way to mint license keys.

## Deploy

Railway, from `Dockerfile` (multi-stage) + `railway.json`. See README for the click-path.
Non-obvious constraints, all of them load-bearing:

- **Root Directory must be `porkin-backend`.** The git root is the monorepo `porkin/` (this dir
  + the untracked `porkin-app/`), so there's no `package.json` at the repo root.
- **Base image must be glibc ≥ 2.38** — `node:24-trixie-slim`, *not* `node:24-slim` (bookworm,
  2.36). better-sqlite3 v13's prebuilt `.node` binaries link `GLIBC_2.38`; on bookworm the
  process dies at `require` with `libm.so.6: version 'GLIBC_2.38' not found`.
- **`npm ci --ignore-scripts`** in both stages: better-sqlite3's postinstall shells out to
  `node-gyp`, which needs python3/make/g++ *just to detect* the prebuild it already ships in
  the tarball (`prebuilds/linux-{x64,arm64}.node`, Node-API so Node-version-independent).
  Verified working on both amd64 (what Railway builds) and arm64.
- **Volume at `/data` + `DB_PATH=/data/porkin.db`**, or redeploys wipe every license key.
- **Exactly one replica** (`numReplicas: 1`): single SQLite writer, and `rateLimit.ts` buckets
  are per-process — a second replica silently doubles the limit.
- Runs as **root** in the container: Railway volumes are root-owned, so `USER node` would
  `EACCES` on the DB file.
- `PROVIDER_API_KEY` + `ADMIN_KEY` come from Railway variables; `.dockerignore` keeps `.env`
  out of the image.

## Not yet built (intentionally deferred)

Anthropic/Google providers · billing / payments (the quota caps spend, nothing charges for it) ·
per-user notification when the cap is hit · automated tests · request logging/metrics beyond the
`usage` table.
