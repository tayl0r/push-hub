import { describe, it, expect } from 'vitest'
import { classifyApns, classifyFcm } from '../../src/engine/classify.js'

describe('classifyApns', () => {
  it('maps dead-token reasons to invalid', () => {
    for (const r of ['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic']) {
      expect(classifyApns(r).kind).toBe('invalid')
    }
  })
  it('maps transient reasons to transient', () => {
    for (const r of ['TooManyRequests', 'InternalServerError', 'ServiceUnavailable', 'Shutdown']) {
      expect(classifyApns(r).kind).toBe('transient')
    }
  })
  it('maps auth/topic reasons to config', () => {
    for (const r of ['InvalidProviderToken', 'ExpiredProviderToken', 'BadTopic', 'TopicDisallowed', 'MissingTopic']) {
      expect(classifyApns(r).kind).toBe('config')
    }
  })
  it('defaults unknown/payload reasons to failed (never invalid)', () => {
    for (const r of ['PayloadTooLarge', 'PayloadEmpty', 'BadMessageId', 'SomethingBrandNew', '']) {
      expect(classifyApns(r).kind).toBe('failed')
    }
  })
})

describe('classifyFcm', () => {
  it('maps UNREGISTERED / SENDER_ID_MISMATCH (from details errorCode) to invalid', () => {
    expect(classifyFcm(404, 'UNREGISTERED').kind).toBe('invalid')
    expect(classifyFcm(403, 'SENDER_ID_MISMATCH').kind).toBe('invalid')
  })
  it('maps INVALID_ARGUMENT to failed, NEVER invalid', () => {
    expect(classifyFcm(400, 'INVALID_ARGUMENT').kind).toBe('failed')
  })
  it('maps auth 401/403 (no invalid errorCode) to config', () => {
    expect(classifyFcm(401, 'UNAUTHENTICATED').kind).toBe('config')
    expect(classifyFcm(403, 'PERMISSION_DENIED').kind).toBe('config')
  })
  it('maps 429/500/503 to transient', () => {
    for (const s of [429, 500, 503]) expect(classifyFcm(s, 'UNAVAILABLE').kind).toBe('transient')
  })
  it('defaults unknown to failed', () => {
    expect(classifyFcm(418, undefined).kind).toBe('failed')
  })
  it('404 with only a canonical status (or no code) → failed, never invalid', () => {
    // NOT_FOUND here is the gRPC canonical status, not the FcmError UNREGISTERED code.
    expect(classifyFcm(404, 'NOT_FOUND').kind).toBe('failed')
    expect(classifyFcm(404, undefined).kind).toBe('failed')
  })
})
