import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REQUIRED_BENCHMARK_DSH_VERSION } from '../../bin/gotry-runtime-resolution.js'
import {
  parsePnpmDshLock,
  REQUIRED_DSH_RUNTIME_PACKAGE_COUNT,
  validateDshRuntimeClosure,
} from './dsh-runtime-closure.ts'

const consumerRoot = process.argv[2]
assert.ok(consumerRoot, 'usage: pnpm-dsh-closure-proof.ts <clean-consumer-root>')

const installedPackage = JSON.parse(readFileSync(
  resolve(consumerRoot, 'node_modules/@danceiny/gotry/package.json'),
  'utf8',
)) as { dependencies?: Record<string, string> }
const lockPackages = parsePnpmDshLock(readFileSync(resolve(consumerRoot, 'pnpm-lock.yaml'), 'utf8'))
const closure = validateDshRuntimeClosure({
  dependencies: installedPackage.dependencies ?? {},
  lockPackages,
  runtimeVersion: REQUIRED_BENCHMARK_DSH_VERSION,
  expectedPackageCount: REQUIRED_DSH_RUNTIME_PACKAGE_COUNT,
})
assert.equal(closure.names.length, REQUIRED_DSH_RUNTIME_PACKAGE_COUNT, 'clean pnpm consumer must resolve the complete Round 5 DSH closure')

console.log(`PNPM DSH CLOSURE PROOF: ${closure.names.length} packages at ${closure.version}`)
