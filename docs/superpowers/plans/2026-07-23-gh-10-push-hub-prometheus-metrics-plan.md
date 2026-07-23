---
dev-flow:
  slug: gh-10-push-hub-prometheus-metrics
  spec: docs/superpowers/specs/2026-07-23-gh-10-push-hub-prometheus-metrics-design.md
---

# push-hub Prometheus `/metrics` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a meaningful internal-only `/metrics` endpoint (RED + `app_build_info` + Postgres dependency + push-domain metrics) on `:9464`, and add the `prometheus.io/*` discovery labels + port to the repo compose file so Prometheus can scrape push-hub.

**Architecture:** A single new module `src/metrics.ts` owns all metric state and is the only file that imports `prom-client`. Everything else calls small typed helpers (`recordSend`, `dbTimed`, `registerHttpMetrics`, `setBuildInfo`, `registerSampledGauges`, `startMetricsServer`), keeping instrumentation decoupled from the metrics library. A bare `node:http` server serves only `GET /metrics`, so scrapes never pass through Fastify and are never counted in the HTTP RED metrics.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥22, Fastify 5, drizzle-orm 0.38 over postgres-js, Vitest 2, `prom-client` ^15.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Dependency:** add `prom-client` via `pnpm add prom-client` (resolves to `^15.1.3`) so `pnpm-lock.yaml` updates in the same commit — the Docker build runs `pnpm install --frozen-lockfile` and fails on a stale lockfile.
- **Gauge names:** `tenants` and `push_tokens` (plain state nouns). Never `*_total` (reserved for counters) or `*_count` (promlint flags it on non-histograms).
- **`app_build_info` labels:** exactly `version` and `commit`. Do NOT add an `environment` label — Prometheus target relabeling stamps `app`/`environment`/`instance` on every series, and an app-side `environment` would be silently renamed `exported_environment`.
- **`DbOperation`** is a bounded union of exactly these 7 strings: `'register_token' | 'remove_token' | 'tokens_for_users' | 'delete_tokens' | 'tenants_load' | 'tenant_insert' | 'tenant_update'`. Adding an 8th is a conscious one-line type edit.
- **`push_sends_total` labels:** `status` ∈ {`delivered`,`failed`,`invalid`,`error`} (`error` is metric-only, added by the route), `provider` ∈ {`apns`,`fcm`}.
- **`route` label** = `request.routeOptions.url` (registered template, e.g. `/v1/send`); the single constant `__unmatched__` for 404s (Fastify leaves `routeOptions.url` undefined there). **Never** a raw path.
- **Never** label any metric by tenant slug, user id, token, request id, or raw path.
- **Sampled-gauge `collect`:** prom-client 15's `Gauge` class type exposes no assignable `collect` property; `collect` MUST be declared inside the `new Gauge({...})` constructor config. A post-construction `gauge.collect = …` fails `tsc` (TS2339) yet passes Vitest (which transpiles without type-checking), so the break would stay hidden until `pnpm build`. The sampled gauges read a module-level mutable `let sampledDeps` that `registerSampledGauges` sets.
- **Metrics server:** bare `node:http`, serves only `GET /metrics` (everything else → 404), bound `0.0.0.0`, **no** Traefik/router label. It does not run through the Fastify app.
- **Test isolation:** the registry in `metrics.ts` is module-global; Vitest re-instantiates the module per test file. Within a file, every suite that asserts metric values calls `register.resetMetrics()` in `beforeEach` and then makes **absolute** assertions (no delta arithmetic). `startMetricsServer` tests listen on port `0` (ephemeral).
- **Shared test helper:** the one way this repo reads a prom-client series lives in `test/helpers/metrics.ts` (`export function readSeries`). Every test file that asserts series values imports it — never re-inline it. The helper imports `register` itself, so a test can't accidentally read the wrong registry. (`tsconfig.json` has `"include": ["src"]`, so `test/` is never part of `pnpm build`; Vitest's suite glob never runs the helper as a test.)
- **Repo `docker-compose.yml`:** `networks.internal` gains `name: apps_internal` (it is `external: true`; without an explicit name Compose looks for a network literally named `internal`, which doesn't exist on the VPS). Add **NO** `aliases:` (Compose auto-registers the service key `push-hub` as the alias). Add `expose: "9464"` and the `prometheus.io/*` labels in **list form** (`- key=value`, so values stay strings).
- **DB-backed test tasks (5, 6, 7, 8)** run against a real Postgres: `TEST_DATABASE_URL` must be set and its schema migrated (Vitest `globalSetup` migrates it automatically once `migrations/` is present, which it already is). The metrics unit tests (Tasks 1–3) and the env test (Task 4) inject fakes and need **no** DB.
- **Commits:** stage with explicit `git add <paths>` (never `git add -A`). End every commit message body with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Out of scope for this plan (do NOT add tasks for these):** opening/merging a PR; any VPS/SSH edits to `/opt/apps/**/docker-compose.yml`; `docker compose up`; live Prometheus verification. Those run outside the pipeline. This plan touches only code, tests, `docs`, `package.json`/lockfile, `Dockerfile`, `.github/workflows/deploy.yml`, `.env.example`, and the repo `docker-compose.yml`.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/metrics.ts` (new) | All metric state + typed helpers; only importer of `prom-client` | 1, 2, 3 |
| `test/metrics.test.ts` (new) | Unit tests for every helper; injects fakes, no DB | 1, 2, 3 |
| `test/helpers/metrics.ts` (new) | Shared `readSeries` test helper — the one seam that knows how to read a prom-client series | 1 (used by 5–8) |
| `src/env.ts` | Adds `METRICS_PORT`, `GIT_COMMIT` | 4 |
| `test/env.test.ts` | Covers the two new env fields | 4 |
| `src/store.ts` | Wraps token queries in `dbTimed`; adds `countTokens` | 5 |
| `src/db/client.ts` | Signpost comment at the shared `db` seam | 5 |
| `test/store.test.ts` | Covers `dbTimed` labelling + `countTokens` | 5 |
| `src/registry.ts` | Wraps load/insert/update in `dbTimed` | 6 |
| `test/registry.test.ts` | Covers the three registry operation labels | 6 |
| `src/app.ts` | Installs `registerHttpMetrics(app)` in `buildApp` | 7 |
| `test/app.test.ts` | Covers RED counting through `buildApp` | 7 |
| `src/routes/send.ts` | `recordSend` on success + on batch-throw | 8 |
| `test/send.route.test.ts` | Covers domain counting both paths | 8 |
| `src/index.ts` | Boot wiring: build info, sampled gauges, metrics server | 9 |
| `Dockerfile`, `.github/workflows/deploy.yml`, `.env.example`, `docker-compose.yml` | Build arg + expose + discovery labels + network name fix | 10 |

---

### Task 1: `src/metrics.ts` core + `recordSend` / `setBuildInfo` / `dbTimed`

Adds the dependency, creates the module with its dedicated registry, default process metrics, the counter/histogram/gauge instances for domain + DB + build-info, and the three synchronous/awaitable helpers. Also creates the shared `test/helpers/metrics.ts`. HTTP hooks and the metrics server come in Tasks 2–3.

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (via `pnpm add`)
- Create: `src/metrics.ts`, `test/helpers/metrics.ts`
- Test: `test/metrics.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `export const register: Registry`
  - `export type DbOperation = 'register_token' | 'remove_token' | 'tokens_for_users' | 'delete_tokens' | 'tenants_load' | 'tenant_insert' | 'tenant_update'`
  - `export function setBuildInfo(info: { version: string; commit: string }): void`
  - `export function recordSend(status: string, provider: string): void`
  - `export async function dbTimed<T>(operation: DbOperation, fn: () => Promise<T>): Promise<T>`
  - `test/helpers/metrics.ts`: `export async function readSeries(fullName: string, labels?: Record<string, string>): Promise<number | undefined>`

- [x] **Step 1: Add the dependency**

Run:
```bash
pnpm add prom-client
```
Expected: `pnpm-lock.yaml` updates and `package.json` `dependencies` gains a `"prom-client": "^15.x"` entry (15.1.3 or newer 15.x). Confirm:
```bash
node -e "console.log(require('./package.json').dependencies['prom-client'])"
```
Expected: prints `^15.1.3` (or a newer `^15.x`).

- [x] **Step 2: Write the shared helper and the failing test**

Create `test/helpers/metrics.ts`:
```ts
// Read one absolute series value from the module-global registry — the one place that
// knows how this repo reads a prom-client series (base-name strip + metricName match).
// For a histogram, pass the derived name directly, e.g. 'db_query_duration_seconds_count'.
import { register } from '../../src/metrics.js'

export async function readSeries(fullName: string, labels: Record<string, string> = {}): Promise<number | undefined> {
  const baseName = fullName.replace(/_(count|sum)$/, '')
  const metric = register.getSingleMetric(baseName)
  if (!metric) return undefined
  const data: any = await metric.get()
  const match = data.values.find((v: any) => {
    const nameMatches = (v.metricName ?? data.name) === fullName
    return nameMatches && Object.entries(labels).every(([k, val]) => String(v.labels[k] ?? '') === val)
  })
  return match?.value
}
```

Create `test/metrics.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { register, recordSend, setBuildInfo, dbTimed } from '../src/metrics.js'
import { readSeries } from './helpers/metrics.js'

beforeEach(() => { register.resetMetrics() })

describe('recordSend', () => {
  it('counts push_sends_total by status and provider', async () => {
    recordSend('delivered', 'apns')
    recordSend('delivered', 'apns')
    recordSend('error', 'fcm')
    expect(await readSeries('push_sends_total', { status: 'delivered', provider: 'apns' })).toBe(2)
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'fcm' })).toBe(1)
  })
})

describe('setBuildInfo', () => {
  it('sets app_build_info=1 with version and commit labels', async () => {
    setBuildInfo({ version: '9.9.9', commit: 'deadbeef' })
    expect(await readSeries('app_build_info', { version: '9.9.9', commit: 'deadbeef' })).toBe(1)
  })
})

describe('dbTimed', () => {
  it('observes duration and settles in-flight on success', async () => {
    const out = await dbTimed('register_token', async () => 'ok')
    expect(out).toBe('ok')
    expect(await readSeries('db_query_duration_seconds_count', { operation: 'register_token' })).toBe(1)
    expect(await readSeries('db_queries_in_flight')).toBe(0)
  })

  it('observes duration, decrements in-flight, and rethrows on a throwing fn', async () => {
    await expect(dbTimed('remove_token', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await readSeries('db_query_duration_seconds_count', { operation: 'remove_token' })).toBe(1)
    expect(await readSeries('db_queries_in_flight')).toBe(0)
  })
})
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run test/metrics.test.ts`
Expected: FAIL — cannot resolve `../src/metrics.js` (the module does not exist yet; both the test file and `test/helpers/metrics.ts` import it).

- [x] **Step 4: Write minimal implementation**

Create `src/metrics.ts`:
```ts
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client'

// Module-global, dedicated registry. Vitest re-instantiates this module per test file,
// so cross-file metric state is a non-issue; within a file, tests call register.resetMetrics().
export const register = new Registry()
collectDefaultMetrics({ register }) // process CPU/mem/event-loop/GC

// ---- app_build_info ----
const buildInfo = new Gauge({
  name: 'app_build_info',
  help: 'Build info; constant 1 with version/commit labels.',
  labelNames: ['version', 'commit'] as const,
  registers: [register],
})

// ---- Dependencies (Postgres) ----
export type DbOperation =
  | 'register_token'
  | 'remove_token'
  | 'tokens_for_users'
  | 'delete_tokens'
  | 'tenants_load'
  | 'tenant_insert'
  | 'tenant_update'

const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'DB query duration in seconds, by operation.',
  labelNames: ['operation'] as const,
  registers: [register],
})
const dbQueriesInFlight = new Gauge({
  name: 'db_queries_in_flight',
  help: 'DB queries currently in flight.',
  registers: [register],
})

// ---- Domain ----
const pushSendsTotal = new Counter({
  name: 'push_sends_total',
  help: 'Push send outcomes by status and provider.',
  labelNames: ['status', 'provider'] as const,
  registers: [register],
})

/** Set app_build_info=1 with the running version + commit. Call once at boot. */
export function setBuildInfo(info: { version: string; commit: string }): void {
  buildInfo.labels(info.version, info.commit).set(1)
}

/** Count one push send outcome. `status` includes the metric-only 'error'. */
export function recordSend(status: string, provider: string): void {
  pushSendsTotal.labels(status, provider).inc()
}

/**
 * Wrap a DB call: count it in-flight, time it, and observe duration on BOTH
 * success and throw (slow-then-failing queries are the ones worth seeing).
 * Rethrows the original error unchanged.
 */
export async function dbTimed<T>(operation: DbOperation, fn: () => Promise<T>): Promise<T> {
  dbQueriesInFlight.inc()
  const end = dbQueryDuration.startTimer({ operation })
  try {
    return await fn()
  } finally {
    end()
    dbQueriesInFlight.dec()
  }
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run test/metrics.test.ts`
Expected: PASS (4 tests).

- [x] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/metrics.ts test/helpers/metrics.ts test/metrics.test.ts
git commit -m "$(cat <<'EOF'
feat(metrics): prom-client registry with recordSend/dbTimed/setBuildInfo

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: HTTP RED hooks (`registerHttpMetrics` + idempotent `settle`)

Adds the RED metric instances and the four Fastify hooks. A single `settle(request)` helper removes the WeakMap entry and decrements `http_requests_in_flight` exactly once per request no matter which terminal hook fires.

**Files:**
- Modify: `src/metrics.ts`
- Test: `test/metrics.test.ts` (extend)

**Interfaces:**
- Consumes: `register`, the metric-instance style from Task 1.
- Produces: `export function registerHttpMetrics(app: FastifyInstance): void` — installs `onRequest`, `onResponse`, `onRequestAbort`, `onTimeout`.

- [x] **Step 1: Write the failing test**

Append to `test/metrics.test.ts` — add `registerHttpMetrics` to the existing import from `../src/metrics.js`, then add:
```ts
describe('registerHttpMetrics', () => {
  // Capture the hook handlers by passing a minimal fake "app".
  function hookApp() {
    const hooks: Record<string, (...args: any[]) => Promise<void>> = {}
    registerHttpMetrics({ addHook: (name: string, fn: any) => { hooks[name] = fn } } as any)
    return hooks
  }

  it('counts a normal request and settles in-flight to zero', async () => {
    const h = hookApp()
    const req: any = { method: 'GET', routeOptions: { url: '/health' } }
    await h.onRequest(req)
    expect(await readSeries('http_requests_in_flight')).toBe(1)
    await h.onResponse(req, { statusCode: 200 })
    expect(await readSeries('http_requests_in_flight')).toBe(0)
    expect(await readSeries('http_requests_total', { method: 'GET', route: '/health', status: '200' })).toBe(1)
    expect(await readSeries('http_request_duration_seconds_count', { method: 'GET', route: '/health' })).toBe(1)
  })

  it('decrements in-flight exactly once when abort then a late response both fire', async () => {
    const h = hookApp()
    const req: any = { method: 'GET', routeOptions: { url: '/health' } }
    await h.onRequest(req)
    await h.onRequestAbort(req)                  // settle #1: in-flight -> 0
    await h.onResponse(req, { statusCode: 200 }) // settle #2 is a no-op (entry already removed)
    expect(await readSeries('http_requests_in_flight')).toBe(0)
    // onResponse's settle returned undefined, so NO duration/total was recorded:
    expect(await readSeries('http_requests_total', { method: 'GET', route: '/health', status: '200' })).toBeUndefined()
  })

  it('decrements in-flight exactly once when timeout then a late response both fire', async () => {
    const h = hookApp()
    const req: any = { method: 'GET', routeOptions: { url: '/health' } }
    await h.onRequest(req)
    await h.onTimeout(req)                        // settle #1: in-flight -> 0
    await h.onResponse(req, { statusCode: 200 }) // settle #2 is a no-op (entry already removed)
    expect(await readSeries('http_requests_in_flight')).toBe(0)
    expect(await readSeries('http_requests_total', { method: 'GET', route: '/health', status: '200' })).toBeUndefined()
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/metrics.test.ts`
Expected: FAIL — `registerHttpMetrics` is not exported from `../src/metrics.js`.

- [x] **Step 3: Write minimal implementation**

In `src/metrics.ts`, add to the top import block:
```ts
import type { FastifyInstance, FastifyRequest } from 'fastify'
```

Add these metric instances (next to the other instances, above the exported functions):
```ts
// ---- RED (HTTP) ----
const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests handled by the Fastify app.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
})
const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route'] as const,
  registers: [register],
})
const httpRequestsInFlight = new Gauge({
  name: 'http_requests_in_flight',
  help: 'HTTP requests currently being processed.',
  registers: [register],
})
```

Add the exported function:
```ts
/**
 * Install RED hooks. onRequest marks a request in-flight and stamps a start time.
 * A single idempotent settle() decrements the gauge exactly once per request no
 * matter which terminal hook fires (onResponse, onRequestAbort, onTimeout).
 * Fastify 5's onResponse never runs when a client disconnects before a response is
 * written, and an aborted request can still fire onResponse later via a response
 * error event — the WeakMap-delete inside settle handles both orderings.
 */
export function registerHttpMetrics(app: FastifyInstance): void {
  const startTimes = new WeakMap<FastifyRequest, number>()

  const settle = (request: FastifyRequest): number | undefined => {
    const start = startTimes.get(request)
    if (start === undefined) return undefined
    startTimes.delete(request)
    httpRequestsInFlight.dec()
    return start
  }

  app.addHook('onRequest', async (request) => {
    startTimes.set(request, performance.now())
    httpRequestsInFlight.inc()
  })

  app.addHook('onResponse', async (request, reply) => {
    const start = settle(request)
    if (start === undefined) return
    const route = request.routeOptions?.url ?? '__unmatched__'
    httpRequestDuration.labels(request.method, route).observe((performance.now() - start) / 1000)
    httpRequestsTotal.labels(request.method, route, String(reply.statusCode)).inc()
  })

  app.addHook('onRequestAbort', async (request) => { settle(request) })
  app.addHook('onTimeout', async (request) => { settle(request) })
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/metrics.test.ts`
Expected: PASS (7 tests).

- [x] **Step 5: Commit**

```bash
git add src/metrics.ts test/metrics.test.ts
git commit -m "$(cat <<'EOF'
feat(metrics): RED hooks with idempotent in-flight settle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Metrics HTTP server + sampled gauges

Adds the bare `node:http` `/metrics` server and the async-`collect` gauges wired to injected live-count functions. Keeps `metrics.ts` free of any db/schema imports.

**Files:**
- Modify: `src/metrics.ts`
- Test: `test/metrics.test.ts` (extend)

**Interfaces:**
- Consumes: `register`.
- Produces:
  - `export function startMetricsServer(port: number): http.Server`
  - `export function registerSampledGauges(deps: { tenantsCount: () => number; tokensCount: () => Promise<number> }): void`

- [x] **Step 1: Write the failing test**

Append to `test/metrics.test.ts` — add `startMetricsServer, registerSampledGauges` to the import from `../src/metrics.js`, add two more imports, then add the suites:
```ts
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
```
```ts
describe('startMetricsServer', () => {
  it('serves GET /metrics and 404s everything else', async () => {
    const server = startMetricsServer(0)
    if (!server.listening) await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/metrics`)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toContain('text/plain')
      const other = await fetch(`http://127.0.0.1:${port}/nope`)
      expect(other.status).toBe(404)
    } finally {
      server.close()
    }
  })
})

