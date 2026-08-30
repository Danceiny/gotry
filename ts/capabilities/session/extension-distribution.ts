/**
 * 扩展产物分发(issue #21 分发通道,ADR-21;founder 2026-08-30「产物下载和安装也得做成更好的
 * 用户体验,可以用 github 作为分发渠道」)。
 *
 * 平台硬约束(诚实前置):Chrome 禁止普通用户从任意 URL 安装打包 CRX——GitHub 只能改善
 * 「下载」(版本化/回滚/与 npm 发版节奏解耦),改善不了「安装」;「开发者模式加载已解压」
 * 那 3 次点击只有上架 Chrome Web Store 才能消掉(商店版自动更新,见 extension-webstore-submission.md)。
 * manifest 固定 key ⇒ 双通道是同一个扩展 ID(olpgkofjhhiiiahdkkbcninhjmegghfe),端口池/
 * host_permissions 不随通道漂移——本模块用 key 钉住这一不变量。
 *
 * 单一职责:① 产物源解析(bundled 默认离线确定性 | github 显式 opt-in);
 * ② GitHub Releases 下载链:dist-manifest → tar.gz → SHA256 校验 → tar 解压 → key 钉扎校验
 *    → 版本比较 → 原子交换 ~/.gotry/extension;
 * ③ 失败语义:github 源任何失败(无网/404/校验不过/key 漂移)→ 结构化 fallback bundled,
 *    绝不挡 setup(安装外部产物永远不挡 gotry 本体——bootstrap 契约)。
 *
 * 信任边界(诚实声明):TLS 传输 + 同源 dist-manifest 哈希完整性——防截断/损坏/误传资产,
 * 不防仓库本身被攻陷(无独立 pinning;独立 pin 需把哈希烘进 npm 包,与「扩展更新与 npm
 * 发版解耦」目标冲突,明确不做)。
 *
 * 零新 npm 依赖:fetch 走 Node ≥22 全局;解压走平台原生 `tar -xzf`(macOS/Linux/Windows10+
 * 自带);SHA256 走 node:crypto。spawn/fetch 可注入(离线测试)。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Releases 稳定资产名(每版覆盖同名上传;latest/download 永久链只认稳定名)。
 *  与 scripts/package-extension.mjs 的资产名必须逐字一致——extension-distribution-tests 防漂移。 */
export const DIST_ASSET_TARBALL = 'gotry-session-bridge.tar.gz'
export const DIST_ASSET_STORE_ZIP = 'gotry-session-bridge-store.zip'
export const DIST_ASSET_MANIFEST = 'extension-dist-manifest.json'

export const DEFAULT_RELEASE_BASE = 'https://github.com/Danceiny/gotry/releases'

export interface ExtensionDistManifest {
  version: string
  tarball: string
  tarballSha256: string
  zip: string
  zipSha256: string
  builtFromCommit?: string
}

export interface GithubSourceOptions {
  /** Releases 基址(测试/镜像可指回环);默认 GitHub 官方 */
  releaseBase?: string
  /** 注入 fetch(离线测试);默认全局 fetch */
  fetch?: typeof fetch
  /** 注入 spawn(离线测试拦截 tar);默认 child_process.spawn */
  spawnFn?: typeof spawn
  /** 下载/解压超时(默认 60s,有界) */
  timeoutMs?: number
}

export type ExtensionInstallAction = 'installed' | 'up-to-date' | 'fallback-bundled'

export interface ExtensionInstallResult {
  ok: boolean
  action: ExtensionInstallAction
  /** 远端 dist-manifest 声明的版本(action=up-to-date 时也带回,供比较报告) */
  version?: string
  /** 交换前 dest 里已就位的版本(无则 undefined) */
  previousVersion?: string
  error?: string
}

