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

export type SendStatus = 'delivered' | 'failed' | 'invalid'

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
