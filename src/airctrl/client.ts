import { randomBytes } from 'node:crypto'
import { decrypt, encrypt, MalformedPayloadError, nextKey } from './crypto.js'
import {
  DeviceInfoSchema,
  parseStatusPayload,
  type DeviceInfo,
  type DeviceStatus,
} from './schema.js'
import { CoapOption, bufferToUint, findOption, type DecodedCoapMessage } from './coap/message.js'
import { CoapSocket, type Observation } from './coap/socket.js'

const STATUS_PATH = '/sys/dev/status'
const CONTROL_PATH = '/sys/dev/control'
const SYNC_PATH = '/sys/dev/sync'
const INFO_PATH = '/sys/dev/info'
const DEFAULT_MAX_AGE = 60
const RENEWAL_TIMEOUT_MS = 10_000
const MAX_TIMER_MS = 2_147_483_647

export interface StatusSnapshot {
  status: DeviceStatus
  source: 'registration' | 'notification'
  maxAge?: number
}

/** CoAP Max-Age is uint32; timers are capped to Node's signed timer limit. */
function statusMaxAge(message?: DecodedCoapMessage): number {
  const option = message && findOption(message.options, CoapOption.MaxAge)
  const value = option && option.value.length <= 4 ? bufferToUint(option.value) : 0
  return value && value > 0 ? value : DEFAULT_MAX_AGE
}

export class NotConnectedError extends Error {
  constructor() {
    super('client key not initialised; call connect() first')
    this.name = 'NotConnectedError'
  }
}

export class NoInitialStatusError extends Error {
  constructor() {
    super('device accepted status observation but sent no initial status')
    this.name = 'NoInitialStatusError'
  }
}

export interface PhilipsCoapClientOptions {
  quietObserve?: boolean
  ignoreMalformedObservePushes?: boolean
}

export interface SetControlOptions {
  retries?: number
  retryDelayMs?: number
  resync?: boolean
  /**
   * Per-request CoAP timeout for the control write and any resync, kept short so
   * a dead device fails fast instead of quietly exhausting HAP-NodeJS's ~10s
   * onSet budget while the caller is still awaiting a response.
   */
  timeoutMs?: number
  /** Hard wall-clock ceiling on the whole retry loop. */
  budgetMs?: number
}

export class PhilipsCoapClient {
  private readonly socket: CoapSocket
  private readonly observations = new Set<Observation>()
  private readonly observationSessions = new Set<(error?: Error) => void>()
  private clientKey?: string
  private closed = false
  /** Serialises {@link setControl}: the rolling key must advance one write at a time. */
  private controlChain: Promise<unknown> = Promise.resolve()

  constructor(
    host: string,
    port = 5683,
    private readonly options: PhilipsCoapClientOptions = {},
  ) {
    this.socket = new CoapSocket(host, port)
  }

  async getInfo(): Promise<DeviceInfo> {
    this.requireOpen()
    try {
      const response = await this.socket.request({ method: 'GET', path: INFO_PATH })
      this.requireOpen()
      return DeviceInfoSchema.parse(JSON.parse(response.payload.toString()))
    } catch (error) {
      this.requireOpen()
      throw error
    }
  }

  async connect(timeoutMs?: number): Promise<void> {
    this.requireOpen()
    const nonce = randomBytes(4).toString('hex').toUpperCase()
    try {
      const response = await this.socket.request({
        method: 'POST',
        path: SYNC_PATH,
        payload: nonce,
        timeoutMs,
      })
      this.requireOpen()
      this.clientKey = response.payload.toString().trim()
    } catch (error) {
      this.requireOpen()
      throw error
    }
  }

  private requireKey(): string {
    if (!this.clientKey) throw new NotConnectedError()
    return this.clientKey
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('client closed')
  }

  private parseStatus(message: DecodedCoapMessage): DeviceStatus {
    return parseStatusPayload(decrypt(message.payload.toString()))
  }

