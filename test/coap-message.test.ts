import { describe, expect, it } from 'vitest'
import {
  CoapCode,
  CoapOption,
  CoapType,
  bufferToUint,
  decode,
  encode,
  uintToBuffer,
} from '../src/airctrl/coap/message.js'

const uriPath = (path: string) =>
  path
    .split('/')
    .filter(Boolean)
    .map((segment) => ({ number: CoapOption.UriPath, value: Buffer.from(segment) }))

describe('uintToBuffer / bufferToUint', () => {
  it.each([
    [0, ''],
    [60, '3c'],
    [900, '0384'],
    [0xffffff, 'ffffff'],
  ])('encodes %i as shortest-form big-endian %s', (value, hex) => {
    expect(uintToBuffer(value).toString('hex')).toBe(hex)
  })

  it('round-trips', () => {
    for (const value of [0, 1, 60, 900, 0xffff, 0xffffff]) {
      expect(bufferToUint(uintToBuffer(value))).toBe(value)
    }
  })
})

describe('encode golden vectors', () => {
  it('encodes GET /sys/dev/status with Observe', () => {
    const bytes = encode({
      type: CoapType.NonConfirmable,
      code: CoapCode.GET,
      messageId: 0x1234,
      token: Buffer.from('deadbeef', 'hex'),
      options: [
        ...uriPath('/sys/dev/status'),
        { number: CoapOption.Observe, value: uintToBuffer(0) },
      ],
    })
    expect(bytes.toString('hex')).toBe('54011234deadbeef60537379730364657606737461747573')
  })

  it('encodes POST /sys/dev/sync with a payload', () => {
    const bytes = encode({
      type: CoapType.NonConfirmable,
      code: CoapCode.POST,
      messageId: 1,
      token: Buffer.from('01020304', 'hex'),
      options: uriPath('/sys/dev/sync'),
      payload: Buffer.from('ABCD1234'),
    })
    expect(bytes.toString('hex')).toBe(
      '5402000101020304b3737973036465760473796e63ff4142434431323334',
    )
  })

  it('sorts options by number regardless of caller order', () => {
    const observeFirst = encode({
      code: CoapCode.GET,
      messageId: 0x1234,
      token: Buffer.from('deadbeef', 'hex'),
      options: [
        { number: CoapOption.Observe, value: uintToBuffer(0) },
        ...uriPath('/sys/dev/status'),
      ],
    })
    expect(observeFirst.toString('hex')).toBe('54011234deadbeef60537379730364657606737461747573')
  })
})

describe('decode', () => {
  it('round-trips a full message', () => {
    const original = {
      type: CoapType.NonConfirmable,
      code: CoapCode.POST,
      messageId: 0xbeef,
      token: Buffer.from('0a0b0c0d', 'hex'),
      options: [
        ...uriPath('/sys/dev/control'),
        { number: CoapOption.MaxAge, value: uintToBuffer(60) },
      ],
      payload: Buffer.from('{"a":1}'),
    }
    const decoded = decode(encode(original))
    expect(decoded.type).toBe(CoapType.NonConfirmable)
    expect(decoded.code).toBe(CoapCode.POST)
    expect(decoded.messageId).toBe(0xbeef)
    expect(decoded.token.toString('hex')).toBe('0a0b0c0d')
    expect(decoded.payload.toString()).toBe('{"a":1}')
    expect(
      decoded.options.filter((o) => o.number === CoapOption.UriPath).map((o) => o.value.toString()),
    ).toEqual(['sys', 'dev', 'control'])
    expect(bufferToUint(decoded.options.find((o) => o.number === CoapOption.MaxAge)!.value)).toBe(
      60,
    )
  })

  it.each([13, 268, 269, 1000])(
    'round-trips an option of length %i via the extension nibbles',
    (length) => {
      const decoded = decode(
        encode({
          code: CoapCode.GET,
          messageId: 1,
          options: [{ number: CoapOption.UriPath, value: Buffer.alloc(length, 0x61) }],
        }),
      )
      expect(decoded.options[0]!.value.length).toBe(length)
    },
  )

  it.each([13, 268, 269, 1000])(
    'round-trips an option delta of %i via the extension nibbles',
    (delta) => {
      // Two options: number 0 (delta 0) and number `delta` (delta = delta - 0),
      // so the second option's delta nibble exercises the same 13/14 escapes
      // already covered above for option length.
      const decoded = decode(
        encode({
          code: CoapCode.GET,
          messageId: 1,
          options: [
            { number: 0, value: Buffer.alloc(0) },
            { number: delta, value: Buffer.from('x') },
          ],
        }),
      )
      expect(decoded.options).toHaveLength(2)
      expect(decoded.options[0]!.number).toBe(0)
      expect(decoded.options[1]!.number).toBe(delta)
      expect(decoded.options[1]!.value.toString()).toBe('x')
    },
  )

  it('parses a 2.05 Content response code', () => {
    const decoded = decode(encode({ code: 69, messageId: 1 })) // 2.05 = (2 << 5) | 5
    expect(decoded.code).toBe(69)
    expect(decoded.code >> 5).toBe(2)
    expect(decoded.code & 0x1f).toBe(5)
  })

  it('rejects malformed input', () => {
    expect(() => decode(Buffer.alloc(3))).toThrow(/4 bytes/)
    expect(() => decode(Buffer.from([0x00, 0x01, 0x00, 0x01]))).toThrow(/version/) // version 0
    expect(() => decode(Buffer.from([0x4f, 0x01, 0x00, 0x01]))).toThrow(/token length/) // TKL 15
    expect(() => decode(Buffer.from('44010001deadbe', 'hex'))).toThrow(/truncated/) // token
    expect(() => decode(Buffer.from('54450001deadbeefd0', 'hex'))).toThrow(/truncated/) // option extension
    expect(() => decode(Buffer.from('400100011361', 'hex'))).toThrow(/truncated/) // option value
    expect(() => decode(Buffer.from('54450001deadbeefff', 'hex'))).toThrow(/payload marker/)
    expect(() => decode(Buffer.from([0x40, 0x01, 0x00, 0x01, 0xf0]))).toThrow(/reserved/) // nibble 15
  })

  it('handles a message with no options and no payload', () => {
    const decoded = decode(encode({ code: CoapCode.GET, messageId: 7 }))
    expect(decoded.options).toEqual([])
    expect(decoded.payload.length).toBe(0)
  })
})
