import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { hashKey, requireTenant, requireEnrollKey } from '../src/auth.js'
import type { Tenant, TenantLookup } from '../src/registry.js'

const tenant: Tenant = { slug: 'team-comm', apiKeyHash: hashKey('secret-key'), engine: { send: vi.fn(), close: vi.fn() } as any }
const lookup: TenantLookup = { byKeyHash: (h) => (h === tenant.apiKeyHash ? tenant : undefined) }

function tenantApp() {
  const app = Fastify()
  app.get('/x', { preHandler: requireTenant(lookup) }, async (req) => ({ slug: (req as any).tenant.slug }))
  return app
}
function enrollApp() {
  const app = Fastify()
  app.post('/e', { preHandler: requireEnrollKey('enroll-secret') }, async () => ({ ok: true }))
  return app
}

describe('requireTenant', () => {
  it('401 without a bearer token', async () => {
    expect((await tenantApp().inject({ method: 'GET', url: '/x' })).statusCode).toBe(401)
  })
  it('401 on an unknown key', async () => {
    expect((await tenantApp().inject({ method: 'GET', url: '/x', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401)
  })
  it('401 on a blank bearer token', async () => {
    expect((await tenantApp().inject({ method: 'GET', url: '/x', headers: { authorization: 'Bearer ' } })).statusCode).toBe(401)
  })
  it('resolves the tenant on a valid key', async () => {
    const res = await tenantApp().inject({ method: 'GET', url: '/x', headers: { authorization: 'Bearer secret-key' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ slug: 'team-comm' })
  })
  it('accepts a case-insensitive bearer scheme', async () => {
    expect((await tenantApp().inject({ method: 'GET', url: '/x', headers: { authorization: 'bearer secret-key' } })).statusCode).toBe(200)
  })
})

describe('requireEnrollKey', () => {
  it('200 with the correct enroll key', async () => {
    expect((await enrollApp().inject({ method: 'POST', url: '/e', headers: { authorization: 'Bearer enroll-secret' } })).statusCode).toBe(200)
  })
  it('401 with a wrong enroll key', async () => {
    expect((await enrollApp().inject({ method: 'POST', url: '/e', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401)
  })
  it('401 with no key', async () => {
    expect((await enrollApp().inject({ method: 'POST', url: '/e' })).statusCode).toBe(401)
  })
  it('401 with a blank enroll token', async () => {
    expect((await enrollApp().inject({ method: 'POST', url: '/e', headers: { authorization: 'Bearer ' } })).statusCode).toBe(401)
  })
})
