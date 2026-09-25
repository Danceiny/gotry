#!/usr/bin/env node
/**
 * Chrome Web Store 发布链响应分类与 artifact 预检(ADR-21 分发通道 B;extension-publish.yml publish job 专用)。
 *
 * 形态:单文件、零依赖(node: 内建)纯函数 + CLI——workflow 直接 `node` 调用;
 * 夹具测试(ts/scripts/extension-distribution-tests.ts §43⑥)以子进程走同一条 CLI 路径,
 * 全离线覆盖响应分类与 pack→download→文件查找。
 *
 * fail-closed 面(HTTP 2xx 一律不足为凭,先查状态码再验响应体):
 *   token    — OAuth2 token 端点:非 2xx / 非 JSON / error 字段(任意类型含对象)/
 *              access_token 缺失、空、含空白或控制字符 → 拒绝(仅空白 token 进不了 workflow output);
 *   upload   — v1.1 Item 上传响应:uploadState !== 'SUCCESS' 一律拒绝(FAILURE/IN_PROGRESS/
 *              NOT_FOUND/未知值);SUCCESS 但 itemError 非空 = 成功/报错自相矛盾,同样拒绝不前进了;
 *   publish  — v1.1 提审响应:status[] 非空且**每个元素都 === 'OK'** 才算本次提审受理;
 *              仅 ITEM_PENDING_REVIEW = 一次既往提审可能在审(非本版受理凭证)——独立拒绝原因、
 *              非零退出、指示先读回再决定、勿盲目重提;混合 pending/error 与其余一切状态
 *              (NOT_AUTHORIZED/ITEM_NOT_FOUND/ITEM_TAKEN_DOWN/枚举外新值)一律拒绝;
 *   artifact — 发布前预检(先于任何 OAuth/网络调用):三件套在位、dist-manifest 版本匹配、
 *              zip/tar.gz 的 SHA256 与清单逐字一致(精确 source/version → built archive 绑定)。
 *
 * 机密纪律(hard rule):失败输出**绝不携带任何 API 供应文本**——响应体、error_description、
 * token、itemError/statusDetail 明细一律不进 stdout/stderr 日志;失败 JSON 只含固定分类原因
 * (本文件自定义的枚举字面量)与数值/布尔派生量。token 的唯一出口 = `--field access_token`
 * 成功提取(单行、无空白,workflow 立即 ::add-mask::)。
 *
 * 官方 API 证据(2026-09-25 核对):
 *   v1.1(本 workflow 所用;官方已归档:https://developer.chrome.com/docs/webstore/api/v1)
 *     upload  → { kind, id, uploadState: SUCCESS|FAILURE|IN_PROGRESS|NOT_FOUND, itemError[] }
 *     publish → { kind, item_id, status[], statusDetail[] },
 *               status ∈ OK|NOT_AUTHORIZED|INVALID_DEVELOPER|DEVELOPER_NO_OWNERSHIP|
 *                        DEVELOPER_SUSPENDED|ITEM_NOT_FOUND|ITEM_PENDING_REVIEW|
 *                        ITEM_TAKEN_DOWN|PUBLISHER_SUSPENDED(无 IN_REVIEW——枚举外值不存在于 v1)
 *     publish 的 documented query 参数是 publishTarget(default),不是 publishMode。
 *   v2(2025-10 起的现行版:路径含 publisher ID,响应枚举不同——迁移面记录在
 *     docs/extension-store-publish.md;本文件只认 v1.1 形态,v1.1 停服时随 workflow 一并迁移)。
 *
 * CLI:
 *   node scripts/cws-publish-validate.mjs <token|upload|publish> --http-code <n> [--file <path>] [--field access_token]
 *   node scripts/cws-publish-validate.mjs artifact --dir <dir> --expect-version <v>
 *   成功 → stdout 单行 JSON(--field access_token 时仅输出 token 本值);失败 → stderr 单行 JSON;
 *   退出码 0(受理)/ 1(拒绝或传输层不可判定)/ 2(用法错误)。传输层超时由 workflow 侧
 *   curl 退出码判定 —— 结果记 UNCONFIRMED,先读回 item 状态再决定,不自动重试。
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 与 scripts/package-extension.mjs 的 ASSET_* 逐字一致(extension-distribution-tests 读源码防漂移)
export const STORE_ZIP_NAME = 'gotry-session-bridge-store.zip'
export const TARBALL_NAME = 'gotry-session-bridge.tar.gz'
export const DIST_MANIFEST_NAME = 'extension-dist-manifest.json'

/** 可用作 Bearer 的 token:非空、无任何空白(\s)与控制字符——CR/LF 注入与截断 token 一律拒绝 */
const BEARER_RE = /^[^\s\x00-\x1f\x7f]+$/

