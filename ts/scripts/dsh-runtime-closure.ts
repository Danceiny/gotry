export type DshLockPackage = {
  version?: string
}

export type DshRuntimeClosureInput = {
  dependencies: Record<string, string>
  lockPackages: Record<string, DshLockPackage>
  runtimeVersion: string
}

export type DshRuntimeClosure = {
  names: string[]
  version: string
}

export function parsePnpmDshLock(text: string): Record<string, DshLockPackage> {
  const packages: Record<string, DshLockPackage> = {}
  const seen = new Set<string>()
  const variants = new Map<string, number>()
  const entry = /^\s{2}['"]?(\@deepseek-ai\/dsh(?:-[^@'":\s]+)?)@([^'":\s(]+)(?:\([^'"]*\))?['"]?:/gm
  for (const match of text.matchAll(entry)) {
    const name = match[1]!
    const version = match[2]!
    const identity = `${name}@${version}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const variant = variants.get(name) ?? 0
    variants.set(name, variant + 1)
    const prefix = variant === 0 ? '' : `.pnpm-variant-${variant}/node_modules/`
    packages[`node_modules/${prefix}${name}`] = { version }
  }
  return packages
}

export function validateDshRuntimeClosure(input: DshRuntimeClosureInput): DshRuntimeClosure {
  const dshVersion = input.dependencies['@deepseek-ai/dsh']
  if (typeof dshVersion !== 'string' || !/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(dshVersion)) {
    throw new Error('@deepseek-ai/dsh 必须以精确 prerelease 版本声明')
  }
  if (dshVersion !== input.runtimeVersion) {
    throw new Error(`DSH runtime guard 版本漂移:${input.runtimeVersion}(manifest ${dshVersion})`)
  }

  const dshNodes = Object.entries(input.lockPackages)
    .flatMap(([path, metadata]) => {
      const match = path.match(/(?:^|\/)node_modules\/(\@deepseek-ai\/dsh(?:-[^/]+)?)$/)
      return match ? [{ name: match[1]!, version: metadata.version }] : []
    })
    .sort((left, right) => left.name.localeCompare(right.name))
  if (dshNodes.length === 0) throw new Error('package-lock 未解析到 DSH runtime closure')

  for (const dependency of dshNodes) {
    if (dependency.version !== dshVersion) {
      throw new Error(`DSH lock 版本漂移:${dependency.name}@${dependency.version ?? 'missing'}(expected ${dshVersion})`)
    }
  }

  const lockNames = [...new Set(dshNodes.map((dependency) => dependency.name))].sort()
  const manifestNames = Object.keys(input.dependencies)
    .filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    .sort()
  const missing = lockNames.filter((name) => !manifestNames.includes(name))
  const extra = manifestNames.filter((name) => !lockNames.includes(name))
  if (missing.length > 0) {
    throw new Error(`DSH closure 未精确声明:${missing[0]}@${dshVersion}`)
  }
  if (extra.length > 0) {
    throw new Error(`DSH manifest 与 lock 集合不一致:missing=${missing.join(',') || '-'};extra=${extra.join(',') || '-'}`)
  }
  for (const name of manifestNames) {
    if (input.dependencies[name] !== dshVersion) {
      throw new Error(`DSH closure 未精确声明:${name}@${dshVersion}`)
    }
  }

  return { names: lockNames, version: dshVersion }
}
