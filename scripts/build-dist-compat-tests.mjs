#!/usr/bin/env node
/**
 * Focused dist compatibility proof. Run under every supported Node lane:
 *
 *   node scripts/build-dist-compat-tests.mjs
 *
 * The proof builds with the current Node executable, compares the complete
 * generated tree with its declared source/assets, rejects TypeScript import
 * specifiers and CommonJS emit wrappers, then executes representative ESM
 * entrypoints whose runtime behavior depends on copied data and rewritten
 * dynamic imports.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = join(root, 'dist')
const sourceRoots = ['ts/src', 'ts/capabilities', 'ts/scripts']
const copiedExtensions = new Set(['.js', '.mjs'])
const copiedFiles = new Map([
  ['ts/capabilities/agent-reach-bridge.py', 'capabilities/agent-reach-bridge.py'],
  ['ts/data/session-golden-20.json', 'data/session-golden-20.json'],
  ['ts/data/sf-golden-manifest.json', 'data/sf-golden-manifest.json'],
  ['ts/data/sf-static-routes.json', 'data/sf-static-routes.json'],
])

function posix(path) {
  return path.split(sep).join('/')
}

function walkFiles(dir) {
  const files = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) files.push(...walkFiles(path))
    else files.push(path)
  }
  return files
}

function run(label, args) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `${label} failed under ${process.version}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  assert.equal(result.signal, null, `${label} terminated by ${result.signal}`)
  return result.stdout
}

function rewriteRelativeTypeScriptSpecifiers(source) {
  return source.replace(/(['"])(\.[^'"]*?)\.ts\1/g, '$1$2.js$1')
}

function registerExpected(expected, distRelative, sourceRelative, expectedBytes) {
  assert.equal(
    expected.has(distRelative),
    false,
    `multiple sources map to dist/${distRelative}: ${expected.get(distRelative)?.source}, ${sourceRelative}`,
  )
  expected.set(distRelative, { source: sourceRelative, expectedBytes })
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const pnpmLock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
const installedTypeScript = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8'))
assert.equal(packageJson.devDependencies?.typescript, '5.9.3', 'root build dependency must be declared exactly')
assert.equal(packageJson.dependencies?.typescript, undefined, 'TypeScript must not be a product runtime dependency')
assert.equal(packageLock.packages?.['']?.devDependencies?.typescript, '5.9.3', 'npm root importer must lock TypeScript exactly')
assert.equal(packageLock.packages?.['node_modules/typescript']?.version, '5.9.3', 'npm package entry must lock TypeScript 5.9.3')
assert.match(
  pnpmLock,
  /^    devDependencies:\n      typescript:\n        specifier: 5\.9\.3\n        version: 5\.9\.3$/m,
  'pnpm root importer must lock TypeScript exactly',
)
assert.equal(installedTypeScript.version, '5.9.3', 'installed build compiler must match the root declaration')
assert.equal(ts.version, '5.9.3', 'build proof must load the pinned root TypeScript compiler')

run('build-dist', ['scripts/build-dist.mjs'])

const expected = new Map()
for (const sourceRoot of sourceRoots) {
  for (const sourcePath of walkFiles(join(root, sourceRoot))) {
    const sourceRelative = posix(relative(root, sourcePath))
    const extension = extname(sourcePath)
    if (extension === '.ts') {
      registerExpected(expected, posix(relative(join(root, 'ts'), sourcePath)).replace(/\.ts$/, '.js'), sourceRelative)
    } else if (copiedExtensions.has(extension)) {
      registerExpected(
        expected,
        posix(relative(join(root, 'ts'), sourcePath)),
        sourceRelative,
        Buffer.from(rewriteRelativeTypeScriptSpecifiers(readFileSync(sourcePath, 'utf8'))),
      )
    }
  }
}
for (const [sourceRelative, distRelative] of copiedFiles) {
  registerExpected(expected, distRelative, sourceRelative, readFileSync(join(root, sourceRelative)))
}

const actual = walkFiles(distRoot).map((path) => posix(relative(distRoot, path))).sort()
assert.deepEqual(
  actual,
  [...expected.keys()].sort(),
  'dist file set must exactly match TypeScript outputs plus declared JS/Python/data assets',
)

for (const [distRelative, entry] of expected) {
  if (entry.expectedBytes === undefined) continue
  assert.deepEqual(
    readFileSync(join(distRoot, distRelative)),
    entry.expectedBytes,
    `runtime asset differs from its exact declared transformation: ${distRelative}`,
  )
}

function simpleString(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

function propertyPath(node) {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) {
    const base = propertyPath(node.expression)
    return base ? `${base}.${node.name.text}` : undefined
  }
  return undefined
}

for (const file of actual.filter((path) => /\.m?js$/.test(path))) {
  const text = readFileSync(join(distRoot, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  assert.equal(source.parseDiagnostics.length, 0, `${file} must be valid JavaScript`)

  const boundStrings = new Map()
  const importSpecifiers = []
  const cjsWrappers = []
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = simpleString(node.initializer)
      if (value !== undefined) boundStrings.set(node.name.text, value)
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const value = node.moduleSpecifier && simpleString(node.moduleSpecifier)
      if (value !== undefined) importSpecifiers.push(value)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
      const argument = node.arguments[0]
      const value = simpleString(argument) ?? (ts.isIdentifier(argument) ? boundStrings.get(argument.text) : undefined)
      if (value !== undefined) importSpecifiers.push(value)
    }
    if (ts.isCallExpression(node) && propertyPath(node.expression) === 'Object.defineProperty') {
      if (ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === 'exports' && simpleString(node.arguments[1]) === '__esModule') {
        cjsWrappers.push('Object.defineProperty(exports, "__esModule")')
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = propertyPath(node.left)
      if (target === 'module.exports' || target?.startsWith('exports.')) cjsWrappers.push(target)
    }
    ts.forEachChild(node, collect)
  }
  collect(source)

  const relativeTypeScript = importSpecifiers.filter((specifier) => /^\.\.?\//.test(specifier) && /\.ts(?:[?#].*)?$/.test(specifier))
  assert.deepEqual(relativeTypeScript, [], `${file} contains relative .ts import specifiers`)
  assert.deepEqual(cjsWrappers, [], `${file} contains CommonJS emit wrappers`)
}

const plugin = await import(pathToFileURL(join(distRoot, 'src/index.js')).href)
assert.equal(plugin.name, 'gotry-tools')
assert.equal(typeof plugin.apply, 'function')
assert.deepEqual(plugin.inject, ['tools', 'systemPrompt'])

const skeleton = await import(pathToFileURL(join(distRoot, 'scripts/skeleton-check.js')).href)
const connectivity = await skeleton.checkConnectivity('HKG', 'HKT')
assert.deepEqual(connectivity.airlines, ['CX', 'FD', 'KA', 'TG', 'UO'])
assert.equal(connectivity.connected, true)
assert.match(connectivity.evidence, /^\[骨架:openflights\] ✅ HKG↔HKT/)

const staticGoldenOutput = run('compiled static-golden dynamic import', ['dist/scripts/static-golden-tests.js'])
assert.match(staticGoldenOutput, /STATIC GOLDEN TESTS: parser \+ snapshot \+ resolve\/fallback contract OK/)
const softScoreOutput = run('compiled soft-score dynamic import', ['dist/scripts/sf-soft-score-tests.js'])
assert.match(softScoreOutput, /SF SOFT SCORE TESTS: fixed 13-field score/)
run('compiled MJS child import', [
  '--input-type=module',
  '-e',
  `await import(${JSON.stringify(pathToFileURL(join(distRoot, 'scripts/fixtures/extension-bridge-unref-child.mjs')).href)}); process.exit(0)`,
])

console.log(
  `BUILD-DIST COMPAT: Node ${process.version} / TypeScript ${ts.version} / ${actual.length} exact files / ESM + skeleton + dynamic imports OK`,
)
