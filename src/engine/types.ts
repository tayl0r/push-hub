export type Provider = 'apns' | 'fcm'

export interface PushTarget {
  token: string
  provider: Provider
  ref?: string
}

export interface PushNotification {
  title?: string
  body?: string
  data?: Record<string, string>
  badge?: number // iOS app-icon badge (APNs only)
  sound?: string // iOS + Android
  priority?: 'high' | 'normal' // default 'high'
}

/**
 * delivered    — the provider accepted the push for this token.
 * failed       — transient or unknown per-token failure; keep the token, retry is the caller's call.
 * invalid      — the token is dead; delete it.
 * config       — the tenant's CONFIGURED provider credentials/topic are broken (expired .p8,
 *                401/403, bad topic). Nothing is wrong with the token — never delete it — and
 *                no retry helps until a human fixes the credentials. Operator-loud: this is an incident.
 * unconfigured — the tenant has no credentials for this target's provider at all (routine, e.g.
 *                Android tokens registered mid-rollout before FCM creds land). Keep the token.
 *                Observable, never paged: a state, not an incident.
 * error        — defect backstop only: a transport rejected instead of returning results.
 *                Outcome unknown; keep the token. A push-hub bug, never a tenant problem.
 */
export type SendStatus = 'delivered' | 'failed' | 'invalid' | 'config' | 'unconfigured' | 'error'

export interface SendResult {
  ref?: string
  token: string
  provider: Provider
  status: SendStatus
  retryable?: boolean
  error?: string
}

export interface ApnsConfig {
  keyId: string
  teamId: string
  bundleId: string
  signingKey: string // base64-encoded .p8
  production: boolean
}

export interface FcmConfig {
  projectId: string
  clientEmail: string
  privateKey: string // may contain literal \n escapes
}

export interface PushServiceConfig {
  apns?: ApnsConfig
  fcm?: FcmConfig
}

export interface SendRequest {
  tokens: PushTarget[]
  notification: PushNotification
}

export interface PushService {
  send(req: SendRequest): Promise<SendResult[]>
  close(): Promise<void>
}
