export type DshLockPackage = {
  version?: string
}

export const REQUIRED_DSH_RUNTIME_PACKAGE_COUNT = 216

export type DshRuntimeClosureInput = {
  dependencies: Record<string, string>
  lockPackages: Record<string, DshLockPackage>
  runtimeVersion: string
  expectedPackageCount?: number
}

export type DshRuntimeClosure = {
  names: string[]
  version: string
}

export type PnpmRootDshImporterEntry = {
  specifier: string
  resolvedVersion: string
}

export type PnpmRootDshImporterInput = {
  dependencies: Record<string, string>
  importerEntries: Record<string, PnpmRootDshImporterEntry>
  runtimeVersion: string
  expectedPackageCount?: number
}

function yamlScalar(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, '')
  const quoted = trimmed.match(/^(['"])(.*)\1$/)
  return quoted?.[2] ?? trimmed
}

function indentation(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0
}

function resolvedPnpmVersion(value: string): string {
  return yamlScalar(value).replace(/\(.+$/, '')
}

export function parsePnpmRootDshImporter(text: string): Record<string, PnpmRootDshImporterEntry> {
  const lines = text.split(/\r?\n/)
  const importers = lines
    .map((line, index) => line === 'importers:' ? index : -1)
    .filter((index) => index >= 0)
  if (importers.length !== 1) throw new Error('pnpm lock importers 区块不可用')

  const importersStart = importers[0]!
  const importersEnd = lines.findIndex((line, index) => index > importersStart && line.trim() !== '' && indentation(line) === 0)
  const rootCandidates = lines
    .map((line, index) => index > importersStart && (importersEnd < 0 || index < importersEnd)
      && /^ {2}(?:\.|'\.'|"\."):\s*$/.test(line) ? index : -1)
    .filter((index) => index >= 0)
  if (rootCandidates.length !== 1) throw new Error('pnpm root importer 不唯一')

  const rootStart = rootCandidates[0]!
  const rootEndRelative = lines.slice(rootStart + 1, importersEnd < 0 ? lines.length : importersEnd)
    .findIndex((line) => line.trim() !== '' && indentation(line) <= 2)
  const rootEnd = rootEndRelative < 0
    ? (importersEnd < 0 ? lines.length : importersEnd)
    : rootStart + 1 + rootEndRelative
  const dependencyBlocks = lines
    .map((line, index) => index > rootStart && index < rootEnd && /^ {4}dependencies:\s*$/.test(line) ? index : -1)
    .filter((index) => index >= 0)
  if (dependencyBlocks.length !== 1) throw new Error('pnpm root importer dependencies 区块不可用')

  const dependenciesStart = dependencyBlocks[0]!
  const dependenciesEndRelative = lines.slice(dependenciesStart + 1, rootEnd)
    .findIndex((line) => line.trim() !== '' && indentation(line) <= 4)
  const dependenciesEnd = dependenciesEndRelative < 0 ? rootEnd : dependenciesStart + 1 + dependenciesEndRelative
  const entries = lines
    .map((line, index) => {
      if (index <= dependenciesStart || index >= dependenciesEnd) return null
      const match = line.match(/^ {6}(['"]?)([^'":\s]+)\1:\s*$/)
      return match ? { index, name: match[2]! } : null
    })
    .filter((entry): entry is { index: number; name: string } => entry !== null)

  const importerEntries: Record<string, PnpmRootDshImporterEntry> = {}
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!
    if (entry.name !== '@deepseek-ai/dsh' && !entry.name.startsWith('@deepseek-ai/dsh-')) continue
    if (Object.hasOwn(importerEntries, entry.name)) throw new Error(`pnpm root importer DSH 依赖重复:${entry.name}`)
    const end = entries[entryIndex + 1]?.index ?? dependenciesEnd
    const block = lines.slice(entry.index + 1, end)
    const specifiers = block
      .map((line) => line.match(/^ {8}specifier:\s*(.+)$/)?.[1])
      .filter((value): value is string => value !== undefined)
    if (specifiers.length !== 1) throw new Error(`pnpm root importer specifier 不可用:${entry.name}`)
    const versions = block
      .map((line) => line.match(/^ {8}version:\s*(.+)$/)?.[1])
      .filter((value): value is string => value !== undefined)
    if (versions.length !== 1) throw new Error(`pnpm root importer version 不可用:${entry.name}`)
    importerEntries[entry.name] = {
      specifier: yamlScalar(specifiers[0]!),
      resolvedVersion: resolvedPnpmVersion(versions[0]!),
    }
  }
  return importerEntries
}

export function validatePnpmRootDshImporter(input: PnpmRootDshImporterInput): DshRuntimeClosure {
  const manifestNames = Object.keys(input.dependencies)
    .filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    .sort()
  const importerNames = Object.keys(input.importerEntries).sort()
  const missing = manifestNames.filter((name) => !importerNames.includes(name))
  const extra = importerNames.filter((name) => !manifestNames.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`pnpm root importer 与 manifest 集合不一致:missing=${missing.join(',') || '-'};extra=${extra.join(',') || '-'}`)
  }
  for (const name of importerNames) {
    const importerEntry = input.importerEntries[name]!
    if (input.dependencies[name] !== input.runtimeVersion || importerEntry.specifier !== input.runtimeVersion) {
      throw new Error(`pnpm root importer 未精确锁定:${name}@${input.runtimeVersion}`)
    }
    if (importerEntry.resolvedVersion !== input.runtimeVersion) {
      throw new Error(`pnpm root importer resolved 版本漂移:${name}@${importerEntry.resolvedVersion}(expected ${input.runtimeVersion})`)
    }
  }
  if (input.expectedPackageCount !== undefined && importerNames.length !== input.expectedPackageCount) {
    throw new Error(`pnpm root importer 包数量不符:${importerNames.length}(expected ${input.expectedPackageCount})`)
  }
  return { names: importerNames, version: input.runtimeVersion }
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
  if (input.expectedPackageCount !== undefined && lockNames.length !== input.expectedPackageCount) {
    throw new Error(`DSH closure 包数量不符:${lockNames.length}(expected ${input.expectedPackageCount})`)
  }

  return { names: lockNames, version: dshVersion }
}
