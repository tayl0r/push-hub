import { createRequire } from 'node:module'
import * as Sentry from '@sentry/node'
import { env } from './env.js'
import { db } from './db/client.js'
import { TenantRegistry } from './registry.js'
import { buildApp } from './app.js'
import { setBuildInfo, registerSampledGauges, startMetricsServer } from './metrics.js'
import { countTokens } from './store.js'

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

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }
setBuildInfo({ version, commit: env.GIT_COMMIT })
registerSampledGauges({ tenantsCount: () => registry.size, tokensCount: () => countTokens(db) })
startMetricsServer(env.METRICS_PORT, '0.0.0.0')

await app.listen({ port: env.PORT, host: '0.0.0.0' })
console.log(`push-hub listening on ${env.PORT} (metrics on ${env.METRICS_PORT}) with ${registry.size} tenant(s)`)
