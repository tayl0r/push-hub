import { describe, it, expect } from 'vitest'

// env.ts eager-parses process.env on import; satisfy the required vars first, then import it.
process.env.DATABASE_URL ??= 'postgres://u:p@localhost:5432/db'
process.env.PUSH_HUB_ENROLL_KEY ??= 'enroll-secret'
process.env.PUSH_HUB_CRED_KEY ??= 'a'.repeat(64)

const { schema } = await import('../src/env.js')

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  PUSH_HUB_ENROLL_KEY: 'enroll-secret',
  PUSH_HUB_CRED_KEY: 'a'.repeat(64),
}

describe('env schema', () => {
  it('parses a valid config and decodes the cred key to a 32-byte Buffer', () => {
    const parsed = schema.parse(base)
    expect(Buffer.isBuffer(parsed.PUSH_HUB_CRED_KEY)).toBe(true)
    expect(parsed.PUSH_HUB_CRED_KEY.length).toBe(32)
  })

  it('rejects a cred key that is not 64 hex chars (not 32 bytes)', () => {
    expect(() => schema.parse({ ...base, PUSH_HUB_CRED_KEY: 'abc' })).toThrow()
  })

  it('rejects a DATABASE_URL that is not a URL', () => {
    expect(() => schema.parse({ ...base, DATABASE_URL: 'not a url' })).toThrow()
  })

  it('rejects a missing/blank enroll key', () => {
    expect(() => schema.parse({ ...base, PUSH_HUB_ENROLL_KEY: '' })).toThrow()
  })

  it('defaults METRICS_PORT to 9464 and GIT_COMMIT to "unknown"', () => {
    const parsed = schema.parse(base)
    expect(parsed.METRICS_PORT).toBe(9464)
    expect(parsed.GIT_COMMIT).toBe('unknown')
  })

  it('coerces METRICS_PORT from a string and reads GIT_COMMIT', () => {
    const parsed = schema.parse({ ...base, METRICS_PORT: '9500', GIT_COMMIT: 'abc123' })
    expect(parsed.METRICS_PORT).toBe(9500)
    expect(parsed.GIT_COMMIT).toBe('abc123')
  })
})
