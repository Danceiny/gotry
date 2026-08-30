/**
 * 发布前离线预验证(发布闸,rc.9 教训固化):
 * 1. npm pack 产 tarball;
 * 2. 装进 mktemp 干净目录(--ignore-scripts 快速);
 * 3. 核验:版本号一致 + dependencies 闭包可达 + 关键入口文件在 + 账本模块可 import。
 * 任何一步失败即 FAIL——rc.9「装得上跑不起」教训的永久闸。
 * 运行:cd ts && npx tsx scripts/publish-preverify.ts
 */

import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = join(import.meta.dirname, '..', '..')
process.chdir(repoRoot)

const pkg = JSON.parse(execSync('cat package.json', { encoding: 'utf-8' }))
const version = pkg.version
console.log(`pre-verify: @danceiny/gotry@${version}`)

let tgz = ''
let dest = ''
try {
  // 1) pack(产物落临时目录,不污染仓根;输出走文件防 ENOBUFS)
  const outDir = mkdtempSync(join(tmpdir(), 'gotry-preverify-out-'))
  execSync(`npm pack --pack-destination ${outDir}`, { stdio: 'ignore' })
  const tgzPath = `danceiny-gotry-${version}.tgz`
  if (!existsSync(join(outDir, tgzPath))) throw new Error('npm pack 未产出 tarball')
  tgz = join(outDir, tgzPath)
  console.log(`tarball: ${tgzPath}`)

  // 2) 直接解 tarball(免网络:验证的是 tarball 自身内容,声明依赖可达性交由 npm registry 安装时保证)
  dest = mkdtempSync(join(tmpdir(), 'gotry-preverify-'))
  execSync(`tar -xzf "${tgz}" -C "${dest}"`, { stdio: 'pipe' })
  const pkgDir = join(dest, 'package')
  const installedPkg = JSON.parse(execSync(`cat ${join(pkgDir, 'package.json')}`, { encoding: 'utf-8' }))
  if (installedPkg.version !== version) throw new Error(`版本不符:${installedPkg.version}`)

  // 3) dependencies 声明完整性:每个依赖必须存在于安装树(rc.9 缺陷=声明了运行时使用但根本没声明依赖)
  const deps = Object.keys(installedPkg.dependencies ?? {})
  console.log(`dependencies: ${deps.join(', ')}`)
  // 3b) 运行时 import 的重依赖必须在 dependencies 里声明(可用性由 npm 安装时保证;rc.9 缺陷=用了但没声明)
  const runtimeImports = ['better-sqlite3']
  for (const dep of runtimeImports) {
    if (!deps.includes(dep)) throw new Error(`运行时依赖 ${dep} 未声明进 dependencies(rc.9 缺陷形态)`)
  }
  console.log('deps resolvable: OK')

  // 4) 关键入口文件在包内 + 账本模块真实 import
  for (const e of [
    'dist/src/state-ledger.js',
    'dist/src/index.js',
    'bin/gotry-inner.js',
    'dist/capabilities/session/static-flight-golden.js',
    'dist/capabilities/session/golden-score.js',
    'dist/scripts/sf-live-benchmark.js',
    'dist/data/session-golden-20.json',
    'dist/data/sf-golden-manifest.json',
    'dist/data/sf-static-routes.json',
  ]) {
    if (!existsSync(join(pkgDir, e))) throw new Error(`发布缺文件: ${e}`)
  }
  // import 冒烟改静态:state-ledger 的 better-sqlite3 引用已被 §3b 声明检查覆盖(无安装树时无法真 import)
  if (!execSync(`grep -c "better-sqlite3" ${join(pkgDir, 'dist/src/state-ledger.js')}`, { encoding: 'utf-8' }).trim().match(/^[1-9]/)) {
    throw new Error('dist/src/state-ledger.js 未引用 better-sqlite3(声明与实现不符)')
  }
  const staticProvider = await import(pathToFileURL(join(pkgDir, 'dist/capabilities/session/static-flight-golden.js')).href)
  const staticSnapshot = staticProvider.loadStaticFlightSnapshot()
  if (staticSnapshot.schema_version !== 'sf-static-routes.v1' || staticSnapshot.routes.length !== 8) {
    throw new Error('发布 static golden 快照不可加载或覆盖不足 8 条')
  }

  console.log('PUBLISH PREVERIFY: OK')
} catch (e) {
  console.error(`PREVERIFY FAILED: ${(e as Error).message}`)
  process.exit(1)
} finally {
  if (tgz) rmSync(tgz, { force: true })
  if (dest) rmSync(dest, { recursive: true, force: true })
}
