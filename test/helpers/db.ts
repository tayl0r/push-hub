import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '../../src/db/schema.js'

// Suites TRUNCATE, so refuse an unset URL (postgres.js would fall back to libpq defaults) or a non-`_test` database.
export function testClient() {
  const url = process.env.TEST_DATABASE_URL
  if (!url || !new URL(url).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name a test database (…_test): CLAUDE.md § Local checks')
  }
  return postgres(url)
}

// Callers must end it in afterAll (`db.$client.end()`); not registered here because global-setup imports this file.
export function testDb() {
  return drizzle(testClient(), { schema })
}