/** v1.1 文档化枚举(仅用于计算 recognized 布尔,枚举外文本不回显) */
const V1_PUBLISH_STATUSES = new Set([
  'OK', 'NOT_AUTHORIZED', 'INVALID_DEVELOPER', 'DEVELOPER_NO_OWNERSHIP', 'DEVELOPER_SUSPENDED',
  'ITEM_NOT_FOUND', 'ITEM_PENDING_REVIEW', 'ITEM_TAKEN_DOWN', 'PUBLISHER_SUSPENDED',
])
const V1_UPLOAD_STATES = new Set(['SUCCESS', 'FAILURE', 'IN_PROGRESS', 'NOT_FOUND'])

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 失败分类:reason 固定枚举,extra 只允许数值/布尔/固定字面量(机密纪律,见文件头) */
function fail(reason, extra) {
  return { ok: false, reason, ...extra }
}

function parseJsonOr(body) {
  try {
    const parsed = JSON.parse(body)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/** OAuth2 token 端点:error 字段任意类型(含对象)即拒;access_token 必须可作 Bearer(无空白/控制字符) */
export function classifyTokenResponse(body) {
  const parsed = parseJsonOr(body)
  if (!parsed) return fail('malformed-json')
  if (Object.hasOwn(parsed, 'error')) return fail('api-error')
  if (typeof parsed.access_token !== 'string' || !BEARER_RE.test(parsed.access_token)) {
    return fail('missing-access-token')
  }
  const out = { ok: true }
  if (typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)) out.expiresIn = parsed.expires_in
  return out
}

/** v1.1 upload 响应:uploadState === 'SUCCESS' 且 itemError 为空才放行;其余一切拒绝(不回显明细文本) */
export function classifyUploadResponse(body) {
  const parsed = parseJsonOr(body)
  if (!parsed) return fail('malformed-json')
  const { uploadState } = parsed
  if (typeof uploadState !== 'string' || !uploadState) return fail('missing-upload-state')
  if (Object.hasOwn(parsed, 'itemError') && !Array.isArray(parsed.itemError)) return fail('malformed-item-errors')
  const itemErrorCount = Array.isArray(parsed.itemError) ? parsed.itemError.length : 0
  if (uploadState === 'SUCCESS') {
    if (itemErrorCount > 0) return fail('upload-success-with-errors', { itemErrorCount })
    return { ok: true, uploadState, itemErrorCount }
  }
  const recognized = V1_UPLOAD_STATES.has(uploadState)
  return fail('upload-rejected', { stateClass: recognized ? 'recognized' : 'unknown', itemErrorCount })
}

/**
 * v1.1 publish 响应:status[] 非空且每个元素都是字面 'OK' = 本次提审受理;
 * 含 ITEM_PENDING_REVIEW = 既往提审可能在审(独立原因、非零退出、读回后再决定);
 * 其余(混合/拒绝/枚举外如 IN_REVIEW/缺 status[])一律拒绝。
 */
export function classifyPublishResponse(body) {
  const parsed = parseJsonOr(body)
  if (!parsed) return fail('malformed-json')
  const statuses = parsed.status
  if (!Array.isArray(statuses) || statuses.length === 0) return fail('missing-status')
  if (!statuses.every((s) => s === 'OK')) {
    if (statuses.includes('ITEM_PENDING_REVIEW')) {
      return fail('publish-already-pending-review', {
        hasRecognizedRejection: statuses.some((s) => s !== 'ITEM_PENDING_REVIEW' && V1_PUBLISH_STATUSES.has(s)),
      })
    }
    return fail('publish-rejected', {
      statusCount: statuses.length,
      allRecognized: statuses.every((s) => V1_PUBLISH_STATUSES.has(s)),
    })
  }
  return { ok: true, reviewState: 'submitted', statusCount: statuses.length }
}

/**
 * 发布前 artifact 预检:三件套在位(文件而非目录)、dist-manifest 可解析、版本与 dispatch 期望一致、
 * zip/tar.gz 实测 SHA256 与清单记录逐字一致。
 */
export function validateArtifactDir({ dir, expectVersion }) {
  const manifestPath = join(dir, DIST_MANIFEST_NAME)
  if (!isFile(manifestPath)) return fail('missing-manifest', { path: manifestPath })
  const manifest = parseJsonOr(readFileSync(manifestPath, 'utf8'))
  if (!manifest) return fail('malformed-manifest', { path: manifestPath })
  if (manifest.version !== expectVersion) {
    // 版本号是仓库自有产物(非 API 供应文本),可回显用于排障
    return fail('version-mismatch', { manifestVersion: manifest.version, expectVersion })
  }
  if (manifest.zip !== STORE_ZIP_NAME || manifest.tarball !== TARBALL_NAME) {
    return fail('asset-name-drift')
  }
  for (const field of ['zipSha256', 'tarballSha256']) {
    if (typeof manifest[field] !== 'string' || !/^[0-9a-f]{64}$/.test(manifest[field])) {
      return fail('bad-hash-format', { field })
    }
  }
  for (const [name, field] of [[STORE_ZIP_NAME, 'zipSha256'], [TARBALL_NAME, 'tarballSha256']]) {
    const path = join(dir, name)
    if (!isFile(path)) return fail('missing-artifact', { name })
    const actual = sha256Hex(readFileSync(path))
    if (actual !== manifest[field]) return fail('checksum-mismatch', { name })
  }
  return {
    ok: true,
    version: manifest.version,
    zipSha256: manifest.zipSha256,
    tarballSha256: manifest.tarballSha256,
    builtFromCommit: typeof manifest.builtFromCommit === 'string' ? manifest.builtFromCommit : '',
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// ─── CLI(与 workflow 调用形态逐字对应) ─────────────────────────────────────
function usage() {
  console.error('usage: cws-publish-validate.mjs <token|upload|publish> --http-code <n> [--file <path>] [--field access_token]')
  console.error('       cws-publish-validate.mjs artifact --dir <dir> --expect-version <version>')
}

function emit(result) {
  if (result.ok) {
    console.log(JSON.stringify(result))
    return 0
  }
  console.error(JSON.stringify(result))
  return 1
}

function usageExit() {
  usage()
  return 2
}

export function main(argv) {
  const [sub, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]
    if (!key.startsWith('--') || i + 1 >= rest.length) return usageExit()
    flags[key.slice(2)] = rest[i + 1]
  }

  if (sub === 'artifact') {
    if (!flags.dir || !flags['expect-version']) return usageExit()
    return emit(validateArtifactDir({ dir: flags.dir, expectVersion: flags['expect-version'] }))
  }
  if (sub !== 'token' && sub !== 'upload' && sub !== 'publish') return usageExit()
  if (flags.http_code === undefined && flags['http-code'] === undefined) return usageExit()
  const httpCode = Number(flags.http_code ?? flags['http-code'])
  if (!Number.isInteger(httpCode)) return usageExit()
  const classify = sub === 'token' ? classifyTokenResponse : sub === 'upload' ? classifyUploadResponse : classifyPublishResponse

  let body = ''
  if (flags.file) {
    if (!isFile(flags.file)) return usageExit()
    body = readFileSync(flags.file, 'utf8')
  } else {
    body = readFileSync(0, 'utf8')
  }
  // 2xx 之外直接拒绝;失败输出只含固定分类 + HTTP 码,响应体不落日志(机密纪律)
  if (httpCode < 200 || httpCode > 299) {
    return emit(fail('http-status', { httpCode }))
  }
  const result = classify(body)
  if (sub === 'publish' && result.reason === 'publish-already-pending-review') {
    // 固定安全指引(本文件字面量,非 API 文本):先读回 item 状态,勿盲目重提
    console.error('cws-publish-validate: a previous submission may already be in review — read back the item state before any retry; do not resubmit blindly')
  }
  if (sub === 'token' && result.ok && flags.field === 'access_token') {
    // token 的唯一出口:成功提取本值(单行无空白),workflow 立即 ::add-mask::
    console.log(parseJsonOr(body).access_token)
    return 0
  }
  return emit(result)
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
