import { createHash } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhilipsCoapClient } from '../src/airctrl/client.js'
import { DigestMismatchError, encrypt } from '../src/airctrl/crypto.js'
import { CoapType } from '../src/airctrl/coap/message.js'
import { DeviceCoordinator } from '../src/device/coordinator.js'
import type { Logging } from 'homebridge'
import {
  startFakeDevice,
  pathOf,
  type FakeDevice,
  type FakeHandler,
} from './helpers/fake-device.js'

const status = (pwr = '1') => encrypt('0DC377BA', JSON.stringify({ state: { reported: { pwr } } }))
const malformed =
  '0DC377BA' +
  'GG'.repeat(16) +
  createHash('sha256')
    .update('0DC377BA' + 'GG'.repeat(16))
    .digest('hex')
    .toUpperCase()

describe('status packet classification (#45)', () => {
  let device: FakeDevice
  let client: PhilipsCoapClient
  afterEach(async () => {
    client?.close()
    await wait(5)
    await device?.close()
    vi.useRealTimers()
  })
  async function start(
    options: ConstructorParameters<typeof PhilipsCoapClient>[2] = {},
    handler?: FakeHandler,
  ) {
    device = await startFakeDevice((request) => {
      if (pathOf(request) === '/sys/dev/sync') return { payload: '0DC377BA' }
      if (handler) return handler(request)
      return { payload: status() }
    })
    client = new PhilipsCoapClient('127.0.0.1', device.port, options)
    await client.connect()
  }

  it('ignores an isolated even-length non-hex notification by default and delivers the next valid status', async () => {
    await start()
    const iterator = client.observe()
    await iterator.next()
    const outcome = iterator.next().then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await device.push(malformed)
    await device.push(status('0'))
    expect(await outcome).toEqual({ value: { done: false, value: { pwr: '0' } } })
    await iterator.return(undefined)
  })

  it('does not ingest ignored malformed packets or rearm watchdog freshness', async () => {
    await start()
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logging
    const coordinator = new DeviceCoordinator(client, log, '192.0.2.1')
    const ingest = vi.spyOn(coordinator, 'ingest')
    await coordinator.start()
    expect(ingest).toHaveBeenCalledOnce()
    await device.push(malformed)
    await wait(10)
    expect(ingest).toHaveBeenCalledOnce()
    expect(coordinator.available).toBe(true)
    coordinator.shutdown()
  })

  it.each([0, 69])('ignores empty later packets with code %s', async (code) => {
    await start()
    const iterator = client.observe()
    await iterator.next()
    const next = iterator.next()
    await device.push('', [], code, CoapType.Acknowledgement)
    await device.push(status('0'))
    expect((await next).value).toEqual({ pwr: '0' })
    await iterator.return(undefined)
  })

  it.each([132, 160])(
    'fails non-success CoAP code %s with a typed response error',
    async (code) => {
      await start()
      const iterator = client.observe()
      await iterator.next()
      const rejected = expect(iterator.next()).rejects.toMatchObject({
        name: 'CoapResponseError',
        code,
      })
      await device.push('', [], code)
      await rejected
    },
  )

  it('keeps a valid-shape digest mismatch fatal', async () => {
    await start()
    const iterator = client.observe()
    await iterator.next()
    const rejected = expect(iterator.next()).rejects.toBeInstanceOf(DigestMismatchError)
    const valid = status()
    await device.push(valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A'))
    await rejected
  })

  it('reports an empty first status response without attempting decryption', async () => {
    await start({}, () => ({ payload: '', code: 0, type: CoapType.Acknowledgement }))
    await expect(client.getStatus()).rejects.toMatchObject({ name: 'NoInitialStatusError' })
  })

  it('waits through an empty first ACK for a real initial snapshot', async () => {
    await start({}, () => ({ payload: '', code: 0, type: CoapType.Acknowledgement }))
    const iterator = client.observe()
    const next = iterator.next()
    await wait(10)
    await device.push(status())
    expect((await next).value).toEqual({ pwr: '1' })
    await iterator.return(undefined)
  })

  it('ignores a malformed later packet while waiting for content after an empty ACK', async () => {
    await start({}, () => ({ payload: '', code: 0, type: CoapType.Acknowledgement }))
    const iterator = client.observe()
    const outcome = iterator.next().then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await wait(10)
    await device.push(malformed)
    await device.push(status())
    expect(await outcome).toEqual({ value: { done: false, value: { pwr: '1' } } })
    await iterator.return(undefined)
  })

  it('bounds a stream that never sends content after an empty initial ACK', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await start({}, () => ({ payload: '', code: 0, type: CoapType.Acknowledgement }))
    const rejected = expect(client.observe().next()).rejects.toThrow(/timeout/)
    await wait(10)
    await vi.advanceTimersByTimeAsync(8000)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a content wait immediately when returned after an empty initial ACK', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await start({}, () => ({ payload: '', code: 0, type: CoapType.Acknowledgement }))
    const iterator = client.observe()
    const next = iterator.next()
    await wait(10)
    await iterator.return(undefined)
    expect(await next).toMatchObject({ done: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['JSON', encrypt('0DC377BA', '{')],
    ['schema', encrypt('0DC377BA', JSON.stringify({ state: { desired: {} } }))],
    [
      'AES',
      (() => {
        const body = '0DC377BAAA'
        return body + createHash('sha256').update(body).digest('hex').toUpperCase()
      })(),
    ],
  ])('keeps %s failures fatal for later notifications', async (_name, payload) => {
    await start()
    const iterator = client.observe()
    await iterator.next()
    const rejected = expect(iterator.next()).rejects.toThrow()
    await device.push(payload)
    await rejected
  })

  it('isolates an advisory diagnostic callback exception from the healthy stream', async () => {
    await start({
      onDiagnostic: () => {
        throw new Error('diagnostic callback failed')
      },
    })
    const iterator = client.observe()
    await iterator.next()
    const next = iterator.next()
    await device.push(malformed)
    await device.push(status('0'))
    expect((await next).value).toEqual({ pwr: '0' })
    await iterator.return(undefined)
  })

  it('emits bounded redacted packet diagnostics without the client key or full ciphertext', async () => {
    const diagnostic = vi.fn()
    await start({ onDiagnostic: diagnostic })
    const iterator = client.observe()
    await iterator.next()
    const next = iterator.next()
    await device.push(malformed)
    await device.push(status('0'))
    await next
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: '2.05',
        messageType: 1,
        payloadLength: malformed.length,
        fullyHex: false,
      }),
    )
    const text = JSON.stringify(diagnostic.mock.calls)
    expect(text).not.toContain(malformed)
    expect(text).not.toContain('0DC377BA')
    await iterator.return(undefined)
  })
})
