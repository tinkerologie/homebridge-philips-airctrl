// Build the .tasks.json from the plan doc so descriptions cannot drift from it.
import { readFileSync, writeFileSync } from 'node:fs'

const PLAN = 'docs/superpowers/plans/2026-07-30-homebridge-philips-airctrl.md'
const doc = readFileSync(PLAN, 'utf8')

const GATE_BANNER =
  '> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.'

// id -> { subject, blockedBy, metadata }
const META = {
  0: {
    subject: 'Task 0: Scaffold ESM plugin package',
    blockedBy: [],
    m: {
      files: [
        'package.json',
        'tsconfig.json',
        'eslint.config.js',
        'vitest.config.ts',
        'src/settings.ts',
        'src/index.ts',
        'test/scaffold.test.ts',
      ],
      verifyCommand: 'npm run build && npm test && npm run lint',
      modelTier: 'mechanical',
    },
  },
  1: {
    subject: 'Task 1: Port encryption layer to node:crypto',
    blockedBy: [0],
    m: {
      files: ['src/airctrl/crypto.ts', 'test/crypto.test.ts'],
      verifyCommand: 'npx vitest run test/crypto.test.ts',
      modelTier: 'standard',
    },
  },
  2: {
    subject: 'Task 2: Implement minimal CoAP over node:dgram',
    blockedBy: [0],
    m: {
      files: [
        'src/airctrl/coap/message.ts',
        'src/airctrl/coap/socket.ts',
        'test/coap-message.test.ts',
        'test/coap-socket.test.ts',
      ],
      verifyCommand: 'npx vitest run test/coap-message.test.ts test/coap-socket.test.ts',
      modelTier: 'frontier',
    },
  },
  3: {
    subject: 'Task 3: Define zod trust boundaries',
    blockedBy: [0],
    m: {
      files: ['src/airctrl/schema.ts', 'test/schema.test.ts'],
      verifyCommand: 'npx vitest run test/schema.test.ts',
      modelTier: 'standard',
    },
  },
  4: {
    subject: 'Task 4: Port the Philips CoAP client',
    blockedBy: [1, 2, 3],
    m: {
      files: ['src/airctrl/client.ts', 'test/client.test.ts', 'test/helpers/fake-device.ts'],
      verifyCommand: 'npx vitest run test/client.test.ts',
      modelTier: 'frontier',
    },
  },
  5: {
    subject: 'Task 5: Port device key and model tables',
    blockedBy: [0],
    m: {
      files: ['src/device/keys.ts', 'src/device/models.ts', 'test/models.test.ts'],
      verifyCommand: 'npx vitest run test/models.test.ts',
      modelTier: 'mechanical',
    },
  },
  6: {
    subject: 'Task 6: Build the device coordinator',
    blockedBy: [4],
    m: {
      files: ['src/device/coordinator.ts', 'test/coordinator.test.ts'],
      verifyCommand: 'npx vitest run test/coordinator.test.ts',
      modelTier: 'frontier',
    },
  },
  7: {
    subject: 'Task 7: Implement network discovery',
    blockedBy: [4],
    m: {
      files: ['src/airctrl/discovery.ts', 'test/discovery.test.ts'],
      verifyCommand: 'npx vitest run test/discovery.test.ts',
      modelTier: 'standard',
    },
  },
  8: {
    subject: 'Task 8: Map device state to HomeKit services',
    blockedBy: [5, 6],
    m: {
      files: ['src/homekit/mapping.ts', 'src/accessory.ts', 'test/mapping.test.ts'],
      verifyCommand: 'npx vitest run test/mapping.test.ts && npm run build',
      modelTier: 'frontier',
    },
  },
  9: {
    subject: 'Task 9: Wire up the dynamic platform',
    blockedBy: [8],
    m: {
      files: ['src/platform.ts', 'src/index.ts', 'test/platform.test.ts'],
      verifyCommand: 'npx vitest run test/platform.test.ts && npm run build',
      modelTier: 'standard',
    },
  },
  10: {
    subject: 'Task 10: Build the custom configuration UI',
    blockedBy: [7, 9],
    m: {
      files: ['config.schema.json', 'homebridge-ui/server.js', 'homebridge-ui/public/index.html'],
      verifyCommand:
        "node -e \"JSON.parse(require('fs').readFileSync('config.schema.json','utf8')); console.log('schema OK')\" && npm pack --dry-run 2>&1 | grep -E 'homebridge-ui|config.schema'",
      modelTier: 'standard',
    },
  },
  11: {
    subject: 'Task 11: Deploy and verify on real hardware',
    blockedBy: [10],
    gate: true,
    m: {
      files: ['scripts/deploy.sh', '.env.example'],
      verifyCommand:
        "bash scripts/deploy.sh && sshpass -p \"$UNRAID_PASS\" ssh -o StrictHostKeyChecking=no root@192.168.20.21 'docker logs --tail 300 homebridge' | grep -iE 'philips|AC4220|unhandled|exception'",
      verifyEvidence: 'captured docker logs plus observed Home app/UI behaviour',
      userGate: true,
      tags: ['user-gate', 'hardware'],
      gateScope: 'single-device',
      failurePolicy: 'stop',
      requireEvidenceTokens: [
        ['added', 'AC4220', 'online'],
        ['No Response', 'unavailable', 'offline'],
        ['Reconnected', 'recovered', 'back online'],
      ],
      modelTier: 'frontier',
    },
  },
  12: {
    subject: 'Task 12: Adversarial code review and fixes',
    blockedBy: [11],
    gate: true,
    m: {
      files: ['docs/superpowers/reviews/2026-07-30-review-notes.md'],
      verifyCommand: 'npm test && npm run build && npm run lint',
      verifyEvidence: 'captured CodeRabbit and Codex outputs plus the review notes table',
      userGate: true,
      tags: ['user-gate', 'review'],
      gateScope: 'whole-repo',
      failurePolicy: 'stop',
      requireEvidenceTokens: [
        ['coderabbit', 'CodeRabbit'],
        ['codex', 'Codex'],
      ],
      modelTier: 'frontier',
    },
  },
}

