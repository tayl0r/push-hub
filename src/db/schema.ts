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

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  apiKeyHash: text('api_key_hash').notNull(),        // sha256 hex of the tenant's API key
  credsEncrypted: text('creds_encrypted').notNull(), // AES-256-GCM base64(iv‖tag‖ciphertext) of JSON { apns?, fcm? }
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (t) => [
  unique('tenants_slug_unique').on(t.slug),               // slug ownership (DB-enforced TOFU lock)
  unique('tenants_api_key_hash_unique').on(t.apiKeyHash), // one key → one tenant
])
