import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Tenant, TenantLookup } from './registry.js'

declare module 'fastify' {
  interface FastifyRequest { tenant: Tenant }
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

// RFC 7235 auth schemes are case-insensitive; match "Bearer " loosely.
function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization
  return header && /^bearer /i.test(header) ? header.slice(7).trim() : null
}

export function requireTenant(lookup: TenantLookup): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = bearer(req)
    if (!key) return reply.code(401).send({ error: 'missing bearer token' })
    const tenant = lookup.byKeyHash(hashKey(key))
    if (!tenant) return reply.code(401).send({ error: 'invalid token' })
    req.tenant = tenant
  }
}

// Enrollment plane: compare the presented key to PUSH_HUB_ENROLL_KEY in constant time,
// over sha256 digests so the compare is length-independent.
export function requireEnrollKey(enrollKey: string): preHandlerHookHandler {
  const expected = createHash('sha256').update(enrollKey).digest()
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = bearer(req)
    if (!key) return reply.code(401).send({ error: 'missing bearer token' })
    const got = createHash('sha256').update(key).digest()
    if (!timingSafeEqual(got, expected)) return reply.code(401).send({ error: 'invalid enroll key' })
  }
}
