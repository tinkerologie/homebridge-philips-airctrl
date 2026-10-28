import { setTimeout as wait } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhilipsCoapClient } from '../src/airctrl/client.js'
import { encrypt } from '../src/airctrl/crypto.js'
import { CoapOption, bufferToUint, uintToBuffer } from '../src/airctrl/coap/message.js'
import {
  pathOf,
  startFakeDevice,
  type FakeDevice,
  type FakeResponse,
} from './helpers/fake-device.js'
import type { CoapSocket } from '../src/airctrl/coap/socket.js'

const payload = encrypt('0DC377BA', JSON.stringify({ state: { reported: { pwr: '1' } } }))
const maxAge = (seconds: number) => [{ number: CoapOption.MaxAge, value: uintToBuffer(seconds) }]
const observeValue = (request: FakeDevice['requests'][number]) => {
  const option = request.options.find((o) => o.number === CoapOption.Observe)
  return option && bufferToUint(option.value)
}
const registrations = (device: FakeDevice) => device.requests.filter((r) => observeValue(r) === 0)

describe('Observe renewal', () => {
  let device: FakeDevice | undefined
  let client: PhilipsCoapClient | undefined
  afterEach(async () => {
    client?.close()
    await wait(5)
    await device?.close()
    vi.useRealTimers()
  })

  it('survives one lost renewal request on the same encryption session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let count = 0
    let reply!: (response: FakeResponse) => void
    device = await startFakeDevice((request) => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (observeValue(request) === 0) {
        if (++count === 1) return { payload, options: maxAge(60) }
        if (count === 3)
          return new Promise((resolve) => {
            reply = resolve
          })
      }
    }, 'independent')
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()
    const iterator = client.observe()
    await iterator.next()
    const result = iterator.next().then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await vi.advanceTimersByTimeAsync(60_000)
    await wait(5)
    await vi.advanceTimersByTimeAsync(10_000)
    await wait(5)
    expect(registrations(device)).toHaveLength(3)
    await device.pushTo(
      registrations(device)[0]!.token,
      encrypt('0DC377BA', JSON.stringify({ state: { reported: { pwr: '0' } } })),
    )
    expect(await result).toMatchObject({ value: { done: false, value: { pwr: '0' } } })
    reply({ payload, options: maxAge(60) })
    expect((await iterator.next()).value).toEqual({ pwr: '1' })
    expect(device.requests.filter((r) => pathOf(r) === '/sys/dev/sync')).toHaveLength(1)
    await iterator.return(undefined)
  })

  it.each(['independent', 'latestOnly'] as const)(
    'renews on the same endpoint/session with a new token while the consumer is paused (%s)',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      device = await startFakeDevice((request) => {
        if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
        if (observeValue(request) === 0) return { payload, options: maxAge(2) }
      }, mode)
      client = new PhilipsCoapClient('127.0.0.1', device.port)
      await client.connect()
      const iterator = client.observe()
      expect((await iterator.next()).value).toEqual({ pwr: '1' })
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(500)
        await device.push(payload)
        await wait(5)
      }
      const requests = registrations(device)
      expect(requests).toHaveLength(2)
      expect(requests[0]!.token.equals(requests[1]!.token)).toBe(false)
      expect(new Set(device.endpoints.map((e) => `${e.address}:${e.port}`)).size).toBe(1)
      expect(device.requests.filter((r) => pathOf(r) === '/sys/dev/sync')).toHaveLength(1)
      expect(device.requests.some((r) => pathOf(r) === '/sys/dev/control')).toBe(false)
      expect((client as unknown as { clientKey: string }).clientKey).toBe('0DC377BA')
      const cancellation = device.requests.findIndex((r) => observeValue(r) === 1)
      expect(cancellation).toBeGreaterThan(device.requests.indexOf(requests[1]!))
      // Drain the four pushes and the unchanged replacement snapshot, then send
      // one packet to each token. A retired token must not deliver stale state.
      for (let i = 0; i < 5; i++) await iterator.next()
      const next = iterator.next()
      await device.pushTo(
        requests[0]!.token,
        encrypt('0DC377BA', JSON.stringify({ state: { reported: { pwr: 'stale' } } })),
      )
      await device.pushTo(
        requests[1]!.token,
        encrypt('0DC377BA', JSON.stringify({ state: { reported: { pwr: '0' } } })),
      )
      expect((await next).value).toEqual({ pwr: '0' })
      await iterator.return(undefined)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each([undefined, 0])('uses a 60-second renewal fallback for Max-Age %s', async (seconds) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    device = await startFakeDevice((request) => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (observeValue(request) === 0)
        return { payload, options: seconds === undefined ? [] : maxAge(seconds) }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()
    const iterator = client.observe()
    await iterator.next()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(registrations(device)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await wait(10)
    expect(registrations(device)).toHaveLength(2)
    expect((await iterator.next()).value).toEqual({ pwr: '1' })
    await iterator.return(undefined)
  })

  it('bounds a failed renewal and cancels both subscriptions', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let count = 0
    device = await startFakeDevice((request) => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (observeValue(request) === 0 && ++count === 1) return { payload, options: maxAge(2) }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()
    const iterator = client.observe()
    await iterator.next()
    const next = iterator.next()
    const rejected = expect(next).rejects.toThrow(/timeout/)
    await vi.advanceTimersByTimeAsync(2_000)
    await wait(5)
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    await wait(5)
    expect(device.requests.filter((r) => observeValue(r) === 1)).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['independent', 'latestOnly'] as const)(
    'keeps the old token until a deferred replacement has answered (%s)',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      let count = 0
      let reply!: (response: FakeResponse) => void
      device = await startFakeDevice((request) => {
        if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
        if (observeValue(request) === 0) {
          if (++count === 1) return { payload, options: maxAge(2) }
          return new Promise((resolve) => {
            reply = resolve
          })
        }
      }, mode)
      client = new PhilipsCoapClient('127.0.0.1', device.port)
      await client.connect()
      const iterator = client.observe()
      await iterator.next()
      await vi.advanceTimersByTimeAsync(2000)
      await wait(5)
      expect(device.requests.some((r) => observeValue(r) === 1)).toBe(false)
      // Latest-only firmware evicts the predecessor when registration arrives.
      // Only independent observers can still deliver while its reply is pending.
      if (mode === 'independent') {
        await device.pushTo(
          registrations(device)[0]!.token,
          encrypt('0DC377BA', JSON.stringify({ state: { reported: { pwr: '0' } } })),
        )
        expect((await iterator.next()).value).toEqual({ pwr: '0' })
      }
      reply({ payload, options: maxAge(2) })
      await iterator.next()
      await wait(5)
      expect(device.requests.filter((r) => observeValue(r) === 1)).toHaveLength(1)
      await iterator.return(undefined)
    },
  )

  it('cleans up renewal when its UDP send fails asynchronously', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    device = await startFakeDevice((request) => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (observeValue(request) === 0) return { payload, options: maxAge(2) }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()
    const iterator = client.observe()
    await iterator.next()
    const transport = (client as unknown as { socket: CoapSocket }).socket
    const udp = (transport as unknown as { socket: { send: (...args: unknown[]) => void } }).socket
    udp.send = (...args) => {
      const callback = args.at(-1)
      if (typeof callback === 'function') callback(new Error('send failed'))
    }
    const rejected = expect(iterator.next()).rejects.toThrow('send failed')
    await vi.advanceTimersByTimeAsync(2000)
    await rejected
    expect(transport.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(
    (['independent', 'latestOnly'] as const).flatMap((mode) =>
      (['return', 'reset', 'close'] as const).map((action) => [mode, action] as const),
    ),
  )(
    'cancels a pending renewal immediately in %s mode on %s and drops its late response',
    async (mode, action) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      let count = 0
      let resolveReply!: (reply: FakeResponse) => void
      device = await startFakeDevice((request) => {
        if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
        if (observeValue(request) === 0) {
          if (++count === 1) return { payload, options: maxAge(2) }
          return new Promise((resolve) => {
            resolveReply = resolve
          })
        }
      }, mode)
      client = new PhilipsCoapClient('127.0.0.1', device.port)
      await client.connect()
      const iterator = client.observe()
      await iterator.next()
      await vi.advanceTimersByTimeAsync(2000)
      await wait(5)
      const pending = iterator.next()
      const settled =
        action === 'return'
          ? expect(pending).resolves.toMatchObject({ done: true })
          : expect(pending).rejects.toThrow(action === 'reset' ? /reset/ : /closed/)
      if (action === 'return') await iterator.return(undefined)
      else if (action === 'reset') expect(client.resetObservations()).toBe(1)
      else client.close()
      await settled
      resolveReply({ payload, options: maxAge(2) })
      await wait(10)
      expect(vi.getTimerCount()).toBe(0)
      expect(device.requests.filter((r) => observeValue(r) === 1)).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(registrations(device)).toHaveLength(2)
    },
  )

  it('fails and cleans up a malformed replacement snapshot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let count = 0
    device = await startFakeDevice((request) => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (observeValue(request) === 0)
        return { payload: ++count === 1 ? payload : 'bad', options: maxAge(2) }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()
    const iterator = client.observe()
    await iterator.next()
    const rejected = expect(iterator.next()).rejects.toThrow(/malformed/)
    await vi.advanceTimersByTimeAsync(2000)
    await rejected
    await wait(5)
    expect(device.requests.filter((r) => observeValue(r) === 1)).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses each replacement Max-Age and exposes registration metadata', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let count = 0
    device = await startFakeDevice((request) => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (observeValue(request) === 0) return { payload, options: maxAge(++count === 1 ? 2 : 3) }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()
    const iterator = client.observe({ metadata: true })
    expect((await iterator.next()).value).toEqual({
      status: { pwr: '1' },
      source: 'registration',
      maxAge: 2,
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect((await iterator.next()).value).toEqual({
      status: { pwr: '1' },
      source: 'registration',
      maxAge: 3,
    })
    await vi.advanceTimersByTimeAsync(2999)
    expect(registrations(device)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await wait(5)
    expect(registrations(device)).toHaveLength(3)
    await iterator.return(undefined)
  })

  it('retains a quiet replacement and schedules its fallback renewal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let count = 0
    device = await startFakeDevice((request) => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (observeValue(request) === 0 && ++count === 1) return { payload, options: maxAge(2) }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port, { quietObserve: true })
    await client.connect()
    const iterator = client.observe()
    await iterator.next()
    await vi.advanceTimersByTimeAsync(2000)
    await wait(5)
    await vi.advanceTimersByTimeAsync(10_000)
    await wait(5)
    expect(device.requests.filter((r) => observeValue(r) === 1)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(registrations(device)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await wait(5)
    expect(registrations(device)).toHaveLength(3)
    await iterator.return(undefined)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails a pending renewal promptly on a socket error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let count = 0
    device = await startFakeDevice((request) => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (observeValue(request) === 0 && ++count === 1) return { payload, options: maxAge(2) }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port)
    await client.connect()
    const iterator = client.observe()
    await iterator.next()
    await vi.advanceTimersByTimeAsync(2000)
    await wait(5)
    const rejected = expect(iterator.next()).rejects.toThrow('network down')
    const transport = (client as unknown as { socket: CoapSocket }).socket
    const udp = (transport as unknown as { socket: { emit(event: string, error: Error): void } })
      .socket
    udp.emit('error', new Error('network down'))
    await rejected
    expect(transport.pendingCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
