import Fastify, { type FastifyInstance } from 'fastify'
import { TenantRegistry } from './registry.js'
import { tokenRoutes } from './routes/tokens.js'
import { sendRoutes } from './routes/send.js'
import { tenantRoutes } from './routes/tenants.js'

export function buildApp(deps: { db: any; registry: TenantRegistry; enrollKey: string }): FastifyInstance {
  const app = Fastify({ logger: true })
  app.get('/health', async () => ({ ok: true }))
  tokenRoutes(app, deps)
  sendRoutes(app, deps)
  tenantRoutes(app, deps)
  return app
}