describe('registerSampledGauges', () => {
  it('reads injected tenant and token counts at collect time', async () => {
    registerSampledGauges({ tenantsCount: () => 5, tokensCount: async () => 12 })
    expect(await readSeries('tenants')).toBe(5)
    expect(await readSeries('push_tokens')).toBe(12)
  })

  it('leaves the previous push_tokens value when the count query throws', async () => {
    let fail = false
    registerSampledGauges({
      tenantsCount: () => 1,
      tokensCount: async () => { if (fail) throw new Error('db down'); return 9 },
    })
    expect(await readSeries('push_tokens')).toBe(9)
    fail = true
    expect(await readSeries('push_tokens')).toBe(9) // retained: collect swallowed the error
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/metrics.test.ts`
Expected: FAIL — `startMetricsServer` / `registerSampledGauges` are not exported.

- [x] **Step 3: Write minimal implementation**

In `src/metrics.ts`, add to the top import block:
```ts
import http from 'node:http'
```

Add the sampled-gauge deps holder and gauge instances (next to the other instances). `collect` MUST be declared inside the constructor config — prom-client 15's `Gauge` class type has no assignable `collect` property, so a post-construction `gauge.collect = …` fails `tsc` (TS2339) even though Vitest (which transpiles without type-checking) would pass:
```ts
// Deps for the sampled gauges, injected at boot by registerSampledGauges().
// Mutable module state rather than constructor args: prom-client's Gauge type only
// accepts `collect` in the constructor config (it is not an assignable class property),
// but the count fns aren't known until index.ts has a db + registry.
let sampledDeps: { tenantsCount: () => number; tokensCount: () => Promise<number> } | undefined

const tenantsGauge = new Gauge({
  name: 'tenants',
  help: 'Number of tenants currently loaded in the registry.',
  registers: [register],
  collect() {
    if (sampledDeps) this.set(sampledDeps.tenantsCount())
  },
})
const pushTokensGauge = new Gauge({
  name: 'push_tokens',
  help: 'Number of rows in the push_tokens table (sampled at scrape).',
  registers: [register],
  async collect() {
    if (!sampledDeps) return
    try {
      this.set(await sampledDeps.tokensCount())
    } catch {
      // Leave the previous value on a transient DB error rather than blank the whole scrape.
    }
  },
})
```

Add the exported functions:
```ts
/** Serve ONLY GET /metrics on a bare http server, bound 0.0.0.0. No Fastify, no router label. */
export function startMetricsServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      try {
        const body = await register.metrics()
        res.writeHead(200, { 'Content-Type': register.contentType })
        res.end(body)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end(err instanceof Error ? err.message : String(err))
      }
      return
    }
    res.writeHead(404).end()
  })
  server.listen(port, '0.0.0.0')
  return server
}

