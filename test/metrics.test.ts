import { describe, it, expect, beforeEach } from 'vitest'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { register, recordSend, setBuildInfo, dbTimed, registerHttpMetrics, startMetricsServer, registerSampledGauges } from '../src/metrics.js'
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
