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
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, fn, () => 0 /* unreachable: fn never throws */)
    expect(out).toEqual([2, 4, 6, 8, 10])
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  // The unit-level proof of the property both transports and the orchestrator depend on:
  // a throwing item costs exactly its own slot and never the batch.
  it('maps a throwing item via onError in place, siblings keep their results, and it resolves', async () => {
    const fn = async (n: number) => { if (n === 2) throw new Error('boom'); return n * 2 }
    const out = await mapWithConcurrency([1, 2, 3], 2, fn, (n: number) => -n)
    expect(out).toEqual([2, -2, 6])
  })

  // Pins worker survival across a caught error: with as many throwing items as the
  // concurrency limit, every worker hits an error on its very first item. A broken
  // implementation whose worker loop exits after handling one catch would leave the
  // remaining items (idx 2, 3) unprocessed, producing undefined holes in the array.
  it('keeps every worker alive across a caught error so no results slot is left unfilled', async () => {
    const fn = async (n: number) => { if (n === 1 || n === 2) throw new Error('boom'); return n * 2 }
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, fn, (n: number) => -1000 - n)
    expect(out).toEqual([-1001, -1002, 6, 8])
  })

  it('returns [] for an empty input without calling fn', async () => {
    const fn = vi.fn(async (n: number) => n)
    expect(await mapWithConcurrency([], 4, fn, () => 0)).toEqual([])
    expect(fn).not.toHaveBeenCalled()
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
