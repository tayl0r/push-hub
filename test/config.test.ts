import { describe, it, expect, vi } from 'vitest'

const created: any[] = []
vi.mock('@tsteil/push-service', () => ({
  createPushService: (cfg: any) => { created.push(cfg); return { send: vi.fn() } },
}))

import { loadTenants } from '../src/config.js'

describe('loadTenants', () => {
  it('builds one tenant+engine per entry, keyed by apiKeyHash', () => {
    const map = loadTenants(JSON.stringify([
      { slug: 'team-comm', apiKeyHash: 'h1', apns: { keyId: 'k' } },
      { slug: 'setpiece', apiKeyHash: 'h2', fcm: { projectId: 'p' } },
    ]))
    expect(map.size).toBe(2)
    expect(map.get('h1')!.slug).toBe('team-comm')
    expect(created).toHaveLength(2)
  })
  it('throws on a tenant missing slug or apiKeyHash', () => {
    expect(() => loadTenants(JSON.stringify([{ slug: 'x' }]))).toThrow()
  })
  it('throws on a tenant with neither apns nor fcm', () => {
    expect(() => loadTenants(JSON.stringify([{ slug: 'x', apiKeyHash: 'h' }]))).toThrow()
  })
})
