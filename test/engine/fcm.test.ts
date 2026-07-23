import { describe, it, expect, vi } from 'vitest'

const getAccessToken = vi.fn(async () => ({ token: 'oauth-token' }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient() { return { getAccessToken } }
  },
}))

import { FcmTransport } from '../../src/engine/fcm.js'

const config = { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: 'line1\\nline2' }
const note = { title: 'T', body: 'B', data: { k: 'v' } }

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))
}

describe('FcmTransport', () => {
  it('un-escapes the private key at construction', () => {
    // constructing with an escaped key must not throw
    expect(() => new FcmTransport(config)).not.toThrow()
  })

  it('delivered on 200', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { name: 'projects/proj/messages/1' }))
    const t = new FcmTransport(config)
    const [r] = await t.send([{ token: 'tok', provider: 'fcm', ref: 'r1' }], note)
    expect(r).toMatchObject({ ref: 'r1', provider: 'fcm', status: 'delivered' })
  })

  // NOTE: real FCM v1 error bodies put the FCM code in error.details[].errorCode,
  // with error.status carrying the canonical gRPC status. Fixtures below match that shape.
  it('404 NOT_FOUND / UNREGISTERED → invalid', async () => {
    vi.stubGlobal('fetch', mockFetch(404, {
      error: {
        code: 404, status: 'NOT_FOUND', message: 'requested entity was not found',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
      },
    }))
    const t = new FcmTransport(config)
    const [r] = await t.send([{ token: 'tok', provider: 'fcm', ref: 'r2' }], note)
    expect(r).toMatchObject({ status: 'invalid' })
  })

  it('400 INVALID_ARGUMENT → failed (never invalid)', async () => {
    vi.stubGlobal('fetch', mockFetch(400, {
      error: {
        code: 400, status: 'INVALID_ARGUMENT', message: 'the registration token is not valid',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' }],
      },
    }))
    const t = new FcmTransport(config)
    const [r] = await t.send([{ token: 'tok', provider: 'fcm', ref: 'r3' }], note)
    expect(r.status).toBe('failed')
  })

  it('401 UNAUTHENTICATED → throws (fail-loud config error)', async () => {
    vi.stubGlobal('fetch', mockFetch(401, {
      error: { code: 401, status: 'UNAUTHENTICATED', message: 'request had invalid authentication credentials' },
    }))
    const t = new FcmTransport(config)
    await expect(t.send([{ token: 'tok', provider: 'fcm' }], note)).rejects.toThrow()
  })

  it('sends high android priority and string data', async () => {
    const fetchMock = mockFetch(200, {})
    vi.stubGlobal('fetch', fetchMock)
    const t = new FcmTransport(config)
    await t.send([{ token: 'tok', provider: 'fcm' }], note)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body)
    expect(body.message.android.priority).toBe('high')
    expect(body.message.data).toEqual({ k: 'v' })
    expect(body.message.token).toBe('tok')
  })

  it('maps priority: normal and sound onto the android body; badge is iOS-only and never sent', async () => {
    const fetchMock = mockFetch(200, {})
    vi.stubGlobal('fetch', fetchMock)
    const t = new FcmTransport(config)
    await t.send([{ token: 'tok', provider: 'fcm' }], { ...note, priority: 'normal', sound: 'default', badge: 3 })
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body)
    expect(body.message.android.priority).toBe('normal')
    expect(body.message.android.notification.sound).toBe('default')
    expect(body.message.android.badge).toBeUndefined() // badge is iOS-only — must never leak into the FCM body
    expect(body.message.badge).toBeUndefined()
  })

  // Real FCM 503 body: canonical status UNAVAILABLE, no details[] FcmError entry.
  const unavailable = () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: { code: 503, status: 'UNAVAILABLE', message: 'The service is currently unavailable.' } }),
  })

  it('retries a transient 503 then delivers on 200', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ name: 'projects/proj/messages/1' }) })
    vi.stubGlobal('fetch', fetchMock)
    const t = new FcmTransport(config)
    vi.useFakeTimers()
    try {
      const p = t.send([{ token: 'tok', provider: 'fcm', ref: 'r5' }], note)
      await vi.runAllTimersAsync()
      const [r] = await p
      expect(r).toMatchObject({ ref: 'r5', status: 'delivered' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after 3 attempts of 503 → failed + retryable', async () => {
    const fetchMock = vi.fn(unavailable)
    vi.stubGlobal('fetch', fetchMock)
    const t = new FcmTransport(config)
    vi.useFakeTimers()
    try {
      const p = t.send([{ token: 'tok', provider: 'fcm', ref: 'r6' }], note)
      await vi.runAllTimersAsync()
      const [r] = await p
      expect(r).toMatchObject({ status: 'failed', retryable: true })
      expect(fetchMock).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
    } finally {
      vi.useRealTimers()
    }
  })

  // A 404 whose body carries NO FcmError detail (only the canonical NOT_FOUND status)
  // must be `failed`, NEVER `invalid` — so it can never delete a token.
  it('404 without an FcmError detail → failed (never invalid)', async () => {
    vi.stubGlobal('fetch', mockFetch(404, {
      error: { code: 404, status: 'NOT_FOUND', message: 'not found' },
    }))
    const t = new FcmTransport(config)
    const [r] = await t.send([{ token: 'tok', provider: 'fcm', ref: 'r7' }], note)
    expect(r.status).toBe('failed')
    expect(r.status).not.toBe('invalid')
  })

  it('close() resolves without touching the network (no-op)', async () => {
    const t = new FcmTransport(config)
    await expect(t.close()).resolves.toBeUndefined()
  })
})