/** 纯函数:三段数字版本比较(a<b 负 / 相等 0 / a>b 正;非数字段按 0 处理,长度差补 0) */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map((s) => Number.parseInt(s, 10) || 0)
  const pb = String(b).split('.').map((s) => Number.parseInt(s, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 纯函数:Releases latest/download 永久链(稳定资产名) */
export function distAssetUrls(releaseBase: string = DEFAULT_RELEASE_BASE): { tarball: string; storeZip: string; manifest: string } {
  const base = releaseBase.replace(/\/+$/, '')
  return {
    tarball: `${base}/latest/download/${DIST_ASSET_TARBALL}`,
    storeZip: `${base}/latest/download/${DIST_ASSET_STORE_ZIP}`,
    manifest: `${base}/latest/download/${DIST_ASSET_MANIFEST}`,
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/

/** 纯函数:dist-manifest 解析,fail-closed(坏 JSON/缺字段/资产名漂移/哈希非 64-hex 一律拒绝) */
export function parseDistManifest(raw: string): ExtensionDistManifest {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error('dist-manifest 不是合法 JSON')
  }
  const version = obj.version
  const tarball = obj.tarball
  const tarballSha256 = obj.tarballSha256
  const zip = obj.zip
  const zipSha256 = obj.zipSha256
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('dist-manifest.version 缺失或非 x.y.z')
  if (tarball !== DIST_ASSET_TARBALL) throw new Error(`dist-manifest.tarball 资产名漂移(期望 ${DIST_ASSET_TARBALL})`)
  if (zip !== DIST_ASSET_STORE_ZIP) throw new Error(`dist-manifest.zip 资产名漂移(期望 ${DIST_ASSET_STORE_ZIP})`)
  if (typeof tarballSha256 !== 'string' || !SHA256_RE.test(tarballSha256)) throw new Error('dist-manifest.tarballSha256 非 64-hex')
  if (typeof zipSha256 !== 'string' || !SHA256_RE.test(zipSha256)) throw new Error('dist-manifest.zipSha256 非 64-hex')
  return {
    version,
    tarball,
    tarballSha256,
    zip,
    zipSha256,
    builtFromCommit: typeof obj.builtFromCommit === 'string' ? obj.builtFromCommit : undefined,
  }
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 读取扩展 manifest 的 key(固定 key ⇒ 固定扩展 ID;分发通道 ID 不变量的锚点) */
export function readExtensionKey(extensionDir: string): string | undefined {
  const p = join(extensionDir, 'manifest.json')
  if (!existsSync(p)) return undefined
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as { key?: unknown }
    return typeof m.key === 'string' ? m.key : undefined
  } catch {
    return undefined
  }
}

export function readExtensionVersion(extensionDir: string): string | undefined {
  const p = join(extensionDir, 'manifest.json')
  if (!existsSync(p)) return undefined
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }
    return typeof m.version === 'string' ? m.version : undefined
  } catch {
    return undefined
  }
}

function runTar(args: string[], spawnFn: typeof spawn, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawnFn('tar', args, { stdio: 'ignore' })
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve({ ok: false, error: `tar 超时(>${timeoutMs}ms)` })
      }
    }, timeoutMs)
    child.on('error', (e) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        resolve({ ok: false, error: `tar 不可用:${e.message}` })
      }
    })
    child.on('close', (code) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        resolve(code === 0 ? { ok: true } : { ok: false, error: `tar exit ${code}` })
      }
    })
  })
}

