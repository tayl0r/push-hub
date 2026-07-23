import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  createPushService,
  type ApnsConfig,
  type FcmConfig,
  type PushService,
  type PushServiceConfig,
} from './engine/index.js'
import { tenants } from './db/schema.js'
import { hashKey } from './auth.js'
import { encrypt, decrypt } from './crypto.js'
import { dbTimed } from './metrics.js'

type Db = any // drizzle instance; kept loose so the registry works with the app db and the test db (matches store.ts)
type BuildEngine = (config: PushServiceConfig) => PushService

export interface Tenant {
  slug: string
  apiKeyHash: string
  engine: PushService
}

export interface TenantLookup {
  byKeyHash(hash: string): Tenant | undefined
}

export class InvalidCreds extends Error {}
export class SlugTaken extends Error {}

export class TenantRegistry implements TenantLookup {
  private readonly db: Db
  private readonly credKey: Buffer
  private readonly buildEngine: BuildEngine
  private readonly byHash = new Map<string, Tenant>()

  constructor(deps: { db: Db; credKey: Buffer; buildEngine?: BuildEngine }) {
    this.db = deps.db
    this.credKey = deps.credKey
    this.buildEngine = deps.buildEngine ?? createPushService
  }

  get size(): number {
    return this.byHash.size
  }

  byKeyHash(hash: string): Tenant | undefined {
    return this.byHash.get(hash)
  }

  // Boot load: decrypt + build every tenant, throwing on any failure (fail the deploy, not the first send).
  async load(): Promise<void> {
    // dbTimed<any[]>: this.db is `any`; without the type arg T infers `unknown`
    // and the `for (const row of rows)` iteration fails tsc (same reason as
    // store.ts removeToken). insert/update below discard their result, so they don't need it.
    const rows = await dbTimed<any[]>('tenants_load', () => this.db.select().from(tenants))
    for (const row of rows) {
      const creds = JSON.parse(decrypt(this.credKey, row.credsEncrypted)) as PushServiceConfig
      const engine = this.buildEngine(creds)
      this.byHash.set(row.apiKeyHash, { slug: row.slug, apiKeyHash: row.apiKeyHash, engine })
    }
  }

  async register(input: { slug: string; apns?: ApnsConfig; fcm?: FcmConfig }): Promise<{ slug: string; apiKey: string }> {
    const creds: PushServiceConfig = { apns: input.apns, fcm: input.fcm } // the provider set minus slug — built + encrypted as one value
    const apiKey = `phk_${randomBytes(24).toString('hex')}`
    const apiKeyHash = hashKey(apiKey)
    const credsEncrypted = encrypt(this.credKey, JSON.stringify(creds))
    const engine = this.buildOrThrow(creds)                           // engine built last — nothing throwing sits between this and the teardown try
    try {
      await dbTimed('tenant_insert', () => this.db.insert(tenants).values({ slug: input.slug, apiKeyHash, credsEncrypted }))
    } catch (err) {
      await engine.close().catch(() => {})                       // don't leak the engine we built if the insert failed (e.g. a taken slug)
      if (isUniqueViolation(err)) throw new SlugTaken(input.slug) // any 23505 on insert = taken slug
      throw err
    }
    this.byHash.set(apiKeyHash, { slug: input.slug, apiKeyHash, engine }) // map updated only after commit
    return { slug: input.slug, apiKey }
  }

  async updateCredentials(tenant: Tenant, creds: PushServiceConfig): Promise<void> {
    const credsEncrypted = encrypt(this.credKey, JSON.stringify(creds))
    const engine = this.buildOrThrow(creds)                           // engine built last — nothing throwing sits between this and the teardown try
    try {
      await dbTimed('tenant_update', () => this.db.update(tenants).set({ credsEncrypted, updatedAt: new Date() }).where(eq(tenants.apiKeyHash, tenant.apiKeyHash)))
    } catch (err) {
      await engine.close().catch(() => {}) // don't leak the engine we built if the UPDATE failed
      throw err
    }
    const previous = this.byHash.get(tenant.apiKeyHash)
    this.byHash.set(tenant.apiKeyHash, { ...tenant, engine })
    await previous?.engine.close().catch(() => {}) // close the replaced engine; a close failure must not 500 a succeeded update
  }

  // require ≥1 provider and a buildable provider set; both failures surface as InvalidCreds (→ 400).
  private buildOrThrow(creds: PushServiceConfig): PushService {
    if (!creds.apns && !creds.fcm) throw new InvalidCreds('at least one of apns/fcm is required')
    try {
      return this.buildEngine(creds)
    } catch (err) {
      throw new InvalidCreds(err instanceof Error ? err.message : String(err))
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  // postgres-js surfaces the raw PostgresError with `.code`; a future drizzle bump (≥0.44) may wrap it under `.cause`.
  const code = (err as any)?.code ?? (err as any)?.cause?.code
  return code === '23505'
}
