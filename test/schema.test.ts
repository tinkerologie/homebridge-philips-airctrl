import { describe, expect, it } from 'vitest'
import fixture from './fixtures/ac4220-12-status.json' with { type: 'json' }
import { DeviceInfoSchema, PluginConfigSchema, parseStatusPayload } from '../src/airctrl/schema.js'

describe('parseStatusPayload', () => {
  it('extracts state.reported and preserves every key', () => {
    const reported = parseStatusPayload(JSON.stringify({ state: { reported: fixture } }))
    // Assert the actual invariant — every fixture key survives, none invented —
    // rather than a hard-coded count that breaks whenever the fixture is regenerated.
    expect(new Set(Object.keys(reported))).toEqual(new Set(Object.keys(fixture)))
    expect(reported.D01S05).toBe('AC4220/12')
    expect(reported.D03224).toBe(284)
  })

  it('passes through keys it has never seen', () => {
    const reported = parseStatusPayload(
      JSON.stringify({ state: { reported: { ZZ9999: 'plural-z-alpha' } } }),
    )
    expect(reported.ZZ9999).toBe('plural-z-alpha')
  })

  it('throws when state.reported is absent', () => {
    expect(() => parseStatusPayload(JSON.stringify({ state: {} }))).toThrow(/reported/)
  })

  it('throws on malformed JSON', () => {
    expect(() => parseStatusPayload('not json')).toThrow()
  })
})

describe('DeviceInfoSchema', () => {
  it('parses the plaintext /sys/dev/info payload', () => {
    const info = DeviceInfoSchema.parse({
      product_id: 'c8167180b50111ee899806d016384e4a',
      device_id: '96868ce0a7cb11ef9fbda30d1cde3e50',
      name: 'Office 1',
      type: 'Unicorn',
      modelid: 'AC4220/12',
      swversion: '0.0.0',
    })
    expect(info.modelid).toBe('AC4220/12')
  })
})

describe('PluginConfigSchema', () => {
  it.each([0, -1, 1.5, 65536])('rejects invalid UDP port %s', (port) => {
    expect(() =>
      PluginConfigSchema.parse({
        platform: 'PhilipsAirPurifier',
        devices: [{ host: '192.0.2.1', port }],
      }),
    ).toThrow()
  })

  it.each([1, 65535])('accepts UDP port boundary %s', (port) => {
    expect(
      PluginConfigSchema.parse({
        platform: 'PhilipsAirPurifier',
        devices: [{ host: '192.0.2.1', port }],
      }).devices[0]!.port,
    ).toBe(port)
  })

  it('accepts a minimal config and defaults the switch opt-ins to false', () => {
    const config = PluginConfigSchema.parse({
      platform: 'PhilipsAirPurifier',
      devices: [{ host: '192.168.20.151' }],
    })
    expect(config.devices[0]!.host).toBe('192.168.20.151')
    expect(config.devices[0]!.exposeSleepSwitch).toBe(false)
    expect(config.devices[0]!.exposeBeepSwitch).toBe(false)
  })

  it('rejects a device with no host', () => {
    expect(() =>
      PluginConfigSchema.parse({ platform: 'PhilipsAirPurifier', devices: [{}] }),
    ).toThrow()
  })

  it('defaults devices to an empty list so an unconfigured plugin is inert', () => {
    expect(PluginConfigSchema.parse({ platform: 'PhilipsAirPurifier' }).devices).toEqual([])
  })
})
