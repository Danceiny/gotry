import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const REQUIRED_BENCHMARK_DSH_VERSION = '0.1.2-alpha.3'

export function readDshPackage(bin) {
  try {
    const packageJson = join(dirname(dirname(bin)), 'package.json')
    const metadata = JSON.parse(readFileSync(packageJson, 'utf8'))
    return typeof metadata.version === 'string' ? { bin, version: metadata.version } : null
  } catch {
    return null
  }
}

export function resolveDshPackage(resolver) {
  try {
    return readDshPackage(resolver.resolve('@deepseek-ai/dsh/lib/bin.js'))
  } catch {
    return null
  }
}

export function supportsNodeVersion(version) {
  const match = /^(\d+)\.(\d+)/.exec(version)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 22 || (major === 22 && minor >= 15)
}

export function selectDshRuntime({ repoRoot, rootResolver, benchmark }) {
  const root = resolveDshPackage(rootResolver)
  if (root) return { ...root, source: 'root' }
  if (benchmark) return null

  const vendoredBin = join(repoRoot, 'ts/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!existsSync(vendoredBin)) return null
  const vendored = readDshPackage(vendoredBin)
  return vendored ? { ...vendored, source: 'legacy-vendored' } : null
}

export function benchmarkRuntimeSupported(runtime) {
  return runtime?.version === REQUIRED_BENCHMARK_DSH_VERSION
}

export function selectDshCwd({ repoRoot, invocationCwd, sourceCheckoutMode, benchmark }) {
  if (sourceCheckoutMode && !benchmark) return join(repoRoot, 'ts/dsh-runtime')
  return invocationCwd
}
