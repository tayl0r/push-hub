import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as Sentry from '@sentry/node'
import { requireTenant } from '../auth.js'
import type { TenantLookup } from '../registry.js'
import { tokensForUsers, deleteByIds } from '../store.js'
import { recordSend } from '../metrics.js'

const sendBody = z.object({
  to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  title: z.string().optional(),
  body: z.string().optional(),
  data: z.record(z.string()).optional(),
  badge: z.number().int().optional(),
  sound: z.string().optional(),
  priority: z.enum(['high', 'normal']).optional(),
})

// `name` is set explicitly so GlitchTip groups these under the dedicated type, not `Error`.
// Neither is exported: nothing outside this route constructs or catches them.
class ProviderConfigError extends Error { name = 'ProviderConfigError' }
class PushTransportDefect extends Error { name = 'PushTransportDefect' }

const distinct = (values: (string | undefined)[]): string[] =>
  [...new Set(values.map(v => v ?? 'unknown'))].sort()

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
      for (const t of targets) recordSend('error', t.provider) // domain metric stays live when per-result counting goes blind
      req.log.error({ err }, 'push-hub: engine send rejected unexpectedly (push-hub defect) — no tickets returned, cleanup skipped')
      Sentry.captureException(err, { tags: { tenant: req.tenant.slug } })
      return reply.code(500).send({ error: 'send failed' })
    }

    for (const r of results) recordSend(r.status, r.provider)

    // One event per REQUEST, not per target: a 500-device fan-out on an expired .p8 must
    // produce one GlitchTip issue, not 500. No tokens, refs or user ids in any payload.
    const configFailures = results.filter(r => r.status === 'config')
    if (configFailures.length) {
      const providers = distinct(configFailures.map(r => r.provider))
      const reasons   = distinct(configFailures.map(r => r.error))
      req.log.error(
        { tenant: req.tenant.slug, providers, reasons, failed: configFailures.length, total: results.length },
        'push-hub: provider configuration fault — tenant credentials need fixing',
      )
      Sentry.captureException(
        new ProviderConfigError(`push: ${providers.join('+')} config fault (${reasons.join(', ')})`),
        {
          tags:  { tenant: req.tenant.slug, providers: providers.join('+') },
          extra: { failed: configFailures.length, total: results.length },
        },
      )
    }

    const defects = results.filter(r => r.status === 'error')
    if (defects.length) {
      const providers = distinct(defects.map(r => r.provider))
      const reasons   = distinct(defects.map(r => r.error))
      req.log.error(
        { tenant: req.tenant.slug, providers, reasons, failed: defects.length, total: results.length },
        'push-hub: transport defect — backstop produced error results (push-hub bug, not tenant config)',
      )
      Sentry.captureException(
        new PushTransportDefect(`push: ${providers.join('+')} transport defect (${reasons.join(', ')})`),
        {
          tags:  { tenant: req.tenant.slug, providers: providers.join('+') },
          extra: { failed: defects.length, total: results.length },
        },
      )
    }

    const unconfigured = results.filter(r => r.status === 'unconfigured')
    if (unconfigured.length) {
      req.log.warn(
        {
          tenant: req.tenant.slug,
          providers: distinct(unconfigured.map(r => r.provider)),
          count: unconfigured.length,
          total: results.length,
        },
        'push-hub: send targeted a provider this tenant has not configured',
      )
      // deliberately NO Sentry: a routine mid-rollout state must not hold a GlitchTip issue open forever
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
