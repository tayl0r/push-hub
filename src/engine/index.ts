import { ApnsTransport } from './apns.js'
import { FcmTransport } from './fcm.js'
import type { PushService, PushServiceConfig, PushTarget, SendRequest, SendResult } from './types.js'

export * from './types.js'

export function createPushService(config: PushServiceConfig): PushService {
  const apns = config.apns ? new ApnsTransport(config.apns) : null
  const fcm = config.fcm ? new FcmTransport(config.fcm) : null

  const notConfigured = (targets: PushTarget[]): SendResult[] =>
    targets.map(t => ({ ref: t.ref, token: t.token, provider: t.provider, status: 'failed', error: 'provider not configured' }))

  return {
    async send({ tokens, notification }: SendRequest): Promise<SendResult[]> {
      const apnsTargets = tokens.filter(t => t.provider === 'apns')
      const fcmTargets = tokens.filter(t => t.provider === 'fcm')
      const [a, f] = await Promise.all([
        apns ? apns.send(apnsTargets, notification) : Promise.resolve(notConfigured(apnsTargets)),
        fcm ? fcm.send(fcmTargets, notification) : Promise.resolve(notConfigured(fcmTargets)),
      ])
      return [...a, ...f]
    },
    async close(): Promise<void> {
      await Promise.all([apns?.close(), fcm?.close()])
    },
  }
}
