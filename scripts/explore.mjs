// Hardware exploration: probe key domains and mode->speed behaviour.
// Records original values first and restores them at the end, always.
import crypto from 'node:crypto'
import coap from 'coap'

const HOST = process.argv[2] ?? '192.168.20.151'
const PORT = 5683
const SECRET = 'JiangPan'

const parts = (k) => {
  const x = crypto
    .createHash('md5')
    .update(SECRET + k)
    .digest('hex')
    .toUpperCase()
  return [Buffer.from(x.slice(0, 16), 'ascii'), Buffer.from(x.slice(16), 'ascii')]
}
// NOTE: >>> 0, not & 0xFFFFFFFF — JS & is signed and breaks above 0x7FFFFFFF.
const nextKey = (k) => ((parseInt(k, 16) + 1) >>> 0).toString(16).padStart(8, '0').toUpperCase()

function encrypt(key, payload) {
  const [k, iv] = parts(key)
  const c = crypto.createCipheriv('aes-128-cbc', k, iv)
  const ct = Buffer.concat([c.update(payload, 'utf8'), c.final()])
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
function decrypt(blob) {
  const key = blob.slice(0, 8),
    ct = blob.slice(8, -64)
  const [k, iv] = parts(key)
  const d = crypto.createDecipheriv('aes-128-cbc', k, iv)
  return Buffer.concat([d.update(Buffer.from(ct, 'hex')), d.final()]).toString('utf8')
}
function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = coap.request({ hostname: HOST, port: PORT, confirmable: false, ...opts })
    const t = setTimeout(() => reject(new Error('timeout ' + opts.pathname)), 8000)
    r.on('response', (res) => {
      clearTimeout(t)
      resolve(res)
    })
    r.on('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
    if (body !== undefined) r.write(Buffer.from(body))
    r.end()
  })
}

let clientKey = (
  await req(
    { method: 'POST', pathname: '/sys/dev/sync' },
    crypto.randomBytes(4).toString('hex').toUpperCase(),
  )
).payload
  .toString()
  .trim()

const stream = await req({ method: 'GET', pathname: '/sys/dev/status', observe: true })
let latest = JSON.parse(decrypt(stream.payload.toString())).state.reported
stream.on('data', (buf) => {
  try {
    latest = JSON.parse(decrypt(buf.toString())).state.reported
  } catch {}
})

const ORIGINAL = { ...latest }
const WATCH = [
  'D03102',
  'D03103',
  'D03105',
  'D0310A',
  'D0310C',
  'D0310D',
  'D03130',
  'D03135',
  'D0312A',
]
console.log('original:', Object.fromEntries(WATCH.map((k) => [k, ORIGINAL[k]])))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function write(key, value) {
  clientKey = nextKey(clientKey)
  const body = JSON.stringify({
    state: { desired: { CommandType: 'app', DeviceId: '', EnduserId: '', [key]: value } },
  })
  const res = await req({ method: 'POST', pathname: '/sys/dev/control' }, encrypt(clientKey, body))
  const ok = JSON.parse(res.payload.toString()).status === 'success'
  await sleep(2500) // let the device push
  return ok
}

async function probe(key, values, extra = []) {
  console.log(`\n=== ${key} ===`)
  for (const v of values) {
    const ok = await write(key, v)
    const seen = latest[key]
    const side = extra.map((k) => `${k}=${latest[k]}`).join(' ')
    console.log(
      `  set ${JSON.stringify(v).padEnd(6)} ack=${String(ok).padEnd(5)} readback=${JSON.stringify(seen).padEnd(6)} ${side}`,
    )
  }
}

try {
  // 1. Is D03130 boolean or a 0-100 range? Original reads 100.
  await probe('D03130', [0, 50, 1, 100])

  // 2. Mode -> reported speed. Validates the RotationSpeed ladder.
  await probe('D0310C', [1, 2, 3, 4, 5, 17, 18, 19, 0], ['D0310D', 'D0310A'])

  // 3. Child lock: boolean?
  await probe('D03103', [1, 0])

  // 4. Display backlight: boolean or 3-step + auto?
  await probe('D03105', [1, 2, 3, 0])
} finally {
  console.log('\n=== restoring originals ===')
  let restoreFailed = false
  for (const k of ['D03130', 'D03103', 'D03105', 'D0310C', 'D03102']) {
    if (ORIGINAL[k] === undefined) continue
    // Attempt every restore even if an earlier one throws — a failed light
    // restore must never skip the power restore that follows it.
    try {
      const ok = await write(k, ORIGINAL[k])
      console.log(
        `  ${k} -> ${JSON.stringify(ORIGINAL[k])} ack=${ok} readback=${JSON.stringify(latest[k])}`,
      )
      if (!ok) restoreFailed = true
    } catch (error) {
      restoreFailed = true
      console.log(
        `  ${k} -> ${JSON.stringify(ORIGINAL[k])} FAILED: ${error instanceof Error ? error.message : error}`,
      )
    }
  }
  const drift = WATCH.filter((k) => JSON.stringify(latest[k]) !== JSON.stringify(ORIGINAL[k]))
  if (drift.length) {
    restoreFailed = true
    console.log(`!! DRIFT: ${drift.map((k) => `${k}: ${ORIGINAL[k]} -> ${latest[k]}`).join(', ')}`)
  } else {
    console.log('all watched keys restored')
  }
  stream.close?.()
  process.exitCode = restoreFailed ? 1 : 0
}
