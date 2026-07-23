import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../src/db/schema.js'
import { registerToken, removeToken, tokensForUsers, deleteByIds, countTokens } from '../src/store.js'
import { register } from '../src/metrics.js'
import { readSeries } from './helpers/metrics.js'

const client = postgres(process.env.TEST_DATABASE_URL!)
const db = drizzle(client, { schema })
beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE push_tokens`); register.resetMetrics() })
afterAll(async () => { await client.end() })

describe('token store', () => {
  it('registers, reassigns on token conflict, and lists per user (1→many, tenant-scoped)', async () => {
    await registerToken(db, 'team-comm', 'u1', 't-ios', 'ios')
    await registerToken(db, 'team-comm', 'u1', 't-and', 'android') // same user, 2nd device
    await registerToken(db, 'setpiece', 'u1', 't-other', 'ios')    // different tenant, same userId string

    const rows = await tokensForUsers(db, 'team-comm', ['u1'])
    expect(rows.map(r => r.token).sort()).toEqual(['t-and', 't-ios']) // both devices, not the other tenant's

    await registerToken(db, 'team-comm', 'u2', 't-ios', 'ios')       // device handed to a new user
    const forU1 = await tokensForUsers(db, 'team-comm', ['u1'])
    expect(forU1.map(r => r.token)).toEqual(['t-and'])              // reassigned away from u1
  })

  it('scopes uniqueness to the tenant — the same token string under two apps is two independent rows', async () => {
    await registerToken(db, 'team-comm', 'u1', 'shared-tok', 'ios')
    await registerToken(db, 'setpiece', 'u9', 'shared-tok', 'ios')  // MUST NOT evict team-comm's row
    expect((await tokensForUsers(db, 'team-comm', ['u1'])).map(r => r.token)).toEqual(['shared-tok'])
    expect((await tokensForUsers(db, 'setpiece', ['u9'])).map(r => r.token)).toEqual(['shared-tok'])
  })

  it('removeToken is tenant-scoped', async () => {
    await registerToken(db, 'team-comm', 'u1', 't1', 'ios')
    expect(await removeToken(db, 'setpiece', 't1')).toBe(0)         // wrong tenant → nothing
    expect(await removeToken(db, 'team-comm', 't1')).toBe(1)
  })

  it('deleteByIds removes exactly the given rows', async () => {
    await registerToken(db, 'team-comm', 'u1', 'a', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'b', 'ios')
    const [row] = await tokensForUsers(db, 'team-comm', ['u1'])
    await deleteByIds(db, [row.id])
    expect((await tokensForUsers(db, 'team-comm', ['u1'])).length).toBe(1)
  })

  it('times a store query under its db operation label', async () => {
    await registerToken(db, 'team-comm', 'u1', 't1', 'ios')
    expect(await readSeries('db_query_duration_seconds_count', { operation: 'register_token' })).toBe(1)
  })

  it('countTokens returns the row count as a number', async () => {
    await registerToken(db, 'team-comm', 'u1', 'a', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'b', 'ios')
    await registerToken(db, 'team-comm', 'u2', 'c', 'android')
    const n = await countTokens(db)
    expect(n).toBe(3)
    expect(typeof n).toBe('number')
  })
})
