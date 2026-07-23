import { ApnsTransport } from './apns.js'
import { FcmTransport } from './fcm.js'
import type { PushNotification, PushService, PushServiceConfig, PushTarget, SendRequest, SendResult } from './types.js'

export * from './types.js'

export function createPushService(config: PushServiceConfig): PushService {
  const apns = config.apns ? new ApnsTransport(config.apns) : null
  const fcm = config.fcm ? new FcmTransport(config.fcm) : null

  const synthesized = (targets: PushTarget[], status: 'unconfigured' | 'error', error: string): SendResult[] =>
    targets.map(t => ({ ref: t.ref, token: t.token, provider: t.provider, status, error }))

  const runTransport = async (
    transport: { send(t: PushTarget[], n: PushNotification): Promise<SendResult[]> } | null,
    targets: PushTarget[],
    n: PushNotification,
  ): Promise<SendResult[]> => {
    if (!transport) return synthesized(targets, 'unconfigured', 'provider not configured')
    try {
      return await transport.send(targets, n)
    } catch (err) {
      // Backstop: after #11 a transport rejects only on a defect outside the per-target map
      // (or from onError itself). Convert to per-target results rather than reject the join —
      // a sibling transport's batch must never be collateral.
      return synthesized(targets, 'error', `transport error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    // Resolves exactly one SendResult per input target, always. Promise.all is safe here
    // precisely because runTransport absorbs rejections — it keeps the typed tuple destructure.
    async send({ tokens, notification }: SendRequest): Promise<SendResult[]> {
      const [a, f] = await Promise.all([
        runTransport(apns, tokens.filter(t => t.provider === 'apns'), notification),
        runTransport(fcm, tokens.filter(t => t.provider === 'fcm'), notification),
      ])
      return [...a, ...f]
    },
    async close(): Promise<void> {
      await Promise.all([apns?.close(), fcm?.close()])
    },
  }
}
