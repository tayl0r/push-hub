import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { sql, eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { tenants } from '../src/db/schema.js'
import { decrypt } from '../src/crypto.js'
import { TenantRegistry } from '../src/registry.js'
import { tenantRoutes } from '../src/routes/tenants.js'
import { tokenRoutes } from '../src/routes/tokens.js'
import { testDb } from './helpers/db.js'

const db = testDb()
const credKey = randomBytes(32)
const ENROLL = 'enroll-secret'
const buildEngine = vi.fn(() => ({ send: vi.fn(), close: vi.fn(async () => {}) }))

async function appWith() {
  const registry = new TenantRegistry({ db, credKey, buildEngine })
  await registry.load()
  const app = Fastify()
  tenantRoutes(app, { registry, enrollKey: ENROLL })
  tokenRoutes(app, { db, registry }) // to prove the issued key works on the data plane
  return app
}

const apns = { keyId: 'K', teamId: 'T', bundleId: 'com.x.y', signingKey: 'sk', production: true }
const fcm = { projectId: 'p', clientEmail: 'e', privateKey: 'k' }
const enroll = { authorization: `Bearer ${ENROLL}` }

beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE tenants, push_tokens`); buildEngine.mockClear() })

describe('POST /v1/tenants', () => {
  it('registers with the enroll key; the returned key then authenticates on the data plane', async () => {
    const app = await appWith()
    const res = await app.inject({ method: 'POST', url: '/v1/tenants', headers: enroll, payload: { slug: 'team-comm', apns } })
    expect(res.statusCode).toBe(201)
    const { slug, apiKey } = res.json()
    expect(slug).toBe('team-comm')
    const reg = await app.inject({
      method: 'POST', url: '/v1/tokens',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { userId: 'u1', token: 'tok', platform: 'ios' },
    })
    expect(reg.statusCode).toBe(200) // hot-add: fresh key works immediately
  })

  it('401 with a missing or wrong enroll key', async () => {
    const app = await appWith()
    expect((await app.inject({ method: 'POST', url: '/v1/tenants', payload: { slug: 's', apns } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/v1/tenants', headers: { authorization: 'Bearer wrong' }, payload: { slug: 's', apns } })).statusCode).toBe(401)
  })

  it('401 when a valid tenant key is used to enroll (planes are separate)', async () => {
    const app = await appWith()
    const first = await app.inject({ method: 'POST', url: '/v1/tenants', headers: enroll, payload: { slug: 'team-comm', apns } })
    const { apiKey } = first.json()
    const res = await app.inject({ method: 'POST', url: '/v1/tenants', headers: { authorization: `Bearer ${apiKey}` }, payload: { slug: 'other', apns } })
    expect(res.statusCode).toBe(401)
  })

  it('409 on a taken slug', async () => {
    const app = await appWith()
    await app.inject({ method: 'POST', url: '/v1/tenants', headers: enroll, payload: { slug: 'dup', apns } })
    expect((await app.inject({ method: 'POST', url: '/v1/tenants', headers: enroll, payload: { slug: 'dup', apns } })).statusCode).toBe(409)
  })

  it('400 on a bad body or zero providers', async () => {
    const app = await appWith()
    expect((await app.inject({ method: 'POST', url: '/v1/tenants', headers: enroll, payload: { slug: '' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/v1/tenants', headers: enroll, payload: { slug: 'noprov' } })).statusCode).toBe(400)
  })
})

describe('POST /v1/tenants — slug validation (RFC 1123 / DNS-1123 label)', () => {
  it.each(['team-comm', 'a', 'app-123'])('accepts a valid DNS-1123 label slug: %j', async (slug) => {
    const app = await appWith()
    const res = await app.inject({ method: 'POST', url: '/v1/tenants', headers: enroll, payload: { slug, apns } })
    expect(res.statusCode).toBe(201)
    expect(res.json().slug).toBe(slug)
  })

  it.each([
    ['Team-Comm', 'uppercase'],
    ['a b', 'space'],
    ['a/../b', 'slash/traversal'],
    ['-lead', 'leading hyphen'],
    ['trail-', 'trailing hyphen'],
    ['a'.repeat(64), 'too long (64 chars)'],
    ['', 'empty'],
  ])('rejects %j (%s) with 400 and writes no tenant row', async (slug) => {
    const app = await appWith()
    const res = await app.inject({ method: 'POST', url: '/v1/tenants', headers: enroll, payload: { slug, apns } })
    expect(res.statusCode).toBe(400)
    const rows = await db.select().from(tenants)
    expect(rows.length).toBe(0) // the registry was never called — rejected by zod before it could write
  })
})

describe('PUT /v1/tenant/credentials', () => {
  async function register(app: any, slug: string, payload: any) {
    const res = await app.inject({ method: 'POST', url: '/v1/tenants', headers: enroll, payload: { slug, ...payload } })
    return res.json().apiKey as string
  }

  it('updates its own creds (200) and is a full replacement — dropping a provider', async () => {
    const app = await appWith()
    const apiKey = await register(app, 'team-comm', { apns, fcm }) // dual-provider tenant
    const res = await app.inject({
      method: 'PUT', url: '/v1/tenant/credentials',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { fcm: { projectId: 'p2', clientEmail: 'e2', privateKey: 'k2' } }, // fcm only
    })
    expect(res.statusCode).toBe(200)
    const [row] = await db.select().from(tenants)
    const stored = JSON.parse(decrypt(credKey, row.credsEncrypted))
    expect(stored.apns).toBeUndefined() // replacement dropped apns
    expect(stored.fcm.projectId).toBe('p2')
  })

  it('a tenant key only ever updates its own tenant (cross-tenant isolation)', async () => {
    const app = await appWith()
    const keyA = await register(app, 'a', { apns })
    await register(app, 'b', { apns })
    const [bBefore] = await db.select().from(tenants).where(eq(tenants.slug, 'b'))
    await app.inject({ method: 'PUT', url: '/v1/tenant/credentials', headers: { authorization: `Bearer ${keyA}` }, payload: { fcm } })
    const [bAfter] = await db.select().from(tenants).where(eq(tenants.slug, 'b'))
    expect(bAfter.credsEncrypted).toBe(bBefore.credsEncrypted) // B untouched by A's update
  })

  it('400 when the update body has zero providers', async () => {
    const app = await appWith()
    const apiKey = await register(app, 'team-comm', { apns })
    const res = await app.inject({ method: 'PUT', url: '/v1/tenant/credentials', headers: { authorization: `Bearer ${apiKey}` }, payload: {} })
    expect(res.statusCode).toBe(400) // updateCredentials → buildOrThrow rejects zero providers → InvalidCreds → 400
  })

  it('401 with a wrong or missing tenant key', async () => {
    const app = await appWith()
    expect((await app.inject({ method: 'PUT', url: '/v1/tenant/credentials', payload: { fcm } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PUT', url: '/v1/tenant/credentials', headers: { authorization: 'Bearer nope' }, payload: { fcm } })).statusCode).toBe(401)
  })
})
