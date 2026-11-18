import postgres from 'postgres'

// The one way tests connect to Postgres. The DB suites TRUNCATE between cases, so this refuses an unset
// TEST_DATABASE_URL (postgres.js would fall back to libpq's defaults: localhost:5432, a database named after
// the user) and any database whose name doesn't end in `_test`.
export function testClient() {
  const url = process.env.TEST_DATABASE_URL
  if (!url || !new URL(url).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name a test database (…_test): CLAUDE.md § Local checks')
  }
  return postgres(url)
}