async function fetchBytes(url: string, fetchFn: typeof fetch, timeoutMs: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${url}` }
    const buf = new Uint8Array(await res.arrayBuffer())
    return { ok: true, bytes: buf }
  } catch (e) {
    return { ok: false, error: `下载失败 ${(e as Error).message}` }
  }
}

export interface InstallFromGithubOptions extends GithubSourceOptions {
  /** 落位目录(默认 ~/.gotry/extension 由调用方决定,本层不猜) */
  destDir: string
  /** 钉扎参照:bundled extension/ 目录(其 manifest key 是 ID 不变量的基准;缺省只做版本校验) */
  pinnedSourceDir?: string
  /** 只报告不落盘(up-to-date/将安装哪个版本;不下载 tarball 之外的任何东西) */
  checkOnly?: boolean
}

/**
 * GitHub Releases → ~/.gotry/extension 安装链。
 * 任何失败都返回 { ok:false, action:'fallback-bundled' }——调用方显式降级 bundled,
 * 本函数不抛出(bootstrap 契约:安装外部产物永远不挡 gotry 本体)。
 */
export async function installExtensionFromGithub(opts: InstallFromGithubOptions): Promise<ExtensionInstallResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const fetchFn = opts.fetch ?? fetch
  const spawnFn = opts.spawnFn ?? spawn
  const urls = distAssetUrls(opts.releaseBase)
  const fail = (error: string): ExtensionInstallResult => ({ ok: false, action: 'fallback-bundled', error })

  const mRes = await fetchBytes(urls.manifest, fetchFn, timeoutMs)
  if (!mRes.ok) return fail(mRes.error)
  let manifest: ExtensionDistManifest
  try {
    manifest = parseDistManifest(new TextDecoder().decode(mRes.bytes))
  } catch (e) {
    return fail(`dist-manifest 校验失败:${(e as Error).message}`)
  }

  const previousVersion = readExtensionVersion(opts.destDir)
  if (previousVersion != null && compareVersions(manifest.version, previousVersion) <= 0) {
    return { ok: true, action: 'up-to-date', version: manifest.version, previousVersion }
  }
  if (opts.checkOnly) {
    return { ok: true, action: 'up-to-date', version: manifest.version, previousVersion } // check-only 语义:报告远端版本,不落盘
  }

  const tRes = await fetchBytes(urls.tarball, fetchFn, timeoutMs)
  if (!tRes.ok) return fail(tRes.error)
  const actual = sha256Hex(tRes.bytes)
  if (actual !== manifest.tarballSha256) return fail(`SHA256 不符(期望 ${manifest.tarballSha256.slice(0, 12)}… 实得 ${actual.slice(0, 12)}…)`)

  // 落盘 → tar 解压 → key 钉扎 → 原子交换;incoming 目录同盘保证 rename 原子性
  const incoming = `${opts.destDir}.incoming-${process.pid}-${Date.now()}`
  const tarPath = `${incoming}.tar.gz`
  try {
    rmSync(incoming, { recursive: true, force: true })
    mkdirSync(incoming, { recursive: true })
    writeFileSync(tarPath, tRes.bytes)
    // 包内含顶层目录 gotry-session-bridge/;--strip-components 落到 incoming 根
    const ext = await runTar(['-xzf', tarPath, '-C', incoming, '--strip-components', '1'], spawnFn, timeoutMs)
    if (!ext.ok) return fail(ext.error!)

    const incomingKey = readExtensionKey(incoming)
    if (incomingKey == null) return fail('解压产物缺 manifest.json/key(非法包)')
    if (opts.pinnedSourceDir) {
      const pinnedKey = readExtensionKey(opts.pinnedSourceDir)
      if (pinnedKey != null && incomingKey !== pinnedKey) return fail('扩展 key 漂移(通道产物与 bundled 不同 ID——拒绝安装,防端口池/host 权限漂移)')
    }
    const incomingVersion = readExtensionVersion(incoming)
    if (incomingVersion !== manifest.version) return fail(`解压产物版本(${incomingVersion})与 dist-manifest(${manifest.version})不符`)

    rmSync(opts.destDir, { recursive: true, force: true })
    cpSync(incoming, opts.destDir, { recursive: true })
    return { ok: true, action: 'installed', version: manifest.version, previousVersion }
  } catch (e) {
    return fail(`落位失败 ${(e as Error).message}`)
  } finally {
    rmSync(incoming, { recursive: true, force: true })
    rmSync(tarPath, { force: true })
  }
}
