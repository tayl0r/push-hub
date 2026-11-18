import postgres from 'postgres'

// Suites TRUNCATE, so refuse any database not named `…_test`. It checks the name postgres.js will send, since a
// `?database=` parameter overrides the URL's path. No vitest import: global-setup uses this outside a test file.
export function testClient() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL must name a test database (…_test), got none (unset): CLAUDE.md § Local checks')
  const client = postgres(url)
  const database = String(client.options.connection.database ?? client.options.database)
  if (!database.endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL must name a test database (…_test), got ${database}: CLAUDE.md § Local checks`)
  }
  return client
}
