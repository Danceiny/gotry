#!/usr/bin/env node
/**
 * 扩展发布产物打包(ADR-21 分发通道 A;founder 确认制:本脚本只产产物,不做任何上传/发布)。
 *
 * 产物(dist-extension/,稳定资产名——latest/download 永久链只认稳定名,每版覆盖同名上传):
 *   gotry-session-bridge.tar.gz        gotry setup --extension-from=github 的下载/校验/解压对象
 *   gotry-session-bridge-store.zip     Chrome Web Store 上架用(商店后台只收 zip)
 *   extension-dist-manifest.json       版本 + 双产物 SHA256(+builtFromCommit 溯源)
 *
 * 资产名与 ts/capabilities/session/extension-distribution.ts 的 DIST_ASSET_* 必须逐字一致
 * (extension-distribution-tests 读本文件源码防漂移)。
 *
 * 依赖:平台 tar(必在);zip(打包机需要——macOS/Linux 自带,缺则明确报错)。
 * 产出的上传步骤(founder 确认后执行):gh release create/upload 到 Danceiny/gotry,
 * 三个文件同 Release 上传,tag 建议与扩展 version 对齐(ext-v0.1.0)。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'extension')
const OUT = join(root, 'dist-extension')

const ASSET_TARBALL = 'gotry-session-bridge.tar.gz'
const ASSET_STORE_ZIP = 'gotry-session-bridge-store.zip'
const ASSET_MANIFEST = 'extension-dist-manifest.json'

const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'))
const version = manifest.version

function must(cmd, args, what, cwd = root) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', cwd })
  } catch (e) {
    console.error(`✗ ${what}失败:${e.message}
   tar 为平台自带;zip 在 macOS/Linux 通常预装(缺则 brew/apt install zip);Windows 打包机建议在 WSL 跑本脚本。`)
    process.exit(1)
  }
}

// 先清后建(陈旧产物不随新包混入——同 build-dist 纪律)
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// 打包根目录名固定 gotry-session-bridge/(下载端 --strip-components 1 依赖此约定)
const STAGE = join(OUT, 'gotry-session-bridge')
mkdirSync(STAGE, { recursive: true })
for (const f of ['manifest.json', 'background.js', 'content-main.js', 'content-bridge.js', 'README.md']) {
  cpSync(join(SRC, f), join(STAGE, f))
}

must('tar', ['-czf', join(OUT, ASSET_TARBALL), '-C', OUT, 'gotry-session-bridge'], 'tar.gz 打包')
// store zip:manifest 必须在 zip 根(Chrome Web Store 上传要求);tar.gz 才带顶层目录约定
must('zip', ['-r', '-q', join(OUT, ASSET_STORE_ZIP), '.'], 'store zip 打包', STAGE)

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
let commit = ''
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root }).trim()
} catch {
  /* 非 git 环境留空 */
}

const distManifest = {
  version,
  tarball: ASSET_TARBALL,
  tarballSha256: sha256(join(OUT, ASSET_TARBALL)),
  zip: ASSET_STORE_ZIP,
  zipSha256: sha256(join(OUT, ASSET_STORE_ZIP)),
  builtFromCommit: commit,
}
writeFileSync(join(OUT, ASSET_MANIFEST), `${JSON.stringify(distManifest, null, 2)}\n`)
rmSync(STAGE, { recursive: true, force: true })

console.log(`extension dist v${version} → dist-extension/`)
console.log(`  ${ASSET_TARBALL}      ${distManifest.tarballSha256.slice(0, 16)}…`)
console.log(`  ${ASSET_STORE_ZIP}  ${distManifest.zipSha256.slice(0, 16)}…`)
console.log(`  ${ASSET_MANIFEST}`)
console.log('上传(founder 确认后):三个文件同 Release(tag 建议 ext-v' + version + '),稳定资产名覆盖式上传。')
