---
dev-flow:
  slug: gh-10-push-hub-prometheus-metrics
  stops: []
---

# push-hub Prometheus `/metrics` — Design

**Issue:** [#10](https://github.com/tayl0r/push-hub/issues/10) — Add Prometheus `/metrics` endpoint + scrape labels (DEPLOY.md observability gap)
**Date:** 2026-07-23
**Spec source:** DEPLOY.md § *Custom Metrics (Prometheus)* and § *Observability (required for every app)*
**Baseline:** written against `main` at #9 (`Consolidate push-service engine into push-hub`) — the engine is vendored at `src/engine/`, not the former `@tsteil/push-service` package.

## Problem

push-hub is missing the **metrics** item on the DEPLOY.md observability checklist — the only gap. Confirmed in code (no `prom-client`, no `/metrics`, no `:9464` server, no `prometheus.io/*` compose labels) and live (Prometheus reports "NO push-hub targets scraped"). Everything else is done: GlitchTip error tracking (`@sentry/node`, server-only — correct for an internal API with no browser bundle), Uptime Kuma monitors #17/#18, Loki logs.

## Goal

Expose a *meaningful* `/metrics` (RED + `app_build_info` + dependency + domain metrics) on an internal-only `:9464` server, and add the `prometheus.io/*` discovery labels so Prometheus scrapes push-hub automatically over `apps_internal`. Verified live with `"health": "up"` under Prometheus's `apps` job, for both dev and prod.

## Non-goals

- No public routing. push-hub stays **internal-only** (no `web` network, no Traefik label) — deliberate: `/v1/send` can push to any of a tenant's users, so only apps already on `apps_internal` may reach it. The metrics port inherits the same isolation.
- No edit to `monitoring/prometheus.yml` — discovery is label-driven. (Setting `honor_labels: true` there would let a drifted app `.env` override infra-derived target labels for *every* app — the wrong fix; see the `app_build_info` deviation below.)
- No network migration — the VPS compose files already map their `internal` key to `name: apps_internal` with a service alias, so push-hub is already on the network Prometheus scrapes.
- No engine behavior change. The send engine at `src/engine/` (APNs/FCM transports) is instrumented from the *outside* (the route boundary), not rewritten. One pre-existing engine wart this surfaced is filed as a separate follow-up (see *Follow-ups*).

## Architecture

A new **`src/metrics.ts`** owns all metrics state and is the only module that imports `prom-client`. Everything else calls small typed helpers, so instrumentation stays decoupled from the metrics library.

`src/metrics.ts` exports:

- `register` — a dedicated `prom-client` `Registry` (also runs `collectDefaultMetrics({ register })` for process CPU/mem/event-loop/GC).
- `startMetricsServer(port)` — a bare `node:http` server that serves **only** `GET /metrics` (everything else → 404), bound `0.0.0.0`, **no Traefik label**. Returns the server so `index.ts` can log/manage it. Scrape requests do **not** pass through the Fastify app, so they are never counted in the HTTP RED metrics.
- `registerHttpMetrics(app)` — installs `onRequest`, `onResponse`, `onRequestAbort`, and `onTimeout` Fastify hooks for the RED signals. `onRequest` increments `http_requests_in_flight` and stores the start time in a `WeakMap<FastifyRequest, number>`. A single internal `settle(request)` helper does `WeakMap.get` → if the entry is present, `delete` it and decrement the gauge, returning the start time; if absent it returns `undefined`. Removing the WeakMap entry makes `settle` idempotent, so the gauge decrements **exactly once per request** no matter which hooks fire. `onResponse` calls `settle` and — only when it returns a start time — observes `http_request_duration_seconds` and increments `http_requests_total` with `reply.statusCode`. `onRequestAbort` and `onTimeout` just call `settle` (no duration/counter — no meaningful response was delivered), correcting the gauge. This is required, not belt-and-braces: Fastify 5's `onResponse` fires off the raw response's finish/error events and **never runs when a client disconnects before a response is written** (the gauge would otherwise ratchet upward under load until restart), while an aborted request *can* still later fire `onResponse` via a response `error` event — the idempotent `settle` handles both orderings. All four hooks receive the same `FastifyRequest` object (verified in Fastify `lib/route.js`), so the WeakMap key holds. `onTimeout` is inert today (no `connectionTimeout` configured) but is registered so the gauge stays correct if one is ever added.
- `dbTimed(operation, fn)` — wraps a DB call: increments `db_queries_in_flight`, starts a timer, and in a `finally` block observes `db_query_duration_seconds{operation}` **and** decrements in-flight — duration and in-flight both settle on success **or** throw (slow-then-failing queries are precisely the ones worth seeing), rethrowing the error unchanged. `operation` is typed `DbOperation` (a bounded union — see below), so adding an 8th operation is a conscious one-line type edit rather than a silent free-form string.
- `recordSend(status, provider)` — increments `push_sends_total{status, provider}`.
- `setBuildInfo({ version, commit })` — sets `app_build_info` = 1 once.
- `registerSampledGauges({ tenantsCount, tokensCount })` — wires the `tenants` and `push_tokens` gauge collect callbacks against injected live-count functions (keeps `metrics.ts` free of db/schema imports).

Wiring points (all pre-existing files, structurally unchanged by #9):

- **`src/index.ts`** — after `registry.load()` and `buildApp(...)`: `setBuildInfo({ version, commit })`, `registerSampledGauges({ tenantsCount: () => registry.size, tokensCount: () => countTokens(db) })`, `startMetricsServer(env.METRICS_PORT)`.
- **`src/app.ts`** — call `registerHttpMetrics(app)` inside `buildApp`.
- **`src/store.ts` + `src/registry.ts`** — wrap each query call-site in `dbTimed(operation, () => …)`. In `registry.ts` these are the `load()` select, the `register()` insert, and the `updateCredentials()` update. `store.ts` also gains `countTokens(db)` — the `push_tokens` sampling query, deliberately **not** `dbTimed`-wrapped (see the operations-enum note).
- **`src/db/client.ts`** — a signpost comment beside the `db` export: `// Every query call-site must be wrapped in dbTimed(operation, …) — see src/metrics.ts (no driver-level duration hook exists).`
- **`src/routes/send.ts`** — `recordSend(r.status, r.provider)` per engine result on success; `recordSend('error', t.provider)` per attempted target in the `catch` block (see *Domain metric placement*).

## Metrics

Baseline (RED) — required of every backend:

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | histogram | `method`, `route` |
| `http_requests_in_flight` | gauge | — |
| `app_build_info` | gauge (=1) | `version`, `commit` |

> **Deviation from the issue, on purpose (`app_build_info` labels).** The issue and DEPLOY.md's baseline table list an `environment` label on `app_build_info`. The fleet scrape config (`monitoring/prometheus.yml`, `apps` job) already stamps `environment`, `app`, and `instance` onto **every** scraped series via target relabeling (from the compose project name), with `honor_labels` unset (Prometheus default `false`). On a same-name collision the scraped metric's own `environment` is renamed `exported_environment` and the target's value wins — so an app-side `environment` label can never appear as written. Deploy correlation needs only `version`+`commit` from the app; `app_build_info{app="push-hub",environment="production",…}` is fully populated by the target labels.

Dependencies actually used (Postgres):

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `db_query_duration_seconds` | histogram | `operation` | observed on success **and** throw; one bounded `DbOperation` enum |
| `db_queries_in_flight` | gauge | — | in-flight query count; settles on both paths |

> **Deviation from the issue, on purpose (DB pool).** The issue lists `db_pool_connections{state=active/idle/waiting}`. postgres-js exposes no reliable public API for idle/waiting pool state (verified: only config knobs and `reserve()`, no `idleCount`/`waitingCount`), so rather than fabricate those series we expose `db_queries_in_flight` — a value we can measure honestly — alongside query duration. This still answers "is the DB a bottleneck?" (rising in-flight + rising duration = saturation) without inventing numbers.

Domain (what the product does):

| Metric | Type | Labels | Source |
|---|---|---|---|
| `push_sends_total` | counter | `status` (`delivered`/`failed`/`invalid`/`error`), `provider` (`apns`/`fcm`) | per engine `SendResult` on success; per attempted target with `status="error"` on a batch-level engine throw |
| `tenants` | gauge | — | sampled from `registry.size` at scrape |
| `push_tokens` | gauge | — | sampled via `store.countTokens(db)` (drizzle `count()`) at scrape |

Plus `collectDefaultMetrics` (process metrics).

`tenants` and `push_tokens` are renamed from issue #10's *example* names (`tenants_total`/`tokens_total`) to satisfy the gauge-naming rule: `_total` is reserved for counters (DEPLOY.md § Custom Metrics; promlint also flags `_count` on non-histograms, ruling out `tenants_count`/`tokens_count` too), so plain state-noun names are correct — matching DEPLOY.md's own gauge examples (`active_sessions`, `queue_depth`). `push_tokens` matches the table name (`src/db/schema.ts`).

### `db_query_duration_seconds` operations (bounded enum)

`metrics.ts` declares `type DbOperation = 'register_token' | 'remove_token' | 'tokens_for_users' | 'delete_tokens' | 'tenants_load' | 'tenant_insert' | 'tenant_update'` and `dbTimed(operation: DbOperation, fn)`. The `push_tokens` sampling `count()` (`store.countTokens`) is **not** wrapped in `dbTimed` — it is scrape-driven, not request work, and would otherwise pollute query-duration percentiles.

**Why per-call-site, not a single choke point:** postgres-js exposes no per-query lifecycle hook that yields *duration* (its `debug` callback fires at dispatch only), and drizzle has no query-complete event — the only single-seam option is a recursive Proxy over drizzle's lazy builder chains, which is fragile against drizzle internals and would downgrade labels from product-meaningful names (`register_token`) to SQL-derived ones (`insert:push_tokens`). The accepted cost is that a future query call-site must remember to wrap itself in `dbTimed`; the `DbOperation` type keeps the enum compiler-bounded, and a missed wrap degrades to a *missing series*, never wrong data. The signpost comment in `src/db/client.ts` flags the requirement at the shared `db` seam.

### Sampled gauges (async collect)

`tenants` and `push_tokens` use `prom-client` async `collect` callbacks, evaluated when `register.metrics()` runs (once per scrape, ~15s). `push_tokens`'s count query is wrapped in try/catch: on DB error it leaves the previous value rather than failing the whole `/metrics` response, so a transient DB blip doesn't blank the scrape.

`countTokens` lives in `store.ts` (the `push_tokens` data-access seam, alongside every other token query) and uses drizzle's `count()` aggregate:

```ts
import { count } from 'drizzle-orm'   // drizzle 0.38 exports this from the package root

export async function countTokens(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(pushTokens)
  return Number(row.n)
}
```

Why not raw `db.execute(sql\`select count(*) from push_tokens\`)`: two postgres-js footguns. (1) Postgres returns `count(*)` as `int8` (OID 20), which postgres-js does **not** parse to a number (its number parser covers OIDs 21/23/26/700/701 only) — the value arrives as a *string*, which fails `Gauge.set(number)` under strict TS. (2) The postgres-js result is a `RowList` that carries its own `.count` **metadata** property (rows returned — always 1 here), trivially confused with the `count` column; a naive `result.count` reads `1` forever. Drizzle's `count()` sidesteps both: it emits `count(*)` and maps the value with `.mapWith(Number)`, typed `SQL<number>`. The explicit `Number(...)` is a belt-and-braces guard because `store.ts` types `Db` as `any` (Number precision loss only starts at 2^53 rows, and is strictly safer than an `::int` cast's 2.1B cap).

The `count()` is a full scan tied to the scrape interval (~15s) — fine at current scale and blessed by DEPLOY.md for DB-sourced gauges; if `push_tokens` ever grows enough to show up in scrape latency, the known cheap swap is `pg_stat_user_tables.n_live_tup` (approximate, vacuum-lagged).

### Domain metric placement (`push_sends_total`)

Counted at the `/v1/send` route boundary, not inside `src/engine/`. `SendStatus` (`delivered`/`failed`/`invalid`, from `src/engine/types.ts`) is the engine's bounded union; `error` is a **metric-only** status added by the route. Both `SendResult` and the route's `targets` array carry `provider: 'apns'|'fcm'`, so every increment is provider-attributed.

- **Success path:** `recordSend(r.status, r.provider)` per `SendResult`.
- **Batch-throw path:** a config-classified per-token error thrown from either transport rejects the whole `engine.send` `Promise.all`, discarding the sibling transport's results too (`src/engine/apns.ts`, `src/engine/fcm.ts`, `src/engine/index.ts`). The route's `catch` block does `recordSend('error', t.provider)` for each entry of the already-built `targets` array. This keeps the domain metric live during exactly the misconfig incidents where per-result counting goes blind (the generic `http_requests_total{route="/v1/send",status="500"}` still fires as before), and keeps `sum(push_sends_total)` in one unit — tokens attempted — on both paths. Per-target (not per-batch) increments are deliberate: a single `+1` per batch would mix units with the per-token success path. On this path the `provider` label attributes the *lost outcome* to each target's own provider, not to whichever provider caused the throw — correct at the service-contract level (those sends produced no result for the caller).
- The empty-token early return increments nothing.

## Cardinality guards

- `route` = Fastify `request.routeOptions.url` (the registered template, e.g. `/v1/send`, `/v1/tokens`), a single constant (`__unmatched__`) for 404s (Fastify's default 404 handler leaves `routeOptions.url` undefined) — **never** a raw path.
- `operation` (7), `status` (4), and `provider` (2) are fixed enums (`push_sends_total` = 4×2 = 8 series).
- **Never** labeled by tenant slug, user id, token, request id, or raw path.

## Config & build

- `package.json` gains `"prom-client": "^15.1.3"` in `dependencies` — add via `pnpm add prom-client` so `pnpm-lock.yaml` updates in the same commit (the Docker build runs `pnpm install --frozen-lockfile` and fails on a stale lockfile). 15.x is the current major; the async `collect()` the sampled gauges rely on has been supported since prom-client 13, so `^15` clears that floor comfortably.
- `src/env.ts` gains `METRICS_PORT` (`z.coerce.number().default(9464)`) and `GIT_COMMIT` (`z.string().default('unknown')`).
- `Dockerfile` gains `ARG GIT_COMMIT` → `ENV GIT_COMMIT=$GIT_COMMIT` (placed after `RUN pnpm build` so a changing SHA doesn't bust the install/build cache layers), and `EXPOSE 3000 9464`. (#9 already removed the `git` apk install, so the Dockerfile is transport-only; these edits are additive.)
- `.github/workflows/deploy.yml` build step passes `build-args: GIT_COMMIT=${{ github.sha }}`.
- `app_build_info` labels: `version` from `package.json` (via `createRequire`), `commit` from `env.GIT_COMMIT`.
- `.env.example` documents `METRICS_PORT` (optional).

## Compose changes ("the new form")

push-hub stays internal-only; the change is adding the metrics port + discovery labels. Applied to **all three** compose files:

```yaml
services:
  push-hub:
    # …unchanged…
    expose:
      - "3000"
      - "9464"
    labels:
      - prometheus.io/scrape=true
      - prometheus.io/port=9464
```

- **Repo `docker-compose.yml`** — also reconciled on one point of real drift: `networks.internal` gains `name: apps_internal` (with `external: true` and no `name:`, Compose resolves the external network by its key — `internal` — which doesn't exist on the VPS; the actual network is `apps_internal`). No `aliases:` are added: Compose auto-registers the service key as a network alias, and this file's key is already `push-hub`, so an explicit identical alias is a no-op. On the VPS only the **dev** file's `aliases: [push-hub-dev]` is load-bearing — it gives the dev container a distinct DNS name on the shared network (DEPLOY.md's template uses the generic service key `app:`, which is why the live files carry explicit aliases at all); the repo file is a prod-shaped reference and needs none. (This file is reference-only; deployment uses the per-dir VPS files.)
- **VPS `/opt/apps/push-hub-dev/docker-compose.yml`** and **`/opt/apps/push-hub/docker-compose.yml`** — add the `expose`/`labels` blocks above; everything else stays.

Labels are kept in list form (`- key=value`) so the value stays a string, as DEPLOY.md requires. `app`/`environment` metric labels derive from the compose project name (dir name: `push-hub` / `push-hub-dev`) — nothing to set.

## Testing (TDD)

Test isolation: `metrics.ts`'s registry is module-global; Vitest re-instantiates it per test file, so cross-file state is a non-issue (`fileParallelism: false` additionally serializes files). Within a file, every suite that asserts metric values calls `register.resetMetrics()` in `beforeEach` and then makes **absolute** assertions (e.g. `http_requests_total{method="GET",route="/health",status="200"} == 1` after one request) — no delta arithmetic. `resetMetrics()` zeroes values but keeps metric instances, so `collect` callbacks and default metrics keep working. `startMetricsServer` tests listen on port 0 (ephemeral) to avoid collisions.

- **`test/metrics.test.ts`** (new) — `recordSend`/`dbTimed`/`setBuildInfo` produce the expected series and values; on a throwing `fn`, `dbTimed` decrements `db_queries_in_flight` **and** increments `db_query_duration_seconds_count{operation}`, then rethrows; the `settle` lifecycle decrements `http_requests_in_flight` exactly once even when abort-then-response both fire; the sampled-gauge collect callbacks read injected counts; `push_tokens` collect swallows a DB error; `startMetricsServer` serves `/metrics` and 404s other paths. No DB needed — this suite injects fakes.
- **`test/app.test.ts`** (extend) — one request through `buildApp` yields `http_requests_total{route="/health",…} == 1` after `resetMetrics()`.
- **`test/store.test.ts`** (extend) — a store call increments `db_query_duration_seconds_count{operation}`; `countTokens` returns the row count as a `number`.
- **`test/send.route.test.ts`** (extend) — a `/v1/send` call increments `push_sends_total` by result status+provider; the existing "500 when the engine throws" case additionally asserts `push_sends_total{status="error"}` rises by the number of attempted targets, with the correct per-target provider.
- Full existing suite stays green (`pnpm test`; DB suites need `TEST_DATABASE_URL` migrated).

## Deploy & verify (live, dev → prod)

1. Land code + repo compose + Dockerfile + workflow via squash PR to `main`.
2. Merge → CI builds `:dev`, deploys `push-hub-dev`.
3. Edit `/opt/apps/push-hub-dev/docker-compose.yml` (add `expose`/`labels`), `docker compose up -d` in that dir.
4. Verify discovery:
   ```
   docker exec monitoring-prometheus-1 wget -qO- \
     'http://localhost:9090/api/v1/targets?state=active' | grep -A8 push-hub-dev
   ```
   Expect it under the `apps` job with `"health": "up"`.
5. Promote `git push origin main:prod` → CI deploys `push-hub` (prod).
6. Edit `/opt/apps/push-hub/docker-compose.yml` likewise, `up -d`, verify prod target `health=up`.

> **Note on pipeline scope:** dev-flow carries this to a squash-merged PR (Stages 4–5). Steps 3–6 above (VPS compose edits + live Prometheus verification — the actual #10 acceptance) run *after* the merge, outside the pipeline's endpoint.

## Follow-ups (out of scope for this PR)

- **Engine batch-discard bug** (filed as a GitHub issue): a config-classified per-token error thrown from a transport rejects the whole `engine.send` `Promise.all`, so a fully-successful sibling batch is discarded, `/v1/send` returns 500 with no tickets, and invalid-token cleanup is skipped despite real deliveries. This design only makes the incident *observable* (`status="error"` counting); the semantics fix is its own change.
- **DEPLOY.md template fix** (fleet repo `~/dev/vps`, separate from this PR): the baseline observability table lists an `environment` label on `app_build_info`, which every future app would self-set and see silently renamed to `exported_environment`. The template should drop it and note that `app`/`environment`/`instance` come from Prometheus target relabeling.

## Acceptance criteria (from #10)

- [ ] `/metrics` on `:9464` (internal only), exposing RED + `app_build_info` + domain metrics.
- [ ] `prometheus.io/*` labels + port in compose (repo + dev + prod VPS dirs).
- [ ] Verified discovered & `"health": "up"` under Prometheus's `apps` job (dev and prod).
