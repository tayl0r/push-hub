import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Tenant } from './config.js'

declare module 'fastify' {
  interface FastifyRequest { tenant: Tenant }
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function requireTenant(tenants: Map<string, Tenant>): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization
    // RFC 7235 auth schemes are case-insensitive; match "Bearer " loosely
    const key = header && /^bearer /i.test(header) ? header.slice(7).trim() : null
    if (!key) return reply.code(401).send({ error: 'missing bearer token' })
    const tenant = tenants.get(hashKey(key))
    if (!tenant) return reply.code(401).send({ error: 'invalid token' })
    req.tenant = tenant
  }
}
