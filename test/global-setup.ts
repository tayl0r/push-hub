// No-op when TEST_DATABASE_URL is unset, so unit suites run without Postgres; DB suites then fail on testClient()'s check.
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { testClient } from './helpers/test-client.js'

export default async function () {
  if (!process.env.TEST_DATABASE_URL) return
  const client = testClient()
  try {
    await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) })
  } finally {
    await client.end()
  }
}
