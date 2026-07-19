import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const client = postgres(process.env.DATABASE_URL!)
await migrate(drizzle(client), { migrationsFolder: path.resolve(__dirname, '../migrations') })
console.log('Migrations applied')
await client.end()
