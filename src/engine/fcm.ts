import { GoogleAuth } from 'google-auth-library'
import type { FcmConfig, PushNotification, PushTarget, SendResult } from './types.js'
import { classifyFcm, type Classification } from './classify.js'
import { mapWithConcurrency, retryTransient } from './concurrency.js'

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const CONCURRENCY = 10

class FcmError extends Error {
  constructor(public classification: Classification, public reason: string) {
    super(reason)
  }
}

export class FcmTransport {
  private auth: GoogleAuth
  private endpoint: string

  constructor(config: FcmConfig) {
    if (!config.projectId || !config.clientEmail || !config.privateKey) {
      throw new Error('[fcm] projectId, clientEmail and privateKey are all required')
    }
    const privateKey = config.privateKey.replace(/\\n/g, '\n') // normalize escaped newlines
    this.auth = new GoogleAuth({
      credentials: { client_email: config.clientEmail, private_key: privateKey },
      scopes: [FCM_SCOPE],
    })
    this.endpoint = `https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`
  }

  private async accessToken(): Promise<string> {
    const client = await this.auth.getClient()
    const { token } = await client.getAccessToken()
    if (!token) throw new FcmError({ kind: 'config' }, 'no access token')
    return token
  }

  private body(target: PushTarget, n: PushNotification): string {
    const android: Record<string, unknown> = { priority: n.priority === 'normal' ? 'normal' : 'high' } // default high priority
    if (n.sound) android.notification = { sound: n.sound }
    return JSON.stringify({
      message: {
        token: target.token,
        notification: { title: n.title, body: n.body },
        data: n.data,
        android,
      },
    })
  }

  async send(targets: PushTarget[], n: PushNotification): Promise<SendResult[]> {
    return mapWithConcurrency(
      targets,
      CONCURRENCY,
      async (target): Promise<SendResult> => {
        const attempt = async () => {
          const token = await this.accessToken()
          const res = await fetch(this.endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: this.body(target, n),
          })
          if (res.ok) return
          const payload = (await res.json().catch(() => ({}))) as {
            error?: { status?: string; message?: string; details?: Array<{ '@type'?: string; errorCode?: string }> }
          }
          // The FCM-specific code lives in details[].errorCode (@type …v1.FcmError), not error.status.
          const detail = payload.error?.details?.find(
            d => d['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
          )
          const fcmCode = detail?.errorCode ?? payload.error?.status
          throw new FcmError(classifyFcm(res.status, fcmCode), fcmCode ?? `HTTP ${res.status}`)
        }
        await retryTransient(attempt, (e) => e instanceof FcmError && e.classification.kind === 'transient')
        return { ref: target.ref, token: target.token, provider: 'fcm', status: 'delivered' }
      },
      // Every per-target throw becomes exactly one SendResult here — including accessToken()'s
      // `no access token` FcmError, which is raised inside `attempt` and classified `config`.
      (target, e): SendResult => {
        const c = e instanceof FcmError ? e.classification : { kind: 'failed' as const }
        const reason = e instanceof Error ? e.message : String(e)
        if (c.kind === 'config') return { ref: target.ref, token: target.token, provider: 'fcm', status: 'config', error: reason }
        if (c.kind === 'invalid') return { ref: target.ref, token: target.token, provider: 'fcm', status: 'invalid', error: reason }
        return { ref: target.ref, token: target.token, provider: 'fcm', status: 'failed', retryable: c.kind === 'transient', error: reason }
      },
    )
  }

  async close(): Promise<void> {
    // GoogleAuth holds no persistent sockets or timers — nothing to tear down.
  }
}
