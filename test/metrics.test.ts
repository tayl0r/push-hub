import { describe, it, expect, beforeEach } from 'vitest'
import { register, recordSend, setBuildInfo, dbTimed, registerHttpMetrics } from '../src/metrics.js'
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
