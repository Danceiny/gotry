import { readFileSync } from 'node:fs'
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

export function selectDshRuntime({ rootResolver }) {
  const root = resolveDshPackage(rootResolver)
  if (root) return { ...root, source: 'root' }
  // D-27 清偿(issue #120):legacy vendored 回退路径已移除——该形态的 Node 兼容窗口
  // 断裂(Round 5 起「不承诺可运行」),解析成功只会把「dsh 缺失」变成下游玄学失败。
  // 唯一受支持形态 = root manifest / 依赖解析(216 精确依赖闭包);找不到即 fail-closed,
  // 由调用方给明确重装指引。benchmark 原本就禁用回退,语义不变(入参保留以稳调用面)。
  return null
}

export function benchmarkRuntimeSupported(runtime) {
  return runtime?.version === REQUIRED_BENCHMARK_DSH_VERSION
}

export function selectDshCwd({ repoRoot, invocationCwd, sourceCheckoutMode, benchmark }) {
  if (sourceCheckoutMode && !benchmark) return join(repoRoot, 'ts/dsh-runtime')
  return invocationCwd
}
