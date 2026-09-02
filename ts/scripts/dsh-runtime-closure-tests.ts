import assert from 'node:assert/strict'
import test from 'node:test'
import type { DshRuntimeClosureInput } from './dsh-runtime-closure.ts'
import {
  parsePnpmDshLock,
  parsePnpmRootDshImporter,
  REQUIRED_DSH_RUNTIME_PACKAGE_COUNT,
  validateDshRuntimeClosure,
  validatePnpmRootDshImporter,
} from './dsh-runtime-closure.ts'

const VERSION = '0.1.2-alpha.3'

function validInput(): DshRuntimeClosureInput {
  return {
    dependencies: {
      '@deepseek-ai/dsh': VERSION,
      '@deepseek-ai/dsh-session-title': VERSION,
    },
    lockPackages: {
      'node_modules/@deepseek-ai/dsh': { version: VERSION },
      'node_modules/@deepseek-ai/dsh-session-title': { version: VERSION },
    },
    runtimeVersion: VERSION,
  }
}

test('accepts an exact coherent DSH prerelease closure', () => {
  assert.deepEqual(validateDshRuntimeClosure(validInput()), {
    names: ['@deepseek-ai/dsh', '@deepseek-ai/dsh-session-title'],
    version: VERSION,
  })
})

test('rejects a lock package missing from the published direct dependencies', () => {
  const input = validInput()
  input.dependencies = { '@deepseek-ai/dsh': VERSION }
  assert.throws(() => validateDshRuntimeClosure(input), /DSH closure 未精确声明/)
})

test('rejects an extra ranged DSH dependency absent from the tested lock closure', () => {
  const input = validInput()
  input.dependencies['@deepseek-ai/dsh-web'] = '^0.1.2-alpha.3'
  assert.throws(() => validateDshRuntimeClosure(input), /DSH manifest 与 lock 集合不一致/)
})

test('rejects a nested DSH package from another prerelease', () => {
  const input = validInput()
  input.lockPackages['node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-title'] = {
    version: '0.1.2-alpha.4',
  }
  assert.throws(() => validateDshRuntimeClosure(input), /DSH lock 版本漂移/)
})

test('rejects drift from the runtime spawn guard version', () => {
  const input = validInput()
  input.runtimeVersion = '0.1.2-alpha.4'
  assert.throws(() => validateDshRuntimeClosure(input), /DSH runtime guard 版本漂移/)
})

test('parses each pnpm DSH resolution once across packages and snapshots', () => {
  const lock = `
packages:
  '@deepseek-ai/dsh@0.1.2-alpha.3': {}
  '@deepseek-ai/dsh-session@0.1.2-alpha.3': {}
snapshots:
  '@deepseek-ai/dsh@0.1.2-alpha.3': {}
`
  assert.deepEqual(parsePnpmDshLock(lock), {
    'node_modules/@deepseek-ai/dsh': { version: VERSION },
    'node_modules/@deepseek-ai/dsh-session': { version: VERSION },
  })
})

test('preserves two pnpm resolutions of the same DSH package for mixed-version rejection', () => {
  const lock = `
packages:
  '@deepseek-ai/dsh@0.1.2-alpha.3': {}
  '@deepseek-ai/dsh-session@0.1.2-alpha.3': {}
  '@deepseek-ai/dsh-session@0.1.2-alpha.4': {}
`
  const parsed = parsePnpmDshLock(lock)
  assert.equal(Object.keys(parsed).length, 3)
  assert.throws(() => validateDshRuntimeClosure({
    dependencies: {
      '@deepseek-ai/dsh': VERSION,
      '@deepseek-ai/dsh-session': VERSION,
    },
    lockPackages: parsed,
    runtimeVersion: VERSION,
  }), /DSH lock 版本漂移/)
})

