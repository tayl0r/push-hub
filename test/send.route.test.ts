import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Fastify from 'fastify'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../src/db/schema.js'
import { hashKey } from '../src/auth.js'
import { sendRoutes } from '../src/routes/send.js'
import { registerToken, tokensForUsers } from '../src/store.js'

const client = postgres(process.env.TEST_DATABASE_URL!)
const db = drizzle(client, { schema })
const engine = { send: vi.fn() }
const tenant = { slug: 'team-comm', apiKeyHash: hashKey('key'), engine } as any
const tenants = new Map([[tenant.apiKeyHash, tenant]])

function app() {
  const a = Fastify()
  sendRoutes(a, { db, tenants })
  return a
}
beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE push_tokens`); engine.send.mockReset() })
afterAll(async () => { await client.end() })

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

  it('500 when the engine throws (tenant misconfig)', async () => {
    await registerToken(db, 'team-comm', 'u1', 't', 'ios')
    engine.send.mockRejectedValueOnce(new Error('bad .p8'))
    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(500)
  })
})
