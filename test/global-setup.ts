// test/global-setup.ts — migrate the test DB before any suite runs.
// No-op when TEST_DATABASE_URL is unset or migrations/ doesn't exist yet, so the
// non-DB suites (config, auth) still run in Tasks 2 & 4 before the DB is provisioned.
export default async function () {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return
  const { existsSync, readdirSync } = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const migrationsFolder = path.resolve(dir, '../migrations')
  if (!existsSync(migrationsFolder) || readdirSync(migrationsFolder).length === 0) return
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const { migrate } = await import('drizzle-orm/postgres-js/migrator')
  const postgres = (await import('postgres')).default
  const client = postgres(url, { max: 1 })
  await migrate(drizzle(client), { migrationsFolder })
  await client.end()
}
