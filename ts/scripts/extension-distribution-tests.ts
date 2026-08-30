/**
 * 扩展分发通道合同测试(§43;ADR-21 分发 A,GitHub Releases 下载链)。
 *
 * 全离线确定性:回环 node:http 服务器(mkdtemp + 临时端口)serve dist-manifest 与
 * 真 tar.gz 夹具(由平台 tar 从仓内 extension/ 打出);零外网、零浏览器、零共享状态。
 *
 * 断言面:
 *   ① 合同:稳定资产名/URL 形态;package-extension.mjs 资产名逐字防漂移(读源码比对);
 *   ② fail-closed:parseDistManifest 对坏 JSON/缺字段/资产名漂移/非 64-hex 哈希全部拒绝;
 *   ③ 版本比较:0.1.0<0.1.1<0.2.0<1.0.0,相等为 0;
 *   ④ 回环 e2e:installed(下载→SHA256→tar 解压→key 钉扎→原子交换)/ up-to-date(不下载 tarball)/
 *      check-only(只报告不落盘)/ 坏 SHA 拒绝 / 404 降级 fallback-bundled / key 漂移拒绝;
 *   ⑤ CLI 契约:extension-distribution-cli.ts 对回环基址单行 JSON + 退出码 0/2。
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_RELEASE_BASE,
  DIST_ASSET_MANIFEST,
  DIST_ASSET_STORE_ZIP,
  DIST_ASSET_TARBALL,
  compareVersions,
  distAssetUrls,
  installExtensionFromGithub,
  parseDistManifest,
  readExtensionKey,
  sha256Hex,
} from '../capabilities/session/extension-distribution.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXT_SRC = join(repoRoot, 'extension')
const EXT_FILES = ['manifest.json', 'background.js', 'content-main.js', 'content-bridge.js', 'README.md']

let passed = 0
function ok(cond: boolean, label: string) {
  if (!cond) {
    console.error(`  ✗ ${label}`)
    process.exit(1)
  }
  passed += 1
  console.log(`  ok - ${label}`)
}

// ─── ① 合同面 ───────────────────────────────────────────────────────────────
{
  const urls = distAssetUrls()
  ok(urls.tarball === `${DEFAULT_RELEASE_BASE}/latest/download/${DIST_ASSET_TARBALL}`, `tarball URL 形态(${urls.tarball})`)
  ok(urls.manifest.endsWith(`/latest/download/${DIST_ASSET_MANIFEST}`), 'manifest URL 形态(latest/download 永久链)')
  ok(distAssetUrls('https://x.example/releases/').tarball === 'https://x.example/releases/latest/download/gotry-session-bridge.tar.gz', 'releaseBase 尾斜杠归一')
  // 打包脚本资产名逐字防漂移(读 mjs 源码;名字漂移 = latest/download 永久链断裂)
  const pkgSrc = readFileSync(join(repoRoot, 'scripts', 'package-extension.mjs'), 'utf8')
  ok(pkgSrc.includes(`const ASSET_TARBALL = '${DIST_ASSET_TARBALL}'`), 'package-extension.mjs tarball 资产名一致')
  ok(pkgSrc.includes(`const ASSET_STORE_ZIP = '${DIST_ASSET_STORE_ZIP}'`), 'package-extension.mjs store zip 资产名一致')
  ok(pkgSrc.includes(`const ASSET_MANIFEST = '${DIST_ASSET_MANIFEST}'`), 'package-extension.mjs dist-manifest 资产名一致')
  ok(pkgSrc.includes("const STAGE = join(OUT, 'gotry-session-bridge')"), '打包根目录名固定 gotry-session-bridge/(下载端 strip-components 依赖)')
  ok(pkgSrc.includes('delete m.key'), 'store zip 变体剥离 manifest key(2026-08-30 商店首传实测拒绝 key;tar.gz 保留 key 保通道 ID 不变量)')
}

// ─── ② parseDistManifest fail-closed ────────────────────────────────────────
{
  const good = JSON.stringify({ version: '0.1.0', tarball: DIST_ASSET_TARBALL, tarballSha256: 'a'.repeat(64), zip: DIST_ASSET_STORE_ZIP, zipSha256: 'b'.repeat(64) })
  ok(parseDistManifest(good).version === '0.1.0', '合法 dist-manifest 解析')
  const rejects: Array<[string, string]> = [
    ['{bad json', '坏 JSON'],
    [JSON.stringify({ version: 'x', tarball: DIST_ASSET_TARBALL, tarballSha256: 'a'.repeat(64), zip: DIST_ASSET_STORE_ZIP, zipSha256: 'b'.repeat(64) }), 'version 非 x.y.z'],
    [JSON.stringify({ tarball: DIST_ASSET_TARBALL, tarballSha256: 'a'.repeat(64), zip: DIST_ASSET_STORE_ZIP, zipSha256: 'b'.repeat(64) }), '缺 version'],
    [JSON.stringify({ version: '0.1.0', tarball: 'other-name.tar.gz', tarballSha256: 'a'.repeat(64), zip: DIST_ASSET_STORE_ZIP, zipSha256: 'b'.repeat(64) }), 'tarball 资产名漂移'],
    [JSON.stringify({ version: '0.1.0', tarball: DIST_ASSET_TARBALL, tarballSha256: 'zz', zip: DIST_ASSET_STORE_ZIP, zipSha256: 'b'.repeat(64) }), 'tarballSha256 非 64-hex'],
  ]
  for (const [raw, label] of rejects) {
    let threw = false
    try { parseDistManifest(raw) } catch { threw = true }
    ok(threw, `fail-closed:${label}`)
  }
}

// ─── ③ 版本比较 ─────────────────────────────────────────────────────────────
{
  ok(compareVersions('0.1.0', '0.1.1') < 0, '0.1.0 < 0.1.1')
  ok(compareVersions('0.2.0', '0.1.9') > 0, '0.2.0 > 0.1.9')
  ok(compareVersions('1.0.0', '0.9.9') > 0, '1.0.0 > 0.9.9')
  ok(compareVersions('0.1.0', '0.1.0') === 0, '相等为 0')
  ok(compareVersions('0.1', '0.1.0') === 0, '缺段按 0 补齐')
}

// ─── ④ 回环 e2e ─────────────────────────────────────────────────────────────
interface Loopback {
  base: string
  manifestJson: string
  tarball: Buffer
  tarballHits: () => number
  close: () => Promise<void>
}

async function startLoopback(manifestJson: string, tarball: Buffer): Promise<Loopback> {
  let hits = 0
  const server = createServer((req, res) => {
    if (req.url?.endsWith(DIST_ASSET_MANIFEST)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(manifestJson)
    } else if (req.url?.endsWith(DIST_ASSET_TARBALL)) {
      hits += 1
      res.writeHead(200, { 'content-type': 'application/gzip' })
      res.end(tarball)
    } else {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/releases`
  return {
    base,
    manifestJson,
    tarball,
    tarballHits: () => hits,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

/** 用平台 tar 从 sourceDir 打一个真 tar.gz 夹具(顶层目录 gotry-session-bridge/);
 *  versionOverride 把暂存副本的 manifest 版本改写为远端版本(保留真实 key——key 钉扎闸要在场) */