/** Inject the live-count fns the sampled gauges' collect() callbacks read at each scrape. Call at boot; last call wins. */
export function registerSampledGauges(deps: {
  tenantsCount: () => number
  tokensCount: () => Promise<number>
}): void {
  sampledDeps = deps
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/metrics.test.ts`
Expected: PASS (10 tests).

- [x] **Step 5: Commit**

```bash
git add src/metrics.ts test/metrics.test.ts
git commit -m "$(cat <<'EOF'
feat(metrics): /metrics http server and sampled tenants/push_tokens gauges

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `env.ts` — `METRICS_PORT` + `GIT_COMMIT`

**Files:**
- Modify: `src/env.ts`
- Test: `test/env.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `env.METRICS_PORT: number` (default `9464`), `env.GIT_COMMIT: string` (default `'unknown'`).

- [x] **Step 1: Write the failing test**

Append to `test/env.test.ts`, inside the `describe('env schema', ...)` block:
```ts
  it('defaults METRICS_PORT to 9464 and GIT_COMMIT to "unknown"', () => {
    const parsed = schema.parse(base)
    expect(parsed.METRICS_PORT).toBe(9464)
    expect(parsed.GIT_COMMIT).toBe('unknown')
  })

  it('coerces METRICS_PORT from a string and reads GIT_COMMIT', () => {
    const parsed = schema.parse({ ...base, METRICS_PORT: '9500', GIT_COMMIT: 'abc123' })
    expect(parsed.METRICS_PORT).toBe(9500)
    expect(parsed.GIT_COMMIT).toBe('abc123')
  })
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/env.test.ts`
Expected: FAIL — `parsed.METRICS_PORT` is `undefined` (expected `9464`).

- [x] **Step 3: Write minimal implementation**

In `src/env.ts`, add two fields to the `z.object({ ... })` schema (place after the `SENTRY_ENVIRONMENT` line):
```ts
  METRICS_PORT: z.coerce.number().default(9464),
  GIT_COMMIT: z.string().default('unknown'),
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/env.test.ts`
Expected: PASS (all env tests).

- [x] **Step 5: Commit**

```bash
git add src/env.ts test/env.test.ts
git commit -m "$(cat <<'EOF'
feat(env): add METRICS_PORT and GIT_COMMIT

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `store.ts` — wrap queries in `dbTimed` + add `countTokens`; `db/client.ts` signpost

Wraps every token query call-site in `dbTimed` with its `DbOperation`, and adds the scrape-only `countTokens` (deliberately **not** wrapped — it is scrape-driven, not request work, and would pollute query-duration percentiles). Adds a signpost comment at the shared `db` export.

**DB-backed:** requires `TEST_DATABASE_URL` set + migrated (Vitest `globalSetup` handles migration).

**Files:**
- Modify: `src/store.ts`, `src/db/client.ts`
- Test: `test/store.test.ts` (extend)

**Interfaces:**
- Consumes: `dbTimed`, `DbOperation` (Task 1); `readSeries` from `test/helpers/metrics.ts` (Task 1).
- Produces: `export async function countTokens(db: Db): Promise<number>`. Existing signatures (`registerToken`, `removeToken`, `tokensForUsers`, `deleteByIds`) are unchanged.

- [x] **Step 1: Write the failing test**

In `test/store.test.ts`: add `countTokens` to the import from `../src/store.js`, add the metrics + helper imports, and add `register.resetMetrics()` to `beforeEach`. Concretely:

Change the store import line to:
```ts
import { registerToken, removeToken, tokensForUsers, deleteByIds, countTokens } from '../src/store.js'
import { register } from '../src/metrics.js'
import { readSeries } from './helpers/metrics.js'
```
Change `beforeEach` to:
```ts
beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE push_tokens`); register.resetMetrics() })
```
Add these tests inside `describe('token store', ...)`:
```ts
  it('times a store query under its db operation label', async () => {
    await registerToken(db, 'team-comm', 'u1', 't1', 'ios')
    expect(await readSeries('db_query_duration_seconds_count', { operation: 'register_token' })).toBe(1)
  })

  it('countTokens returns the row count as a number', async () => {
    await registerToken(db, 'team-comm', 'u1', 'a', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'b', 'ios')
    await registerToken(db, 'team-comm', 'u2', 'c', 'android')
    const n = await countTokens(db)
    expect(n).toBe(3)
    expect(typeof n).toBe('number')
  })
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/store.test.ts`
Expected: FAIL — `countTokens` is not exported, and `db_query_duration_seconds_count` has no series (queries aren't wrapped yet).

- [x] **Step 3: Write minimal implementation**

Replace the entire contents of `src/store.ts` with:
```ts
import { and, count, eq, inArray } from 'drizzle-orm'
import { pushTokens } from './db/schema.js'
import { dbTimed } from './metrics.js'