  async getStatus(): Promise<{ status: DeviceStatus; maxAge: number }> {
    this.requireOpen()
    this.requireKey()
    let observation: Observation | undefined
    try {
      observation = await this.socket.observe({
        path: STATUS_PATH,
        onNotify: () => {},
        allowQuiet: this.options.quietObserve === true,
      })
      this.requireOpen()
      if (!observation.first) throw new NoInitialStatusError()
      const maxAge = statusMaxAge(observation.first)
      return {
        status: this.parseStatus(observation.first),
        maxAge: maxAge > 0 ? maxAge : DEFAULT_MAX_AGE,
      }
    } catch (error) {
      this.requireOpen()
      throw error
    } finally {
      observation?.cancel()
    }
  }

  observe(): AsyncGenerator<DeviceStatus>
  observe(options: { metadata: true }): AsyncGenerator<StatusSnapshot>
  observe(options?: { metadata?: boolean }): AsyncGenerator<DeviceStatus | StatusSnapshot> {
    const queue: StatusSnapshot[] = []
    let failure: Error | undefined
    let wake: (() => void) | undefined
    let current: Observation | undefined
    let pendingAbort: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let started = false
    let stopped = false
    let generation = 0

    const stop = (error?: Error): void => {
      if (stopped) return
      stopped = true
      failure = error
      generation += 1
      if (timer) clearTimeout(timer)
      timer = undefined
      pendingAbort?.abort()
      pendingAbort = undefined
      if (current) {
        this.observations.delete(current)
        current.cancel()
      }
      this.observationSessions.delete(stop)
      queue.length = 0
      wake?.()
      wake = undefined
    }
    const fail = (error: unknown): void =>
      stop(error instanceof Error ? error : new Error(String(error)))
    const enqueue = (message: DecodedCoapMessage, source: StatusSnapshot['source']): void => {
      if (stopped) return
      try {
        queue.push({
          status: this.parseStatus(message),
          source,
          ...(source === 'registration' ? { maxAge: statusMaxAge(message) } : {}),
        })
        wake?.()
        wake = undefined
      } catch (error) {
        if (
          source === 'notification' &&
          this.options.ignoreMalformedObservePushes === true &&
          error instanceof MalformedPayloadError
        )
          return
        fail(error)
      }
    }
    const register = async (timeoutMs?: number): Promise<void> => {
      const registration = ++generation
      const abort = new AbortController()
      pendingAbort = abort
      let replacement: Observation | undefined
      try {
        replacement = await this.socket.observe({
          path: STATUS_PATH,
          onNotify: (message) => enqueue(message, 'notification'),
          onError: fail,
          allowQuiet: this.options.quietObserve === true,
          timeoutMs,
          signal: abort.signal,
        })
        if (stopped || this.closed || registration !== generation) {
          replacement.cancel()
          return
        }
        // Validate before retiring the old token. A bad replacement must fail
        // the session rather than installing a timer around invalid telemetry.
        if (replacement.first) enqueue(replacement.first, 'registration')
        if (stopped) {
          replacement.cancel()
          return
        }
        const previous = current
        current = replacement
        this.observations.add(replacement)
        pendingAbort = undefined
        timer = setTimeout(
          () => {
            timer = undefined
            void register(RENEWAL_TIMEOUT_MS).catch(fail)
          },
          Math.min(statusMaxAge(replacement.first) * 1000, MAX_TIMER_MS),
        )
        // The replacement has answered (or explicitly accepted quiet mode).
        // Its token is installed before cancellation targets the previous token.
        if (previous) {
          this.observations.delete(previous)
          previous.cancel()
        }
      } catch (error) {
        replacement?.cancel()
        throw error
      } finally {
        if (pendingAbort === abort) pendingAbort = undefined
      }
    }
    const read = async (): Promise<IteratorResult<DeviceStatus | StatusSnapshot>> => {
      if (!started && !stopped) {
        started = true
        try {
          this.requireOpen()
          this.requireKey()
          this.observationSessions.add(stop)
          await register()
        } catch (error) {
          fail(error)
        }
      }
      while (!queue.length && !stopped)
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      if (failure) {
        const error = failure
        failure = undefined
        throw error
      }
      if (stopped) return { done: true, value: undefined }
      const snapshot = queue.shift()!
      return { done: false, value: options?.metadata ? snapshot : snapshot.status }
    }
    // Unlike AsyncGenerator.return(), this return() wakes an in-flight next()
    // immediately and aborts any registration before awaiting iterator cleanup.
    let chain: Promise<unknown> = Promise.resolve()
    const iterator: AsyncGenerator<DeviceStatus | StatusSnapshot> = {
      next: () => {
        const next = chain.then(read)
        chain = next.catch(() => {})
        return next
      },
      return: async (value) => {
        stop()
        return { done: true, value }
      },
      throw: async (error) => {
        fail(error)
        throw error
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
    return iterator
  }

  /** Compatibility hook for explicit same-token refresh; scheduled renewal uses new tokens. */
  refreshObservations(): number {
    this.requireOpen()
    for (const observation of this.observations) observation.refresh()
    return this.observations.size
  }

  /** End live and pending long-lived sessions, waking any waiting iterator. */
  resetObservations(): number {
    this.requireOpen()
    const sessions = [...this.observationSessions]
    for (const stop of sessions) stop(new Error('observation reset'))
    return sessions.length
  }

  /**
   * Control writes advance a rolling key, so two concurrent writes (HAP sends Active and
   * RotationSpeed as one PUT, invoking both onSet handlers at once) would emit K+1 and K+2
   * as separate NON datagrams that UDP may reorder — the device then rejects the stale one.
   * Queue them instead. A rejected write never poisons the chain, and close() still lands:
   * the queued call's own requireOpen() rejects it.
   * ponytail: each queued write gets its own budgetMs from the moment it starts, so a
   * device that burns the full ~6s can push the second write past HAP's 10s timeout.
   * Acceptable — that device is already failing. Share a deadline if it ever matters.
   */
  async setControl(
    values: Record<string, unknown>,
    options: SetControlOptions = {},
  ): Promise<boolean> {
    this.requireOpen()
    const write = this.controlChain.then(() => this.writeControl(values, options))
    this.controlChain = write.catch(() => {})
    return write
  }

  private async writeControl(
    values: Record<string, unknown>,
    options: SetControlOptions,
  ): Promise<boolean> {
    this.requireOpen()
    const {
      retries = 5,
      retryDelayMs = 500,
      resync = true,
      timeoutMs = 2000,
      budgetMs = 6000,
    } = options
    this.requireKey()
    const payload = JSON.stringify({
      state: {
        desired: {
          CommandType: 'app',
          DeviceId: '',
          EnduserId: '',
          ...values,
        },
      },
    })

    // Every wait below is clamped to what's left of this deadline, so the whole
    // loop — regardless of how `retries` is configured — never runs longer than
    // budgetMs. That keeps a single onSet() well inside HAP-NodeJS's ~10s write
    // timeout instead of hammering an unresponsive device for tens of seconds.
    const deadline = Date.now() + budgetMs

    for (let attempt = 0; attempt <= retries; attempt++) {
      this.requireOpen()
      const requestBudget = deadline - Date.now()
      if (requestBudget <= 0) break
      try {
        this.clientKey = nextKey(this.requireKey())
        const response = await this.socket.request({
          method: 'POST',
          path: CONTROL_PATH,
          payload: encrypt(this.clientKey, payload),
          timeoutMs: Math.min(timeoutMs, requestBudget),
        })
        this.requireOpen()
        if (JSON.parse(response.payload.toString()).status === 'success') return true
      } catch {
        this.requireOpen()
        // A timeout, malformed response, or rejected write is retryable.
      }

      if (attempt === retries) break
      const resyncBudget = deadline - Date.now()
      if (resyncBudget <= 0) break
      if (resync) {
        try {
          await this.connect(Math.min(timeoutMs, resyncBudget))
        } catch {
          this.requireOpen()
          // A failed resync is retryable too: keep the stale key and let the next
          // attempt's own resync try again, still bounded by the deadline below.
        }
      }
      const delayBudget = deadline - Date.now()
      if (delayBudget <= 0) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, delayBudget)))
    }

    return false
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const stop of [...this.observationSessions]) stop(new Error('client closed'))
    setImmediate(() => this.socket.close())
  }
}
