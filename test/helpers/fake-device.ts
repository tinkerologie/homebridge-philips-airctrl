import { createSocket, type RemoteInfo } from 'node:dgram'
import {
  CoapOption,
  CoapType,
  type CoapOptionEntry,
  type DecodedCoapMessage,
  bufferToUint,
  decode,
  encode,
} from '../../src/airctrl/coap/message.js'

export const CONTENT_2_05 = 69

export interface FakeResponse {
  payload?: string | Buffer
  options?: CoapOptionEntry[]
  code?: number
}

export type FakeHandler = (
  request: DecodedCoapMessage,
) => FakeResponse | undefined | Promise<FakeResponse | undefined>

export interface FakeDevice {
  port: number
  requests: DecodedCoapMessage[]
  push(payload: string | Buffer, options?: CoapOptionEntry[]): Promise<void>
  close(): Promise<void>
}

export function pathOf(message: DecodedCoapMessage): string {
  const segments = message.options
    .filter((option) => option.number === CoapOption.UriPath)
    .map((option) => option.value.toString('utf8'))
  return `/${segments.join('/')}`
}

export async function startFakeDevice(handler: FakeHandler): Promise<FakeDevice> {
  const socket = createSocket('udp4')
  const requests: DecodedCoapMessage[] = []
  let observer: { token: Buffer; remote: RemoteInfo } | undefined
  let nextMessageId = 1
  let closed = false

  const send = (
    token: Buffer,
    remote: RemoteInfo,
    payload: string | Buffer,
    options: CoapOptionEntry[] = [],
    code = CONTENT_2_05,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      socket.send(
        encode({
          type: CoapType.NonConfirmable,
          code,
          messageId: nextMessageId++,
          token,
          options,
          payload: Buffer.from(payload),
        }),
        remote.port,
        remote.address,
        (error) => (error ? reject(error) : resolve()),
      )
    })

  socket.on('message', (buffer, remote) => {
    void (async () => {
      const request = decode(buffer)
      requests.push(request)

      const observe = request.options.find((option) => option.number === CoapOption.Observe)
      if (observe && bufferToUint(observe.value) === 0) {
        observer = { token: Buffer.from(request.token), remote }
      } else if (
        observe &&
        bufferToUint(observe.value) === 1 &&
        observer?.token.equals(request.token)
      ) {
        observer = undefined
      }

      const response = await handler(request)
      if (!response) return
      await send(
        request.token,
        remote,
        response.payload ?? Buffer.alloc(0),
        response.options,
        response.code,
      )
    })().catch(() => {})
  })

  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
  const address = socket.address()

  return {
    port: address.port,
    requests,
    push(payload, options = []) {
      if (!observer) throw new Error('no active observer')
      return send(observer.token, observer.remote, payload, options)
    },
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve) => socket.close(() => resolve()))
    },
  }
}
