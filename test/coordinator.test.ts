import type { Logging } from 'homebridge'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type PhilipsCoapClient, type StatusSnapshot } from '../src/airctrl/client.js'
import { DeviceCoordinator } from '../src/device/coordinator.js'

function logging() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logging
}

function client(status: Record<string, unknown> = { pwr: '1' }, maxAge = 20) {
  const instance = {
    connect: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ status, maxAge }),
    getInfo: vi.fn().mockResolvedValue({ modelid: 'TEST' }),
    refreshObservations: vi.fn().mockReturnValue(1),
    resetObservations: vi.fn().mockReturnValue(1),
    observe: vi.fn(async function* () {
      yield { status, source: 'registration', maxAge }
      await new Promise(() => {})
    }),
    setControl: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
  }
  return instance as unknown as PhilipsCoapClient & typeof instance
}

function controlledClient(
  status: Record<string, unknown> = { pwr: '1' },
  maxAge = 20,
  quiet = false,
) {
  const instance = client(status, maxAge)
  const iterators: Array<{
    next: ReturnType<typeof vi.fn>
    return: ReturnType<typeof vi.fn>
    resolveNext?: (result: IteratorResult<StatusSnapshot>) => void
    rejectNext?: (error: Error) => void
    [Symbol.asyncIterator](): unknown
  }> = []

  const makeIterator = () => {
    let initial = !quiet
    const iterator = {
      resolveNext: undefined as ((result: IteratorResult<StatusSnapshot>) => void) | undefined,
      rejectNext: undefined as ((error: Error) => void) | undefined,
      next: vi.fn(() => {
        if (initial) {
          initial = false
          return Promise.resolve({
            done: false,
            value: { status, source: 'registration' as const, maxAge },
          })
        }
        return new Promise<IteratorResult<StatusSnapshot>>((resolve, reject) => {
          iterator.resolveNext = resolve
          iterator.rejectNext = reject
        })
      }),
      return: vi.fn(async () => {
        iterator.resolveNext?.({ done: true, value: undefined })
        iterator.resolveNext = undefined
        iterator.rejectNext = undefined
        return { done: true as const, value: undefined }
      }),
      [Symbol.asyncIterator]() {
        return this
      },
    }
    iterators.push(iterator)
    return iterator
  }

  instance.observe = vi.fn(() => makeIterator()) as unknown as typeof instance.observe
  const controlled = Object.assign(instance, {
    iterators,
    push(value: Record<string, unknown>, registrationMaxAge?: number) {
      const iterator = iterators.at(-1)
      iterator?.resolveNext?.({
        done: false,
        value: {
          status: value,
          source: registrationMaxAge === undefined ? 'notification' : 'registration',
          maxAge: registrationMaxAge,
        },
      })
      if (iterator) {
        iterator.resolveNext = undefined
        iterator.rejectNext = undefined
      }
    },
    fail(error: Error) {
      const iterator = iterators.at(-1)
      iterator?.rejectNext?.(error)
      if (iterator) {
        iterator.resolveNext = undefined
        iterator.rejectNext = undefined
      }
    },
    finish() {
      const iterator = iterators.at(-1)
      iterator?.resolveNext?.({ done: true, value: undefined })
      if (iterator) {
        iterator.resolveNext = undefined
        iterator.rejectNext = undefined
      }
    },
  })
  Object.defineProperty(controlled, 'iterator', {
    get: () => iterators.at(-1),
  })
  return controlled as typeof controlled & { iterator: (typeof iterators)[number] }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('DeviceCoordinator', () => {
  afterEach(() => vi.useRealTimers())

  it('contains an unexpected quiet-probe rejection without losing recovery', async () => {
    vi.useFakeTimers()
    const log = logging()
    const coordinator = new DeviceCoordinator(controlledClient(), log, '192.0.2.1', undefined, {
      statusSilenceProbeMs: 600_000,
    })
    vi.spyOn(
      coordinator as unknown as { checkQuietLiveness(): Promise<void> },
      'checkQuietLiveness',
    ).mockRejectedValueOnce(new Error('unexpected failure'))
    await coordinator.start()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('quiet-device liveness task failed'),
    )
    expect(coordinator.available).toBe(false)
    coordinator.shutdown()
  })

  it('ends a pending initial registration cleanly on shutdown', async () => {
    const device = controlledClient({ pwr: '1' }, 60, true)
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1')
    const starting = coordinator.start()
    await flush()
    coordinator.shutdown()
    await starting
    expect(coordinator.available).toBe(false)
    expect(device.close).toHaveBeenCalledOnce()
    expect(device.iterator.return).toHaveBeenCalledOnce()
  })

  it('backs off and recovers after the only initial registration fails', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 60, true)
    const replacement = controlledClient({ pwr: '1' }, 60)
    const factory = vi.fn().mockResolvedValue(replacement)
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1', factory)
    const starting = coordinator.start()
    const rejected = expect(starting).rejects.toThrow('registration timeout')
    await flush()
    device.fail(new Error('registration timeout'))
    await rejected
    expect(coordinator.available).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(coordinator.available).toBe(true)
    expect(device.getStatus).not.toHaveBeenCalled()
    expect(factory).toHaveBeenCalledOnce()
    coordinator.shutdown()
  })

  it('preserves an idle quiet-profile fan after a successful reachability probe', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 60, true)
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1', undefined, {
      initialStatusNudge: { D0310A: 1 },
      statusSilenceProbeMs: 600_000,
    })
    await coordinator.start()
    device.push({ pwr: '1' }, 60)
    await flush()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(device.getInfo).toHaveBeenCalledOnce()
    expect(coordinator.available).toBe(true)
    expect(coordinator.status).toEqual({ pwr: '1' })
    device.getInfo.mockRejectedValueOnce(new Error('offline'))
    await vi.advanceTimersByTimeAsync(600_000)
    expect(coordinator.available).toBe(false)
    coordinator.shutdown()
  })

  it('ignores a quiet-device probe that settles after shutdown', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 60)
    let reject!: (error: Error) => void
    device.getInfo.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    )
    const log = logging()
    const coordinator = new DeviceCoordinator(device, log, '192.0.2.1', undefined, {
      statusSilenceProbeMs: 600_000,
    })
    await coordinator.start()
    await vi.advanceTimersByTimeAsync(600_000)
    coordinator.shutdown()
    reject(new Error('late failure'))
    await flush()
    expect(log.warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps ten minutes of unchanged renewal snapshots fresh without duplicate HomeKit events', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 60)
    const factory = vi.fn()
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1', factory)
    await coordinator.start()
    const status = vi.fn()
    coordinator.on('status', status)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(60_000)
      device.push({ pwr: '1' }, 60)
      await flush()
    }
    expect(coordinator.available).toBe(true)
    expect(status).not.toHaveBeenCalled()
    expect(factory).not.toHaveBeenCalled()
    expect(device.getInfo).not.toHaveBeenCalled()
    expect(device.setControl).not.toHaveBeenCalled()
    coordinator.shutdown()
  })

  it('uses a renewal registration Max-Age to update the watchdog deadline', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 60)
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1')
    await coordinator.start()
    device.push({ pwr: '1' }, 20)
    await flush()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(coordinator.available).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(coordinator.available).toBe(false)
    coordinator.shutdown()
  })

  it('waits for the only initial registration snapshot before marking an ordinary device available', async () => {
    const device = controlledClient({ pwr: '1' }, 60, true)
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1')
    const starting = coordinator.start()
    await flush()
    expect(coordinator.available).toBe(false)
    device.push({ pwr: '1' }, 60)
    await starting
    expect(coordinator.available).toBe(true)
    expect(device.observe).toHaveBeenCalledOnce()
    expect(device.getStatus).not.toHaveBeenCalled()
    coordinator.shutdown()
  })

  it('bounds quiet-model silence at ten minutes without using reachability probes', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 60, true)
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1', undefined, {
      initialStatusNudge: { D0310A: 1 },
      statusSilenceMs: 600_000,
    })
    await coordinator.start()
    await vi.advanceTimersByTimeAsync(599_999)
    expect(coordinator.available).toBe(true)
    expect(device.setControl).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(coordinator.available).toBe(false)
    expect(device.getInfo).not.toHaveBeenCalled()
    coordinator.shutdown()
  })

  it('contains an unexpectedly rejected detached reconnect and retries with backoff', async () => {
    vi.useFakeTimers()
    const log = logging()
    const coordinator = new DeviceCoordinator(controlledClient(), log, '192.0.2.1', vi.fn())
    const reconnect = vi
      .spyOn(coordinator as unknown as { reconnect(): Promise<void> }, 'reconnect')
      .mockRejectedValueOnce(new Error('unexpected reconnect rejection'))
      .mockResolvedValueOnce(undefined)
    coordinator.retryStart()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('reconnect task failed'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reconnect).toHaveBeenCalledTimes(2)
    coordinator.shutdown()
  })

  it('contains cleanup exceptions and schedules a reconnect retry', async () => {
    vi.useFakeTimers()
    const device = controlledClient()
    device.close.mockImplementationOnce(() => {
      throw new Error('close failed')
    })
    const coordinator = new DeviceCoordinator(
      device,
      logging(),
      '192.0.2.1',
      vi.fn().mockResolvedValue(controlledClient()),
    )
    const reconnect = () => (coordinator as unknown as { reconnect(): Promise<void> }).reconnect()
    await expect(reconnect()).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)
    coordinator.shutdown()
  })

  it('does not start a second reconnect while a replacement factory is pending', async () => {
    vi.useFakeTimers()
    const replacement = controlledClient()
    let resolveClient!: (client: PhilipsCoapClient) => void
    const pending = new Promise<PhilipsCoapClient>((resolve) => {
      resolveClient = resolve
    })
    const factory = vi.fn().mockReturnValue(pending)
    const coordinator = new DeviceCoordinator(controlledClient(), logging(), '192.0.2.1', factory)
    const reconnect = () => (coordinator as unknown as { reconnect(): Promise<void> }).reconnect()
    const first = reconnect()
    const second = reconnect()
    const calls = factory.mock.calls.length
    resolveClient(replacement)
    await Promise.all([first, second])
    coordinator.shutdown()
    expect(calls).toBe(1)
  })

  it('expires the watchdog even when bootstrap never receives a first status', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 20, true)
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1', undefined, {
      initialStatusNudge: { D0310A: 1 },
      statusSilenceProbeMs: 180_000,
    })
    await coordinator.start()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(device.getInfo).not.toHaveBeenCalled()
    expect(coordinator.available).toBe(false)
    coordinator.shutdown()
  })

  it('starts with one long-lived registration, availability and watchdog', async () => {
    vi.useFakeTimers()
    const device = client()
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1')
    const statuses: Record<string, unknown>[] = []
    const availability: boolean[] = []
    coordinator.on('status', (status) => statuses.push(status))
    coordinator.on('availability', (value) => availability.push(value))

    await coordinator.start()
    await Promise.resolve()

    expect(device.connect).toHaveBeenCalledOnce()
    expect(device.getStatus).not.toHaveBeenCalled()
    expect(device.observe).toHaveBeenCalledOnce()
    expect(coordinator.status).toEqual({ pwr: '1' })
    expect(coordinator.available).toBe(true)
    expect(statuses).toEqual([{ pwr: '1' }])
    expect(availability).toEqual([true])
    expect(vi.getTimerCount()).toBe(1)

    coordinator.shutdown()
  })

  it('sends at most two bootstrap nudges when a fresh Observe remains quiet', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 20, true)
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1', undefined, {
      initialStatusNudge: { D0310A: 1 },
      initialStatusGraceMs: 1_500,
    })

    await coordinator.start()
    await flush()

    expect(device.getStatus).not.toHaveBeenCalled()
    expect(device.observe).toHaveBeenCalledOnce()
    expect(device.setControl).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_499)
    expect(device.setControl).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(device.setControl).toHaveBeenCalledOnce()
    expect(device.setControl).toHaveBeenLastCalledWith(
      { D0310A: 1 },
      { retries: 0, resync: false, timeoutMs: 2_000, budgetMs: 2_000 },
    )

    await vi.advanceTimersByTimeAsync(63_499)
    expect(device.setControl).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(device.setControl).toHaveBeenCalledTimes(2)
    expect(device.setControl).toHaveBeenLastCalledWith(
      { D0310A: 1 },
      { retries: 0, resync: false, timeoutMs: 2_000, budgetMs: 2_000 },
    )

    await vi.advanceTimersByTimeAsync(120_000)
    expect(device.setControl).toHaveBeenCalledTimes(2)
    expect(coordinator.status).toBeNull()
    coordinator.shutdown()
  })

  it('cancels the delayed fallback nudge as soon as the first nudge gets a status', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 20, true)
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1', undefined, {
      initialStatusNudge: { D0310A: 1 },
      initialStatusGraceMs: 1_500,
      initialStatusSecondNudgeMs: 65_000,
    })

    await coordinator.start()
    await vi.advanceTimersByTimeAsync(1_500)
    await flush()
    expect(device.setControl).toHaveBeenCalledOnce()

    device.push({ D03102: 1, D0310A: 1, D0310C: 2 })
    await flush()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(device.setControl).toHaveBeenCalledOnce()
    coordinator.shutdown()
  })

  it('cancels the startup nudge when a quiet device reports during the grace period', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 20, true)
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1', undefined, {
      initialStatusNudge: { D0310A: 1 },
      initialStatusGraceMs: 1_500,
    })

    await coordinator.start()
    await flush()
    device.push({ D03102: 1, D0310A: 1, D0310C: 2 })
    await flush()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(device.setControl).not.toHaveBeenCalled()
    expect(coordinator.status).toEqual({ D03102: 1, D0310A: 1, D0310C: 2 })
    coordinator.shutdown()
  })

  it('keeps a quiet device available and accepts its first later status push', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 20, true)
    const log = logging()
    const coordinator = new DeviceCoordinator(device, log, '192.0.2.1', undefined, {
      initialStatusNudge: { D0310A: 1 },
    })
    const statuses: Record<string, unknown>[] = []

    coordinator.on('status', (status) => statuses.push(status))

    await coordinator.start()
    await flush()

    expect(coordinator.available).toBe(true)
    expect(coordinator.status).toBeNull()
    expect(device.observe).toHaveBeenCalledOnce()
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('waiting for initial status'))

    device.push({ pwr: '1', D0310C: 2 })
    await flush()

    expect(coordinator.status).toEqual({ pwr: '1', D0310C: 2 })
    expect(statuses).toEqual([{ pwr: '1', D0310C: 2 }])
    expect(vi.getTimerCount()).toBe(1)

    coordinator.shutdown()
  })

  it('emits only added, removed, or strictly changed status keys', () => {
    vi.useFakeTimers()
    const coordinator = new DeviceCoordinator(client(), logging(), '192.0.2.1')
    const statuses: Record<string, unknown>[] = []
    coordinator.on('status', (status) => statuses.push(status))

    coordinator.ingest({ a: 1, b: 'x' })
    coordinator.ingest({ a: 1, b: 'x' })
    coordinator.ingest({ a: 1, b: 'y' })
    coordinator.ingest({ a: 1 })
    coordinator.ingest({ a: 1, c: undefined })

    expect(statuses).toEqual([{ a: 1, b: 'x' }, { a: 1, b: 'y' }, { a: 1 }, { a: 1, c: undefined }])
    expect(vi.getTimerCount()).toBe(1)
    coordinator.shutdown()
  })

  it('emits and logs availability transitions only once', () => {
    const log = logging()
    const coordinator = new DeviceCoordinator(client(), log, '192.0.2.1')
    const availability: boolean[] = []
    coordinator.on('availability', (value) => availability.push(value))

    coordinator.markUnavailable('not available yet')
    coordinator.markAvailable()
    coordinator.markAvailable()
    coordinator.markUnavailable('timeout')
    coordinator.markUnavailable('still timed out')

    expect(availability).toEqual([true, false])
    expect(log.info).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalledOnce()
    coordinator.shutdown()
  })

  it('provides capped exponential reconnect delays and resets them', () => {
    const coordinator = new DeviceCoordinator(client(), logging(), '192.0.2.1')

    expect(Array.from({ length: 6 }, () => coordinator.nextBackoffMs())).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ])
    coordinator.resetBackoff()
    expect(coordinator.nextBackoffMs()).toBe(5_000)
    coordinator.shutdown()
  })

  it('delegates control writes to the current client', async () => {
    const device = client()
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1')

    await expect(coordinator.setControl({ pwr: '0' })).resolves.toBe(true)
    expect(device.setControl).toHaveBeenCalledWith({ pwr: '0' })
    coordinator.shutdown()
  })

  it('reconnects after three missed pushes and resets backoff after success', async () => {
    vi.useFakeTimers()
    const first = controlledClient({ pwr: '1' }, 2)
    const replacement = controlledClient({ pwr: '0' }, 4)
    const reconnectClient = vi.fn().mockResolvedValue(replacement)
    const log = logging()
    const coordinator = new DeviceCoordinator(first, log, '192.0.2.1', reconnectClient)
    const availability: boolean[] = []
    coordinator.on('availability', (value) => availability.push(value))

    await coordinator.start()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(coordinator.available).toBe(false)
    expect(reconnectClient).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(reconnectClient).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(first.close).toHaveBeenCalledOnce()
    expect(reconnectClient).toHaveBeenCalledOnce()
    expect(replacement.connect).toHaveBeenCalledOnce()
    expect(replacement.getStatus).not.toHaveBeenCalled()
    expect(replacement.observe).toHaveBeenCalledOnce()
    expect(coordinator.status).toEqual({ pwr: '0' })
    expect(coordinator.available).toBe(true)
    expect(availability).toEqual([true, false, true])
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Reconnected'))
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(coordinator.nextBackoffMs()).toBe(5_000)
    coordinator.shutdown()
  })

  it('uses the same bounded bootstrap after watchdog reconnect for a quiet device', async () => {
    vi.useFakeTimers()
    const first = controlledClient({ pwr: '1' }, 20, true)
    const replacement = controlledClient({ pwr: '1' }, 20, true)
    const reconnectClient = vi.fn().mockResolvedValue(replacement)
    const coordinator = new DeviceCoordinator(first, logging(), '192.0.2.1', reconnectClient, {
      initialStatusNudge: { D0310A: 1 },
      initialStatusGraceMs: 1_500,
      initialStatusSecondNudgeMs: 65_000,
    })

    await coordinator.start()
    await vi.advanceTimersByTimeAsync(1_500)
    await flush()
    first.push({ D03102: 1, D0310A: 1, D0310C: 2 })
    await flush()

    // The first real status arms the watchdog at the default 60s * 3.
    await vi.advanceTimersByTimeAsync(180_000)
    expect(coordinator.available).toBe(false)

    await vi.advanceTimersByTimeAsync(5_000)
    await flush()

    expect(first.close).toHaveBeenCalledOnce()
    expect(reconnectClient).toHaveBeenCalledOnce()
    expect(replacement.connect).toHaveBeenCalledOnce()
    expect(replacement.getStatus).not.toHaveBeenCalled()
    expect(replacement.observe).toHaveBeenCalledOnce()
    expect(replacement.setControl).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_500)
    await flush()
    expect(replacement.setControl).toHaveBeenCalledOnce()
    expect(replacement.setControl).toHaveBeenCalledWith(
      { D0310A: 1 },
      { retries: 0, resync: false, timeoutMs: 2_000, budgetMs: 2_000 },
    )

    replacement.push({ D03102: 0, D0310A: 1, D0310C: 2 })
    await flush()
    expect(coordinator.status).toEqual({ D03102: 0, D0310A: 1, D0310C: 2 })
    expect(coordinator.available).toBe(true)
    coordinator.shutdown()
  })

  it('emits an unchanged first status after reconnect, then resumes duplicate suppression', async () => {
    vi.useFakeTimers()
    const status = { pwr: '1', pm25: 8 }
    const first = controlledClient(status, 2)
    const replacement = controlledClient(status, 2)
    const coordinator = new DeviceCoordinator(
      first,
      logging(),
      '192.0.2.1',
      vi.fn().mockResolvedValue(replacement),
    )
    const statuses: Record<string, unknown>[] = []
    coordinator.on('status', (value) => statuses.push(value))

    await coordinator.start()
    await vi.advanceTimersByTimeAsync(11_000)
    await flush()

    expect(statuses).toEqual([status, status])

    replacement.push(status)
    await flush()
    expect(statuses).toEqual([status, status])
    coordinator.shutdown()
  })

  it('cancels a pending reconnect when the current stream recovers', async () => {
    vi.useFakeTimers()
    const device = controlledClient({ pwr: '1' }, 2)
    const reconnectClient = vi.fn().mockResolvedValue(controlledClient())
    const log = logging()
    const coordinator = new DeviceCoordinator(device, log, '192.0.2.1', reconnectClient)

    await coordinator.start()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(coordinator.available).toBe(false)

    await vi.advanceTimersByTimeAsync(4_000)
    device.push({ pwr: '1', pm25: 8 })
    await flush()
    expect(coordinator.available).toBe(true)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(1_001)
    expect(reconnectClient).not.toHaveBeenCalled()
    expect(device.close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Reconnected'))
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(coordinator.nextBackoffMs()).toBe(5_000)
    coordinator.shutdown()
  })

  it('deduplicates reconnects and retries failures with the next backoff', async () => {
    vi.useFakeTimers()
    const first = controlledClient({ pwr: '1' }, 10)
    const replacement = controlledClient({ pwr: '0' }, 10)
    const reconnectClient = vi
      .fn()
      .mockRejectedValueOnce(new Error('factory failed'))
      .mockResolvedValueOnce(replacement)
    const log = logging()
    const coordinator = new DeviceCoordinator(first, log, '192.0.2.1', reconnectClient)
    const availability: boolean[] = []
    coordinator.on('availability', (value) => availability.push(value))

    await coordinator.start()
    first.fail(new Error('stream failed'))
    await flush()
    coordinator.markUnavailable('same failure')
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(reconnectClient).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(reconnectClient).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(reconnectClient).toHaveBeenCalledTimes(2)
    expect(availability).toEqual([true, false, true])
    expect(log.warn).toHaveBeenCalledOnce()
    coordinator.shutdown()
  })

  it('never retries a permanently closed client without a replacement factory', async () => {
    vi.useFakeTimers()
    const device = controlledClient()
    const coordinator = new DeviceCoordinator(device, logging(), '192.0.2.1')

    await coordinator.start()
    device.fail(new Error('stream failed'))
    await flush()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(device.connect).toHaveBeenCalledOnce()
    expect(device.close).not.toHaveBeenCalled()
    coordinator.shutdown()
  })

  it('keeps a throwing listener out of transport state', () => {
    vi.useFakeTimers()
    const log = logging()
    const coordinator = new DeviceCoordinator(client(), log, '192.0.2.1')
    const seen: Record<string, unknown>[] = []
    const availability: boolean[] = []
    coordinator.on('status', () => {
      throw new Error('consumer blew up')
    })
    coordinator.on('status', (status) => seen.push(status))
    coordinator.on('availability', () => {
      throw new Error('availability consumer blew up')
    })
    coordinator.on('availability', (value) => availability.push(value))

    expect(() => coordinator.ingest({ a: 1 })).not.toThrow()
    expect(() => coordinator.markAvailable()).not.toThrow()

    // A consumer bug must not stop the other consumers or the coordinator itself.
    expect(seen).toEqual([{ a: 1 }])
    expect(availability).toEqual([true])
    expect(coordinator.status).toEqual({ a: 1 })
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('consumer blew up'))
    coordinator.shutdown()
  })

  it('arms the backoff on retryStart after a failed initial connect', async () => {
    vi.useFakeTimers()
    const first = controlledClient()
    first.connect.mockRejectedValue(new Error('offline'))
    const replacement = controlledClient({ pwr: '1' }, 10)
    const reconnectClient = vi.fn().mockResolvedValue(replacement)
    const coordinator = new DeviceCoordinator(first, logging(), '192.0.2.1', reconnectClient)

    await expect(coordinator.start()).rejects.toThrow('offline')
    expect(vi.getTimerCount()).toBe(0)

    coordinator.retryStart()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(reconnectClient).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(reconnectClient).toHaveBeenCalledOnce()
    expect(coordinator.status).toEqual({ pwr: '1' })
    expect(coordinator.available).toBe(true)
    coordinator.shutdown()
  })

  it('never double-arms retryStart and never retries after shutdown', async () => {
    vi.useFakeTimers()
    const reconnectClient = vi.fn().mockResolvedValue(controlledClient())
    const coordinator = new DeviceCoordinator(
      controlledClient(),
      logging(),
      '192.0.2.1',
      reconnectClient,
    )

    coordinator.retryStart()
    coordinator.retryStart()
    expect(vi.getTimerCount()).toBe(1)

    coordinator.shutdown()
    expect(vi.getTimerCount()).toBe(0)
    coordinator.retryStart()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(vi.getTimerCount()).toBe(0)
    expect(reconnectClient).not.toHaveBeenCalled()
  })

  it('shutdown ends observation, clears timers and listeners, and blocks reconnect races', async () => {
    vi.useFakeTimers()
    const first = controlledClient()
    const replacement = controlledClient()
    let rejectConnect!: (error: Error) => void
    replacement.connect.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectConnect = reject
        }),
    )
    const coordinator = new DeviceCoordinator(
      first,
      logging(),
      '192.0.2.1',
      vi.fn().mockResolvedValue(replacement),
    )
    coordinator.on('availability', vi.fn())

    await coordinator.start()
    first.fail(new Error('stream failed'))
    await flush()
    await vi.advanceTimersByTimeAsync(5_000)
    await flush()
    expect(replacement.connect).toHaveBeenCalledOnce()

    coordinator.shutdown()
    rejectConnect(new Error('late failure'))
    await flush()
    await vi.runAllTimersAsync()

    expect(first.iterator.return).toHaveBeenCalledOnce()
    expect(replacement.close).toHaveBeenCalledOnce()
    expect(coordinator.listenerCount('availability')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
