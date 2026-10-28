import { EventEmitter } from 'node:events'
import type { Logging } from 'homebridge'
import type { PhilipsCoapClient, StatusSnapshot } from '../airctrl/client.js'
import type { DeviceStatus } from '../airctrl/schema.js'

export interface DeviceCoordinatorOptions {
  /**
   * Some devices accept Observe but do not publish an initial snapshot. For those
   * models only, use a bounded bootstrap control after a short grace period to
   * provoke the first status. This is bootstrap/reconnect recovery, never polling.
   */
  initialStatusNudge?: Record<string, unknown>
  initialStatusGraceMs?: number
  /** Target age of a fresh Observe session for one final bootstrap nudge. */
  initialStatusSecondNudgeMs?: number
  /**
   * Model-specific upper bound on status silence, including quiet registrations.
   */
  statusSilenceMs?: number
  /** Explicit quiet-firmware exception: probe reachability after silence, preserving cached state. */
  statusSilenceProbeMs?: number
}

export class DeviceCoordinator extends EventEmitter {
  private lastStatus: DeviceStatus | null = null
  private maxAgeS = 60
  private isAvailable = false
  private backoffMs = 5_000
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnecting = false
  private initialStatusNudgeTimer: ReturnType<typeof setTimeout> | null = null
  private awaitingFreshStatus = false
  private initialStatusNudgesSent = 0
  private observeAbort: AbortController | null = null
  private observeIterator: AsyncIterator<StatusSnapshot> | null = null
  private clientClosed = false
  private shuttingDown = false
  private forceNextStatus = false
  private statusEpoch = 0

  constructor(
    private client: PhilipsCoapClient,
    private readonly log: Logging,
    private readonly host: string,
    private readonly reconnectClient?: () => Promise<PhilipsCoapClient>,
    private readonly options: DeviceCoordinatorOptions = {},
  ) {
    super()
  }

  get available(): boolean {
    return this.isAvailable
  }

  get status(): DeviceStatus | null {
    return this.lastStatus
  }

  async start(): Promise<void> {
    await this.client.connect()
    if (this.shuttingDown) return

    // CX3550-class quiet devices are best handled by establishing the long-lived
    // Observe first, then using a bounded bootstrap if it remains silent. Avoid a
    // throwaway getStatus() Observe and its timeout before the real subscription starts.
    if (this.options.initialStatusNudge) {
      this.markAvailable(`${this.host} available; waiting for initial status`)
      this.resetBackoff()
      this.beginFreshObservation()
      return
    }

    await this.beginObserving()
    this.resetBackoff()
  }

  /**
   * Arm the backoff/reconnect loop after a failed initial {@link start}, which otherwise
   * leaves the coordinator idle because reconnection is only wired up once observing began.
   */
  retryStart(): void {
    this.scheduleReconnect()
  }

  ingest(status: DeviceStatus, maxAge?: number): void {
    if (maxAge !== undefined && Number.isFinite(maxAge) && maxAge > 0) this.maxAgeS = maxAge
    this.statusEpoch += 1
    this.awaitingFreshStatus = false
    this.clearInitialStatusNudge()
    this.armWatchdog()
    const force = this.forceNextStatus
    this.forceNextStatus = false
    if (!force && this.lastStatus) {
      const keys = new Set([...Object.keys(this.lastStatus), ...Object.keys(status)])
      if (
        [...keys].every(
          (key) =>
            Object.hasOwn(this.lastStatus!, key) === Object.hasOwn(status, key) &&
            this.lastStatus![key] === status[key],
        )
      )
        return
    }
    this.lastStatus = status
    this.safeEmit('status', status)
  }

  /**
   * Emit without letting a consumer's exception escape into transport state. The HomeKit
   * layer throws HapStatusError, and a throw out of {@link ingest} would mark the device
   * unavailable or abort a successful reconnect. Listeners are isolated from each other.
   *
   * Invariant: listeners MUST be synchronous. Only a synchronous throw is caught here — an
   * async listener returns a promise this ignores, so its rejection escapes as an unhandled
   * rejection. Every in-tree listener (accessory.ts, platform.ts) is synchronous.
   */
  private safeEmit(event: 'status' | 'availability', payload: DeviceStatus | boolean): void {
    for (const listener of this.rawListeners(event)) {
      try {
        listener(payload)
      } catch (error) {
        this.log.error(`${this.host} ${event} listener failed: ${String(error)}`)
      }
    }
  }

  markAvailable(message = `${this.host} available`): void {
    if (this.isAvailable) return
    this.isAvailable = true
    // A quiet bootstrap still needs a bounded liveness check before its first push.
    this.armWatchdog()
    this.forceNextStatus = this.lastStatus !== null
    this.log.info(message)
    this.safeEmit('availability', true)
  }

