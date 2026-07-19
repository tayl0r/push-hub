import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { hashKey, requireTenant } from '../src/auth.js'

const tenant = { slug: 'team-comm', apiKeyHash: hashKey('secret-key'), engine: { send: vi.fn() } as any }
const tenants = new Map([[tenant.apiKeyHash, tenant]])

function appWith() {
  const app = Fastify()
  app.get('/x', { preHandler: requireTenant(tenants) }, async (req) => ({ slug: (req as any).tenant.slug }))
  return app
}

describe('requireTenant', () => {
  it('401 without a bearer token', async () => {
    const res = await appWith().inject({ method: 'GET', url: '/x' })
    expect(res.statusCode).toBe(401)
  })
  it('401 on an unknown key', async () => {
    const res = await appWith().inject({ method: 'GET', url: '/x', headers: { authorization: 'Bearer nope' } })
    expect(res.statusCode).toBe(401)
  })
  it('401 on a blank bearer token', async () => {
    const res = await appWith().inject({ method: 'GET', url: '/x', headers: { authorization: 'Bearer ' } })
    expect(res.statusCode).toBe(401)
  })
  it('resolves the tenant on a valid key', async () => {
    const res = await appWith().inject({ method: 'GET', url: '/x', headers: { authorization: 'Bearer secret-key' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ slug: 'team-comm' })
  })
  it('accepts a case-insensitive bearer scheme', async () => {
    const res = await appWith().inject({ method: 'GET', url: '/x', headers: { authorization: 'bearer secret-key' } })
    expect(res.statusCode).toBe(200)
  })
})