type Db = any // drizzle instance; kept loose so store fns work with the app db and the test db

export async function registerToken(db: Db, appSlug: string, userId: string, token: string, platform: 'ios' | 'android'): Promise<void> {
  await dbTimed('register_token', () =>
    db.insert(pushTokens)
      .values({ appSlug, userId, token, platform, lastSeenAt: new Date() })
      // conflict target is the (appSlug, token) unique constraint: a re-register within the same app reassigns the user;
      // the same token string under another app is a separate row (structural tenant isolation, never a cross-tenant evict)
      .onConflictDoUpdate({ target: [pushTokens.appSlug, pushTokens.token], set: { userId, platform, lastSeenAt: new Date() } }))
}

export async function removeToken(db: Db, appSlug: string, token: string): Promise<number> {
  // dbTimed<any[]>: db is `any`, so without the explicit type arg T infers `unknown`
  // and `deleted.length` fails tsc (TS18046). tokensForUsers doesn't need it — its
  // return-type annotation contextually types T. See Task 5 review.
  const deleted = await dbTimed<any[]>('remove_token', () =>
    db.delete(pushTokens)
      .where(and(eq(pushTokens.appSlug, appSlug), eq(pushTokens.token, token)))
      .returning())
  return deleted.length
}

export async function tokensForUsers(db: Db, appSlug: string, userIds: string[]): Promise<Array<{ id: string; token: string; platform: 'ios' | 'android'; userId: string }>> {
  if (userIds.length === 0) return []
  return dbTimed('tokens_for_users', () =>
    db.select({ id: pushTokens.id, token: pushTokens.token, platform: pushTokens.platform, userId: pushTokens.userId })
      .from(pushTokens)
      .where(and(eq(pushTokens.appSlug, appSlug), inArray(pushTokens.userId, userIds))))
}