  markUnavailable(reason: string): void {
    if (!this.isAvailable) return
    this.isAvailable = false
    this.log.warn(`${this.host} unavailable: ${reason}`)
    this.safeEmit('availability', false)
  }

  nextBackoffMs(): number {
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000)
    return delay
  }

  resetBackoff(): void {
    this.backoffMs = 5_000
  }

  async setControl(values: Record<string, unknown>): Promise<boolean> {
    return this.client.setControl(values)
  }

  shutdown(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    if (this.watchdog) clearTimeout(this.watchdog)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.clearInitialStatusNudge()
    this.awaitingFreshStatus = false
    this.initialStatusNudgesSent = 0
    this.watchdog = null
    this.reconnectTimer = null
    this.stopObserving()
    this.closeCurrentClient()
    this.removeAllListeners()
  }

  private beginFreshObservation(): void {
    this.awaitingFreshStatus = true
    this.initialStatusNudgesSent = 0
    void this.beginObserving().catch(() => {})
    this.scheduleInitialStatusNudge(this.options.initialStatusGraceMs ?? 1_500)
  }

  private scheduleInitialStatusNudge(delay: number): void {
    const values = this.options.initialStatusNudge
    if (!values || this.shuttingDown || !this.awaitingFreshStatus) return
    this.clearInitialStatusNudge()
    this.initialStatusNudgeTimer = setTimeout(() => {
      this.initialStatusNudgeTimer = null
      if (this.shuttingDown || !this.awaitingFreshStatus) return
      void this.sendInitialStatusNudge(values)
    }, delay)
  }

  private async sendInitialStatusNudge(values: Record<string, unknown>): Promise<void> {
    if (this.initialStatusNudgesSent >= 2) return
    this.initialStatusNudgesSent += 1
    try {
      const accepted = await this.client.setControl(values, {
        retries: 0,
        resync: false,
        timeoutMs: 2_000,
        budgetMs: 2_000,
      })
      if (!accepted) this.log.debug(`${this.host} initial-status nudge was not accepted`)
    } catch (error) {
      if (!this.shuttingDown) {
        this.log.debug(`${this.host} initial-status nudge failed: ${String(error)}`)
      }
    } finally {
      if (!this.shuttingDown && this.awaitingFreshStatus && this.initialStatusNudgesSent === 1) {
        const firstAt = this.options.initialStatusGraceMs ?? 1_500
        const secondAt = this.options.initialStatusSecondNudgeMs ?? 65_000
        this.scheduleInitialStatusNudge(Math.max(0, secondAt - firstAt))
      }
    }
  }

  private clearInitialStatusNudge(): void {
    if (!this.initialStatusNudgeTimer) return
    clearTimeout(this.initialStatusNudgeTimer)
    this.initialStatusNudgeTimer = null
  }

  private armWatchdog(): void {
    if (this.shuttingDown) return
    if (this.watchdog) clearTimeout(this.watchdog)
    const delayMs =
      this.options.statusSilenceMs ?? this.options.statusSilenceProbeMs ?? this.maxAgeS * 3 * 1000
    this.watchdog = setTimeout(
      () => {
        this.watchdog = null
        if (this.shuttingDown || this.reconnecting) return
        if (this.options.statusSilenceProbeMs !== undefined && this.lastStatus !== null) {
          void this.checkQuietLiveness().catch((error: unknown) => {
            if (this.shuttingDown) return
            this.log.error(`${this.host} quiet-device liveness task failed: ${String(error)}`)
            this.markUnavailable('quiet-device liveness check failed')
            this.scheduleReconnect()
          })
          return
        }
        this.markUnavailable(`no status for ${Math.round(delayMs / 1000)}s`)
        this.scheduleReconnect()
      },
      Math.min(delayMs, 2_147_483_647),
    )
  }

  private async checkQuietLiveness(): Promise<void> {
    const client = this.client
    const iterator = this.observeIterator
    const epoch = this.statusEpoch
    const current = (): boolean =>
      !this.shuttingDown &&
      this.client === client &&
      this.observeIterator === iterator &&
      this.statusEpoch === epoch &&
      !this.reconnecting &&
      this.reconnectTimer === null &&
      this.isAvailable
    try {
      await client.getInfo()
      if (!current()) return
      // This opt-in fan firmware only pushes changes. Reachability preserves its
      // cached state; it does not advance telemetry freshness or statusEpoch.
      this.log.debug(`${this.host} quiet-device liveness probe succeeded`)
      this.armWatchdog()
    } catch (error) {
      if (!current()) return
      this.markUnavailable(`quiet-device liveness probe failed: ${String(error)}`)
      this.scheduleReconnect()
    }
  }

  private beginObserving(): Promise<void> {
    this.stopObserving()
    const abort = new AbortController()
    const iterator = this.client.observe({ metadata: true })[Symbol.asyncIterator]()
    this.observeAbort = abort
    this.observeIterator = iterator

    let resolveReady!: () => void
    let rejectReady!: (error: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    void (async () => {
      try {
        while (!abort.signal.aborted && !this.shuttingDown) {
          const result = await this.nextStatus(iterator, abort.signal)
          if (!result || result.done) {
            if (!abort.signal.aborted && !this.shuttingDown) {
              throw new Error('observation ended')
            }
            return
          }
          if (abort.signal.aborted || this.shuttingDown) return
          const snapshot = result.value
          const recovered = this.reconnectTimer !== null || this.reconnecting
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
          if (recovered) this.resetBackoff()
          this.markAvailable(recovered ? `${this.host} Reconnected` : undefined)
          if (snapshot.source === 'registration') {
            this.log.debug(
              `${this.host} Observe registration snapshot (Max-Age ${snapshot.maxAge}s)`,
            )
          }
          this.ingest(snapshot.status, snapshot.maxAge)
          resolveReady()
        }
      } catch (error) {
        if (abort.signal.aborted || this.shuttingDown) return
        rejectReady(error)
        this.log.error(`${this.host} observation failed: ${String(error)}`)
        this.markUnavailable(error instanceof Error ? error.message : String(error))
        this.scheduleReconnect()
      } finally {
        resolveReady()
        if (this.observeIterator === iterator) {
          this.observeIterator = null
          this.observeAbort = null
          this.endObservation(iterator)
        }
      }
    })().catch(rejectReady)
    return ready
  }

  private nextStatus(
    iterator: AsyncIterator<StatusSnapshot>,
    signal: AbortSignal,
  ): Promise<IteratorResult<StatusSnapshot> | null> {
    if (signal.aborted) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(null)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void iterator.next().then(
        (result) => {
          signal.removeEventListener('abort', onAbort)
          resolve(result)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  private stopObserving(): void {
    this.observeAbort?.abort()
    this.observeAbort = null
    const iterator = this.observeIterator
    this.observeIterator = null
    if (iterator) this.endObservation(iterator)
  }

  private endObservation(iterator: AsyncIterator<StatusSnapshot>): void {
    try {
      void iterator.return?.().catch(() => {})
    } catch {
      // Iterator already ended.
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || !this.reconnectClient || this.reconnectTimer || this.reconnecting)
      return
    if (this.watchdog) clearTimeout(this.watchdog)
    this.clearInitialStatusNudge()
    this.awaitingFreshStatus = false
    this.initialStatusNudgesSent = 0
    this.watchdog = null
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect().catch((error: unknown) => {
        if (this.shuttingDown) return
        this.log.error(`${this.host} reconnect task failed: ${String(error)}`)
        this.reconnecting = false
        this.scheduleReconnect()
      })
    }, this.nextBackoffMs())
  }

  private async reconnect(): Promise<void> {
    if (this.shuttingDown || !this.reconnectClient || this.reconnecting) return
    this.reconnecting = true

    let replacement: PhilipsCoapClient | undefined
    try {
      this.stopObserving()
      this.closeCurrentClient()
      replacement = await this.reconnectClient()
      if (this.shuttingDown) {
        replacement.close()
        return
      }
      this.client = replacement
      this.clientClosed = false
      await replacement.connect()
      if (this.shuttingDown) return

      if (this.options.initialStatusNudge) {
        this.markAvailable(`${this.host} Reconnected; waiting for initial status`)
        this.resetBackoff()
        this.beginFreshObservation()
        return
      }

      await this.beginObserving()
      this.resetBackoff()
    } catch (error) {
      try {
        if (replacement && this.client === replacement) this.closeCurrentClient()
        else replacement?.close()
      } catch (cleanupError) {
        this.log.debug(`${this.host} replacement cleanup failed: ${String(cleanupError)}`)
      }
      if (this.shuttingDown) return
      this.log.error(`${this.host} reconnect failed: ${String(error)}`)
      this.markUnavailable(error instanceof Error ? error.message : String(error))
      this.reconnecting = false
      this.scheduleReconnect()
    } finally {
      this.reconnecting = false
    }
  }

  private closeCurrentClient(): void {
    if (this.clientClosed) return
    this.clientClosed = true
    this.client.close()
  }
}
