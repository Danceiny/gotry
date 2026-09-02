export type DshResolver = {
  resolve(specifier: string): string
}

export type DshRuntime = {
  bin: string
  version: string
  source: 'root' | 'legacy-vendored'
}

export const REQUIRED_BENCHMARK_DSH_VERSION: '0.1.2-alpha.3'

export function readDshPackage(bin: string): Omit<DshRuntime, 'source'> | null
export function resolveDshPackage(resolver: DshResolver): Omit<DshRuntime, 'source'> | null
export function supportsNodeVersion(version: string): boolean
export function selectDshRuntime(options: {
  repoRoot: string
  rootResolver: DshResolver
  benchmark: boolean
}): DshRuntime | null
export function benchmarkRuntimeSupported(runtime: { version: string } | null): boolean
export function selectDshCwd(options: {
  repoRoot: string
  invocationCwd: string
  sourceCheckoutMode: boolean
  benchmark: boolean
}): string
