#!/usr/bin/env node
/** Build a self-contained, production Booking Copilot release from clean HEAD. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_VERSION = 'booking.surface.v1'
const SCHEMA_SHA256 = 'd9c2194ec839bd1168e70e8a201581addc005039d9b299660e20650bbb65df81'
const PROVENANCE_VERSION = 'gotry.booking-copilot.release-provenance.v1'
function fail(message) { throw new Error(`booking-copilot-release: ${message}`) }

if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) fail('Linux glibc x64/arm64 is required')
const glibcVersion = process.report?.getReport?.().header?.glibcVersionRuntime || ''
const libc = glibcVersion ? 'glibc' : ''
if (!libc) fail('glibc runtime is required')
const nodeModulesAbi = process.versions.modules || ''
if (!/^[0-9]+$/.test(nodeModulesAbi)) fail('Node modules ABI is unavailable')
const releaseTuple = `${process.platform}-${process.arch}-${libc}`
for (const name of ['EXPECTED_GOTRY_ARTIFACT_ID', 'EXPECTED_GOTRY_RELEASE_TUPLE', 'EXPECTED_NODE_VERSION', 'EXPECTED_NPM_VERSION']) if (!process.env[name]) fail(`${name} is required`)
if (!/^[0-9a-f]{40}$/.test(process.env.EXPECTED_GOTRY_ARTIFACT_ID)) fail('EXPECTED_GOTRY_ARTIFACT_ID must be a full lowercase commit SHA')
if (process.env.EXPECTED_GOTRY_RELEASE_TUPLE !== releaseTuple) fail('release tuple mismatch')

const nodeBinDir = dirname(process.execPath)
const allowedEnv = [
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CI',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]
const childEnv = Object.fromEntries(allowedEnv.filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
childEnv.PATH = `${nodeBinDir}${delimiter}${process.env.PATH || ''}`
const gitArgs = ['-c', `safe.directory=${ROOT}`]
function run(command, args, cwd) {
  try { return execFileSync(command, args, { cwd, encoding: 'utf8', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (error) { fail(`${command} failed: ${error.stderr?.trim() || error.message}`) }
}
function walk(root, dir = root) {
  const paths = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) paths.push(...walk(root, path))
    else if (stat.isFile() || stat.isSymbolicLink()) paths.push(relative(root, path))
  }
  return paths
}
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function probeNode24() {
  const version = execFileSync('node', ['--version'], { encoding: 'utf8', env: childEnv }).trim()
  if (version !== process.env.EXPECTED_NODE_VERSION) fail(`Node version mismatch (got ${version})`)
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8', env: childEnv }).trim()
  if (npmVersion !== process.env.EXPECTED_NPM_VERSION) fail(`npm version mismatch (got ${npmVersion})`)
}

if (process.versions.node.split('.')[0] !== '24') fail(`Node 24 is required (got ${process.version})`)
if (!existsSync(join(ROOT, '.git'))) fail('must run inside the GoTry git worktree')
const trackedStatus = execFileSync('git', [...gitArgs, 'status', '--porcelain=v1', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8', env: childEnv }).trim()
if (trackedStatus) fail(`tracked worktree changes are not allowed:\n${trackedStatus}`)
const artifactId = run('git', [...gitArgs, 'rev-parse', 'HEAD'], ROOT).trim()
if (!/^[0-9a-f]{40}$/.test(artifactId)) fail('HEAD is not a full commit SHA')
if (artifactId !== process.env.EXPECTED_GOTRY_ARTIFACT_ID) fail('artifact identity does not match EXPECTED_GOTRY_ARTIFACT_ID')
const committedBuilder = execFileSync('git', [...gitArgs, 'show', `${artifactId}:scripts/build-booking-copilot-release.mjs`], { cwd: ROOT, env: childEnv })
if (!committedBuilder.equals(readFileSync(fileURLToPath(import.meta.url)))) fail('packaging logic must match committed HEAD')

if (!process.argv[2]) fail('output path is required and must be outside the repository')
const destination = resolve(process.argv[2])
if (existsSync(destination)) fail(`output already exists: ${destination}`)
const parent = dirname(destination)
mkdirSync(parent, { recursive: true })
const destinationPhysical = join(realpathSync(parent), basename(destination))
const destinationRelative = relative(realpathSync(ROOT), destinationPhysical)
if (!destinationRelative.startsWith(`..${sep}`) && destinationRelative !== '..') fail('output path must be physically outside the repository')
const temp = join(parent, `.booking-copilot-release-${process.pid}-${Date.now()}`)
const source = join(temp, 'source')
const release = join(temp, 'release')
const archivePath = join(temp, 'source.tar')
mkdirSync(source, { recursive: true })
try {
  const npmHome = join(temp, 'npm-home'); const npmCache = join(temp, 'npm-cache'); mkdirSync(npmHome, { recursive: true }); mkdirSync(npmCache, { recursive: true })
  childEnv.HOME = npmHome
  childEnv.NPM_CONFIG_USERCONFIG = join(npmHome, '.npmrc')
  childEnv.NPM_CONFIG_CACHE = process.env.BOOKING_COPILOT_NPM_CACHE || npmCache
  childEnv.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
  writeFileSync(childEnv.NPM_CONFIG_USERCONFIG, '')
  execFileSync('git', [...gitArgs, 'archive', '-o', archivePath, artifactId], { cwd: ROOT, env: childEnv, stdio: 'ignore' })
  execFileSync('tar', ['-xf', archivePath, '-C', source], { env: childEnv, stdio: 'ignore' })
  run(process.execPath, ['scripts/build-dist.mjs'], source)

  mkdirSync(release, { recursive: true })
  for (const path of ['package.json', 'package-lock.json', 'bin/gotry-booking-copilot.js', 'schemas/booking.surface.v1.schema.json']) {
    const target = join(release, path)
    mkdirSync(dirname(target), { recursive: true })
    execFileSync('cp', ['-p', join(source, path), target], { env: childEnv })
  }
  execFileSync('cp', ['-a', join(source, 'dist'), join(release, 'dist')], { env: childEnv })
  probeNode24()
  // The root lock was created with npm's legacy peer resolver. Reuse that
  // resolution instead of asking a newer npm to invent an unlocked peer tree.
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'], release)
  const packageJson = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  writeFileSync(join(release, 'package.json'), `${JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    type: 'module',
    bin: { 'gotry-booking-copilot': 'bin/gotry-booking-copilot.js' },
    dependencies: packageJson.dependencies,
    engines: { node: '24.x' },
  }, null, 2)}\n`)
  rmSync(join(release, 'package-lock.json'))

  const schema = join(release, 'schemas/booking.surface.v1.schema.json')
  if (sha256(schema) !== SCHEMA_SHA256) fail('schema bytes do not match the Hotel-BE release contract')
  writeFileSync(join(release, 'SCHEMA_VERSION'), `${SCHEMA_VERSION}\n`)
  writeFileSync(join(release, 'SCHEMA_SHA256'), `${SCHEMA_SHA256}\n`)
  writeFileSync(join(release, 'ARTIFACT_ID'), `${artifactId}\n`)
  writeFileSync(join(release, 'BUILD_PROVENANCE.json'), `${JSON.stringify({
    schemaVersion: PROVENANCE_VERSION,
    bookingSurfaceSchemaVersion: SCHEMA_VERSION,
    artifactId,
    platform: process.platform,
    arch: process.arch,
    libc,
    libcVersion: glibcVersion,
    nodeVersion: process.env.EXPECTED_NODE_VERSION,
    nodeModulesAbi,
    npmVersion: process.env.EXPECTED_NPM_VERSION,
    releaseTuple,
  }, null, 2)}\n`)
  const entries = walk(release).filter((path) => path !== 'MANIFEST.sha256')
  for (const path of entries) {
    if (path === '.git' || path.startsWith('.git/') || path.split('/').some((part) => part === '.env' || part.startsWith('.env.') || /^(?:secret|secrets)(?:[._-]|$)/i.test(part))) {
      fail(`forbidden release path: ${path}`)
    }
  }
  writeFileSync(join(release, 'MANIFEST.sha256'), entries.map((path) => `${sha256(join(release, path))}  ${path}`).join('\n') + '\n')
  renameSync(release, destination)
  console.log(JSON.stringify({ artifactId, release: destination, releaseTuple, nodeVersion: process.env.EXPECTED_NODE_VERSION, npmVersion: process.env.EXPECTED_NPM_VERSION, files: entries.length, bytes: walk(destination).reduce((n, p) => n + lstatSync(join(destination, p)).size, 0) }))
} catch (error) {
  rmSync(temp, { recursive: true, force: true })
  throw error
}
rmSync(temp, { recursive: true, force: true })
