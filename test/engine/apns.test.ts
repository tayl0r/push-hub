import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.fn()
const destroy = vi.fn(async () => {})
vi.mock('apns2', () => {
  // Faithful to apns2 v12: constructed with a single props object, `reason`/`timestamp`
  // are getters over `response`. Production only ever reads `.reason`.
  class ApnsError extends Error {
    statusCode: number
    notification: any
    response: { reason: string; timestamp?: number }
    constructor(props: { statusCode: number; notification?: any; response: { reason: string; timestamp?: number } }) {
      super(`APNS Error: ${props.statusCode} - ${props.response.reason}`)
      this.statusCode = props.statusCode
      this.notification = props.notification
      this.response = props.response
    }
    get reason() { return this.response.reason }
    get timestamp() { return this.response.timestamp }
  }
  return {
    ApnsClient: class { send = send; destroy = destroy },
    Notification: class { constructor(public deviceToken: string, public options: any) {} },
    Priority: { immediate: 10, throttled: 5 },
    PushType: { alert: 'alert' },
    Errors: {},
    ApnsError,
  }
})

import { ApnsTransport } from '../../src/engine/apns.js'
import { ApnsError, Priority } from 'apns2'

// helper mirroring `new ApnsError({ statusCode, notification, response: { reason } })`
const apnsError = (reason: string, statusCode: number) =>
  new ApnsError({ statusCode, notification: {} as any, response: { reason } })

// base64 of a dummy PEM so the constructor's structural check passes
const p8 = Buffer.from('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----').toString('base64')
const config = { keyId: 'K', teamId: 'T', bundleId: 'com.x.y', signingKey: p8, production: true }
const note = { title: 'T', body: 'B', data: { k: 'v' } }

beforeEach(() => { send.mockReset() })

describe('ApnsTransport', () => {
  it('throws on non-base64/empty signing key', () => {
    expect(() => new ApnsTransport({ ...config, signingKey: '' })).toThrow()
  })

  it('delivered when apns2 resolves', async () => {
    send.mockResolvedValueOnce(undefined)
    const t = new ApnsTransport(config)
    const [r] = await t.send([{ token: 'tok', provider: 'apns', ref: 'r1' }], note)
    expect(r).toMatchObject({ ref: 'r1', provider: 'apns', status: 'delivered' })
  })

  it('BadDeviceToken → invalid', async () => {
    send.mockRejectedValueOnce(apnsError('BadDeviceToken', 400))
    const t = new ApnsTransport(config)
    const [r] = await t.send([{ token: 'tok', provider: 'apns', ref: 'r2' }], note)
    expect(r.status).toBe('invalid')
  })

  it('InvalidProviderToken → a config result, not a throw', async () => {
    send.mockRejectedValue(apnsError('InvalidProviderToken', 403))
    const t = new ApnsTransport(config)
    const [r] = await t.send([{ token: 'tok', provider: 'apns', ref: 'r-cfg' }], note)
    expect(r).toMatchObject({ ref: 'r-cfg', provider: 'apns', status: 'config', error: 'InvalidProviderToken' })
    expect(r!.retryable).toBeUndefined() // config is not retryable — absent, matching `invalid`
  })

  it('a config fault on one target does not discard its siblings', async () => {
    // Keyed on the notification's deviceToken, NOT on call order: the 3 targets are dispatched
    // concurrently, so a mockRejectedValueOnce chain would depend on worker scheduling.
    send.mockImplementation(async (n: any) => {
      if (n.deviceToken === 'bad') throw apnsError('ExpiredProviderToken', 403)
      return undefined
    })
    const t = new ApnsTransport(config)
    const results = await t.send([
      { token: 'ok1', provider: 'apns', ref: 'r1' },
      { token: 'bad', provider: 'apns', ref: 'r2' },
      { token: 'ok2', provider: 'apns', ref: 'r3' },
    ], note)
    expect(results).toHaveLength(3)
    expect(results.map(r => r.status)).toEqual(['delivered', 'config', 'delivered'])
    expect(results.map(r => r.ref)).toEqual(['r1', 'r2', 'r3'])
    expect(results[1]!.error).toBe('ExpiredProviderToken')
  })

  it('retries a transient TooManyRequests then delivers', async () => {
    send
      .mockRejectedValueOnce(apnsError('TooManyRequests', 429))
      .mockResolvedValueOnce(undefined)
    const t = new ApnsTransport(config)
    vi.useFakeTimers()
    try {
      const p = t.send([{ token: 'tok', provider: 'apns', ref: 'r3' }], note)
      await vi.runAllTimersAsync()
      const [r] = await p
      expect(r).toMatchObject({ ref: 'r3', status: 'delivered' })
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after 3 TooManyRequests attempts → failed + retryable', async () => {
    send.mockRejectedValue(apnsError('TooManyRequests', 429))
    const t = new ApnsTransport(config)
    vi.useFakeTimers()
    try {
      const p = t.send([{ token: 'tok', provider: 'apns', ref: 'r4' }], note)
      await vi.runAllTimersAsync()
      const [r] = await p
      expect(r).toMatchObject({ status: 'failed', retryable: true })
      expect(send).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps badge, sound and priority: normal onto the apns2 Notification options', async () => {
    send.mockResolvedValueOnce(undefined)
    const t = new ApnsTransport(config)
    await t.send(
      [{ token: 'tok', provider: 'apns', ref: 'r5' }],
      { title: 'T', body: 'B', badge: 3, sound: 'default', priority: 'normal' },
    )
    const notification = send.mock.calls[0][0]
    expect(notification.options).toMatchObject({ badge: 3, sound: 'default', priority: Priority.throttled })
  })

  it('defaults to Priority.immediate when priority is unspecified', async () => {
    send.mockResolvedValueOnce(undefined)
    const t = new ApnsTransport(config)
    await t.send([{ token: 'tok', provider: 'apns', ref: 'r6' }], note)
    const notification = send.mock.calls[0][0]
    expect(notification.options.priority).toBe(Priority.immediate)
  })

  it('close() destroys the underlying apns2 client', async () => {
    const t = new ApnsTransport(config)
    await t.close()
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