export async function deleteByIds(db: Db, ids: string[]): Promise<void> {
  if (ids.length) await dbTimed('delete_tokens', () => db.delete(pushTokens).where(inArray(pushTokens.id, ids)))
}

// Scrape-only count for the push_tokens gauge — deliberately NOT dbTimed-wrapped (it is
// scrape-driven, not request work, and would pollute query-duration percentiles). Uses
// drizzle count(): it emits count(*) and maps the value with Number, sidestepping two
// postgres-js footguns (int8 arrives as a string; RowList carries its own .count metadata).
export async function countTokens(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(pushTokens)
  return Number(row.n)
}
```

- [x] **Step 4: Add the signpost comment in `db/client.ts`**

In `src/db/client.ts`, add a comment on the line immediately above `export const db = drizzle(client, { schema })`:
```ts
// Every query call-site must be wrapped in dbTimed(operation, …) — see src/metrics.ts (no driver-level duration hook exists).
export const db = drizzle(client, { schema })
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run test/store.test.ts`
Expected: PASS (all store tests, including the two new ones).

- [x] **Step 6: Commit**

```bash
git add src/store.ts src/db/client.ts test/store.test.ts
git commit -m "$(cat <<'EOF'
feat(store): dbTimed-wrap token queries and add countTokens

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `registry.ts` — wrap load / insert / update in `dbTimed`

**DB-backed:** requires `TEST_DATABASE_URL` set + migrated.

**Files:**
- Modify: `src/registry.ts`
- Test: `test/registry.test.ts` (extend)

**Interfaces:**
- Consumes: `dbTimed` (Task 1); `readSeries` from `test/helpers/metrics.ts` (Task 1). Uses operations `tenants_load`, `tenant_insert`, `tenant_update`.
- Produces: no signature changes.

- [x] **Step 1: Write the failing test**

In `test/registry.test.ts`: add `import { register } from '../src/metrics.js'` and `import { readSeries } from './helpers/metrics.js'`, add `register.resetMetrics()` to `beforeEach`, and three tests.

Change `beforeEach` to:
```ts
beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE tenants`); buildEngine.mockClear(); engines.length = 0; register.resetMetrics() })
```
Add these tests inside `describe('TenantRegistry', ...)`:
```ts
  it('times the insert under operation="tenant_insert"', async () => {
    await registry().register({ slug: 'team-comm', apns })
    expect(await readSeries('db_query_duration_seconds_count', { operation: 'tenant_insert' })).toBe(1)
  })

  it('times load under operation="tenants_load"', async () => {
    await registry().register({ slug: 'team-comm', apns })
    register.resetMetrics()
    await registry().load()
    expect(await readSeries('db_query_duration_seconds_count', { operation: 'tenants_load' })).toBe(1)
  })

  it('times updateCredentials under operation="tenant_update"', async () => {
    const r = registry()
    const { apiKey } = await r.register({ slug: 'team-comm', apns })
    const before = r.byKeyHash(hashKey(apiKey))!
    register.resetMetrics()
    await r.updateCredentials(before, { fcm: { projectId: 'p', clientEmail: 'e', privateKey: 'k' } })
    expect(await readSeries('db_query_duration_seconds_count', { operation: 'tenant_update' })).toBe(1)
  })
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/registry.test.ts`
Expected: FAIL — `db_query_duration_seconds_count` has no `tenant_insert`/`tenants_load`/`tenant_update` series (queries aren't wrapped yet).

- [x] **Step 3: Write minimal implementation**

In `src/registry.ts`:

Add to the imports at the top of the file:
```ts
import { dbTimed } from './metrics.js'
```

In `load()`, wrap the select. Replace:
```ts
    const rows = await this.db.select().from(tenants)
