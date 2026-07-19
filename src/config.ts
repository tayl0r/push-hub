import { createPushService, type ApnsConfig, type FcmConfig, type PushService } from '@tsteil/push-service'

export interface Tenant {
  slug: string
  apiKeyHash: string
  engine: PushService
}

interface TenantInput {
  slug: string
  apiKeyHash: string
  apns?: ApnsConfig
  fcm?: FcmConfig
}

export function loadTenants(json: string): Map<string, Tenant> {
  const parsed = JSON.parse(json) as TenantInput[]
  const byHash = new Map<string, Tenant>()
  for (const t of parsed) {
    if (!t.slug || !t.apiKeyHash) throw new Error(`push-hub: tenant needs slug and apiKeyHash (got ${JSON.stringify(t)})`)
    if (!t.apns && !t.fcm) throw new Error(`push-hub: tenant ${t.slug} must configure at least one of apns/fcm`)
    // createPushService throws on a malformed present provider block — fail the deploy, not the first send.
    const engine = createPushService({ apns: t.apns, fcm: t.fcm })
    byHash.set(t.apiKeyHash, { slug: t.slug, apiKeyHash: t.apiKeyHash, engine })
  }
  return byHash
}
