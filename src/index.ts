import * as Sentry from '@sentry/node'
import { env } from './env.js'
import { loadTenants } from './config.js'
import { db } from './db/client.js'
import { buildApp } from './app.js'

if (env.GLITCHTIP_DSN) Sentry.init({ dsn: env.GLITCHTIP_DSN, environment: env.SENTRY_ENVIRONMENT })

const tenants = loadTenants(env.PUSH_HUB_TENANTS) // throws on malformed config → deploy fails loudly
const registry = { byKeyHash: (hash: string) => tenants.get(hash) } // bridge; Task 9 swaps in the real TenantRegistry
const app = buildApp({ db, registry })
if (env.GLITCHTIP_DSN) Sentry.setupFastifyErrorHandler(app)
await app.listen({ port: env.PORT, host: '0.0.0.0' })
console.log(`push-hub listening on ${env.PORT} with ${tenants.size} tenant(s)`)