```
with:
```ts
    // dbTimed<any[]>: this.db is `any`; without the type arg T infers `unknown`
    // and the `for (const row of rows)` iteration fails tsc (same reason as
    // store.ts removeToken). insert/update below discard their result, so they don't need it.
    const rows = await dbTimed<any[]>('tenants_load', () => this.db.select().from(tenants))
```

In `register()`, wrap the insert. Replace:
```ts
      await this.db.insert(tenants).values({ slug: input.slug, apiKeyHash, credsEncrypted })
```
with:
```ts
      await dbTimed('tenant_insert', () => this.db.insert(tenants).values({ slug: input.slug, apiKeyHash, credsEncrypted }))
```

In `updateCredentials()`, wrap the update. Replace:
```ts
      await this.db.update(tenants).set({ credsEncrypted, updatedAt: new Date() }).where(eq(tenants.apiKeyHash, tenant.apiKeyHash))
```
with:
```ts
      await dbTimed('tenant_update', () => this.db.update(tenants).set({ credsEncrypted, updatedAt: new Date() }).where(eq(tenants.apiKeyHash, tenant.apiKeyHash)))
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/registry.test.ts`
Expected: PASS (all registry tests, including the three new ones). Note the existing "closes the engine it built when the UPDATE fails" test still passes: its `db.update` spy throws synchronously inside `dbTimed`'s `fn()`, which the `finally` settles and rethrows unchanged.

- [x] **Step 5: Commit**

```bash
git add src/registry.ts test/registry.test.ts
git commit -m "$(cat <<'EOF'
feat(registry): dbTimed-wrap tenants load/insert/update

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `app.ts` — install `registerHttpMetrics` in `buildApp`

**DB-backed:** `test/app.test.ts` requires `TEST_DATABASE_URL` set + migrated.

**Files:**
- Modify: `src/app.ts`
- Test: `test/app.test.ts` (extend)

**Interfaces:**
- Consumes: `registerHttpMetrics` (Task 2); `readSeries` from `test/helpers/metrics.ts` (Task 1).
- Produces: no signature changes; `buildApp` now records RED metrics for every request.

- [ ] **Step 1: Write the failing test**

In `test/app.test.ts`: add `import { register } from '../src/metrics.js'` and `import { readSeries } from './helpers/metrics.js'`, add `register.resetMetrics()` to `beforeEach`, and two new tests.

