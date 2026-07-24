import { describe, it, expect, vi } from 'vitest'

// Mock transports so orchestration is tested in isolation. Outcome is derived from a
// convention in the token string so a single batch can mix delivered/failed/invalid, and
// a token of `<provider>-config-boom` makes the whole transport REJECT — which after #11 is
// a push-hub defect, caught by the orchestrator's backstop, not a tenant config fault.
const outcome = (token: string) =>
  token.includes('dead') ? 'invalid' : token.includes('fail') ? 'failed' : 'delivered'

const apnsClose = vi.fn(async () => {})
const fcmClose = vi.fn(async () => {})

vi.mock('../../src/engine/apns.js', () => ({
  ApnsTransport: class {
    send = vi.fn(async (targets: any[]) => {
      if (targets.some((t) => t.token === 'apns-config-boom')) throw new Error('config: bad .p8 signing key')
      return targets.map((t) => ({ ref: t.ref, token: t.token, provider: 'apns', status: outcome(t.token) }))
    })
    close = apnsClose
  },
}))
vi.mock('../../src/engine/fcm.js', () => ({
  FcmTransport: class {
    send = vi.fn(async (targets: any[]) => {
      if (targets.some((t) => t.token === 'fcm-config-boom')) throw new Error('config: bad service account')
      return targets.map((t) => ({ ref: t.ref, token: t.token, provider: 'fcm', status: outcome(t.token) }))
    })
    close = fcmClose
  },
}))

import { createPushService } from '../../src/engine/index.js'

const note = { title: 'T', body: 'B' }

describe('createPushService', () => {
  it('routes each target to its provider and preserves refs', async () => {
    const push = createPushService({ apns: {} as any, fcm: {} as any })
    const results = await push.send({
      tokens: [
        { token: 'a', provider: 'apns', ref: 'r1' },
        { token: 'b', provider: 'fcm', ref: 'r2' },
      ],
      notification: note,
    })
    expect(results).toHaveLength(2)
    expect(results.find(r => r.ref === 'r1')).toMatchObject({ provider: 'apns', status: 'delivered' })
    expect(results.find(r => r.ref === 'r2')).toMatchObject({ provider: 'fcm', status: 'delivered' })
  })

  it('returns "unconfigured" results when a provider is absent', async () => {
    const push = createPushService({ apns: {} as any }) // no fcm
    const results = await push.send({
      tokens: [{ token: 'b', provider: 'fcm', ref: 'r2' }],
      notification: note,
    })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ status: 'unconfigured', error: 'provider not configured', ref: 'r2' })
    // a missing provider is a routine rollout state — never the `config` incident status
    expect(results[0]!.status).not.toBe('config')
    expect(results[0]!.retryable).toBeUndefined()
  })

  it('echoes every input ref across a mixed-provider, mixed-outcome batch', async () => {
    const push = createPushService({ apns: {} as any, fcm: {} as any })
    const tokens = [
      { token: 'ok-apns', provider: 'apns' as const, ref: 'r1' },
      { token: 'dead-apns', provider: 'apns' as const, ref: 'r2' },
      { token: 'ok-fcm', provider: 'fcm' as const, ref: 'r3' },
      { token: 'fail-fcm', provider: 'fcm' as const, ref: 'r4' },
    ]
    const results = await push.send({ tokens, notification: note })

    expect(results).toHaveLength(tokens.length)
    // every input ref is echoed on exactly one result, matched to its own target
    for (const t of tokens) {
      const r = results.find(x => x.token === t.token)
      expect(r?.ref).toBe(t.ref)
    }
    // and the mixed outcomes flowed through unchanged
    expect(results.find(r => r.ref === 'r1')).toMatchObject({ provider: 'apns', status: 'delivered' })
    expect(results.find(r => r.ref === 'r2')).toMatchObject({ provider: 'apns', status: 'invalid' })
    expect(results.find(r => r.ref === 'r3')).toMatchObject({ provider: 'fcm', status: 'delivered' })
    expect(results.find(r => r.ref === 'r4')).toMatchObject({ provider: 'fcm', status: 'failed' })
  })

  it('a transport-level rejection never discards the sibling transport\'s results', async () => {
    const push = createPushService({ apns: {} as any, fcm: {} as any })
    const results = await push.send({
      tokens: [
        { token: 'apns-config-boom', provider: 'apns', ref: 'r1' },
        { token: 'ok-fcm', provider: 'fcm', ref: 'r2' },
      ],
      notification: note,
    })
    expect(results).toHaveLength(2)
    // a transport that REJECTS is a push-hub defect, not a tenant credential fault
    const backstopped = results.find(r => r.ref === 'r1')!
    expect(backstopped.status).toBe('error')
    expect(backstopped.error).toMatch(/^transport error: /)
    // …and the sibling transport's batch survives — the whole point of #11
    expect(results.find(r => r.ref === 'r2')).toMatchObject({ provider: 'fcm', status: 'delivered' })
  })

  it('resolves exactly one result per input target even when a transport rejects', async () => {
    const push = createPushService({ apns: {} as any, fcm: {} as any })
    const tokens = [
      { token: 'apns-config-boom', provider: 'apns' as const, ref: 'r1' },
      { token: 'ok-apns', provider: 'apns' as const, ref: 'r2' },
      { token: 'ok-fcm', provider: 'fcm' as const, ref: 'r3' },
      { token: 'dead-fcm', provider: 'fcm' as const, ref: 'r4' },
    ]
    const results = await push.send({ tokens, notification: note })

    expect(results).toHaveLength(tokens.length)
    expect(results.map(r => r.ref).sort()).toEqual(['r1', 'r2', 'r3', 'r4'])
    // the rejecting transport's whole batch is backstopped per target…
    expect(results.filter(r => r.provider === 'apns').every(r => r.status === 'error')).toBe(true)
    // …while the sibling transport keeps its real per-target outcomes
    expect(results.find(r => r.ref === 'r3')).toMatchObject({ status: 'delivered' })
    expect(results.find(r => r.ref === 'r4')).toMatchObject({ status: 'invalid' })
    // emission split: `unconfigured` comes only from the missing-transport branch, never from a transport
    expect(results.some(r => r.status === 'unconfigured')).toBe(false)
  })

  it('close() closes every configured transport', async () => {
    const push = createPushService({ apns: {} as any, fcm: {} as any })
    await push.close()
    expect(apnsClose).toHaveBeenCalledTimes(1)
    expect(fcmClose).toHaveBeenCalledTimes(1)
  })

  it('close() only closes the transports that were configured', async () => {
    const push = createPushService({ apns: {} as any }) // no fcm
    await push.close()
    expect(apnsClose).toHaveBeenCalledTimes(1)
    expect(fcmClose).not.toHaveBeenCalled()
  })
})
