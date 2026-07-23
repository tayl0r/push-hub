import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../src/db/schema.js'
import { hashKey } from '../src/auth.js'
import { buildApp } from '../src/app.js'
import { register } from '../src/metrics.js'
import { readSeries } from './helpers/metrics.js'
import type { TenantRegistry } from '../src/registry.js'

const client = postgres(process.env.TEST_DATABASE_URL!)
const db = drizzle(client, { schema })
const engine = { send: vi.fn(), close: vi.fn() }
const tenant = { slug: 'team-comm', apiKeyHash: hashKey('key'), engine } as any
// the tenant stub only needs byKeyHash for these data-plane tests; buildApp demands a
// TenantRegistry for tenantRoutes, which these tests never exercise — so cast it.
const registry = { byKeyHash: (h: string) => (h === tenant.apiKeyHash ? tenant : undefined) } as unknown as TenantRegistry

beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE push_tokens`); engine.send.mockReset(); register.resetMetrics() })
afterAll(async () => { await client.end() })

describe('buildApp', () => {
  it('GET /health returns 200 { ok: true }', async () => {
    const app = buildApp({ db, registry, enrollKey: 'test-enroll' })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('registers a device then sends it a push end-to-end', async () => {
    const app = buildApp({ db, registry, enrollKey: 'test-enroll' })

    const register = await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer key' },
      payload: { userId: 'u1', token: 'ios-tok', platform: 'ios' },
    })
    expect(register.statusCode).toBe(200)

    engine.send.mockResolvedValueOnce([{ ref: 'whatever', token: 'ios-tok', provider: 'apns', status: 'delivered' }])

    const send = await app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: 'Bearer key' },
      payload: { to: 'u1', title: 'Hi', body: 'there' },
    })
    expect(send.statusCode).toBe(200)
    const { data } = send.json()
    expect(data[0].status).toBe('ok')
  })

  // new test — proves buildApp registered the enrollment route (regression guard for Step 1):
  it('wires the enrollment route (POST /v1/tenants is registered)', async () => {
    const app = buildApp({ db, registry, enrollKey: 'test-enroll' })
    const res = await app.inject({ method: 'POST', url: '/v1/tenants', payload: { slug: 's' } })
    expect(res.statusCode).toBe(401) // enroll-key preHandler rejects; a 404 would mean the route is missing
  })

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
})
