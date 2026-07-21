import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireTenant } from '../auth.js'
import type { TenantLookup } from '../registry.js'
import { registerToken, removeToken } from '../store.js'

const registerBody = z.object({ userId: z.string().min(1), token: z.string().min(1), platform: z.enum(['ios', 'android']) })
const removeBody = z.object({ token: z.string().min(1) })

export function tokenRoutes(app: FastifyInstance, deps: { db: any; registry: TenantLookup }) {
  app.post('/v1/tokens', { preHandler: requireTenant(deps.registry) }, async (req, reply) => {
    const parsed = registerBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() })
    const { userId, token, platform } = parsed.data
    await registerToken(deps.db, req.tenant.slug, userId, token, platform)
    return reply.send({ ok: true })
  })

  app.delete('/v1/tokens', { preHandler: requireTenant(deps.registry) }, async (req, reply) => {
    const parsed = removeBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() })
    const deleted = await removeToken(deps.db, req.tenant.slug, parsed.data.token)
    return reply.send({ ok: true, deleted })
  })
}
