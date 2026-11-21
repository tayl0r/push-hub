import { describe, it, expect, vi } from 'vitest'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { recordSend, setBuildInfo, dbTimed, registerHttpMetrics, startMetricsServer, registerSampledGauges, SCRAPE_SAMPLE_TIMEOUT_MS } from '../src/metrics.js'
import { readSeries } from './helpers/metrics.js'

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
    const host = '127.0.0.1'
    const server = startMetricsServer(0, host)
    if (!server.listening) await once(server, 'listening')
    const { address, port } = server.address() as AddressInfo
    try {
      expect(address).toBe(host)
      const ok = await fetch(`http://${host}:${port}/metrics`)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toContain('text/plain')
      const other = await fetch(`http://${host}:${port}/nope`)
      expect(other.status).toBe(404)
    } finally {
      server.close()
    }
  })

  it('logs and survives a bind failure instead of crashing the process', async () => {
    const blocker = http.createServer(() => {})
    blocker.listen(0, '0.0.0.0') // same wildcard address as startMetricsServer -> EADDRINUSE is deterministic cross-platform
    await once(blocker, 'listening')
    const { port } = blocker.address() as AddressInfo
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Deliberately NO test-side 'error' listener: attaching one would itself prevent the
    // crash and make this test pass against unfixed code.
    const server = startMetricsServer(port, '0.0.0.0')
    try {
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledOnce())
      expect(server.listening).toBe(false)
    } finally {
      errorSpy.mockRestore()
      server.close()
      blocker.close()
      await once(blocker, 'close')
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

  it('degrades to the previous value when the count query hangs, instead of stalling the scrape', async () => {
    vi.useFakeTimers()
    try {
      let hang = false
      registerSampledGauges({
        tenantsCount: () => 1,
        tokensCount: () => (hang ? new Promise<number>(() => {}) : Promise.resolve(7)),
      })
      expect(await readSeries('push_tokens')).toBe(7)
      hang = true
      const read = readSeries('push_tokens') // starts collect(); withTimeout schedules its (fake) timer synchronously
      await vi.advanceTimersByTimeAsync(SCRAPE_SAMPLE_TIMEOUT_MS)
      expect(await read).toBe(7) // timed out -> previous value retained, scrape read settled (no hang)
    } finally {
      vi.useRealTimers()
      registerSampledGauges({ tenantsCount: () => 0, tokensCount: async () => 0 }) // never leave a hanging dep behind for later full-registry scrapes
    }
  })
})
