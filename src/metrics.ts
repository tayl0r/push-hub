import http from 'node:http'
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client'
import type { FastifyInstance, FastifyRequest } from 'fastify'

// Module-global, dedicated registry. Vitest re-instantiates this module per test file,
// so cross-file metric state is a non-issue; within a file, a shared setupFiles hook (test/setup.ts) resets values before every test.
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

// ---- Sampled gauges ----
// Deps for the sampled gauges, injected at boot by registerSampledGauges().
// Mutable module state rather than constructor args: prom-client's Gauge type only
// accepts `collect` in the constructor config (it is not an assignable class property),
// but the count fns aren't known until index.ts has a db + registry.
let sampledDeps: { tenantsCount: () => number; tokensCount: () => Promise<number> } | undefined

// Registry.metrics() awaits every metric's collect() under ONE Promise.all, so a single
// sampled collect that throws 500s the entire scrape and one that hangs stalls it
// (process + RED metrics included). Every sampled collect must therefore swallow errors
// and bound its wait, degrading to the gauge's previous value — never the whole payload.
export const SCRAPE_SAMPLE_TIMEOUT_MS = 2000

/** Race `promise` against a timeout. The loser is not cancelled, but both of its settle
 * paths stay handled, so a late result or rejection is dropped without an unhandledRejection. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

const tenantsGauge = new Gauge({
  name: 'tenants',
  help: 'Number of tenants currently loaded in the registry.',
  registers: [register],
  collect() {
    if (!sampledDeps) return
    try {
      this.set(sampledDeps.tenantsCount())
    } catch {
      // Keep the previous value — see the Promise.all note above.
    }
  },
})
const pushTokensGauge = new Gauge({
  name: 'push_tokens',
  help: 'Number of rows in the push_tokens table (sampled at scrape).',
  registers: [register],
  async collect() {
    if (!sampledDeps) return
    try {
      this.set(await withTimeout(sampledDeps.tokensCount(), SCRAPE_SAMPLE_TIMEOUT_MS))
    } catch {
      // Transient DB error OR hung query: keep the previous value — see the note above.
    }
  },
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

/** Serve ONLY GET /metrics on a bare http server at the supplied host. No Fastify, no router label. */
export function startMetricsServer(port: number, host: string): http.Server {
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
  // Metrics is a side-channel: a bind failure (e.g. EADDRINUSE) must degrade metrics —
  // Prometheus's `up == 0` on this target is the alert — never crash the API. Without a
  // listener, Node re-throws the 'error' emit as an uncaught exception and kills the process.
  server.on('error', (err) => {
    console.error(`metrics server error (port ${port}); metrics disabled:`, err)
  })
  server.listen(port, host)
  return server
}

/** Inject the live-count fns the sampled gauges' collect() callbacks read at each scrape. Call at boot; last call wins. */
export function registerSampledGauges(deps: {
  tenantsCount: () => number
  tokensCount: () => Promise<number>
}): void {
  sampledDeps = deps
}
