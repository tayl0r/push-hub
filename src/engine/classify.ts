export type Classification = { kind: 'invalid' | 'transient' | 'failed' | 'config' }

const APNS_INVALID = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic'])
const APNS_TRANSIENT = new Set(['TooManyRequests', 'InternalServerError', 'ServiceUnavailable', 'Shutdown'])
const APNS_CONFIG = new Set([
  'InvalidProviderToken', 'ExpiredProviderToken', 'BadTopic', 'TopicDisallowed', 'MissingTopic',
])

export function classifyApns(reason: string): Classification {
  if (APNS_INVALID.has(reason)) return { kind: 'invalid' }
  if (APNS_TRANSIENT.has(reason)) return { kind: 'transient' }
  if (APNS_CONFIG.has(reason)) return { kind: 'config' }
  return { kind: 'failed' } // default-safe: unknown/payload never deletes a token
}

const FCM_TRANSIENT = new Set([429, 500, 503])

export function classifyFcm(httpStatus: number, fcmCode?: string): Classification {
  // fcmCode is the FCM-specific code from error.details[].errorCode — NOT error.status
  // (error.status carries the canonical gRPC status: NOT_FOUND, PERMISSION_DENIED, …).
  if (fcmCode === 'UNREGISTERED') return { kind: 'invalid' }
  if (fcmCode === 'SENDER_ID_MISMATCH') return { kind: 'invalid' }
  if (fcmCode === 'INVALID_ARGUMENT') return { kind: 'failed' } // never invalid — also fires on payload bugs
  if (httpStatus === 401 || httpStatus === 403) return { kind: 'config' } // UNAUTHENTICATED / PERMISSION_DENIED
  if (FCM_TRANSIENT.has(httpStatus)) return { kind: 'transient' } // 429/500/503
  return { kind: 'failed' } // default-safe, never invalid
}
