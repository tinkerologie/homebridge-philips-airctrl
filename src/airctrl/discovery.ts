import { networkInterfaces } from 'node:os'
import { PhilipsCoapClient } from './client.js'

const MAX_USABLE_HOSTS = 1024

export interface DiscoveredDevice {
  host: string
  model: string
  name: string
  deviceId?: string
  firmware?: string
}

export interface DiscoverOptions {
  hosts?: string[]
  subnet?: string
  port?: number
  timeoutMs?: number
  concurrency?: number
}

function ipv4ToInt(address: string): number {
  const octets = address.split('.')
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet) || Number(octet) > 255))
    throw new RangeError(`invalid IPv4 address: ${address}`)
  return octets.reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0)
}

function isIpv4(address: string): boolean {
  try {
    ipv4ToInt(address)
    return true
  } catch {
    return false
  }
}

function intToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.')
}

function subnet(cidr: string): { network: number; broadcast: number; prefix: number } {
  const parts = cidr.split('/')
  if (parts.length !== 2 || !/^\d+$/.test(parts[1]!)) {
    throw new RangeError(`invalid IPv4 CIDR: ${cidr}`)
  }
  const [address, prefixText] = parts
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new RangeError(`invalid IPv4 CIDR: ${cidr}`)
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const network = (ipv4ToInt(address!) & mask) >>> 0
  return { network, broadcast: (network | ~mask) >>> 0, prefix }
}

export function localSubnets(): string[] {
  const cidrs = new Set<string>()
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (
        address.family !== 'IPv4' ||
        address.internal ||
        address.address.startsWith('127.') ||
        !address.cidr
      )
        continue
      const { network, prefix } = subnet(address.cidr)
      cidrs.add(`${intToIpv4(network)}/${prefix}`)
    }
  }
  return [...cidrs]
}

export function hostsInSubnet(cidr: string): Generator<string> {
  const { network, broadcast } = subnet(cidr)
  const usableHosts = Math.max(0, broadcast - network - 1)
  if (usableHosts > MAX_USABLE_HOSTS) {
    throw new RangeError(`subnet ${cidr} exceeds the maximum of 1,024 usable hosts`)
  }
  return (function* () {
    for (let host = network + 1; host < broadcast; host++) yield intToIpv4(host)
  })()
}

export async function probeHost(
  host: string,
  port = 5683,
  timeoutMs = 2000,
): Promise<DiscoveredDevice | null> {
  const client = new PhilipsCoapClient(host, port)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const info = await Promise.race([
      client.getInfo(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('discovery timeout')), timeoutMs)
      }),
    ])
    if (!info.modelid) return null
    return {
      host,
      model: info.modelid,
      name: info.name ?? info.modelid,
      ...(info.device_id && { deviceId: info.device_id }),
      ...(info.swversion && { firmware: info.swversion }),
    }
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
    client.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

export async function discover(options: DiscoverOptions = {}): Promise<DiscoveredDevice[]> {
  const { port = 5683, timeoutMs = 2000, concurrency = 32 } = options
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError('concurrency must be a positive integer')
  }

  const hosts = options.hosts
    ? options.hosts.filter(isIpv4)
    : options.subnet
      ? [...hostsInSubnet(options.subnet)]
      : localSubnets().flatMap((cidr) => {
          try {
            return [...hostsInSubnet(cidr)]
          } catch (error) {
            // One oversized interface (docker0 /16, an APIPA /16, ...) must not
            // abort the whole scan; sweep every other subnet instead.
            console.warn(`[philips-air] skipping subnet ${cidr}: ${(error as Error).message}`)
            return []
          }
        })
  const found: DiscoveredDevice[] = []
  let next = 0

  async function worker(): Promise<void> {
    while (next < hosts.length) {
      const host = hosts[next++]!
      const device = await probeHost(host, port, timeoutMs)
      if (device) found.push(device)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, () => worker()))
  return found.sort((a, b) => ipv4ToInt(a.host) - ipv4ToInt(b.host))
}
