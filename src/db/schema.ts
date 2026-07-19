import { pgTable, uuid, text, timestamp, unique, index } from 'drizzle-orm/pg-core'

export const pushTokens = pgTable('push_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  appSlug: text('app_slug').notNull(),
  userId: text('user_id').notNull(),
  token: text('token').notNull(),
  platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
}, (t) => [
  unique('push_tokens_app_token_unique').on(t.appSlug, t.token),
  index('push_tokens_app_user_idx').on(t.appSlug, t.userId),
])
