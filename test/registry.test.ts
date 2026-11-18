import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import * as schema from '../src/db/schema.js'
import { testClient } from './helpers/db.js'
import { tenants } from '../src/db/schema.js'
import { TenantRegistry, InvalidCreds, SlugTaken } from '../src/registry.js'
import { hashKey } from '../src/auth.js'
import { register } from '../src/metrics.js'
import { readSeries } from './helpers/metrics.js'

const client = testClient()
const db = drizzle(client, { schema })
const credKey = randomBytes(32)

// buildEngine mock: throws when a provider block is flagged bad, else returns a fake engine with
// send/close spies. Every built engine is tracked so tests can assert teardown on the failure paths.
const engines: Array<{ send: any; close: any }> = []
const buildEngine = vi.fn((cfg: any) => {
  if (cfg.apns?.bad || cfg.fcm?.bad) throw new Error('bad provider block')
  const engine = { send: vi.fn(), close: vi.fn(async () => {}) }
  engines.push(engine)
  return engine
})

const registry = () => new TenantRegistry({ db, credKey, buildEngine })
const apns = { keyId: 'K', teamId: 'T', bundleId: 'com.x.y', signingKey: 'sk', production: true }

beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE tenants`); buildEngine.mockClear(); engines.length = 0 })
afterAll(async () => { await client.end() })

describe('TenantRegistry', () => {
  it('register returns a phk_ key, inserts an encrypted row, and hot-adds to the map', async () => {
    const r = registry()
    const { slug, apiKey } = await r.register({ slug: 'team-comm', apns })
    expect(slug).toBe('team-comm')
    expect(apiKey).toMatch(/^phk_[0-9a-f]{48}$/)
    expect(r.byKeyHash(hashKey(apiKey))?.slug).toBe('team-comm') // hot-add, no reload
    const [row] = await db.select().from(tenants)
    expect(row.credsEncrypted).not.toContain('com.x.y') // encrypted at rest
    expect(row.credsEncrypted).not.toContain('keyId')
  })

  it('register on a taken slug throws SlugTaken', async () => {
    const r = registry()
    await r.register({ slug: 'dup', apns })
    await expect(r.register({ slug: 'dup', apns })).rejects.toBeInstanceOf(SlugTaken)
  })

  it('closes the engine it built when the slug is already taken (no leak on 409)', async () => {
    const r = registry()
    await r.register({ slug: 'dup', apns })                                   // engines[0] — the winner, stays open
    await expect(r.register({ slug: 'dup', apns })).rejects.toBeInstanceOf(SlugTaken)
    expect(engines[1].close).toHaveBeenCalledTimes(1)                          // the loser's engine is torn down
    expect(engines[0].close).not.toHaveBeenCalled()                           // the winner keeps serving
  })

  it('register with zero providers throws InvalidCreds and writes no row', async () => {
    const r = registry()
    await expect(r.register({ slug: 'none' })).rejects.toBeInstanceOf(InvalidCreds)
    expect(await db.select().from(tenants)).toHaveLength(0)
  })

  it('register with a provider block that fails buildEngine throws InvalidCreds and writes no row', async () => {
    const r = registry()
    await expect(r.register({ slug: 'bad', apns: { ...apns, bad: true } as any })).rejects.toBeInstanceOf(InvalidCreds)
    expect(await db.select().from(tenants)).toHaveLength(0)
  })

  it('load builds an engine per row and resolves them by key hash', async () => {
    const { apiKey } = await registry().register({ slug: 'team-comm', apns })
    const r = registry() // fresh registry over the same DB
    await r.load()
    expect(r.byKeyHash(hashKey(apiKey))?.slug).toBe('team-comm')
  })

  it('load throws when a row cannot be decrypted (wrong cred key) — boot fail-loud', async () => {
    await registry().register({ slug: 'team-comm', apns })
    const wrong = new TenantRegistry({ db, credKey: randomBytes(32), buildEngine })
    await expect(wrong.load()).rejects.toThrow()
  })

  it('load throws when buildEngine throws for a stored row', async () => {
    await registry().register({ slug: 'team-comm', apns })
    const failing = vi.fn(() => { throw new Error('boom') })
    await expect(new TenantRegistry({ db, credKey, buildEngine: failing }).load()).rejects.toThrow()
  })

  it('updateCredentials re-encrypts the row, swaps the map engine, and closes the replaced engine', async () => {
    const r = registry()
    const { apiKey } = await r.register({ slug: 'team-comm', apns })
    const before = r.byKeyHash(hashKey(apiKey))!
    const oldEngine = before.engine
    const [rowBefore] = await db.select().from(tenants)

    await r.updateCredentials(before, { fcm: { projectId: 'p', clientEmail: 'e', privateKey: 'k' } })

    const after = r.byKeyHash(hashKey(apiKey))!
    expect(after.engine).not.toBe(oldEngine)                     // map engine swapped
    expect((oldEngine as any).close).toHaveBeenCalledTimes(1)    // replaced engine closed
    const [rowAfter] = await db.select().from(tenants)
    expect(rowAfter.credsEncrypted).not.toBe(rowBefore.credsEncrypted) // re-encrypted
  })

  it('closes the engine it built when the UPDATE fails, leaving the map entry unchanged (no leak on 500)', async () => {
    const r = registry()
    const { apiKey } = await r.register({ slug: 'team-comm', apns })   // engines[0] — the old engine, stays open
    const before = r.byKeyHash(hashKey(apiKey))!
    const spy = vi.spyOn(db, 'update').mockImplementationOnce(() => { throw new Error('db update boom') })

    await expect(r.updateCredentials(before, { fcm: { projectId: 'p', clientEmail: 'e', privateKey: 'k' } })).rejects.toThrow()

    expect(engines[1].close).toHaveBeenCalledTimes(1)                 // the newly built engine is torn down
    expect(engines[0].close).not.toHaveBeenCalled()                   // the old engine keeps serving
    expect(r.byKeyHash(hashKey(apiKey))!.engine).toBe(before.engine)  // map entry unchanged

    spy.mockRestore()
  })

  it('times the insert under operation="tenant_insert"', async () => {
    await registry().register({ slug: 'team-comm', apns })
    expect(await readSeries('db_query_duration_seconds_count', { operation: 'tenant_insert' })).toBe(1)
  })

  it('times load under operation="tenants_load"', async () => {
    await registry().register({ slug: 'team-comm', apns })
    register.resetMetrics()
    await registry().load()
    expect(await readSeries('db_query_duration_seconds_count', { operation: 'tenants_load' })).toBe(1)
  })

  it('times updateCredentials under operation="tenant_update"', async () => {
    const r = registry()
    const { apiKey } = await r.register({ slug: 'team-comm', apns })
    const before = r.byKeyHash(hashKey(apiKey))!
    register.resetMetrics()
    await r.updateCredentials(before, { fcm: { projectId: 'p', clientEmail: 'e', privateKey: 'k' } })
    expect(await readSeries('db_query_duration_seconds_count', { operation: 'tenant_update' })).toBe(1)
  })
})
