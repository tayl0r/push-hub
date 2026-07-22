import { describe, it, expect, vi } from 'vitest'
import { mapWithConcurrency, retryTransient } from '../../src/engine/concurrency.js'

describe('mapWithConcurrency', () => {
  it('preserves order and caps in-flight count', async () => {
    let inFlight = 0, maxInFlight = 0
    const fn = async (n: number) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--; return n * 2
    }
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, fn)
    expect(out).toEqual([2, 4, 6, 8, 10])
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })
})

describe('retryTransient', () => {
  it('retries transient failures then succeeds', async () => {
    let calls = 0
    const fn = async () => { calls++; if (calls < 3) throw new Error('transient'); return 'ok' }
    const out = await retryTransient(fn, () => true, 3)
    expect(out).toBe('ok')
    expect(calls).toBe(3)
  })
  it('does not retry non-transient failures', async () => {
    let calls = 0
    const fn = async () => { calls++; throw new Error('permanent') }
    await expect(retryTransient(fn, () => false, 3)).rejects.toThrow('permanent')
    expect(calls).toBe(1)
  })
})
