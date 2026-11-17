// test/global-setup.ts — migrate the test DB before any suite runs.
// Fails loudly when TEST_DATABASE_URL is unset: the DB suites would otherwise connect with
// libpq's defaults (localhost:5432, a database named after the user) and TRUNCATE whatever is there.
export default async function () {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is unset: point it at the test Postgres (CLAUDE.md § Local checks)')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const migrationsFolder = path.resolve(dir, '../migrations')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const { migrate } = await import('drizzle-orm/postgres-js/migrator')
  const postgres = (await import('postgres')).default
  const client = postgres(url, { max: 1 })
  await migrate(drizzle(client), { migrationsFolder })
  await client.end()
}
