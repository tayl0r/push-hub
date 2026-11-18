import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import { sql } from 'drizzle-orm'
import { hashKey } from '../src/auth.js'
import { sendRoutes } from '../src/routes/send.js'
import { registerToken, tokensForUsers } from '../src/store.js'
import type { TenantLookup } from '../src/registry.js'
import { testDb } from './helpers/db.js'
import { readSeries } from './helpers/metrics.js'

// The route captures to Sentry; without Sentry.init these are inert no-ops, so mock the module
// to assert on them. `vi.hoisted` gives the spy a handle the (hoisted) vi.mock factory can close over.
const captureException = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({ captureException }))

const db = testDb()
const engine = { send: vi.fn(), close: vi.fn() }
const tenant = { slug: 'team-comm', apiKeyHash: hashKey('key'), engine } as any
const registry: TenantLookup = { byKeyHash: (h) => (h === tenant.apiKeyHash ? tenant : undefined) }

// Stub satisfying Fastify v5's loggerInstance contract; child() returns itself so req.log
// IS this object and the route's log calls land on these spies with raw, unserialized args.
const log = {
  info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), warn: vi.fn(), trace: vi.fn(),
  child() { return log },
}

function app() {
  const a = Fastify({ loggerInstance: log })
  sendRoutes(a, { db, registry })
  return a
}
beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE push_tokens`); engine.send.mockReset() })

async function inject(body: unknown) {
  return app().inject({ method: 'POST', url: '/v1/send', headers: { authorization: 'Bearer key' }, payload: body })
}

describe('POST /v1/send', () => {
  it('fans out to all a user\'s devices and returns tickets', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-tok', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'and-tok', 'android')
    engine.send.mockImplementation(async ({ tokens }: any) =>
      tokens.map((t: any) => ({ ref: t.ref, token: t.token, provider: t.provider, status: 'delivered' })))

    const res = await inject({ to: 'u1', title: 'Hi', body: 'there', data: { k: 'v' }, badge: 3, sound: 'default', priority: 'normal' })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.every((t: any) => t.status === 'ok')).toBe(true)
    const call = engine.send.mock.calls[0][0]
    // provider derived from platform:
    expect(call.tokens.map((t: any) => t.provider).sort()).toEqual(['apns', 'fcm'])
    // Expo-shaped message fields forwarded to the engine:
    expect(call.notification).toMatchObject({ title: 'Hi', body: 'there', badge: 3, sound: 'default', priority: 'normal' })
  })

  it('deletes invalid-token rows, keeps failed', async () => {
    await registerToken(db, 'team-comm', 'u1', 'dead', 'android')
    await registerToken(db, 'team-comm', 'u1', 'live', 'android')
    const rows = await tokensForUsers(db, 'team-comm', ['u1'])
    const dead = rows.find(r => r.token === 'dead')!, live = rows.find(r => r.token === 'live')!
    engine.send.mockResolvedValueOnce([
      { ref: dead.id, token: 'dead', provider: 'fcm', status: 'invalid' },
      { ref: live.id, token: 'live', provider: 'fcm', status: 'failed', retryable: false },
    ])
    await inject({ to: 'u1', title: 'x', body: 'y' })
    expect((await tokensForUsers(db, 'team-comm', ['u1'])).map(r => r.token)).toEqual(['live'])
  })

  it('never deletes a foreign-tenant row, even if the engine returns its id as an invalid ref', async () => {
    await registerToken(db, 'team-comm', 'u1', 'live', 'android')
    await registerToken(db, 'setpiece', 'u9', 'foreign', 'android')
    const [live] = await tokensForUsers(db, 'team-comm', ['u1'])
    const [foreign] = await tokensForUsers(db, 'setpiece', ['u9'])
    // engine misbehaves: reports an "invalid" result for a ref this request never fetched/sent
    engine.send.mockResolvedValueOnce([
      { ref: live.id, token: 'live', provider: 'fcm', status: 'delivered' },
      { ref: foreign.id, token: 'foreign', provider: 'fcm', status: 'invalid' },
    ])
    await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(await tokensForUsers(db, 'setpiece', ['u9'])).toHaveLength(1)
  })

  it('maps failed/invalid results to error tickets via error ?? status', async () => {
    await registerToken(db, 'team-comm', 'u1', 'dead', 'android')
    await registerToken(db, 'team-comm', 'u1', 'live', 'android')
    const rows = await tokensForUsers(db, 'team-comm', ['u1'])
    const dead = rows.find(r => r.token === 'dead')!, live = rows.find(r => r.token === 'live')!
    engine.send.mockResolvedValueOnce([
      { ref: dead.id, token: 'dead', provider: 'fcm', status: 'invalid', error: 'Unregistered' },
      { ref: live.id, token: 'live', provider: 'fcm', status: 'failed', retryable: false },
    ])
    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    // explicit error passes through:
    expect(data[0]).toEqual({ userId: 'u1', status: 'error', error: 'Unregistered' })
    // missing error falls back to status:
    expect(data[1]).toEqual({ userId: 'u1', status: 'error', error: 'failed' })
  })

  it('fans out across multiple users when to is an array', async () => {
    await registerToken(db, 'team-comm', 'u1', 'u1-tok', 'ios')
    await registerToken(db, 'team-comm', 'u2', 'u2-tok', 'android')
    engine.send.mockImplementation(async ({ tokens }: any) =>
      tokens.map((t: any) => ({ ref: t.ref, token: t.token, provider: t.provider, status: 'delivered' })))

    const res = await inject({ to: ['u1', 'u2'], title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data).toHaveLength(2)
    expect(data.map((t: any) => t.userId).sort()).toEqual(['u1', 'u2'])
    expect(data.every((t: any) => t.status === 'ok')).toBe(true)
    const call = engine.send.mock.calls[0][0]
    expect(call.tokens.map((t: any) => t.token).sort()).toEqual(['u1-tok', 'u2-tok'])
  })

  it('empty for a user with no devices', async () => {
    engine.send.mockResolvedValue([])
    const res = await inject({ to: 'ghost', title: 'x', body: 'y' })
    expect(res.json()).toEqual({ data: [] })
    expect(engine.send).not.toHaveBeenCalled()
  })

  it('counts push_sends_total by result status and provider on success', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-tok', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'and-tok', 'android')
    engine.send.mockImplementation(async ({ tokens }: any) =>
      tokens.map((t: any) => ({ ref: t.ref, token: t.token, provider: t.provider, status: 'delivered' })))

    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    expect(await readSeries('push_sends_total', { status: 'delivered', provider: 'apns' })).toBe(1)
    expect(await readSeries('push_sends_total', { status: 'delivered', provider: 'fcm' })).toBe(1)
  })

  // This path is unreachable in normal operation after #11: a rejection out of engine.send means
  // push-hub itself is broken, NOT that a tenant misconfigured a provider. Kept so the defect
  // detector cannot silently rot.
  it('500 when the engine rejects unexpectedly (push-hub defect), counting one `error` per attempted target', async () => {
    await registerToken(db, 'team-comm', 'u1', 't-ios', 'ios')
    await registerToken(db, 'team-comm', 'u1', 't-and', 'android')
    engine.send.mockRejectedValueOnce(new Error('bad .p8'))
    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(500)
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'apns' })).toBe(1)
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'fcm' })).toBe(1)
  })

  it('a config fault returns tickets for every target, deletes only invalid rows, and never 500s', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-tok', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'and-live', 'android')
    await registerToken(db, 'team-comm', 'u1', 'and-dead', 'android')
    const rows = await tokensForUsers(db, 'team-comm', ['u1'])
    const ios = rows.find(r => r.token === 'ios-tok')!
    const live = rows.find(r => r.token === 'and-live')!
    const dead = rows.find(r => r.token === 'and-dead')!
    engine.send.mockResolvedValueOnce([
      { ref: ios.id, token: 'ios-tok', provider: 'apns', status: 'config', error: 'ExpiredProviderToken' },
      { ref: live.id, token: 'and-live', provider: 'fcm', status: 'delivered' },
      { ref: dead.id, token: 'and-dead', provider: 'fcm', status: 'invalid', error: 'Unregistered' },
    ])

    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data).toHaveLength(3)
    // the sibling batch survives — this is what #11 is about
    expect(data[1]).toEqual({ userId: 'u1', status: 'ok' })
    expect(data[0]).toEqual({ userId: 'u1', status: 'error', error: 'ExpiredProviderToken' })

    // the invalid row is deleted; the config row is STILL PRESENT — the property the old `throw` protected
    const after = (await tokensForUsers(db, 'team-comm', ['u1'])).map(r => r.token).sort()
    expect(after).toEqual(['and-live', 'ios-tok'])

    expect(await readSeries('push_sends_total', { status: 'config', provider: 'apns' })).toBe(1)
    expect(await readSeries('push_sends_total', { status: 'delivered', provider: 'fcm' })).toBe(1)
    expect(await readSeries('push_sends_total', { status: 'invalid', provider: 'fcm' })).toBe(1)
    // defect-backstop series untouched on this path: after test/setup.ts's per-test resetMetrics(),
    // a never-incremented labeled series has no entry at all, so readSeries returns undefined
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'apns' })).toBeUndefined()
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'fcm' })).toBeUndefined()
  })

  it('reports exactly one ProviderConfigError per request, not one per target', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-a', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'ios-b', 'ios')
    engine.send.mockImplementation(async ({ tokens }: any) =>
      tokens.map((t: any) => ({ ref: t.ref, token: t.token, provider: t.provider, status: 'config', error: 'ExpiredProviderToken' })))

    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(2)
    expect(captureException).toHaveBeenCalledTimes(1) // one event for the request, not one per target
    expect(captureException.mock.calls[0][0].name).toBe('ProviderConfigError')
    expect(captureException.mock.calls[0][1]).toMatchObject({
      tags: { tenant: 'team-comm', providers: 'apns' },
      extra: { failed: 2, total: 2 },
    })
    expect(log.error).toHaveBeenCalledWith(
      { tenant: 'team-comm', providers: ['apns'], reasons: ['ExpiredProviderToken'], failed: 2, total: 2 },
      'push-hub: provider configuration fault — tenant credentials need fixing',
    )
    expect(await readSeries('push_sends_total', { status: 'config', provider: 'apns' })).toBe(2)
  })

  it('reports a PushTransportDefect for backstopped error results and still returns tickets', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-tok', 'ios')
    const [ios] = await tokensForUsers(db, 'team-comm', ['u1'])
    engine.send.mockResolvedValueOnce([
      { ref: ios!.id, token: 'ios-tok', provider: 'apns', status: 'error', error: 'transport error: boom' },
    ])

    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data[0]).toEqual({ userId: 'u1', status: 'error', error: 'transport error: boom' })
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException.mock.calls[0][0].name).toBe('PushTransportDefect')
    expect(captureException.mock.calls[0][1]).toMatchObject({
      tags: { tenant: 'team-comm', providers: 'apns' },
      extra: { failed: 1, total: 1 },
    })
    expect(log.error).toHaveBeenCalledWith(
      { tenant: 'team-comm', providers: ['apns'], reasons: ['transport error: boom'], failed: 1, total: 1 },
      'push-hub: transport defect — backstop produced error results (push-hub bug, not tenant config)',
    )
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'apns' })).toBe(1)
    // an `error` result is not `invalid` — the token survives
    expect(await tokensForUsers(db, 'team-comm', ['u1'])).toHaveLength(1)
  })

  it('counts an unconfigured provider, keeps its token, and never reports it to Sentry', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-tok', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'and-tok', 'android')
    engine.send.mockImplementation(async ({ tokens }: any) =>
      tokens.map((t: any) => t.provider === 'fcm'
        ? { ref: t.ref, token: t.token, provider: 'fcm', status: 'unconfigured', error: 'provider not configured' }
        : { ref: t.ref, token: t.token, provider: 'apns', status: 'delivered' }))

    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.find((t: any) => t.error === 'provider not configured'))
      .toEqual({ userId: 'u1', status: 'error', error: 'provider not configured' })
    expect(await readSeries('push_sends_total', { status: 'unconfigured', provider: 'fcm' })).toBe(1)
    // routine mid-rollout state: the token survives and holds no GlitchTip issue open
    expect((await tokensForUsers(db, 'team-comm', ['u1'])).map(r => r.token).sort()).toEqual(['and-tok', 'ios-tok'])
    expect(captureException).not.toHaveBeenCalled()
    // the warn is the only signal for an unconfigured provider (no Sentry, by design)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(
      { tenant: 'team-comm', providers: ['fcm'], count: 1, total: 2 },
      'push-hub: send targeted a provider this tenant has not configured',
    )
  })

  it('reports nothing to Sentry on a clean send', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-tok', 'ios')
    engine.send.mockImplementation(async ({ tokens }: any) =>
      tokens.map((t: any) => ({ ref: t.ref, token: t.token, provider: t.provider, status: 'delivered' })))
    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    expect(captureException).not.toHaveBeenCalled()
  })
})