test('parses only the root pnpm importer DSH entries', () => {
  const lock = `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@deepseek-ai/dsh':
        specifier: 0.1.2-alpha.3
        version: 0.1.2-alpha.3(peer@1.0.0)
      '@deepseek-ai/dsh-session':
        specifier: 0.1.2-alpha.3
        version: 0.1.2-alpha.3
  ts:
    dependencies:
      '@deepseek-ai/dsh-web':
        specifier: 0.1.2-alpha.4
        version: 0.1.2-alpha.4
packages: {}
`
  assert.deepEqual(parsePnpmRootDshImporter(lock), {
    '@deepseek-ai/dsh': { specifier: VERSION, resolvedVersion: VERSION },
    '@deepseek-ai/dsh-session': { specifier: VERSION, resolvedVersion: VERSION },
  })
})

test('rejects a pnpm root importer missing a published DSH dependency', () => {
  assert.throws(() => validatePnpmRootDshImporter({
    dependencies: validInput().dependencies,
    importerEntries: {
      '@deepseek-ai/dsh': { specifier: VERSION, resolvedVersion: VERSION },
    },
    runtimeVersion: VERSION,
  }), /pnpm root importer 与 manifest 集合不一致/)
})

test('rejects a ranged DSH specifier in the pnpm root importer', () => {
  assert.throws(() => validatePnpmRootDshImporter({
    dependencies: validInput().dependencies,
    importerEntries: {
      '@deepseek-ai/dsh': { specifier: VERSION, resolvedVersion: VERSION },
      '@deepseek-ai/dsh-session-title': { specifier: '^0.1.2-alpha.3', resolvedVersion: VERSION },
    },
    runtimeVersion: VERSION,
  }), /pnpm root importer 未精确锁定/)
})

test('rejects a drifted resolved DSH version in the pnpm root importer', () => {
  assert.throws(() => validatePnpmRootDshImporter({
    dependencies: validInput().dependencies,
    importerEntries: {
      '@deepseek-ai/dsh': { specifier: VERSION, resolvedVersion: '0.1.2-alpha.4' },
      '@deepseek-ai/dsh-session-title': { specifier: VERSION, resolvedVersion: VERSION },
    },
    runtimeVersion: VERSION,
  }), /pnpm root importer resolved 版本漂移/)
})

test('rejects a missing resolved DSH version in the pnpm root importer', () => {
  const lock = `
importers:
  .:
    dependencies:
      '@deepseek-ai/dsh':
        specifier: 0.1.2-alpha.3
`
  assert.throws(() => parsePnpmRootDshImporter(lock), /pnpm root importer version 不可用/)
})

test('rejects duplicate resolved DSH versions in the pnpm root importer', () => {
  const lock = `
importers:
  .:
    dependencies:
      '@deepseek-ai/dsh':
        specifier: 0.1.2-alpha.3
        version: 0.1.2-alpha.3
        version: 0.1.2-alpha.4
`
  assert.throws(() => parsePnpmRootDshImporter(lock), /pnpm root importer version 不可用/)
})

test('rejects a coherent closure below the required package count', () => {
  assert.throws(() => validateDshRuntimeClosure({
    ...validInput(),
    expectedPackageCount: REQUIRED_DSH_RUNTIME_PACKAGE_COUNT,
  }), /DSH closure 包数量不符/)
})

test('rejects a coherent root importer below the required package count', () => {
  assert.throws(() => validatePnpmRootDshImporter({
    dependencies: validInput().dependencies,
    importerEntries: {
      '@deepseek-ai/dsh': { specifier: VERSION, resolvedVersion: VERSION },
      '@deepseek-ai/dsh-session-title': { specifier: VERSION, resolvedVersion: VERSION },
    },
    runtimeVersion: VERSION,
    expectedPackageCount: REQUIRED_DSH_RUNTIME_PACKAGE_COUNT,
  }), /pnpm root importer 包数量不符/)
})

test('rejects duplicate DSH entries in the pnpm root importer', () => {
  const lock = `
importers:
  .:
    dependencies:
      '@deepseek-ai/dsh':
        specifier: 0.1.2-alpha.3
        version: 0.1.2-alpha.3
      '@deepseek-ai/dsh':
        specifier: 0.1.2-alpha.3
        version: 0.1.2-alpha.3
`
  assert.throws(() => parsePnpmRootDshImporter(lock), /pnpm root importer DSH 依赖重复/)
})