Change `beforeEach` to:
```ts
beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE push_tokens`); engine.send.mockReset(); register.resetMetrics() })
```
Add these tests inside `describe('buildApp', ...)`:
```ts
  it('records an http_requests_total series for a served route', async () => {
    const app = buildApp({ db, registry, enrollKey: 'test-enroll' })
    await app.inject({ method: 'GET', url: '/health' })
    expect(await readSeries('http_requests_total', { method: 'GET', route: '/health', status: '200' })).toBe(1)
    expect(await readSeries('http_requests_in_flight')).toBe(0)
  })

  it('labels an unmatched route __unmatched__, never the raw path', async () => {
    const app = buildApp({ db, registry, enrollKey: 'test-enroll' })
    await app.inject({ method: 'GET', url: '/nope' })
    expect(await readSeries('http_requests_total', { method: 'GET', route: '__unmatched__', status: '404' })).toBe(1)
    expect(await readSeries('http_requests_total', { route: '/nope' })).toBeUndefined()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/app.test.ts`
Expected: FAIL — `http_requests_total` has no series (hooks aren't installed yet).

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `src/app.ts` with:
```ts
import Fastify, { type FastifyInstance } from 'fastify'
import { TenantRegistry } from './registry.js'
import { tokenRoutes } from './routes/tokens.js'
import { sendRoutes } from './routes/send.js'
import { tenantRoutes } from './routes/tenants.js'
import { registerHttpMetrics } from './metrics.js'

export function buildApp(deps: { db: any; registry: TenantRegistry; enrollKey: string }): FastifyInstance {
  const app = Fastify({ logger: true })
  registerHttpMetrics(app)
  app.get('/health', async () => ({ ok: true }))
  tokenRoutes(app, deps)
  sendRoutes(app, deps)
  tenantRoutes(app, deps)
  return app
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/app.test.ts`
Expected: PASS (all app tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/app.ts test/app.test.ts
git commit -m "$(cat <<'EOF'
feat(app): install RED http metrics hooks in buildApp

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `routes/send.ts` — `recordSend` on success + batch-throw

Counts `push_sends_total` per engine `SendResult` on success, and — in the `catch` — one `error` per **attempted target** (its own provider), keeping the domain metric live during exactly the misconfig incidents where per-result counting goes blind. The empty-token early return increments nothing (it returns before `targets` is built).

**DB-backed:** `test/send.route.test.ts` requires `TEST_DATABASE_URL` set + migrated.

**Files:**
- Modify: `src/routes/send.ts`
- Test: `test/send.route.test.ts` (extend)

**Interfaces:**
- Consumes: `recordSend` (Task 1); `readSeries` from `test/helpers/metrics.ts` (Task 1).
- Produces: no signature changes.

- [ ] **Step 1: Write the failing test**

In `test/send.route.test.ts`: add `import { register } from '../src/metrics.js'` and `import { readSeries } from './helpers/metrics.js'`, add `register.resetMetrics()` to `beforeEach`, add one new test, and modify the existing "500 when the engine throws" test.

Change `beforeEach` to:
```ts
beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE push_tokens`); engine.send.mockReset(); register.resetMetrics() })
```
Add this new test inside `describe('POST /v1/send', ...)`:
```ts
  it('counts push_sends_total by result status and provider on success', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-tok', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'and-tok', 'android')
    engine.send.mockImplementation(async ({ tokens }: any) =>
      tokens.map((t: any) => ({ ref: t.ref, token: t.token, provider: t.provider, status: 'delivered' })))

    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    expect(await readSeries('push_sends_total', { status: 'delivered', provider: 'apns' })).toBe(1)
    expect(await readSeries('push_sends_total', { status: 'delivered', provider: 'fcm' })).toBe(1)
  })
```
Replace the existing test:
```ts
  it('500 when the engine throws (tenant misconfig)', async () => {
    await registerToken(db, 'team-comm', 'u1', 't', 'ios')
    engine.send.mockRejectedValueOnce(new Error('bad .p8'))
    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(500)
  })
```
with:
```ts
  it('500 when the engine throws, and counts one error per attempted target by provider', async () => {
    await registerToken(db, 'team-comm', 'u1', 't-ios', 'ios')
    await registerToken(db, 'team-comm', 'u1', 't-and', 'android')
    engine.send.mockRejectedValueOnce(new Error('bad .p8'))
    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(500)
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'apns' })).toBe(1)
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'fcm' })).toBe(1)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/send.route.test.ts`
Expected: FAIL — `push_sends_total` has no series (route doesn't call `recordSend` yet).

- [ ] **Step 3: Write minimal implementation**

In `src/routes/send.ts`:

Add to the imports at the top:
```ts
import { recordSend } from '../metrics.js'
```

In the `catch` block, add the per-target error counting as the first statement. Replace:
```ts
    } catch (err) {
      req.log.error({ err }, 'push-hub: engine send failed (tenant misconfig?)')
      Sentry.captureException(err, { tags: { tenant: req.tenant.slug } })
      return reply.code(500).send({ error: 'send failed' })
    }
```
with:
```ts
    } catch (err) {
      for (const t of targets) recordSend('error', t.provider) // domain metric stays live when per-result counting goes blind
      req.log.error({ err }, 'push-hub: engine send failed (tenant misconfig?)')
      Sentry.captureException(err, { tags: { tenant: req.tenant.slug } })
      return reply.code(500).send({ error: 'send failed' })
    }
```

Immediately after that `catch` block (before the `const rowById = ...` line), add the success counting:
```ts
    for (const r of results) recordSend(r.status, r.provider)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/send.route.test.ts`
Expected: PASS (all send-route tests, including the new + modified ones).

- [ ] **Step 5: Commit**

```bash
git add src/routes/send.ts test/send.route.test.ts
git commit -m "$(cat <<'EOF'
feat(send): record push_sends_total on success and batch-throw

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `index.ts` — boot wiring (build info, sampled gauges, metrics server)

Wires the boot-time calls. `version` comes from `package.json` via `createRequire`; `commit` from `env.GIT_COMMIT`. `registerSampledGauges` is fed `registry.size` and `countTokens(db)` so `metrics.ts` stays free of db/schema imports. This file runs a top-level `await app.listen(...)` and needs a live DB + full env, so it is verified by the type/build check, not a unit test.

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `setBuildInfo`, `registerSampledGauges`, `startMetricsServer` (Tasks 1, 3); `countTokens` (Task 5); `env.METRICS_PORT`, `env.GIT_COMMIT` (Task 4); `registry.size` (existing).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the implementation**

Replace the entire contents of `src/index.ts` with:
```ts
import { createRequire } from 'node:module'
import * as Sentry from '@sentry/node'
import { env } from './env.js'
import { db } from './db/client.js'
import { TenantRegistry } from './registry.js'
import { buildApp } from './app.js'
import { setBuildInfo, registerSampledGauges, startMetricsServer } from './metrics.js'
import { countTokens } from './store.js'

if (env.GLITCHTIP_DSN)
  Sentry.init({
    dsn: env.GLITCHTIP_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    // Tenant-route request bodies ARE plaintext provider creds (APNs .p8 / FCM key).
    // Never let a 5xx ship them to GlitchTip — creds-at-rest is the whole point.
    integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' })],
  })

const registry = new TenantRegistry({ db, credKey: env.PUSH_HUB_CRED_KEY })
await registry.load() // decrypts + builds every tenant; throws → deploy fails loud on a wrong cred key
const app = buildApp({ db, registry, enrollKey: env.PUSH_HUB_ENROLL_KEY })
if (env.GLITCHTIP_DSN) Sentry.setupFastifyErrorHandler(app)

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }
setBuildInfo({ version, commit: env.GIT_COMMIT })
registerSampledGauges({ tenantsCount: () => registry.size, tokensCount: () => countTokens(db) })
startMetricsServer(env.METRICS_PORT)

await app.listen({ port: env.PORT, host: '0.0.0.0' })
console.log(`push-hub listening on ${env.PORT} (metrics on ${env.METRICS_PORT}) with ${registry.size} tenant(s)`)
```

- [ ] **Step 2: Verify the build type-checks**

Run: `pnpm build`
Expected: `tsc` exits 0 with no output (clean compile; `dist/` is produced). `createRequire('../package.json')` is a runtime `require`, so no `resolveJsonModule` is needed.

- [ ] **Step 3: Run the full unit-test suite (no DB env) to confirm nothing broke at import time**

Run: `pnpm exec vitest run test/metrics.test.ts test/env.test.ts`
Expected: PASS. (These files don't need a DB; they confirm `metrics.ts` + `env.ts` still import cleanly after the wiring.)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat(index): wire build info, sampled gauges, and metrics server at boot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Build & config — Dockerfile, deploy workflow, `.env.example`, repo compose

Additive build/config changes: pass `GIT_COMMIT` into the image, expose `9464`, document the port, and reconcile the repo compose file (add the metrics port + `prometheus.io/*` discovery labels, and fix the external network name to `apps_internal`). No VPS files are touched.

**Files:**
- Modify: `Dockerfile`, `.github/workflows/deploy.yml`, `.env.example`, `docker-compose.yml`

**Interfaces:**
- Consumes: `env.METRICS_PORT`/`GIT_COMMIT` (Task 4) at runtime.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Dockerfile — GIT_COMMIT build arg + expose 9464**

In `Dockerfile`, replace:
```dockerfile
RUN pnpm build

EXPOSE 3000
```
with:
```dockerfile
RUN pnpm build

# GIT_COMMIT is set AFTER build so a changing SHA never busts the install/build cache layers.
ARG GIT_COMMIT
ENV GIT_COMMIT=$GIT_COMMIT

EXPOSE 3000 9464
```

- [ ] **Step 2: deploy.yml — pass the SHA as a build arg**

In `.github/workflows/deploy.yml`, in the `Build and push image` step's `with:` block, add a `build-args` line above `tags`. Replace:
```yaml
        with:
          context: .
          push: true
          provenance: false
          tags: ghcr.io/tayl0r/push-hub:${{ env.IMAGE_TAG }}
```
with:
```yaml
        with:
          context: .
          push: true
          provenance: false
          build-args: GIT_COMMIT=${{ github.sha }}
          tags: ghcr.io/tayl0r/push-hub:${{ env.IMAGE_TAG }}
```

- [ ] **Step 3: .env.example — document the port**

In `.env.example`, replace the line:
```bash
PORT=3000
```
with:
```bash
PORT=3000

# Internal-only Prometheus metrics port (GET /metrics). Optional; defaults to 9464.
METRICS_PORT=9464
```

- [ ] **Step 4: docker-compose.yml — expose + labels + network name**

Replace the entire contents of `docker-compose.yml` with:
```yaml
services:
  push-hub:
    image: ghcr.io/tayl0r/push-hub:prod # use :dev in the dev deploy directory
    env_file: .env
    restart: unless-stopped
    expose:
      - "3000"
      - "9464"
    labels:
      - prometheus.io/scrape=true
      - prometheus.io/port=9464
    networks:
      - internal

# `internal` is the shared Docker network the host's other services reach
# push-hub on (service name push-hub, port 3000) — created out-of-band on the
# host as `apps_internal`, not managed by this file. push-hub isn't exposed to
# the public internet by default: /v1/send can push to any of a tenant's users,
# so only apps already on this network can reach it. If an app outside this
# host needs to call push-hub directly, add a reverse-proxy/router config and
# a public domain for it in the host-side deploy config — not here.
networks:
  internal:
    name: apps_internal
    external: true
```

- [ ] **Step 5: Verify the compose file parses and renders the new discovery labels + network name**

Run (copies the file to the scratchpad with an empty `.env` so `docker compose config` can resolve `env_file:` without a real secrets file):
```bash
SCRATCH="$(dirname "$(mktemp -u)")/pushhub-compose-check"; mkdir -p "$SCRATCH"; : > "$SCRATCH/.env"; cp docker-compose.yml "$SCRATCH/dc.yml"; docker compose -f "$SCRATCH/dc.yml" config
```
Expected: valid rendered YAML containing:
- `expose:` list with both `"3000"` and `"9464"`,
- `labels:` with `prometheus.io/scrape: "true"` and `prometheus.io/port: "9464"`,
- under `networks: internal:` → `name: apps_internal` and `external: true`.

- [ ] **Step 6: Verify the Dockerfile / workflow / env edits landed**

Run:
```bash
grep -n 'ARG GIT_COMMIT' Dockerfile && grep -n 'EXPOSE 3000 9464' Dockerfile && grep -n 'GIT_COMMIT=${{ github.sha }}' .github/workflows/deploy.yml && grep -n 'METRICS_PORT=9464' .env.example
```
Expected: one matching line printed for each of the four greps (exit 0).

- [ ] **Step 7: Commit**

```bash
git add Dockerfile .github/workflows/deploy.yml .env.example docker-compose.yml
git commit -m "$(cat <<'EOF'
build: pass GIT_COMMIT, expose 9464, add prometheus discovery labels

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Full suite green.** With `TEST_DATABASE_URL` set to a reachable, migrated Postgres:

Run: `pnpm test`
Expected: all suites PASS (metrics, env, store, registry, app, send.route, plus the pre-existing auth/crypto/engine/tokens/tenants suites).

- [ ] **Type/build clean.**

Run: `pnpm build`
Expected: `tsc` exits 0, `dist/` produced.

---

## Self-Review

**1. Spec coverage** — every design section maps to a task:

- Architecture / `src/metrics.ts` exports: `register` + `collectDefaultMetrics` (T1); `startMetricsServer` (T3); `registerHttpMetrics` + `settle` (T2); `dbTimed` + `DbOperation` (T1); `recordSend` (T1); `setBuildInfo` (T1); `registerSampledGauges` (T3). ✓
- Wiring points: `index.ts` (T9), `app.ts` (T7), `store.ts` + `registry.ts` (T5, T6), `db/client.ts` signpost (T5), `routes/send.ts` (T8). ✓
- Metrics tables — RED (`http_requests_total`/`_duration`/`_in_flight`, `app_build_info`): T2 + T1. DB (`db_query_duration_seconds`, `db_queries_in_flight`): T1 + T5/T6. Domain (`push_sends_total`, `tenants`, `push_tokens`): T1/T8 + T3. ✓
- `app_build_info` = `{version, commit}` only (no `environment`): Global Constraints + T1 test asserts the two labels. ✓
- `DbOperation` bounded 7-value union: T1 (`type` + tests use `register_token`/`remove_token`), exercised across T5 (`register_token`, `remove_token`, `tokens_for_users`, `delete_tokens`) and T6 (`tenants_load`, `tenant_insert`, `tenant_update`). ✓
- `push_tokens` via drizzle `count()` in `store.countTokens`, not `dbTimed`-wrapped, `Number(...)` guard: T5. ✓
- Sampled gauges async `collect` declared in the `Gauge` constructor config (not post-construction — a `tsc` break Vitest wouldn't catch), `push_tokens` swallows DB error, `registerSampledGauges` sets a mutable `sampledDeps`: T3 (impl + both tests) + Global Constraints. ✓
- Domain placement: success per `SendResult`, batch-throw per attempted target with its own provider, empty early-return counts nothing: T8. ✓
- Cardinality: `route` = `routeOptions.url` / `__unmatched__` (T7 asserts the `__unmatched__` fallback via `/nope`); fixed enums; never tenant/user/token/path: Global Constraints + T2 impl + T7 test. ✓
- RED hook completeness: `onRequest`/`onResponse`/`onRequestAbort`/`onTimeout`, idempotent `settle`, both abort-then-response and timeout-then-response orderings tested: T2. ✓
- Config/build: `prom-client ^15.1.3` via `pnpm add` (T1); `METRICS_PORT`/`GIT_COMMIT` env (T4); Dockerfile `ARG/ENV GIT_COMMIT` after build + `EXPOSE 3000 9464` (T10); `deploy.yml` `build-args` (T10); `.env.example` (T10). ✓
- Compose "new form": repo `docker-compose.yml` gets `expose 9464` + `prometheus.io/*` labels (list form) + `name: apps_internal`, NO aliases (T10). VPS files excluded per scope. ✓
- Testing: `test/metrics.test.ts` (T1–3) + shared `test/helpers/metrics.ts` (T1), extend `app`/`store`/`send.route` (T7/T5/T8), plus `registry` (T6) and `env` (T4); `resetMetrics()` + absolute assertions + port 0 (Global Constraints, applied in each test). ✓
- Deploy & verify + Follow-ups: correctly OUT of scope — no tasks, per the scope boundary. ✓

**2. Placeholder scan** — no `TODO`/`TBD`/"similar to"/"add error handling"; every code step shows complete code; every run step states an expected result. ✓

**3. Type consistency** — helper names/signatures are stable across tasks: `register`, `recordSend(status, provider)`, `dbTimed(operation, fn)`, `setBuildInfo({version, commit})`, `registerHttpMetrics(app)`, `startMetricsServer(port)`, `registerSampledGauges({tenantsCount, tokensCount})`, `countTokens(db)`. The `readSeries` test helper is defined once in `test/helpers/metrics.ts` (base-name strip + `metricName ?? name` match) and imported by every test file that asserts series values. `DbOperation` literals used in tests (`register_token`, `remove_token`, `tenant_insert`, `tenants_load`, `tenant_update`) are all members of the T1 union. ✓