/** Pull the Goal/Files/Acceptance Criteria/Verify block for one task out of the plan. */
function sections(id) {
  const start = doc.indexOf(`### Task ${id}:`)
  if (start === -1) throw new Error(`Task ${id} heading not found in ${PLAN}`)
  const body = doc.slice(start)
  const end = body.indexOf('**Steps:**')
  if (end === -1) throw new Error(`Task ${id} has no **Steps:** marker`)
  // Drop the heading line, keep everything up to Steps.
  return body.slice(body.indexOf('\n') + 1, end).trim()
}

/** Acceptance criteria as plain strings, for the metadata array. */
function criteria(block) {
  const start = block.indexOf('**Acceptance Criteria:**')
  const rest = block.slice(start)
  const stop = rest.indexOf('**Verify:**')
  return rest
    .slice(0, stop === -1 ? undefined : stop)
    .split('\n')
    .filter((line) => line.trim().startsWith('- [ ]'))
    .map((line) =>
      line
        .trim()
        .replace(/^- \[ \]\s*/, '')
        .replace(/`/g, ''),
    )
}

const tasks = Object.entries(META).map(([key, spec]) => {
  const id = Number(key)
  const block = sections(id)
  const acceptanceCriteria = criteria(block)
  if (acceptanceCriteria.length === 0) throw new Error(`Task ${id} produced no acceptance criteria`)

  const metadata = { ...spec.m, acceptanceCriteria }
  const goalLine = block.slice(0, block.indexOf('\n'))
  const afterGoal = block.slice(block.indexOf('\n'))
  const description = [
    spec.gate ? `${goalLine}\n\n${GATE_BANNER}${afterGoal}` : block,
    '',
    `Full step-by-step code is in \`${PLAN}\` under Task ${id}.`,
    '',
    '```json:metadata',
    JSON.stringify(metadata),
    '```',
  ].join('\n')

  return {
    id,
    subject: spec.subject,
    status: 'pending',
    ...(spec.blockedBy.length ? { blockedBy: spec.blockedBy } : {}),
    description,
  }
})

if (!process.argv[2])
  throw new Error('Usage: node scripts/gen-tasks.mjs <lastUpdated ISO timestamp>')
const out = { planPath: PLAN, tasks, lastUpdated: process.argv[2] }
writeFileSync(`${PLAN}.tasks.json`, `${JSON.stringify(out, null, 2)}\n`)

// Self-check: every task must carry all four section headers.
for (const header of ['**Goal:**', '**Files:**', '**Acceptance Criteria:**', '**Verify:**']) {
  const count = tasks.filter((t) => t.description.includes(header)).length
  console.log(
    `${header.padEnd(26)} ${count}/${tasks.length}${count === tasks.length ? '' : '  <-- MISSING'}`,
  )
}
console.log(
  `fences${' '.repeat(20)} ${tasks.filter((t) => t.description.includes('```json:metadata')).length}/${tasks.length}`,
)
console.log(
  `gate banners${' '.repeat(14)} ${tasks.filter((t) => t.description.includes('USER-ORDERED GATE')).length}/2`,
)
console.log(
  `criteria per task: ${tasks.map((t) => JSON.parse(t.description.split('```json:metadata\n')[1].split('\n```')[0]).acceptanceCriteria.length).join(', ')}`,
)
