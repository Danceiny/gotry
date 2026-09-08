/**
 * Package proof for issue #202.
 *
 * The full suite passes the executable from its clean tarball install; focused
 * runs pack/unpack locally and attach the already-installed root closure. Both
 * paths load the plugin from the artifact, never from the checkout vendor path.
 * No map provider or paid endpoint is contacted; inline-coordinate geocoding is
 * asserted with fetch disabled.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const upstreamLicenseSha256 = 'b6bbb0c73a02cf8d2c304e9f208b41c32f0a810fabe366986e2b14ac3338f618'
const upstreamVendorFileCount = 32
const adaptedVendorAggregateSha256 = '32a893ff7a51799d2b8b8f246cbf6d094c3f6054e9086c0c8b0cb2da8606ccb1'
const expectedTools = [
  'map_bicycling_route',
  'map_driving_route',
  'map_geocode',
  'map_poi_search',
  'map_reverse_geocode',
  'map_transit_route',
  'map_walking_route',
]

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function vendorAggregate(root: string): { count: number; sha256: string } {
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(path.slice(root.length + 1).replaceAll('\\', '/'))
    }
  }
  walk(root)
  files.sort()
  const digest = createHash('sha256')
  for (const relative of files) {
    digest.update(relative)
    digest.update('\0')
    digest.update(readFileSync(join(root, relative)))
    digest.update('\0')
  }
  return { count: files.length, sha256: digest.digest('hex') }
}

function assertAlpha3LockClosure(): { packages: number; version: string } {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'ts/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  assert.equal(manifest.dependencies?.['dsh-map-tools'], undefined, 'external map-tools dependency must stay removed')

  const lock = JSON.parse(readFileSync(join(repoRoot, 'ts/package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>
  }
  assert.equal(lock.packages?.['']?.dependencies?.['dsh-map-tools'], undefined, 'lock root must not resolve external map-tools')
  assert.equal(lock.packages?.['node_modules/dsh-map-tools'], undefined, 'lock must not carry external map-tools')
  const dshEntries = Object.entries(lock.packages ?? {}).filter(([path]) =>
    /(?:^|\/)node_modules\/@deepseek-ai\/(?:dsh|dsh-[^/]+)$/.test(path),
  )
  assert.ok(dshEntries.length >= 10, 'expected dsh-tools peer closure in the ts lock')
  for (const [path, entry] of dshEntries) {
    assert.equal(entry.version, '0.1.2-alpha.3', `${path} drifted outside the alpha.3 closure`)
  }
  return { packages: dshEntries.length, version: '0.1.2-alpha.3' }
}

function findPackageRoot(entry: string): string {
  let cursor = dirname(entry)
  for (;;) {
    const manifestPath = join(cursor, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
      if (manifest.name === '@danceiny/gotry') return cursor
    }
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error(`cannot locate @danceiny/gotry package root from ${entry}`)
    cursor = parent
  }
}

function assertBinTargetsPackage(binPath: string, expectedTarget: string): void {
  const resolvedExpectedTarget = realpathSync(expectedTarget)
  if (realpathSync(binPath) === resolvedExpectedTarget) return

  // pnpm writes an executable shell shim instead of a symlink. Its final
  // machine-readable marker is safer to verify than accepting any occurrence
  // of the package path in an otherwise unrelated executable.
  const shim = readFileSync(binPath, 'utf8')
  assert.ok(Buffer.byteLength(shim, 'utf8') <= 32_768, 'clean-install gotry shim is unexpectedly large')
  const lines = shim.trimEnd().split(/\r?\n/)
  const markers = lines.filter(line => line.startsWith('# cmd-shim-target='))
  assert.equal(markers.length, 1, 'pnpm gotry shim must contain exactly one target marker')
  assert.equal(lines.at(-1), markers[0], 'pnpm gotry shim target marker must be the final line')
  const markerTarget = markers[0].slice('# cmd-shim-target='.length)
  assert.ok(isAbsolute(markerTarget), 'pnpm gotry shim target must be absolute')
  assert.equal(
    realpathSync(markerTarget),
    resolvedExpectedTarget,
    'GOTRY_MAP_TOOLS_E2E_BIN shim must target this installed GoTry package',
  )
}

function prepareProofPackage(cleanInstalledBin?: string): { packageRoot: string; proofRoot?: string } {
  if (cleanInstalledBin) {
    const binPath = resolve(cleanInstalledBin)
    assert.equal(basename(binPath), 'gotry', 'clean-install executable must use the gotry bin name')
    assert.equal(basename(dirname(binPath)), '.bin', 'clean-install executable must come from node_modules/.bin')
    assert.equal(basename(dirname(dirname(binPath))), 'node_modules', 'clean-install executable must come from a consumer install')
    const consumerRoot = dirname(dirname(dirname(binPath)))
    const packageMain = createRequire(join(consumerRoot, 'package.json')).resolve('@danceiny/gotry')
    const packageRoot = findPackageRoot(packageMain)
    const installedManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      name?: string
      bin?: string | Record<string, string>
    }
    assert.equal(installedManifest.name, '@danceiny/gotry', 'clean-install executable must belong to GoTry')
    const declaredBin = typeof installedManifest.bin === 'string'
      ? installedManifest.bin
      : installedManifest.bin?.gotry
    assert.equal(declaredBin, 'bin/gotry-inner.js', 'installed package must declare the production gotry bin')
    assertBinTargetsPackage(binPath, join(packageRoot, declaredBin))
    return { packageRoot }
  }

  const proofRoot = mkdtempSync(join(repoRoot, '.tmp-map-tools-proof-'))
  try {
    const packOutput = execFileSync('npm', [
      'pack', '--ignore-scripts', '--json', '--pack-destination', proofRoot,
    ], { cwd: repoRoot, encoding: 'utf8' })
    const packInfo = JSON.parse(packOutput) as Array<{ filename: string }>
    assert.equal(packInfo.length, 1, 'npm pack must produce one artifact')
    const tarball = join(proofRoot, packInfo[0].filename)
    assert.ok(existsSync(tarball), `packed artifact missing: ${tarball}`)
    const unpackRoot = join(proofRoot, 'unpacked')
    mkdirSync(unpackRoot)
    execFileSync('tar', ['-xzf', tarball, '-C', unpackRoot])
    const packageRoot = join(unpackRoot, 'package')
    symlinkSync(join(repoRoot, 'node_modules'), join(packageRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    return { packageRoot, proofRoot }
  } catch (error) {
    rmSync(proofRoot, { recursive: true, force: true })
    throw error
  }
}

const cleanInstalledBin = process.env.GOTRY_MAP_TOOLS_E2E_BIN
const { packageRoot, proofRoot } = prepareProofPackage(cleanInstalledBin)

try {
  const lockedDsh = assertAlpha3LockClosure()
  const vendorRoot = join(packageRoot, 'ts/dsh-runtime/vendor/dsh-map-tools')
  const requiredFiles = [
    'LICENSE',
    'package.json',
    'cordis.patch.yml',
    'lib/index.js',
    'lib/settings-ns.js',
    'lib/config.js',
    'lib/tools/geocode.js',
    'lib/tools/routes.js',
    'lib/tools/poi.js',
  ]
  for (const relative of requiredFiles) {
    assert.ok(existsSync(join(vendorRoot, relative)), `required vendor file missing: ${relative}`)
  }
  const vendorTree = vendorAggregate(vendorRoot)
  assert.equal(vendorTree.count, upstreamVendorFileCount, 'vendored payload file count drifted')
  assert.equal(vendorTree.sha256, adaptedVendorAggregateSha256, 'vendored payload aggregate drifted')
  const vendorPackage = JSON.parse(readFileSync(join(vendorRoot, 'package.json'), 'utf8')) as {
    name?: string
    version?: string
    license?: string
  }
  assert.equal(vendorPackage.name, 'dsh-map-tools')
  assert.equal(vendorPackage.version, '0.5.1')
  assert.equal(vendorPackage.license, 'MIT')
  assert.equal(sha256(join(vendorRoot, 'LICENSE')), upstreamLicenseSha256, 'upstream MIT license changed')

  const packageRequire = createRequire(join(packageRoot, 'package.json'))
  const dshToolsPackageJson = packageRequire.resolve('@deepseek-ai/dsh-tools/package.json')
  const dshSettingsPackageJson = packageRequire.resolve('@deepseek-ai/dsh-settings/package.json')
  const dshTools = JSON.parse(readFileSync(dshToolsPackageJson, 'utf8')) as { version: string }
  const dshSettings = JSON.parse(readFileSync(dshSettingsPackageJson, 'utf8')) as { version: string }
  assert.equal(dshTools.version, '0.1.2-alpha.3')
  assert.equal(dshSettings.version, '0.1.2-alpha.3')
  const settingsApi = await import(pathToFileURL(join(dirname(dshSettingsPackageJson), 'lib/index.js')).href) as {
    SettingsProvider?: { prototype?: { installSection?: (...args: unknown[]) => void } }
  }
  const installSection = settingsApi.SettingsProvider?.prototype?.installSection
  assert.equal(
    typeof installSection,
    'function',
    'real alpha.3 SettingsProvider.prototype.installSection must be present',
  )

  const plugin = await import(pathToFileURL(join(vendorRoot, 'lib/index.js')).href)
  type RegisteredTool = Record<string, unknown> & { name: string; execute?: unknown }
  const registered = new Map<string, RegisteredTool>()
  const registerEvents: string[] = []
  const toolDisposeEvents: string[] = []
  const settingsRegistrations: unknown[][] = []
  const settingsWatchers: Array<() => void> = []
  const settingsProviderDisposers: Array<() => void> = []
  const contextDisposers: Array<() => void> = []
  const settingsNamespaceValue = 'dsh-map-tools'
  const activeToolNames = () => [...registered.keys()].sort()
  const settingsProvider = {
    ctx: {
      effect(effect: () => (() => void) | void) {
        const disposer = effect()
        if (typeof disposer === 'function') settingsProviderDisposers.push(disposer)
        return disposer
      },
    },
    register: (...args: unknown[]) => {
      settingsRegistrations.push(args)
      return {
        get: () => args[2] && typeof args[2] === 'object' ? (args[2] as { base?: unknown }).base : undefined,
        watch: (callback: () => void) => {
          settingsWatchers.push(callback)
          return () => {
            const index = settingsWatchers.indexOf(callback)
            if (index >= 0) settingsWatchers.splice(index, 1)
          }
        },
        update: async () => undefined,
        replace: async () => undefined,
      }
    },
    installSection: (...args: unknown[]) => installSection!.apply(settingsProvider, args),
  }
  const context = {
    fiber: { state: 'active' },
    effect(effect: () => (() => void) | void) {
      const disposer = effect()
      if (typeof disposer === 'function') contextDisposers.push(disposer)
      return disposer
    },
    tools: {
      register(tool: RegisteredTool) {
        assert.ok(tool.name.startsWith('map_'), `unexpected map tool name: ${tool.name}`)
        registered.set(tool.name, tool)
        registerEvents.push(tool.name)
        return () => {
          registered.delete(tool.name)
          toolDisposeEvents.push(tool.name)
        }
      },
    },
    inject(dependencies: string[], callback: (scope: Record<string, unknown>) => void) {
      if (dependencies.includes('settings')) {
        callback({ settings: settingsProvider })
      } else if (dependencies.includes('webServer')) {
        callback({ webServer: { register: () => undefined } })
      } else {
        throw new Error(`unexpected dependency injection: ${dependencies.join(',')}`)
      }
    },
  }
  plugin.apply(context, {
    provider: 'osm', amapKey: '', timeoutMs: 1000, maxQps: 2,
    defaultMode: 'driving', language: 'zh',
  })
  assert.deepEqual(activeToolNames(), expectedTools, 'exactly seven active map tools must register')
  assert.equal(registerEvents.length, expectedTools.length * 2, 'installSection initial onChange must rebuild the map tools once')
  assert.equal(toolDisposeEvents.length, expectedTools.length, 'installSection initial reload must dispose the first tool generation')
  assert.equal(settingsRegistrations.length, 1, 'alpha.3 settings section must register once')
  assert.equal(settingsRegistrations[0][0], settingsNamespaceValue, 'settings namespace must be the stable plain string')
  assert.equal(settingsRegistrations[0][2] && typeof settingsRegistrations[0][2] === 'object', true, 'alpha.3 settings register options must be supplied')
  assert.deepEqual(Object.keys(settingsRegistrations[0][2] as object).sort(), ['base'], 'alpha.3 registration must carry the composition base')
  assert.equal(settingsWatchers.length, 1, 'alpha.3 installSection must attach one settings watcher')
  assert.equal(settingsProviderDisposers.length, 1, 'alpha.3 installSection must attach one provider-detach fallback effect')

  settingsWatchers[0]()
  assert.deepEqual(activeToolNames(), expectedTools, 'settings watch reload must keep exactly seven active map tools')
  assert.equal(registerEvents.length, expectedTools.length * 3, 'settings watch must rebuild the map tools')
  assert.equal(toolDisposeEvents.length, expectedTools.length * 2, 'settings watch reload must dispose the previous generation')

  settingsProviderDisposers[0]()
  assert.deepEqual(activeToolNames(), expectedTools, 'settings provider detach fallback must keep exactly seven active map tools')
  assert.equal(registerEvents.length, expectedTools.length * 4, 'provider detach fallback must rebuild the map tools')
  assert.equal(toolDisposeEvents.length, expectedTools.length * 3, 'provider detach fallback must dispose the previous generation')

  const finalActiveTools = [...registered.values()]
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('network forbidden by package proof') }) as typeof fetch
  try {
    const geocode = registered.get('map_geocode')
    assert.ok(geocode, 'map_geocode must be registered')
    const result = await (geocode.execute as (args: unknown, execution: unknown) => Promise<unknown>)(
      { address: '116.397428,39.90923' },
      { signal: new AbortController().signal },
    ) as { provider?: string; location?: number[] }
    assert.equal(result.provider, 'inline')
    assert.deepEqual(result.location, [116.397428, 39.90923])
  } finally {
    globalThis.fetch = originalFetch
  }

  for (const dispose of contextDisposers.splice(0).reverse()) dispose()
  assert.equal(registered.size, 0, 'plugin unload must dispose the active map tool generation')

  console.log(JSON.stringify({
    proof: 'map-tools-vendor-package',
    status: 'PASS',
    artifactMode: cleanInstalledBin ? 'clean-installed-tarball' : 'packed-unpacked-focused',
    vendored: {
      sourcePackage: 'dsh-map-tools@0.5.1',
      licenseSha256: upstreamLicenseSha256, vendorFileCount: vendorTree.count,
      adaptedVendorAggregateSha256: vendorTree.sha256,
    },
    artifactVendor: vendorRoot,
    dshClosure: { tools: dshTools.version, settings: dshSettings.version, ...lockedDsh },
    settingsLifecycle: {
      registerEvents: registerEvents.length,
      toolDisposeEvents: toolDisposeEvents.length,
      watchedReloads: 1,
      providerDetachFallbacks: 1,
      pluginUnloadDisposed: true,
    },
    tools: finalActiveTools.map(tool => tool.name).sort(),
    inlineCoordinate: { provider: 'inline', network: 'forbidden' },
  }, null, 2))
} finally {
  if (proofRoot) rmSync(proofRoot, { recursive: true, force: true })
}
