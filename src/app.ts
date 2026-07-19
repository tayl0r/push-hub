import Fastify, { type FastifyInstance } from 'fastify'
import type { Tenant } from './config.js'
import { tokenRoutes } from './routes/tokens.js'
import { sendRoutes } from './routes/send.js'

export function buildApp(deps: { db: any; tenants: Map<string, Tenant> }): FastifyInstance {
  const app = Fastify({ logger: true })
  app.get('/health', async () => ({ ok: true }))
  tokenRoutes(app, deps)
  sendRoutes(app, deps)
  return app
}
