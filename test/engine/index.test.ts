import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock transports so orchestration is tested in isolation. Outcome is derived from a
// convention in the token string so a single batch can mix delivered/failed/invalid, and
// a token of `<provider>-config-boom` makes the transport reject (fail-loud config error).
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
  beforeEach(() => { apnsClose.mockClear(); fcmClose.mockClear() })
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

  it('returns "provider not configured" failed results when a provider is absent', async () => {
    const push = createPushService({ apns: {} as any }) // no fcm
    const results = await push.send({
      tokens: [{ token: 'b', provider: 'fcm', ref: 'r2' }],
      notification: note,
    })
    expect(results[0]).toMatchObject({ status: 'failed', error: 'provider not configured', ref: 'r2' })
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

  it('propagates a transport config error (fail-loud) out of send()', async () => {
    const push = createPushService({ apns: {} as any, fcm: {} as any })
    await expect(push.send({
      tokens: [
        { token: 'apns-config-boom', provider: 'apns', ref: 'r1' },
        { token: 'ok-fcm', provider: 'fcm', ref: 'r2' }, // other provider's results are discarded
      ],
      notification: note,
    })).rejects.toThrow()
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
