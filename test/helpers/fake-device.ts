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
  type?: DecodedCoapMessage['type']
}

export type FakeHandler = (
  request: DecodedCoapMessage,
) => FakeResponse | undefined | Promise<FakeResponse | undefined>

export interface FakeDevice {
  port: number
  requests: DecodedCoapMessage[]
  endpoints: Array<{ address: string; port: number }>
  pushTo(
    token: Buffer,
    payload: string | Buffer,
    options?: CoapOptionEntry[],
    code?: number,
    type?: DecodedCoapMessage['type'],
  ): Promise<void>
  push(
    payload: string | Buffer,
    options?: CoapOptionEntry[],
    code?: number,
    type?: DecodedCoapMessage['type'],
  ): Promise<void>
  close(): Promise<void>
}

export function pathOf(message: DecodedCoapMessage): string {
  const segments = message.options
    .filter((option) => option.number === CoapOption.UriPath)
    .map((option) => option.value.toString('utf8'))
  return `/${segments.join('/')}`
}

export async function startFakeDevice(
  handler: FakeHandler,
  mode: 'independent' | 'latestOnly' = 'latestOnly',
): Promise<FakeDevice> {
  const socket = createSocket('udp4')
  const requests: DecodedCoapMessage[] = []
  const endpoints: Array<{ address: string; port: number }> = []
  const observers = new Map<string, { token: Buffer; remote: RemoteInfo }>()
  const knownObservers = new Map<string, { token: Buffer; remote: RemoteInfo }>()
  let observer: { token: Buffer; remote: RemoteInfo } | undefined
  let nextMessageId = 1
  let closed = false

  const send = (
    token: Buffer,
    remote: RemoteInfo,
    payload: string | Buffer,
    options: CoapOptionEntry[] = [],
    code = CONTENT_2_05,
    type: DecodedCoapMessage['type'] = CoapType.NonConfirmable,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      socket.send(
        encode({
          type,
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
      endpoints.push({ address: remote.address, port: remote.port })

      const observe = request.options.find((option) => option.number === CoapOption.Observe)
      if (observe && bufferToUint(observe.value) === 0) {
        observer = { token: Buffer.from(request.token), remote }
        if (mode === 'latestOnly') observers.clear()
        const key = `${remote.address}:${remote.port}:${request.token.toString('hex')}`
        observers.set(key, observer)
        knownObservers.set(request.token.toString('hex'), observer)
      } else if (observe && bufferToUint(observe.value) === 1) {
        observers.delete(`${remote.address}:${remote.port}:${request.token.toString('hex')}`)
        if (observer?.token.equals(request.token)) observer = undefined
      }

      const response = await handler(request)
      if (!response) return
      await send(
        request.token,
        remote,
        response.payload ?? Buffer.alloc(0),
        response.options,
        response.code,
        response.type,
      )
    })().catch(() => {})
  })

  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
  const address = socket.address()

  return {
    port: address.port,
    requests,
    endpoints,
    async pushTo(token, payload, options = [], code, type) {
      const target = knownObservers.get(token.toString('hex'))
      if (!target) return
      await send(target.token, target.remote, payload, options, code, type)
    },
    push(payload, options = [], code, type) {
      if (!observer) throw new Error('no active observer')
      return send(observer.token, observer.remote, payload, options, code, type)
    },
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve) => socket.close(() => resolve()))
    },
  }
}