function buildTarball(sourceDir: string, versionOverride?: string): { tarball: Buffer; sha: string } {
  const stage = mkdtempSync(join(tmpdir(), 'extdist-stage-'))
  const root = join(stage, 'gotry-session-bridge')
  mkdirSync(root)
  for (const f of EXT_FILES) copyFileSync(join(sourceDir, f), join(root, f))
  if (versionOverride != null) {
    const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as { version: string }
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...m, version: versionOverride }))
  }
  const tarPath = join(stage, DIST_ASSET_TARBALL)
  execFileSync('tar', ['-czf', tarPath, '-C', stage, 'gotry-session-bridge'])
  const tarball = readFileSync(tarPath)
  rmSync(stage, { recursive: true, force: true })
  return { tarball, sha: sha256Hex(tarball) }
}

function distManifestJson(version: string, sha: string): string {
  return JSON.stringify({ version, tarball: DIST_ASSET_TARBALL, tarballSha256: sha, zip: DIST_ASSET_STORE_ZIP, zipSha256: 'c'.repeat(64), builtFromCommit: 'test' })
}

{
  const work = mkdtempSync(join(tmpdir(), 'extdist-e2e-'))
  const { tarball, sha } = buildTarball(EXT_SRC, '9.9.9')
  const srcVersion = JSON.parse(readFileSync(join(EXT_SRC, 'manifest.json'), 'utf8')) as { version: string; key: string }
  const remoteVersion = '9.9.9'

  // (1) installed:下载→SHA256→解压→key 钉扎→原子交换
  {
    const dest = join(work, 'dest1')
    const lb = await startLoopback(distManifestJson(remoteVersion, sha), tarball)
    const r = await installExtensionFromGithub({ destDir: dest, pinnedSourceDir: EXT_SRC, releaseBase: lb.base })
    lb.close()
    ok(r.ok && r.action === 'installed' && r.version === remoteVersion, `installed 全链(action=${r.action},v=${r.version},err=${r.error ?? '无'})`)
    ok(readExtensionKey(dest) === srcVersion.key, '落位产物 key 与 bundled 逐字一致(同扩展 ID)')
    ok(JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')).version === remoteVersion, '落位产物为远端版本')
    for (const f of EXT_FILES) ok(existsSync(join(dest, f)), `文件就位:${f}`)
  }

  // (2) 坏 SHA 拒绝(截断/误传资产防住)
  {
    const dest = join(work, 'dest2')
    const lb = await startLoopback(distManifestJson(remoteVersion, '0'.repeat(64)), tarball)
    const r = await installExtensionFromGithub({ destDir: dest, pinnedSourceDir: EXT_SRC, releaseBase: lb.base })
    lb.close()
    ok(!r.ok && r.action === 'fallback-bundled' && /SHA256/.test(r.error ?? ''), `SHA256 不符拒绝(${r.error})`)
    ok(!existsSync(dest), '失败路径零落盘')
  }

  // (3) 404 → fallback-bundled
  {
    const dest = join(work, 'dest3')
    const lb = await startLoopback(distManifestJson(remoteVersion, sha), tarball)
    lb.close() // 关掉 = 连接拒绝,等价网络不可达
    const r = await installExtensionFromGithub({ destDir: dest, releaseBase: lb.base })
    ok(!r.ok && r.action === 'fallback-bundled', `无网降级 fallback-bundled(${(r.error ?? '').slice(0, 40)})`)
  }

  // (4) key 漂移拒绝(通道产物与 bundled 不同 ID → 防端口池/host 权限漂移)
  {
    const rogue = mkdtempSync(join(work, 'rogue-'))
    const rogueManifest = { ...srcVersion, version: remoteVersion, key: `ROGUE-${srcVersion.key}` }
    writeFileSync(join(rogue, 'manifest.json'), JSON.stringify(rogueManifest))
    for (const f of EXT_FILES.filter((x) => x !== 'manifest.json')) copyFileSync(join(EXT_SRC, f), join(rogue, f))
    const { tarball: rTar, sha: rSha } = buildTarball(rogue)
    const dest = join(work, 'dest4')
    const lb = await startLoopback(distManifestJson(remoteVersion, rSha), rTar)
    const r = await installExtensionFromGithub({ destDir: dest, pinnedSourceDir: EXT_SRC, releaseBase: lb.base })
    lb.close()
    ok(!r.ok && /key 漂移/.test(r.error ?? ''), `key 漂移拒绝(${r.error})`)
    ok(!existsSync(dest), '漂移路径零落盘')
    rmSync(rogue, { recursive: true, force: true })
  }

  // (5) up-to-date:本地已是远端版本 → 不下载 tarball
  {
    const dest = join(work, 'dest5')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'manifest.json'), JSON.stringify({ ...srcVersion, version: remoteVersion }))
    const lb = await startLoopback(distManifestJson(remoteVersion, sha), tarball)
    const r = await installExtensionFromGithub({ destDir: dest, pinnedSourceDir: EXT_SRC, releaseBase: lb.base })
    const hits = lb.tarballHits()
    lb.close()
    ok(r.ok && r.action === 'up-to-date' && hits === 0, `up-to-date 跳过(tarball 下载 ${hits} 次)`)
  }

  // (6) check-only:只报告远端版本,不落盘
  {
    const dest = join(work, 'dest6')
    const lb = await startLoopback(distManifestJson(remoteVersion, sha), tarball)
    const r = await installExtensionFromGithub({ destDir: dest, releaseBase: lb.base, checkOnly: true })
    lb.close()
    ok(r.ok && r.version === remoteVersion && !existsSync(dest), 'check-only 报告远端版本且零落盘')
  }

  rmSync(work, { recursive: true, force: true })
}

