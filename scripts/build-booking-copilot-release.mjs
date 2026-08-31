#!/usr/bin/env node
/** Build a self-contained, production Booking Copilot release from clean HEAD. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_VERSION = 'booking.surface.v1'
const SCHEMA_SHA256 = 'd9c2194ec839bd1168e70e8a201581addc005039d9b299660e20650bbb65df81'

function fail(message) { throw new Error(`booking-copilot-release: ${message}`) }
const nodeBinDir = dirname(process.execPath)
const childEnv = { ...process.env, PATH: `${nodeBinDir}${delimiter}${process.env.PATH || ''}` }
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
  if (!/^v24\./.test(version)) fail(`Node 24 child runtime required (got ${version})`)
}

if (process.versions.node.split('.')[0] !== '24') fail(`Node 24 is required (got ${process.version})`)
if (!existsSync(join(ROOT, '.git'))) fail('must run inside the GoTry git worktree')
const trackedStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim()
if (trackedStatus) fail(`tracked worktree changes are not allowed:\n${trackedStatus}`)
const artifactId = run('git', ['rev-parse', 'HEAD'], ROOT).trim()
if (!/^[0-9a-f]{40}$/.test(artifactId)) fail('HEAD is not a full commit SHA')
const committedBuilder = execFileSync('git', ['show', 'HEAD:scripts/build-booking-copilot-release.mjs'], { cwd: ROOT })
if (!committedBuilder.equals(readFileSync(fileURLToPath(import.meta.url)))) fail('packaging logic must match committed HEAD')

if (!process.argv[2]) fail('output path is required and must be outside the repository')
const destination = resolve(process.argv[2])
const destinationRelative = relative(ROOT, destination)
if (!destinationRelative.startsWith(`..${sep}`) && destinationRelative !== '..') fail('output path must be outside the repository')
if (existsSync(destination)) fail(`output already exists: ${destination}`)
const parent = dirname(destination)
mkdirSync(parent, { recursive: true })
const temp = join(parent, `.booking-copilot-release-${process.pid}-${Date.now()}`)
const source = join(temp, 'source')
const release = join(temp, 'release')
const archivePath = join(temp, 'source.tar')
mkdirSync(source, { recursive: true })
try {
  execFileSync('git', ['archive', '-o', archivePath, artifactId], { cwd: ROOT, stdio: 'ignore' })
  execFileSync('tar', ['-xf', archivePath, '-C', source], { stdio: 'ignore' })
  run(process.execPath, ['scripts/build-dist.mjs'], source)

  mkdirSync(release, { recursive: true })
  for (const path of ['package.json', 'package-lock.json', 'bin/gotry-booking-copilot.js', 'schemas/booking.surface.v1.schema.json']) {
    const target = join(release, path)
    mkdirSync(dirname(target), { recursive: true })
    execFileSync('cp', ['-p', join(source, path), target])
  }
  execFileSync('cp', ['-a', join(source, 'dist'), join(release, 'dist')])
  probeNode24()
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], release)
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
  const entries = walk(release).filter((path) => path !== 'MANIFEST.sha256')
  for (const path of entries) {
    if (path === '.git' || path.startsWith('.git/') || path.split('/').some((part) => part === '.env' || part.startsWith('.env.') || /^(?:secret|secrets)(?:[._-]|$)/i.test(part))) {
      fail(`forbidden release path: ${path}`)
    }
  }
  writeFileSync(join(release, 'MANIFEST.sha256'), entries.map((path) => `${sha256(join(release, path))}  ${path}`).join('\n') + '\n')
  renameSync(release, destination)
  console.log(JSON.stringify({ artifactId, release: destination, files: entries.length, bytes: walk(destination).reduce((n, p) => n + lstatSync(join(destination, p)).size, 0) }))
} catch (error) {
  rmSync(temp, { recursive: true, force: true })
  throw error
}
rmSync(temp, { recursive: true, force: true })
