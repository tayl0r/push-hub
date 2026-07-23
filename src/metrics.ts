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
