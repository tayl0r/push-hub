import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env.js'
import * as schema from './schema.js'

const client = postgres(env.DATABASE_URL)
// Every query call-site must be wrapped in dbTimed(operation, …) — see src/metrics.ts (no driver-level duration hook exists).
export const db = drizzle(client, { schema })
export { schema }
