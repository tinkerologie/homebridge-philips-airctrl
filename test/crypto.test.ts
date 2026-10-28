import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DigestMismatchError,
  MalformedPayloadError,
  decrypt,
  deriveKeyAndIv,
  encrypt,
  nextKey,
} from '../src/airctrl/crypto.js'

describe('nextKey', () => {
  // Python: (int(k, 16) + 1) & 0xFFFFFFFF, formatted as 4 big-endian bytes.
  // JS `&` is SIGNED 32-bit and returns -80000000 for the first case.
  it.each([
    ['0DC377BA', '0DC377BB'],
    ['0000000F', '00000010'],
    ['7FFFFFFF', '80000000'], // regression: signed AND breaks here
    ['80000000', '80000001'], // regression: signed AND breaks here
    ['FFFFFFFF', '00000000'], // wraps to zero
  ])('increments %s to %s', (input, expected) => {
    expect(nextKey(input)).toBe(expected)
  })
})

describe('deriveKeyAndIv', () => {
  it('derives key and IV from MD5("JiangPan" + clientKey)', () => {
    const { key, iv } = deriveKeyAndIv('0DC377BA')
    // MD5("JiangPan0DC377BA") = 58C810828608D8F6E4C37DBC8DAC1FC9
    expect(key.toString('ascii')).toBe('58C810828608D8F6')
    expect(iv.toString('ascii')).toBe('E4C37DBC8DAC1FC9')
  })
})

describe('encrypt / decrypt', () => {
  it('rejects even-length non-hex ciphertext even with a recomputed valid digest (#45)', () => {
    const body = '0DC377BA' + 'GG'.repeat(16)
    const digest = createHash('sha256').update(body).digest('hex').toUpperCase()
    expect(() => decrypt(body + digest)).toThrow(MalformedPayloadError)
  })
  it('round-trips a JSON payload', () => {
    const payload = JSON.stringify({ state: { desired: { D03102: 1 } } })
    expect(decrypt(encrypt('0DC377BA', payload))).toBe(payload)
  })

  it('produces key + ciphertext + 64-char digest, all uppercase hex', () => {
    const blob = encrypt('0DC377BA', '{"test":1}')
    expect(blob.slice(0, 8)).toBe('0DC377BA')
    expect(blob).toHaveLength(8 + 32 + 64) // 10 bytes padded to 32 hex chars
    expect(blob).toBe(blob.toUpperCase())
  })

  it('throws DigestMismatchError when the digest is tampered with', () => {
    const blob = encrypt('0DC377BA', '{"test":1}')
    const tampered = `${blob.slice(0, -1)}${blob.at(-1) === '0' ? '1' : '0'}`
    expect(() => decrypt(tampered)).toThrow(DigestMismatchError)
  })

  it('fails cleanly, not with a raw OpenSSL error, on a short/truncated blob', () => {
    // Shorter than clientKey(8) + digest(64): rejected by the shape check
    // before any digest or cipher work happens.
    expect(() => decrypt('0DC377BA')).toThrow(MalformedPayloadError)
    expect(() => decrypt('')).toThrow(MalformedPayloadError)
  })

  it('throws a typed MalformedPayloadError (not a raw OpenSSL error) on an odd-length hex ciphertext', () => {
    // Digest-valid but wire-corrupted: drop one hex nibble from the ciphertext,
    // then recompute the digest so decrypt() gets past the digest check and
    // would otherwise reach Buffer.from(ciphertext, 'hex') / decipher with a
    // corrupt, odd-length string — the realistic wire-corruption path, distinct
    // from tampering. The shape check now catches this before the cipher runs,
    // so it throws a clean MalformedPayloadError instead of OpenSSL's own
    // "wrong final block length" error.
    const blob = encrypt('0DC377BA', '{"test":1}')
    const clientKey = blob.slice(0, 8)
    const ciphertext = blob.slice(8, -64).slice(0, -1)
    const digest = createHash('sha256')
      .update(clientKey + ciphertext)
      .digest('hex')
      .toUpperCase()
    expect(() => decrypt(clientKey + ciphertext + digest)).toThrow(MalformedPayloadError)
  })
})
