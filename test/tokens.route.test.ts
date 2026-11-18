import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Fastify from 'fastify'
import { sql } from 'drizzle-orm'
import { hashKey } from '../src/auth.js'
import { tokensForUsers } from '../src/store.js'
import { tokenRoutes } from '../src/routes/tokens.js'
import type { Tenant, TenantLookup } from '../src/registry.js'
import { testDb } from './helpers/db.js'

const db = testDb()
beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE push_tokens`) })
afterAll(async () => { await db.$client.end() })

const tenant: Tenant = { slug: 'team-comm', apiKeyHash: hashKey('secret-key'), engine: { send: vi.fn(), close: vi.fn() } as any }
const registry: TenantLookup = { byKeyHash: (h) => (h === tenant.apiKeyHash ? tenant : undefined) }

function appWith() {
  const app = Fastify()
  tokenRoutes(app, { db, registry })
  return app
}

describe('token routes', () => {
  it('POST /v1/tokens with a valid key registers a row', async () => {
    const res = await appWith().inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer secret-key' },
      payload: { userId: 'u1', token: 't-ios', platform: 'ios' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const rows = await tokensForUsers(db, 'team-comm', ['u1'])
    expect(rows.map(r => r.token)).toEqual(['t-ios'])
  })

  it('POST /v1/tokens with a body missing token returns 400', async () => {
    const res = await appWith().inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer secret-key' },
      payload: { userId: 'u1', platform: 'ios' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /v1/tokens with no Authorization header returns 401', async () => {
    const res = await appWith().inject({
      method: 'POST',
      url: '/v1/tokens',
      payload: { userId: 'u1', token: 't-ios', platform: 'ios' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('DELETE /v1/tokens removes a previously registered token', async () => {
    const app = appWith()
    await app.inject({
      method: 'POST',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer secret-key' },
      payload: { userId: 'u1', token: 't-ios', platform: 'ios' },
    })

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/tokens',
      headers: { authorization: 'Bearer secret-key' },
      payload: { token: 't-ios' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, deleted: 1 })

    const rows = await tokensForUsers(db, 'team-comm', ['u1'])
    expect(rows).toEqual([])
  })
})
