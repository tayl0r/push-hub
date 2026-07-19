import { and, eq, inArray } from 'drizzle-orm'
import { pushTokens } from './db/schema.js'

type Db = any // drizzle instance; kept loose so store fns work with the app db and the test db

export async function registerToken(db: Db, appSlug: string, userId: string, token: string, platform: 'ios' | 'android'): Promise<void> {
  await db.insert(pushTokens)
    .values({ appSlug, userId, token, platform, lastSeenAt: new Date() })
    // conflict target is the (appSlug, token) unique constraint: a re-register within the same app reassigns the user;
    // the same token string under another app is a separate row (structural tenant isolation, never a cross-tenant evict)
    .onConflictDoUpdate({ target: [pushTokens.appSlug, pushTokens.token], set: { userId, platform, lastSeenAt: new Date() } })
}

export async function removeToken(db: Db, appSlug: string, token: string): Promise<number> {
  const deleted = await db.delete(pushTokens)
    .where(and(eq(pushTokens.appSlug, appSlug), eq(pushTokens.token, token)))
    .returning()
  return deleted.length
}

export async function tokensForUsers(db: Db, appSlug: string, userIds: string[]): Promise<Array<{ id: string; token: string; platform: 'ios' | 'android'; userId: string }>> {
  if (userIds.length === 0) return []
  return db.select({ id: pushTokens.id, token: pushTokens.token, platform: pushTokens.platform, userId: pushTokens.userId })
    .from(pushTokens)
    .where(and(eq(pushTokens.appSlug, appSlug), inArray(pushTokens.userId, userIds)))
}

export async function deleteByIds(db: Db, ids: string[]): Promise<void> {
  if (ids.length) await db.delete(pushTokens).where(inArray(pushTokens.id, ids))
}
