#!/usr/bin/env node
/**
 * Tests for the compiler guard at the top of scripts/build-dist.mjs.
 *
 * The guard exists because the dist bytes must come from the publish tree's own TypeScript. Its refusal is the
 * right behaviour for a symlinked or hoisted node_modules — rc.28 was built from a worktree whose node_modules
 * was a symlink — but the message used to say only what was wrong. It must also say what to do, because the person
 * reading it is mid-release with an approval window ticking. A stand-in `typescript` package is enough to reach
 * the guard, so this runs in milliseconds and needs no install.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }

function tree({ declared = '5.9.3', installed = '5.9.3', linked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gotry-build-guard-'))
  mkdirSync(join(root, 'scripts'))
  copyFileSync(join(HERE, 'build-dist.mjs'), join(root, 'scripts/build-dist.mjs'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', devDependencies: { typescript: declared } }))
  // a stand-in compiler package, installed either physically or behind a symlink
  const holder = join(root, linked ? '_elsewhere' : 'node_modules')
  mkdirSync(join(holder, 'typescript'), { recursive: true })
  writeFileSync(join(holder, 'typescript/package.json'), JSON.stringify({ name: 'typescript', version: installed, type: 'module', main: 'index.js' }))
  writeFileSync(join(holder, 'typescript/index.js'), `export default { version: ${JSON.stringify(installed)} }\n`)
  if (linked) symlinkSync(holder, join(root, 'node_modules'))
  return root
}

const build = (root) => spawnSync(process.execPath, [join(root, 'scripts/build-dist.mjs')], { cwd: root, encoding: 'utf8', timeout: 30_000 })
const roots = []
const make = (opts) => { const r = tree(opts); roots.push(r); return r }

{
  // the rc.28 case: node_modules is a symlink to another tree's install
  const r = build(make({ linked: true }))
  ok(r.status !== 0, 'a symlinked node_modules is refused')
  ok(/TypeScript must resolve within root node_modules, got /.test(r.stderr), 'the refusal names what resolved where')
  ok(/refused on purpose/.test(r.stderr), 'and says it is deliberate')
  ok(/npm ci/.test(r.stderr), 'it names `npm ci` as the fix')
  ok(/cp -cR <other-tree>\/node_modules \S+\/node_modules/.test(r.stderr) && /cp -a --reflink=auto/.test(r.stderr), 'and the clone alternative, on macOS and Linux')
  ok(r.stderr.includes(`${join(roots[0], 'node_modules')} (APFS`) || r.stderr.includes(`${join(roots[0], 'node_modules')}\``), "the clone target is this tree's own node_modules")
}
{
  // a physical install passes the guard: the run gets further and fails later, on the missing sources
  const r = build(make())
  ok(r.status !== 0 && !/must resolve within root node_modules/.test(r.stderr), 'a physical node_modules passes the guard')
  ok(/ENOENT/.test(r.stderr), 'and fails afterwards on the missing sources, not on the compiler')
}
{
  const r = build(make({ declared: '5.9.2' }))
  ok(r.status !== 0 && /root devDependency typescript must be exactly 5\.9\.3/.test(r.stderr), 'a wrong declared compiler version is refused')
}
{
  const r = build(make({ installed: '5.8.3' }))
  ok(r.status !== 0 && /TypeScript 5\.9\.3 required, loaded 5\.8\.3/.test(r.stderr), 'a wrong installed compiler version is refused')
}

for (const root of roots) rmSync(root, { recursive: true, force: true })
console.log(`BUILD-DIST GUARD TESTS: ${checks} checks OK`)
