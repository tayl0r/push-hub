import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encrypt, decrypt } from '../src/crypto.js'

const key = randomBytes(32)

describe('crypto', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const plaintext = JSON.stringify({ apns: { keyId: 'K', bundleId: 'com.example.app' } })
    expect(decrypt(key, encrypt(key, plaintext))).toBe(plaintext)
  })

  it('produces a different ciphertext each call (random IV)', () => {
    expect(encrypt(key, 'x')).not.toBe(encrypt(key, 'x'))
  })

  it('decrypt throws on a wrong key', () => {
    const blob = encrypt(key, 'secret')
    expect(() => decrypt(randomBytes(32), blob)).toThrow()
  })

  it('decrypt throws on a tampered blob (auth tag mismatch)', () => {
    const buf = Buffer.from(encrypt(key, 'secret'), 'base64')
    buf[buf.length - 1] ^= 0xff // flip a ciphertext byte
    expect(() => decrypt(key, buf.toString('base64'))).toThrow()
  })

  it('the ciphertext is not the plaintext', () => {
    expect(encrypt(key, 'com.example.app')).not.toContain('com.example.app')
  })
})
