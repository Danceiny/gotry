/**
 * 扩展分发通道合同测试(§43;ADR-21 分发 A,GitHub Releases 下载链 + 通道 B 发布链预检)。
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
 *   ⑤ CLI 契约:extension-distribution-cli.ts 对回环基址单行 JSON + 退出码 0/2;
 *   ⑥ CWS 发布链(scripts/cws-publish-validate.mjs,通道 B #346/#537):token/upload/publish
 *      响应分类经子进程走同一条 CLI 路径(HTTP 2xx 不足为凭;invalid_grant/uploadState≠SUCCESS/
 *      status[] 无 OK 一律拒绝;仅 ITEM_PENDING_REVIEW = 已在审勿重复提审)+ artifact 预检
 *      (三件套/版本/SHA256 对账)+ upload→download 路径错位回归(artifact 根 = dist-extension,
 *      download 缺 path 解到 workspace 根 = 2026-09-24 事故形态)+ workflow/文档防漂移。
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// ─── ⑥ CWS 发布链:响应分类 + artifact 预检 + 路径错位回归(scripts/cws-publish-validate.mjs) ───
{
  const VALIDATOR = join(repoRoot, 'scripts', 'cws-publish-validate.mjs')
  const WORKFLOW_SRC = readFileSync(join(repoRoot, '.github/workflows/extension-publish.yml'), 'utf8')
  const SENTINEL = 'FAKE_SECRET_SENTINEL'
  let importWithoutArgv = false
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(VALIDATOR).href)})`], { cwd: repoRoot, stdio: 'pipe' })
    importWithoutArgv = true
  } catch { /* the pure module must not execute or crash its CLI entrypoint */ }
  ok(importWithoutArgv, '校验器可作为纯模块导入，无 argv[1] 时不触发 CLI')
  /** 子进程走与 workflow 逐字相同的 CLI 路径(stdin + --http-code + 退出码;成功 JSON 在 stdout,失败 JSON 在 stderr) */
  const runValidator = (args: string[], stdin?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('node', [VALIDATOR, ...args], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => { out += c.toString('utf8') })
      child.stderr.on('data', (c) => { err += c.toString('utf8') })
      if (stdin != null) child.stdin.write(stdin)
      child.stdin.end()
      child.on('close', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }))
    })
  /** 机密纪律:任何失败路径的 stdout+stderr 都不得携带响应体/明细/凭据等 API 供应文本 */
  const assertNoLeak = async (args: string[], stdin: string, label: string) => {
    const r = await runValidator(args, stdin)
    ok(r.code === 1, `${label}:非零退出`)
    ok(!`${r.stdout}${r.stderr}`.includes(SENTINEL), `${label}:stdout+stderr 无 sentinel 泄漏`)
    const lastLine = r.stderr.trim().split('\n').pop() ?? '{}'
    ok(JSON.parse(lastLine).ok === false, `${label}:失败 JSON 为固定分类(${JSON.parse(lastLine).reason})`)
  }

  // (1) token:合法 → exit 0;分类 JSON 不携带凭据;--field access_token 是唯一 token 出口
  {
    const r = await runValidator(['token', '--http-code', '200'], '{"access_token":"SECRET-TOKEN","expires_in":3599,"token_type":"Bearer"}')
    ok(r.code === 0 && JSON.parse(r.stdout).ok === true, `token 合法响应接受(${r.stdout.trim()})`)
    ok(!r.stdout.includes('SECRET-TOKEN'), 'token 分类 JSON 不回显 access_token(仅 --field 吐本值)')
    const f = await runValidator(['token', '--http-code', '200', '--field', 'access_token'], '{"access_token":"SECRET-TOKEN"}')
    ok(f.code === 0 && f.stdout.trim() === 'SECRET-TOKEN', 'token --field access_token 吐本值(workflow 捕获形态)')
  }
  // (2) token fail-closed:4xx/5xx、error 字段(任意类型含对象)、缺/空/纯空白/内嵌空白或控制字符的
  //     access_token、畸形 JSON——全部拒绝;每条都同时是 sentinel 泄漏探针(响应体不落日志)
  {
    const cases: Array<[string, string, string, string]> = [
      ['401', `{"access_token":"${SENTINEL}"}`, 'http-status', 'HTTP 401(体含 sentinel)'],
      ['200', `{"error":"invalid_grant","error_description":"expired ${SENTINEL}"}`, 'api-error', 'invalid_grant(描述含 sentinel)'],
      ['200', `{"error":{"code":5,"message":"${SENTINEL}"}}`, 'api-error', '对象值 error 字段'],
      ['200', `{"expires_in":3599,"note":"${SENTINEL}"}`, 'missing-access-token', '缺 access_token(体含 sentinel)'],
      ['200', `{"access_token":"${SENTINEL}","error":null}`, 'api-error', 'null error 字段仍拒绝'],
      ['200', '{"access_token":""}', 'missing-access-token', '空 access_token'],
      ['200', '{"access_token":"   "}', 'missing-access-token', '纯空白 access_token'],
      ['200', '{"access_token":"ab\\ncd"}', 'missing-access-token', '合法 JSON 内嵌 \\n(转义形式)'],
      ['200', '{"access_token":"a\\tb"}', 'missing-access-token', '内嵌制表符'],
      ['200', 'not-json', 'malformed-json', '畸形 JSON'],
    ]
    for (const [code, body, reason, label] of cases) {
      const r = await runValidator(['token', '--http-code', code], body)
      ok(r.code === 1 && JSON.parse(r.stderr).reason === reason, `token fail-closed:${label}(${reason})`)
      ok(!`${r.stdout}${r.stderr}`.includes(SENTINEL), `token 无泄漏:${label}`)
    }
  }
  // (3) upload:SUCCESS 且 itemError 为空唯一放行;HTTP-success/application-rejection(200 + FAILURE、
  //     SUCCESS 带非空 itemError 的自相矛盾响应)拒绝;明细文本不落日志
  {
    const r = await runValidator(['upload', '--http-code', '200'], '{"kind":"chromewebstore#item","uploadState":"SUCCESS"}')
    ok(r.code === 0 && JSON.parse(r.stdout).uploadState === 'SUCCESS', 'upload SUCCESS(空 itemError)接受')
    const rejection: Array<[string, string]> = [
      [`{"uploadState":"FAILURE","itemError":["${SENTINEL}"]}`, '200+FAILURE(明细含 sentinel)'],
      [`{"uploadState":"SUCCESS","itemError":["${SENTINEL}"]}`, 'SUCCESS 带非空 itemError(自相矛盾,不前进了)'],
      [`{"uploadState":"SUCCESS","itemError":"${SENTINEL}"}`, 'itemError 字符串拒绝'],
      [`{"uploadState":"SUCCESS","itemError":{"message":"${SENTINEL}"}}`, 'itemError 对象拒绝'],
      ['{"uploadState":"SUCCESS","itemError":null}', 'itemError null 拒绝'],
      ['{"uploadState":"IN_PROGRESS"}', 'IN_PROGRESS 拒绝'],
      ['{"uploadState":"NOT_FOUND"}', 'NOT_FOUND 拒绝'],
      ['{"uploadState":"SOMETHING_NEW"}', '未知新值 fail-closed'],
      ['{"kind":"chromewebstore#item"}', '缺 uploadState'],
      ['<html>gateway error</html>', 'HTML 网关体按畸形 JSON 拒绝'],
    ]
    for (const [body, label] of rejection) await assertNoLeak(['upload', '--http-code', '200'], body, `upload:${label}`)
    const rMixed = await runValidator(['upload', '--http-code', '200'], rejection[1][0])
    ok(JSON.parse(rMixed.stderr).reason === 'upload-success-with-errors' && JSON.parse(rMixed.stderr).itemErrorCount === 1, 'SUCCESS+itemError 归类 upload-success-with-errors(计数为派生布尔/数值)')
    const r500 = await runValidator(['upload', '--http-code', '500'], '{"uploadState":"SUCCESS"}')
    ok(r500.code === 1 && JSON.parse(r500.stderr).reason === 'http-status' && JSON.parse(r500.stderr).httpCode === 500, '非 2xx 即使体面 SUCCESS 也拒绝(仅固定分类 + HTTP 码)')
  }
  // (4) publish:status[] 非空且每个元素都 === 'OK' 才算本次提审受理;混合 OK/拒绝、非字符串元素、
  //     枚举外新值(IN_REVIEW 不存在于 v1)一律拒绝;仅 ITEM_PENDING_REVIEW = 独立拒绝原因
  //     (非零退出 + 读回指引,绝不是本版受理凭证);所有失败路径体文本不落日志
  {
    const rOk = await runValidator(['publish', '--http-code', '200'], '{"kind":"chromewebstore#item","item_id":"x","status":["OK"],"statusDetail":["OK"]}')
    ok(rOk.code === 0 && JSON.parse(rOk.stdout).reviewState === 'submitted', 'publish status=[OK] 归类 submitted(HTTP 200 ≠ 提审受理,以响应体为准)')
    const rOk2 = await runValidator(['publish', '--http-code', '200'], '{"status":["OK","OK"]}')
    ok(rOk2.code === 0 && JSON.parse(rOk2.stdout).reviewState === 'submitted', '全 OK 多元素仍受理')
    const rPending = await runValidator(['publish', '--http-code', '200'], '{"status":["ITEM_PENDING_REVIEW"]}')
    const pendingJson = JSON.parse(rPending.stderr.trim().split('\n').pop() ?? '{}')
    ok(rPending.code === 1 && pendingJson.reason === 'publish-already-pending-review', '仅 ITEM_PENDING_REVIEW = 独立拒绝原因,非零退出(读回后再决定,绝非本版受理凭证)')
    ok(/read back the item state/.test(rPending.stderr) && !rPending.stderr.includes(SENTINEL), '读回指引为固定安全文本')
    const rejections: Array<[string, string]> = [
      [`{"status":["NOT_AUTHORIZED"],"statusDetail":["${SENTINEL}"]}`, 'NOT_AUTHORIZED(明细含 sentinel)'],
      ['{"status":["OK","NOT_AUTHORIZED"]}', '混合 OK + 拒绝状态'],
      ['{"status":["OK",123]}', '非字符串元素混入'],
      ['{"status":["ITEM_NOT_FOUND"]}', 'ITEM_NOT_FOUND'],
      ['{"status":["ITEM_TAKEN_DOWN"]}', 'ITEM_TAKEN_DOWN'],
      ['{"status":["IN_REVIEW"]}', 'IN_REVIEW(v1 无此枚举值)'],
      ['{"status":["ITEM_PENDING_REVIEW","NOT_AUTHORIZED"]}', '混合 pending + 拒绝'],
      ['{"kind":"chromewebstore#item","item_id":"x"}', '缺 status[]'],
      ['{"status":[]}', '空 status[]'],
      ['{bad', '畸形 JSON'],
    ]
    for (const [body, label] of rejections) await assertNoLeak(['publish', '--http-code', '200'], body, `publish:${label}`)
    const rMix = await runValidator(['publish', '--http-code', '200'], rejections[1][0])
    ok(JSON.parse(rMix.stderr).reason === 'publish-rejected', '混合 OK/拒绝归 publish-rejected(绝不标 review-submitted)')
    const rMixPending = await runValidator(['publish', '--http-code', '200'], rejections[6][0])
    const mixPendingJson = JSON.parse(rMixPending.stderr.trim().split('\n').pop() ?? '{}')
    ok(mixPendingJson.reason === 'publish-already-pending-review' && mixPendingJson.hasRecognizedRejection === true, '混合 pending/拒绝也 fail(附 recognized-rejection 派生布尔)')
  }
  // (5) 用法错误 exit 2(--http-code 必填——workflow 逐字携带)
  {
    const r = await runValidator(['upload'], '{}')
    ok(r.code === 2, '缺 --http-code 归用法错误 exit 2')
  }

  // (6) artifact 预检:三件套/版本/SHA256 对账 + pack→download→文件查找错位回归
  //     (upload-artifact 多路径 root 在公共祖先 dist-extension/;download 缺 path 解到
  //      workspace 根 = 2026-09-24 事故形态——旧 curl 引 dist-extension/ 必 ENOENT)
  {
    const work = mkdtempSync(join(tmpdir(), 'extdist-cws-'))
    const zipBytes = Buffer.from(`store-zip-bytes-${Date.now()}`)
    const tarBytes = Buffer.from(`tar-bytes-${Date.now()}`)
    const zipSha = sha256Hex(zipBytes)
    const tarSha = sha256Hex(tarBytes)
    const distManifest = JSON.stringify({
      version: '0.2.0.25',
      tarball: DIST_ASSET_TARBALL,
      tarballSha256: tarSha,
      zip: DIST_ASSET_STORE_ZIP,
      zipSha256: zipSha,
      builtFromCommit: 'fb1cbf2',
    })
    // 事故形态(红):artifact 内容按 v4 根规则 = 三件文件在 archive 根;download 缺 path 落 workspace 根
    const oldDownload = join(work, 'workspace-old')
    mkdirSync(oldDownload)
    writeFileSync(join(oldDownload, DIST_ASSET_STORE_ZIP), zipBytes)
    writeFileSync(join(oldDownload, DIST_ASSET_TARBALL), tarBytes)
    writeFileSync(join(oldDownload, DIST_ASSET_MANIFEST), distManifest)
    const red = await runValidator(['artifact', '--dir', join(oldDownload, 'dist-extension'), '--expect-version', '0.2.0.25'])
    ok(red.code === 1 && JSON.parse(red.stderr).reason === 'missing-manifest', '路径错位事故形态拒绝(download 缺 path → dist-extension/ 下无三件套,旧 curl 必 ENOENT)')
    // 修复形态(绿):download 显式 path: dist-extension
    const newDownload = join(work, 'workspace-new', 'dist-extension')
    mkdirSync(newDownload, { recursive: true })
    writeFileSync(join(newDownload, DIST_ASSET_STORE_ZIP), zipBytes)
    writeFileSync(join(newDownload, DIST_ASSET_TARBALL), tarBytes)
    writeFileSync(join(newDownload, DIST_ASSET_MANIFEST), distManifest)
    const green = await runValidator(['artifact', '--dir', newDownload, '--expect-version', '0.2.0.25'])
    ok(green.code === 0 && JSON.parse(green.stdout).zipSha256 === zipSha, '修复形态:显式 path 后预检全绿(版本+SHA256 对账)')

    const mkFixture = () => {
      const dir = join(work, `fixture-${Math.random().toString(36).slice(2)}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, DIST_ASSET_STORE_ZIP), zipBytes)
      writeFileSync(join(dir, DIST_ASSET_TARBALL), tarBytes)
      writeFileSync(join(dir, DIST_ASSET_MANIFEST), distManifest)
      return dir
    }
    const tamper: Array<(dir: string) => string> = [
      (dir) => { writeFileSync(join(dir, DIST_ASSET_MANIFEST), JSON.stringify({ ...JSON.parse(distManifest), version: '0.0.1.1' })); return 'version-mismatch' },
      (dir) => { writeFileSync(join(dir, DIST_ASSET_STORE_ZIP), Buffer.from('tampered')); return 'checksum-mismatch' },
      (dir) => { rmSync(join(dir, DIST_ASSET_STORE_ZIP)); return 'missing-artifact' },
      (dir) => { rmSync(join(dir, DIST_ASSET_MANIFEST)); return 'missing-manifest' },
      (dir) => { writeFileSync(join(dir, DIST_ASSET_MANIFEST), '{bad'); return 'malformed-manifest' },
      (dir) => { writeFileSync(join(dir, DIST_ASSET_MANIFEST), JSON.stringify({ ...JSON.parse(distManifest), zipSha256: 'zz' })); return 'bad-hash-format' },
      (dir) => { writeFileSync(join(dir, DIST_ASSET_MANIFEST), JSON.stringify({ ...JSON.parse(distManifest), zip: 'other.zip' })); return 'asset-name-drift' },
    ]
    for (const mutate of tamper) {
      const dir = mkFixture()
      const reason = mutate(dir)
      const r = await runValidator(['artifact', '--dir', dir, '--expect-version', '0.2.0.25'])
      ok(r.code === 1 && JSON.parse(r.stderr).reason === reason, `artifact 预检 fail-closed:${reason}`)
    }
    rmSync(work, { recursive: true, force: true })
  }

  // (7) 防漂移:validator 资产名与 package-extension.mjs 逐字一致;workflow 逐字携带
  //     path: dist-extension + 预检 + 校验器三步调用 + publishTarget + 有界超时 + UNCONFIRMED 读回
  //     + 机密纪律(-f 不回用);双语文档不再提 CHROME_PUBLISHER_ID(四 secret 口径)
  {
    const pkgSrc = readFileSync(join(repoRoot, 'scripts', 'package-extension.mjs'), 'utf8')
    const validatorSrc = readFileSync(VALIDATOR, 'utf8')
    ok(validatorSrc.includes(`export const STORE_ZIP_NAME = '${DIST_ASSET_STORE_ZIP}'`), 'validator store zip 资产名一致')
    ok(validatorSrc.includes(`export const TARBALL_NAME = '${DIST_ASSET_TARBALL}'`), 'validator tarball 资产名一致')
    ok(validatorSrc.includes(`export const DIST_MANIFEST_NAME = '${DIST_ASSET_MANIFEST}'`), 'validator dist-manifest 资产名一致')
    for (const name of [DIST_ASSET_STORE_ZIP, DIST_ASSET_TARBALL, DIST_ASSET_MANIFEST]) {
      ok(pkgSrc.includes(`'${name}'`), `package-extension.mjs 含 ${name}(validator 对账对象在场)`)
    }
    ok(/download-artifact@v4[\s\S]{0,400}path: dist-extension/.test(WORKFLOW_SRC), 'workflow download 显式 path: dist-extension(路径错位修复在位)')
    ok(WORKFLOW_SRC.includes('cws-publish-validate.mjs artifact --dir dist-extension'), 'workflow 预检先于网络调用')
    ok((WORKFLOW_SRC.match(/cws-publish-validate\.mjs (token|upload|publish)/g) ?? []).length === 3, 'token/upload/publish 三步都走校验器')
    ok(!WORKFLOW_SRC.includes('CHROME_PUBLISHER_ID'), 'workflow 无 CHROME_PUBLISHER_ID(直连 API 四 secret)')
    ok(WORKFLOW_SRC.includes('publishTarget=default'), 'publish query 用 v1 文档化参数 publishTarget=default')
    ok(!/publish\?publishMode|&publishMode/.test(WORKFLOW_SRC), 'publishMode(v1 无此参数)不再出现在请求 URL')
    const curlCalls = WORKFLOW_SRC.match(/curl -sS --connect-timeout \d+ --max-time \d+/g) ?? []
    ok(curlCalls.length === 3, `三步 curl 均带有界 --connect-timeout/--max-time(实得 ${curlCalls.length})`)
    ok((WORKFLOW_SRC.match(/::error::[^\n]*UNCONFIRMED/g) ?? []).length === 3, '传输失败三步均记 UNCONFIRMED(读回后再决定,不自动重试)')
    ok(!WORKFLOW_SRC.includes('curl -fsS'), '不再用 -f(吞错误响应体,无法分类)')
    ok(WORKFLOW_SRC.includes('if-no-files-found: error'), 'workflow pack 侧 if-no-files-found: error 保留(缺件即红)')
    for (const doc of ['docs/extension-store-publish.md', 'docs/extension-store-publish.zh-CN.md']) {
      const src = readFileSync(join(repoRoot, doc), 'utf8')
      ok(!src.includes('CHROME_PUBLISHER_ID'), `${doc} 无 CHROME_PUBLISHER_ID(四 secret 口径同步)`)
      ok(src.includes('publishTarget'), `${doc} 载明 publishTarget(v1 文档化参数)`)
    }
  }
}

console.log(`EXTENSION DISTRIBUTION: ${passed} pass, 0 fail`)
