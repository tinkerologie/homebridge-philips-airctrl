/**
 * Minimal RFC 7252 codec — only what Philips firmware needs.
 *
 * Deliberately absent: CON/ACK retransmission, block-wise transfer, DTLS,
 * server mode, multicast. Do not add protocol surface no endpoint uses.
 * Pure functions, no I/O, so this is fully testable on byte arrays.
 */

export const CoapType = {
  Confirmable: 0,
  NonConfirmable: 1,
  Acknowledgement: 2,
  Reset: 3,
} as const

export const CoapCode = {
  GET: 1, // 0.01
  POST: 2, // 0.02
} as const

export const CoapOption = {
  Observe: 6,
  UriPath: 11,
  MaxAge: 14,
} as const

export interface CoapOptionEntry {
  number: number
  value: Buffer
}

export interface CoapMessage {
  type?: number
  code: number
  messageId: number
  token?: Buffer
  options?: CoapOptionEntry[]
  payload?: Buffer
}

export interface DecodedCoapMessage {
  type: number
  code: number
  messageId: number
  token: Buffer
  options: CoapOptionEntry[]
  payload: Buffer
}

const PAYLOAD_MARKER = 0xff

/** Shortest-form big-endian unsigned integer, as CoAP option values require. */
export function uintToBuffer(value: number): Buffer {
  if (value === 0) return Buffer.alloc(0)
  const bytes: number[] = []
  let remaining = value
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining = Math.floor(remaining / 256)
  }
  return Buffer.from(bytes)
}

export function bufferToUint(buffer: Buffer): number {
  return buffer.reduce((acc, byte) => acc * 256 + byte, 0)
}

/** Option deltas and lengths use 13/14 as escapes for 1- and 2-byte extensions. */
function nibbleFor(value: number): number {
  if (value < 13) return value
  if (value < 269) return 13
  return 14
}

function extensionFor(value: number): Buffer {
  if (value < 13) return Buffer.alloc(0)
  if (value < 269) return Buffer.from([value - 13])
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16BE(value - 269)
  return buffer
}

export function encode(message: CoapMessage): Buffer {
  const token = message.token ?? Buffer.alloc(0)
  if (token.length > 8) throw new Error(`token too long: ${token.length} bytes (max 8)`)

  const header = Buffer.alloc(4)
  header[0] = (1 << 6) | ((message.type ?? CoapType.NonConfirmable) << 4) | token.length
  header[1] = message.code
  header.writeUInt16BE(message.messageId, 2)

  // Deltas are relative to the previous option number, so options must be sorted.
  const sorted = [...(message.options ?? [])].sort((a, b) => a.number - b.number)
  const parts: Buffer[] = [header, token]
  let previous = 0
  for (const { number, value } of sorted) {
    const delta = number - previous
    parts.push(
      Buffer.from([(nibbleFor(delta) << 4) | nibbleFor(value.length)]),
      extensionFor(delta),
      extensionFor(value.length),
      value,
    )
    previous = number
  }

  if (message.payload?.length) parts.push(Buffer.from([PAYLOAD_MARKER]), message.payload)
  return Buffer.concat(parts)
}

export function decode(buffer: Buffer): DecodedCoapMessage {
  if (buffer.length < 4) throw new Error('CoAP message shorter than 4 bytes')

  const version = buffer[0]! >> 6
  if (version !== 1) throw new Error(`unsupported CoAP version ${version}`)

  const type = (buffer[0]! >> 4) & 0x03
  const tokenLength = buffer[0]! & 0x0f
  if (tokenLength > 8) throw new Error(`invalid token length ${tokenLength}`)

  const code = buffer[1]!
  const messageId = buffer.readUInt16BE(2)

  let offset = 4
  if (offset + tokenLength > buffer.length) throw new Error('truncated CoAP token')
  const token = buffer.subarray(offset, offset + tokenLength)
  offset += tokenLength

  const options: CoapOptionEntry[] = []
  let number = 0
  while (offset < buffer.length && buffer[offset] !== PAYLOAD_MARKER) {
    const byte = buffer[offset++]!
    const readExtension = (nibble: number): number => {
      if (nibble === 13) {
        if (offset >= buffer.length) throw new Error('truncated CoAP option extension')
        return buffer[offset++]! + 13
      }
      if (nibble === 14) {
        if (offset + 2 > buffer.length) throw new Error('truncated CoAP option extension')
        const value = buffer.readUInt16BE(offset) + 269
        offset += 2
        return value
      }
      if (nibble === 15) throw new Error('reserved option nibble 15')
      return nibble
    }
    const delta = readExtension(byte >> 4)
    const length = readExtension(byte & 0x0f)
    number += delta
    if (offset + length > buffer.length) throw new Error('truncated CoAP option value')
    options.push({ number, value: buffer.subarray(offset, offset + length) })
    offset += length
  }

  if (buffer[offset] === PAYLOAD_MARKER && offset + 1 === buffer.length) {
    throw new Error('CoAP payload marker without payload')
  }
  const payload = buffer[offset] === PAYLOAD_MARKER ? buffer.subarray(offset + 1) : Buffer.alloc(0)
  return { type, code, messageId, token, options, payload }
}

/** Find the first option with the given number, or undefined. */
export function findOption(
  options: CoapOptionEntry[],
  number: number,
): CoapOptionEntry | undefined {
  return options.find((option) => option.number === number)
}

/** Build the repeated Uri-Path options for a path like "/sys/dev/status". */
export function uriPathOptions(path: string): CoapOptionEntry[] {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => ({
      number: CoapOption.UriPath,
      value: Buffer.from(segment, 'utf8'),
    }))
}
