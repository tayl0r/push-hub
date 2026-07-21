import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ApnsConfig, FcmConfig } from '@tsteil/push-service'
import { requireEnrollKey, requireTenant } from '../auth.js'
import { TenantRegistry, InvalidCreds, SlugTaken } from '../registry.js'

const provider = z.object({}).passthrough() // provider shape is validated by the engine at build time, not here
const providerFields = { apns: provider.optional(), fcm: provider.optional() }

const registerBody = z.object({ slug: z.string().min(1), ...providerFields })
// No ≥1-provider refine: the registry's buildOrThrow is the single owner of that rule and runs on
// both register + updateCredentials, so both routes reject zero providers identically — via
// InvalidCreds → 400 (same status AND same error body) — and stay symmetric.
const credsBody = z.object({ ...providerFields })

export function tenantRoutes(app: FastifyInstance, deps: { registry: TenantRegistry; enrollKey: string }) {
  app.post('/v1/tenants', { preHandler: requireEnrollKey(deps.enrollKey) }, async (req, reply) => {
    const parsed = registerBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() })
    try {
      const { slug, apiKey } = await deps.registry.register({
        slug: parsed.data.slug,
        apns: parsed.data.apns as ApnsConfig | undefined,
        fcm: parsed.data.fcm as FcmConfig | undefined,
      })
      return reply.code(201).send({ slug, apiKey })
    } catch (err) {
      if (err instanceof SlugTaken) return reply.code(409).send({ error: 'slug already registered' })
      if (err instanceof InvalidCreds) return reply.code(400).send({ error: err.message })
      throw err
    }
  })

  app.put('/v1/tenant/credentials', { preHandler: requireTenant(deps.registry) }, async (req, reply) => {
    const parsed = credsBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() })
    try {
      await deps.registry.updateCredentials(req.tenant, {
        apns: parsed.data.apns as ApnsConfig | undefined,
        fcm: parsed.data.fcm as FcmConfig | undefined,
      })
      return reply.send({ ok: true })
    } catch (err) {
      if (err instanceof InvalidCreds) return reply.code(400).send({ error: err.message })
      throw err
    }
  })
}
