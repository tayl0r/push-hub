import { afterAll } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../../src/db/schema.js'
import { testClient } from './test-client.js'

// Call it at a test file's top level: the client ends in that file's afterAll.
export function testDb() {
  const db = drizzle(testClient(), { schema })
  afterAll(() => db.$client.end())
  return db
}
