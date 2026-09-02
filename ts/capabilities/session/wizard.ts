/**
 * 会话扩展 onboarding wizard(RFC user-session-data-rfc.md §3.3,ADR-21 上架后重设)。
 *
 * 单一职责(2026-09-02 重设):**只做 Node 端两件事**——
 *   ① 扩展文件从源落位到 `~/.gotry/extension`(幂等)
 *   ② source/dest 静态预检 + manifest.key 校验(给 health-watch 前的快照)
 *
 * 浏览器商店安装是浏览器的事,dsh 渲染 verdict.installUrl 是 dsh UI 的事;
 * gotry **不再**弹 GUI 面板(pbcopy/osascript/zenity/msg)、不再 open 浏览器、
 * 不再写一墙文字 CLI 指引。任何"装到能用"的 UX 都由浏览器商店 + dsh UI 分担。
 *
 * 历史形态回顾:
 * - 2026-08-30 初版:5 步编排 + 剪贴板 + GUI 面板 + 健康探活(全栈闭环初衷好,但越界管了浏览器)
 * - 2026-09-02 上架后:缩为 2 步(ensure + watch precheck),纯 Node 职责
 *
 * 接口契约:
 * - `runOnboardingWizard({ dryRun, extensionDir?, sourceDir? })` 返回 2 步 OnboardingResult
 * - `defaultExtensionDir()` / `describeExtensionDir()` 留作公开工具
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OnboardingStep {
  step: 'ensure-extension-files' | 'watch-extension-ready'
  status: 'ok' | 'skip' | 'fail'
  summary: string
}

export interface OnboardingOptions {
  /** 零网络零浏览器;只校验命令编排与输出形态;run-all §40 必走 */
  dryRun?: boolean
  /** 扩展落位目录(默认 ~/.gotry/extension) */
  extensionDir?: string
  /** 源扩展目录(默认仓库 ./extension/,随 npm 装入 dist/extension) */
  sourceDir?: string
}

export interface OnboardingResult {
  ok: boolean
  steps: OnboardingStep[]
  extensionDir: string
}

const DEFAULT_SOURCE_DIR_CANDIDATES = [
  join(process.cwd(), 'extension'),
  join(process.cwd(), 'dist', 'extension'),
  join(process.cwd(), 'ts', '..', 'extension'),
]

function resolveExtensionSourceDir(): string {
  for (const candidate of DEFAULT_SOURCE_DIR_CANDIDATES) {
    if (existsSync(join(candidate, 'manifest.json'))) return candidate
  }
  return DEFAULT_SOURCE_DIR_CANDIDATES[0]!
}

export function defaultExtensionDir(): string {
  return join(homedir(), '.gotry', 'extension')
}

/** 落位扩展文件(幂等);缺源/源不全会 fail-soft,提示用户重跑 `gotry setup` */
function ensureExtensionFiles(source: string, target: string, dryRun: boolean): OnboardingStep {
  if (dryRun) return { step: 'ensure-extension-files', status: 'skip', summary: '[dry-run] skip 扩展落位' }
  try {
    if (!existsSync(source) || !existsSync(join(source, 'manifest.json'))) {
      return { step: 'ensure-extension-files', status: 'fail', summary: `源扩展目录缺失 manifest.json: ${source}(先跑 npx gotry setup 落位)` }
    }
    mkdirSync(target, { recursive: true })
    const required = ['manifest.json', 'background.js', 'content-main.js', 'content-bridge.js']
    for (const f of required) {
      const src = join(source, f)
      if (!existsSync(src)) return { step: 'ensure-extension-files', status: 'fail', summary: `源扩展缺 ${f}(重新 npm install 或 gotry setup)` }
      copyFileSync(src, join(target, f))
    }
    return { step: 'ensure-extension-files', status: 'ok', summary: `扩展已落位 ${target}(manifest+3 文件)` }
  } catch (e) {
    return { step: 'ensure-extension-files', status: 'fail', summary: `扩展落位失败: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` }
  }
}

/** 静态预检:落位目录可见 + manifest.key 存在(扩展 ID 稳定)+ 源未新于 dest */
async function watchExtensionReady(dryRun: boolean, sourceDir: string, extensionDir: string): Promise<OnboardingStep> {
  if (dryRun) return { step: 'watch-extension-ready', status: 'skip', summary: '[dry-run] skip health-watch precheck' }
  if (!existsSync(extensionDir) || !existsSync(join(extensionDir, 'manifest.json'))) {
    return { step: 'watch-extension-ready', status: 'fail', summary: `落位缺失 manifest.json:${extensionDir}` }
  }
  try {
    const srcStat = statSync(sourceDir)
    const dstStat = statSync(extensionDir)
    if (srcStat.mtimeMs > dstStat.mtimeMs) {
      return { step: 'watch-extension-ready', status: 'fail', summary: `扩展文件可能过期(源比落位新);重跑 npx gotry setup` }
    }
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(extensionDir, 'manifest.json'), 'utf8'))
    if (typeof manifest.key !== 'string' || manifest.key.length < 100) {
      return { step: 'watch-extension-ready', status: 'fail', summary: 'manifest.key 缺失或过短,扩展 ID 不能稳定' }
    }
  } catch (e) {
    return { step: 'watch-extension-ready', status: 'fail', summary: `静态预检失败: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` }
  }
  return { step: 'watch-extension-ready', status: 'ok', summary: '扩展文件就绪(manifest.key 校验通过,后台轮询就绪态由 health-watch 接管)' }
}

/**
 * 主入口(2 步):①扩展落位 ②watch precheck 静态预检。
 * 真 health-watch 由 health-watch.ts 单独负责,不并入 wizard。
 */
export async function runOnboardingWizard(opts: OnboardingOptions = {}): Promise<OnboardingResult> {
  const dryRun = opts.dryRun ?? false
  const extensionDir = opts.extensionDir ?? defaultExtensionDir()
  const sourceDir = opts.sourceDir ?? resolveExtensionSourceDir()

  const steps: OnboardingStep[] = []
  steps.push(ensureExtensionFiles(sourceDir, extensionDir, dryRun))
  steps.push(await watchExtensionReady(dryRun, sourceDir, extensionDir))

  const ok = steps.every((s) => s.status !== 'fail')
  return { ok, steps, extensionDir }
}

/** stdout 人话化打印(给 bootstrap 子进程单行 JSON 输出之外的兜底形态) */
export function printWizardResult(result: OnboardingResult, destination: NodeJS.WritableStream = process.stdout): void {
  const tag = (s: OnboardingStep): string => {
    if (s.status === 'ok') return '✅'
    if (s.status === 'skip') return '⏭ '
    return '❌'
  }
  for (const s of result.steps) {
    destination.write(`${tag(s)} ${s.step}: ${s.summary}\n`)
  }
  destination.write(`extensionDir=${result.extensionDir}; overall=${result.ok ? 'ok' : 'has-failures'}\n`)
}

/** 公开诊断探针(bootstrap 报告用) */
export function describeExtensionDir(extensionDir: string): { exists: boolean; fileCount: number; hasManifest: boolean } {
  if (!existsSync(extensionDir)) return { exists: false, fileCount: 0, hasManifest: false }
  const files = readdirSync(extensionDir)
  return { exists: true, fileCount: files.length, hasManifest: files.includes('manifest.json') }
}
