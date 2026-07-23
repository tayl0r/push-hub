import { and, count, eq, inArray } from 'drizzle-orm'
import { pushTokens } from './db/schema.js'
import { dbTimed } from './metrics.js'

type Db = any // drizzle instance; kept loose so store fns work with the app db and the test db

export async function registerToken(db: Db, appSlug: string, userId: string, token: string, platform: 'ios' | 'android'): Promise<void> {
  await dbTimed('register_token', () =>
    db.insert(pushTokens)
      .values({ appSlug, userId, token, platform, lastSeenAt: new Date() })
      // conflict target is the (appSlug, token) unique constraint: a re-register within the same app reassigns the user;
      // the same token string under another app is a separate row (structural tenant isolation, never a cross-tenant evict)
      .onConflictDoUpdate({ target: [pushTokens.appSlug, pushTokens.token], set: { userId, platform, lastSeenAt: new Date() } }))
}

export async function removeToken(db: Db, appSlug: string, token: string): Promise<number> {
  const deleted = await dbTimed<any[]>('remove_token', () =>
    db.delete(pushTokens)
      .where(and(eq(pushTokens.appSlug, appSlug), eq(pushTokens.token, token)))
      .returning())
  return deleted.length
}

export async function tokensForUsers(db: Db, appSlug: string, userIds: string[]): Promise<Array<{ id: string; token: string; platform: 'ios' | 'android'; userId: string }>> {
  if (userIds.length === 0) return []
  return dbTimed('tokens_for_users', () =>
    db.select({ id: pushTokens.id, token: pushTokens.token, platform: pushTokens.platform, userId: pushTokens.userId })
      .from(pushTokens)
      .where(and(eq(pushTokens.appSlug, appSlug), inArray(pushTokens.userId, userIds))))
}

export async function deleteByIds(db: Db, ids: string[]): Promise<void> {
  if (ids.length) await dbTimed('delete_tokens', () => db.delete(pushTokens).where(inArray(pushTokens.id, ids)))
}

// Scrape-only count for the push_tokens gauge — deliberately NOT dbTimed-wrapped (it is
// scrape-driven, not request work, and would pollute query-duration percentiles). Uses
// drizzle count(): it emits count(*) and maps the value with Number, sidestepping two
// postgres-js footguns (int8 arrives as a string; RowList carries its own .count metadata).
export async function countTokens(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(pushTokens)
  return Number(row.n)
}
