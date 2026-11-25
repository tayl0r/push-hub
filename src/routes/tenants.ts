import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ApnsConfig, FcmConfig } from '../engine/index.js'
import { requireEnrollKey, requireTenant } from '../auth.js'
import { TenantRegistry, InvalidCreds, SlugTaken } from '../registry.js'

const provider = z.looseObject({}) // provider shape is validated by the engine at build time, not here
const providerFields = { apns: provider.optional(), fcm: provider.optional() }

// RFC 1123 / DNS-1123 label (as Kubernetes enforces): lowercase alphanumeric + internal
// hyphens, must start and end alphanumeric, 1–63 chars. Slugs are permanent tenant identities,
// so reject non-conforming input rather than normalizing it.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

const registerBody = z.object({
  slug: z.string().regex(SLUG_RE, 'slug must be a lowercase DNS-1123 label (a-z, 0-9, hyphens; start/end alphanumeric; ≤63 chars)'),
  ...providerFields,
})
// No ≥1-provider refine: the registry's buildOrThrow is the single owner of that rule and runs on
// both register + updateCredentials, so both routes reject zero providers identically — via
// InvalidCreds → 400 (same status AND same error body) — and stay symmetric.
const credsBody = z.object({ ...providerFields })

export function tenantRoutes(app: FastifyInstance, deps: { registry: TenantRegistry; enrollKey: string }) {
  app.post('/v1/tenants', { preHandler: requireEnrollKey(deps.enrollKey) }, async (req, reply) => {
    const parsed = registerBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', details: z.flattenError(parsed.error) })
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
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', details: z.flattenError(parsed.error) })
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
