import { ApnsClient, Notification, Priority, PushType, ApnsError } from 'apns2'
import type { ApnsConfig, PushNotification, PushTarget, SendResult } from './types.js'
import { classifyApns } from './classify.js'
import { mapWithConcurrency, retryTransient } from './concurrency.js'

const CONCURRENCY = 50 // HTTP/2 multiplexes over one connection

export class ApnsTransport {
  private client: ApnsClient
  private bundleId: string

  constructor(config: ApnsConfig) {
    if (!config.keyId || !config.teamId || !config.bundleId || !config.signingKey) {
      throw new Error('[apns] keyId, teamId, bundleId and signingKey are all required')
    }
    const pem = Buffer.from(config.signingKey, 'base64').toString('utf8')
    if (!pem.includes('BEGIN PRIVATE KEY')) {
      throw new Error('[apns] signingKey must be the base64-encoded contents of the .p8 file')
    }
    this.bundleId = config.bundleId
    this.client = new ApnsClient({
      team: config.teamId,
      keyId: config.keyId,
      signingKey: pem,
      defaultTopic: config.bundleId,
      host: config.production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com',
    })
  }

  private notification(target: PushTarget, n: PushNotification): Notification {
    return new Notification(target.token, {
      alert: { title: n.title ?? '', body: n.body ?? '' }, // apns2 requires non-optional strings under strict
      data: n.data,
      badge: n.badge,
      sound: n.sound,
      type: PushType.alert,
      priority: n.priority === 'normal' ? Priority.throttled : Priority.immediate, // default high priority
    })
  }

  async send(targets: PushTarget[], n: PushNotification): Promise<SendResult[]> {
    return mapWithConcurrency(
      targets,
      CONCURRENCY,
      async (target): Promise<SendResult> => {
        await retryTransient(
          () => this.client.send(this.notification(target, n)),
          (e) => e instanceof ApnsError && classifyApns(e.reason).kind === 'transient',
        )
        return { ref: target.ref, token: target.token, provider: 'apns', status: 'delivered' }
      },
      // Every per-target throw — classified provider error, network failure, or a future bug in
      // the callback — becomes exactly one SendResult here. A config fault is reported as a
      // `config` result, never a throw: loudness lives on the observability plane (see #11).
      (target, e): SendResult => {
        const c = e instanceof ApnsError ? classifyApns(e.reason) : { kind: 'failed' as const }
        const reason = e instanceof ApnsError ? e.reason : e instanceof Error ? e.message : String(e)
        if (c.kind === 'config') return { ref: target.ref, token: target.token, provider: 'apns', status: 'config', error: reason }
        if (c.kind === 'invalid') return { ref: target.ref, token: target.token, provider: 'apns', status: 'invalid', error: reason }
        return { ref: target.ref, token: target.token, provider: 'apns', status: 'failed', retryable: c.kind === 'transient', error: reason }
      },
    )
  }

  async close(): Promise<void> {
    await this.client.destroy() // apns2 clears its keep-alive interval + tears down the undici pool
  }
}
