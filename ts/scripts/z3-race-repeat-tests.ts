/** Multi-process Z3 race repeat proof for issue #227. */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  assert.ok(Number.isInteger(value) && value > 0, `${name} must be a positive integer`)
  return value
}

const repeats = parsePositiveInt('GOTRY_Z3_RACE_REPEAT_PROCESSES', 3)
const rounds = parsePositiveInt('GOTRY_Z3_RACE_REPEAT_ROUNDS', parsePositiveInt('GOTRY_Z3_RACE_ROUNDS', 12))
const artifactDir = process.env.GOTRY_Z3_RACE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'gotry-z3-race-repeat-'))
mkdirSync(artifactDir, { recursive: true })

const tsRoot = process.cwd()
const tsxCli = join(tsRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
assert.ok(existsSync(tsxCli), `tsx CLI not found: ${tsxCli}`)

for (let i = 1; i <= repeats; i++) {
  const result = spawnSync(process.execPath, [tsxCli, 'scripts/z3-race-tests.ts'], {
    cwd: tsRoot,
    env: {
      ...process.env,
      GOTRY_Z3_RACE_ROUNDS: String(rounds),
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const outFile = join(artifactDir, `${String(i).padStart(2, '0')}.out`)
  const errFile = join(artifactDir, `${String(i).padStart(2, '0')}.err`)
  writeFileSync(outFile, result.stdout ?? '')
  writeFileSync(errFile, result.stderr ?? '')
  assert.equal(result.status, 0, `repeat ${i} failed; stdout=${outFile} stderr=${errFile}`)
  assert.match(result.stdout ?? '', /Z3 RACE TESTS OK/, `repeat ${i} did not report success; stdout=${outFile}`)
}

console.log(`Z3 RACE REPEAT TESTS OK(processes=${repeats}, rounds=${rounds}, artifactDir=${artifactDir})`)