// ─── ⑤ CLI 契约(回环基址,单行 JSON + 退出码) ────────────────────────────────
{
  const { tarball, sha } = buildTarball(EXT_SRC, '9.9.9')
  const srcVersion = JSON.parse(readFileSync(join(EXT_SRC, 'manifest.json'), 'utf8')) as { version: string }
  const lb = await startLoopback(distManifestJson('9.9.9', sha), tarball)
  const dest = mkdtempSync(join(tmpdir(), 'extdist-cli-'))
  const cli = join(repoRoot, 'ts', 'scripts', 'extension-distribution-cli.ts')
  const run = (args: string[]) =>
    new Promise<{ code: number; json: Record<string, unknown> | null }>((resolve) => {
      const child = spawn('npx', ['--yes', 'tsx', cli, ...args], { cwd: join(repoRoot, 'ts'), stdio: ['ignore', 'pipe', 'inherit'] })
      let buf = ''
      child.stdout.on('data', (c) => { buf += c.toString('utf8') })
      child.on('close', (code) => {
        const line = (buf.trim().split('\n').pop() ?? '')
        let json: Record<string, unknown> | null = null
        if (line.startsWith('{')) { try { json = JSON.parse(line) as Record<string, unknown> } catch { /* null */ } }
        resolve({ code: code ?? -1, json })
      })
    })
  const r1 = await run(['--dest', dest, '--source-dir', EXT_SRC, '--release-base', lb.base])
  ok(r1.code === 0 && r1.json?.ok === true && r1.json?.action === 'installed', `CLI installed 单行 JSON + exit 0(action=${String(r1.json?.action)})`)
  const r2 = await run(['--dest', dest, '--source-dir', EXT_SRC, '--release-base', 'http://127.0.0.1:1/releases'])
  ok(r2.code === 2 && r2.json?.ok === false && r2.json?.action === 'fallback-bundled', `CLI 失败 exit 2 + fallback-bundled JSON`)
  lb.close()
  rmSync(dest, { recursive: true, force: true })
}

console.log(`EXTENSION DISTRIBUTION: ${passed} pass, 0 fail`)
