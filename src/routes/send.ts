import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as Sentry from '@sentry/node'
import { requireTenant } from '../auth.js'
import type { TenantLookup } from '../registry.js'
import { tokensForUsers, deleteByIds } from '../store.js'

const sendBody = z.object({
  to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  title: z.string().optional(),
  body: z.string().optional(),
  data: z.record(z.string()).optional(),
  badge: z.number().int().optional(),
  sound: z.string().optional(),
  priority: z.enum(['high', 'normal']).optional(),
})

export function sendRoutes(app: FastifyInstance, deps: { db: any; registry: TenantLookup }) {
  app.post('/v1/send', { preHandler: requireTenant(deps.registry) }, async (req, reply) => {
    const parsed = sendBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() })
    const { to, title, body, data, badge, sound, priority } = parsed.data
    const userIds = Array.isArray(to) ? to : [to]

    const rows = await tokensForUsers(deps.db, req.tenant.slug, userIds)
    if (rows.length === 0) return reply.send({ data: [] })

    const targets = rows.map(r => ({
      token: r.token,
      provider: r.platform === 'ios' ? ('apns' as const) : ('fcm' as const),
      ref: r.id,
    }))

    let results
    try {
      results = await req.tenant.engine.send({ tokens: targets, notification: { title, body, data, badge, sound, priority } })
    } catch (err) {
      req.log.error({ err }, 'push-hub: engine send failed (tenant misconfig?)')
      Sentry.captureException(err, { tags: { tenant: req.tenant.slug } })
      return reply.code(500).send({ error: 'send failed' })
    }

    const rowById = new Map<string | undefined, (typeof rows)[number]>(rows.map(r => [r.id, r]))
    // only delete rows this request actually fetched — deleteByIds is keyed by global PK, so never trust a ref the engine didn't get from us
    await deleteByIds(deps.db, results.filter(r => r.status === 'invalid' && r.ref && rowById.has(r.ref)).map(r => r.ref!))

    const tickets = results.map(r => ({
      userId: rowById.get(r.ref)?.userId,
      status: r.status === 'delivered' ? 'ok' : 'error',
      ...(r.status === 'delivered' ? {} : { error: r.error ?? r.status }),
    }))
    return reply.send({ data: tickets })
  })
}
