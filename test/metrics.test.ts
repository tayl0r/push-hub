import { describe, it, expect, beforeEach } from 'vitest'
import { register, recordSend, setBuildInfo, dbTimed } from '../src/metrics.js'
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
