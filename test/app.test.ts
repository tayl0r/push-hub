import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../src/db/schema.js'
import { hashKey } from '../src/auth.js'
import { buildApp } from '../src/app.js'

const client = postgres(process.env.TEST_DATABASE_URL!)
const db = drizzle(client, { schema })
const engine = { send: vi.fn() }
const tenant = { slug: 'team-comm', apiKeyHash: hashKey('key'), engine } as any
const tenants = new Map([[tenant.apiKeyHash, tenant]])

beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE push_tokens`); engine.send.mockReset() })
afterAll(async () => { await client.end() })

describe('buildApp', () => {
  it('GET /health returns 200 { ok: true }', async () => {
    const app = buildApp({ db, tenants })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('registers a device then sends it a push end-to-end', async () => {
    const app = buildApp({ db, tenants })

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
})
