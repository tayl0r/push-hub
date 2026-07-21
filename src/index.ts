import * as Sentry from '@sentry/node'
import { env } from './env.js'
import { db } from './db/client.js'
import { TenantRegistry } from './registry.js'
import { buildApp } from './app.js'

if (env.GLITCHTIP_DSN)
  Sentry.init({
    dsn: env.GLITCHTIP_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    // Tenant-route request bodies ARE plaintext provider creds (APNs .p8 / FCM key).
    // Never let a 5xx ship them to GlitchTip — creds-at-rest is the whole point.
    integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' })],
  })

const registry = new TenantRegistry({ db, credKey: env.PUSH_HUB_CRED_KEY })
await registry.load() // decrypts + builds every tenant; throws → deploy fails loud on a wrong cred key
const app = buildApp({ db, registry, enrollKey: env.PUSH_HUB_ENROLL_KEY })
if (env.GLITCHTIP_DSN) Sentry.setupFastifyErrorHandler(app)
await app.listen({ port: env.PORT, host: '0.0.0.0' })
console.log(`push-hub listening on ${env.PORT} with ${registry.size} tenant(s)`)
