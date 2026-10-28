// Follow-up: D03105 backlight writes were ACKed but ignored. Find what
// actually controls the display/light, and confirm the D03130 on-value.
import crypto from 'node:crypto'
import coap from 'coap'

const HOST = process.argv[2] ?? '192.168.20.151'
const SECRET = 'JiangPan'
const parts = (k) => {
  const x = crypto
    .createHash('md5')
    .update(SECRET + k)
    .digest('hex')
    .toUpperCase()
  return [Buffer.from(x.slice(0, 16), 'ascii'), Buffer.from(x.slice(16), 'ascii')]
}
const nextKey = (k) => ((parseInt(k, 16) + 1) >>> 0).toString(16).padStart(8, '0').toUpperCase()
const encrypt = (key, p) => {
  const [k, iv] = parts(key)
  const c = crypto.createCipheriv('aes-128-cbc', k, iv)
  const ct = Buffer.concat([c.update(p, 'utf8'), c.final()])
    .toString('hex')
    .toUpperCase()
  return (
    key +
    ct +
    crypto
      .createHash('sha256')
      .update(key + ct)
      .digest('hex')
      .toUpperCase()
  )
}
const decrypt = (b) => {
  const [k, iv] = parts(b.slice(0, 8))
  const d = crypto.createDecipheriv('aes-128-cbc', k, iv)
  return Buffer.concat([d.update(Buffer.from(b.slice(8, -64), 'hex')), d.final()]).toString('utf8')
}
const req = (opts, body) =>
  new Promise((res, rej) => {
    const r = coap.request({ hostname: HOST, port: 5683, confirmable: false, ...opts })
    const t = setTimeout(() => rej(new Error('timeout')), 8000)
    r.on('response', (x) => {
      clearTimeout(t)
      res(x)
    })
    r.on('error', (e) => {
      clearTimeout(t)
      rej(e)
    })
    if (body !== undefined) r.write(Buffer.from(body))
    r.end()
  })

let ck = (
  await req(
    { method: 'POST', pathname: '/sys/dev/sync' },
    crypto.randomBytes(4).toString('hex').toUpperCase(),
  )
).payload
  .toString()
  .trim()
const stream = await req({ method: 'GET', pathname: '/sys/dev/status', observe: true })
let latest = JSON.parse(decrypt(stream.payload.toString())).state.reported
stream.on('data', (b) => {
  try {
    latest = JSON.parse(decrypt(b.toString())).state.reported
  } catch {}
})

const LIGHT = ['D03105', 'D03135', 'D03136', 'D03137', 'D0313B', 'D03134']
const ORIGINAL = { ...latest }
console.log('original:', Object.fromEntries(LIGHT.map((k) => [k, ORIGINAL[k]])))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function write(key, value) {
  ck = nextKey(ck)
  const body = JSON.stringify({
    state: { desired: { CommandType: 'app', DeviceId: '', EnduserId: '', [key]: value } },
  })
  const res = await req({ method: 'POST', pathname: '/sys/dev/control' }, encrypt(ck, body))
  await sleep(2500)
  return JSON.parse(res.payload.toString()).status === 'success'
}
async function probe(key, values, extra) {
  console.log(`\n=== ${key} ===`)
  for (const v of values) {
    const ok = await write(key, v)
    console.log(
      `  set ${String(v).padEnd(4)} ack=${String(ok).padEnd(5)} readback=${String(latest[key]).padEnd(5)} ${extra.map((k) => `${k}=${latest[k]}`).join(' ')}`,
    )
  }
}

try {
  await probe('D03135', [1, 2, 3, 0], ['D03105', 'D03136', 'D0313B'])
  await probe('D03137', [0, 1], ['D03105', 'D03135'])
  console.log('\n=== retry D03105 after touching lamp mode ===')
  await probe('D03105', [1, 2, 0], ['D03135'])
  console.log('\n=== D0313B (reads 20) ===')
  await probe('D0313B', [50, 100, 20], ['D03105'])
} finally {
  console.log('\n=== restoring ===')
  for (const k of LIGHT) {
    if (ORIGINAL[k] === undefined || latest[k] === ORIGINAL[k]) continue
    await write(k, ORIGINAL[k])
    console.log(`  ${k} -> ${ORIGINAL[k]} readback=${latest[k]}`)
  }
  const drift = LIGHT.filter((k) => latest[k] !== ORIGINAL[k])
  console.log(
    drift.length
      ? `!! DRIFT: ${drift.map((k) => `${k}: ${ORIGINAL[k]}->${latest[k]}`).join(', ')}`
      : 'all light keys restored',
  )
  stream.close?.()
  process.exit(0)
}
