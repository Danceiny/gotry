/**
 * 会话扩展 onboarding wizard(issue #21 onboarding UX,P3.6 gotry-session-onboarding-goal,
 * RFC user-session-data-rfc.md §3.3)。
 *
 * 单一职责:**编排** 4 步闭环(扩展落位→打开 chrome://extensions→剪贴板复制→后台 health-watch) +
 * 跨平台降级(macOS osascript / Linux zenity / Windows msg / headless 终端)。
 * 不实现任何 cookie 值读取、不发起任何写入操作、不引 GUI 包。
 *
 * 形态:
 * - `runOnboardingWizard({ dryRun, openBrowser, clipboard, panel })` 返回步骤结果数组;
 * - 每步 `{step, status: 'ok'|'skip'|'fail', summary}`;终端 stdout 顺序打印;
 * - 失败步不挡退出(exit 0;失败信息人话化,不抛栈)。
 *
 * 跨平台策略:
 * - macOS:`osascript -e 'tell application "Google Chrome" to open location "chrome://extensions"'`
 *   + `pbcopy <path>`;有 Cocoa 引导面板(`osascript -e 'display dialog ...'`)。
 * - Linux:`xdg-open chrome://extensions`(浏览器由系统默认) + `xclip -selection clipboard`;
 *   有 `zenity --info --text=...` 面板(无 zenity 降 terminal)。
 * - Windows:`start chrome chrome://extensions` + `clip`;无 panel,降 terminal。
 * - Headless(SSH / CI):terminal 面板 + 跳过所有 GUI 调用。
 *
 * 不引入 npm 包:osascript/zenity/pbcopy/xclip/clip/start/xdg-open 走 child_process.spawn,
 * 失败降级 stdout,不挡主流程(run-all §40 onboarding-tests 4 断言覆盖跨平台降级)。
 *
 * 输出形态:`runOnboardingWizard` 是纯编排,**不直接抓 Chrome 状态**——
 * 健康检查由 health-watch.ts 接管(单独测试覆盖)。Wizard 只负责「把人引到 Chrome 前」,
 * watch 负责「等 Chrome 真的就绪」。
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export interface OnboardingStep {
  step: 'ensure-extension-files' | 'open-chrome-extensions' | 'clipboard-extension-path' | 'watch-extension-ready' | 'panel-guide'
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
  /** 覆盖平台探测(headless 测试) */
  forcePlatform?: 'darwin' | 'linux' | 'win32' | 'headless'
  /** 注入 spawn(测试可拦截命令执行);签名同 child_process.spawn,默认 spawn */
  spawn?: typeof spawn
}

export interface OnboardingResult {
  ok: boolean
  steps: OnboardingStep[]
  platform: 'darwin' | 'linux' | 'win32' | 'headless'
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

function detectPlatform(force?: OnboardingOptions['forcePlatform']): 'darwin' | 'linux' | 'win32' | 'headless' {
  if (force) return force
  if (process.env.GOTRY_ONBOARDING_HEADLESS === '1') return 'headless'
  const p = platform()
  if (p === 'darwin' || p === 'linux' || p === 'win32') {
    if (p !== 'darwin' && !process.env.DISPLAY) return 'headless'
    return p
  }
  return 'headless'
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

/** 打开 chrome://extensions;失败降级提示用户手开 */
function openChromeExtensions(sp: typeof spawn, plat: 'darwin' | 'linux' | 'win32' | 'headless', dryRun: boolean): OnboardingStep {
  if (dryRun) return { step: 'open-chrome-extensions', status: 'skip', summary: '[dry-run] skip 打开 chrome://extensions' }
  if (plat === 'headless') return { step: 'open-chrome-extensions', status: 'skip', summary: 'headless 环境跳过 GUI;请在你桌面 Chrome 手动打开 chrome://extensions' }
  const cmd = (() => {
    if (plat === 'darwin') return { bin: 'open', args: ['-a', 'Google Chrome', 'chrome://extensions'] }
    if (plat === 'linux') return { bin: 'xdg-open', args: ['chrome://extensions'] }
    return { bin: 'cmd', args: ['/c', 'start', 'chrome', 'chrome://extensions'] }
  })()
  try {
    const child = sp(cmd.bin, cmd.args, { detached: true, stdio: 'ignore' })
    child.unref?.()
    return { step: 'open-chrome-extensions', status: 'ok', summary: `已打开 chrome://extensions(${plat})` }
  } catch (e) {
    return { step: 'open-chrome-extensions', status: 'fail', summary: `自动打开失败: ${e instanceof Error ? e.message.slice(0, 80) : String(e)};请手开 chrome://extensions` }
  }
}

/** 复制扩展目录路径到剪贴板;失败降级 stdout */
async function clipboardExtensionPath(sp: typeof spawn, plat: 'darwin' | 'linux' | 'win32' | 'headless', path: string, dryRun: boolean): Promise<OnboardingStep> {
  if (dryRun) return { step: 'clipboard-extension-path', status: 'skip', summary: '[dry-run] skip 剪贴板复制' }
  if (plat === 'headless') return { step: 'clipboard-extension-path', status: 'skip', summary: `headless 无剪贴板;扩展目录路径:${path}` }
  const cmd = (() => {
    if (plat === 'darwin') return { bin: 'pbcopy', args: [] as string[] }
    if (plat === 'linux') return { bin: 'xclip', args: ['-selection', 'clipboard'] }
    return { bin: 'clip', args: [] as string[] }
  })()
  // 关键:pbcopy/xclip/clip 都在 stdin EOF 之后才提交内容,stdin 必须 pipe,
  // 且必须 await exit(否则 end() 还在 buffer 里就被当作「完成」)。
  // 之前用 stdio: 'inherit' → stdin 是 null → write 没生效 → 用户剪贴板没被覆盖。
  return new Promise<OnboardingStep>((resolveStep) => {
    let child: ReturnType<typeof spawn>
    try {
      child = sp(cmd.bin, cmd.args, { stdio: ['pipe', 'ignore', 'ignore'] }) as unknown as ReturnType<typeof spawn>
    } catch {
      resolveStep({ step: 'clipboard-extension-path', status: 'skip', summary: `剪贴板工具不可用(${cmd.bin});扩展目录路径手动复制: ${path}` })
      return
    }
    let settled = false
    const settle = (s: OnboardingStep): void => {
      if (settled) return
      settled = true
      resolveStep(s)
    }
    child.on('error', () => settle({ step: 'clipboard-extension-path', status: 'skip', summary: `剪贴板工具启动失败(${cmd.bin});扩展目录路径手动复制: ${path}` }))
    child.on('exit', (code) => {
      if (code === 0) settle({ step: 'clipboard-extension-path', status: 'ok', summary: `已复制扩展目录到剪贴板: ${path}` })
      else settle({ step: 'clipboard-extension-path', status: 'fail', summary: `剪贴板工具退出码 ${code}(${cmd.bin});扩展目录路径手动复制: ${path}` })
    })
    try {
      child.stdin?.write(path)
      child.stdin?.end()
    } catch {
      settle({ step: 'clipboard-extension-path', status: 'skip', summary: `剪贴板工具 stdin 不可写(${cmd.bin});扩展目录路径手动复制: ${path}` })
    }
  })
}

/** 终端面板 stdout(无 GUI 时唯一形态);headless / GUI 不可用时使用 */
function panelGuideTerminal(plat: 'darwin' | 'linux' | 'win32' | 'headless', extensionDir: string, watchMs: number): OnboardingStep {
  const lines = [
    '┌─ GoTry 扩展安装 ─────────────────────────────────┐',
    '│  共 3 步,约 30 秒,装完零弹窗                     │',
    '│                                                   │',
    '│  ① 在 Chrome 右上角开启「开发者模式」             │',
    `│  ② 点「加载已解压的扩展程序」选这个目录(已复制):  │`,
    `│     ${extensionDir}`,
    '│  ③ 弹窗「添加扩展」点「添加」                    │',
    `│                                                   │`,
    `│  后台探活中(最长 ${Math.round(watchMs / 1000)}s)…         │`,
    '└───────────────────────────────────────────────────┘',
  ]
  // headless = 纯文本面板;darwin/linux/win32 在 GUI 面板不可用时也走这路
  if (plat === 'headless') {
    process.stdout.write(lines.join('\n') + '\n')
    return { step: 'panel-guide', status: 'skip', summary: 'headless 终端面板已打印' }
  }
  process.stdout.write(lines.join('\n') + '\n')
  return { step: 'panel-guide', status: 'skip', summary: '终端面板已打印(GUI 面板降级)' }
}

/** GUI 面板(Cocoa / zenity / msg);失败降 terminal */
function panelGuideGui(sp: typeof spawn, plat: 'darwin' | 'linux' | 'win32' | 'headless', extensionDir: string, dryRun: boolean): OnboardingStep {
  if (dryRun) return { step: 'panel-guide', status: 'skip', summary: '[dry-run] skip GUI 面板' }
  if (plat === 'headless') return panelGuideTerminal(plat, extensionDir, 120_000)
  const message = `在 Chrome 右上角开启「开发者模式」 → 点「加载已解压的扩展程序」 → 选择(已复制):${extensionDir} → 弹窗点「添加扩展」`
  try {
    if (plat === 'darwin') {
      const script = `display dialog "${message.replace(/"/g, '\\"')}" with title "GoTry 扩展安装" buttons {"我装好了"} default button 1`
      sp('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref?.()
      return { step: 'panel-guide', status: 'ok', summary: '已弹 macOS Cocoa 引导面板' }
    }
    if (plat === 'linux') {
      const child = sp('zenity', ['--info', '--title=GoTry 扩展安装', `--text=${message}`], { stdio: 'ignore', detached: true })
      child.unref?.()
      child.on('error', () => {
        process.stdout.write(`(zenity 不可用,走终端面板)扩展目录: ${extensionDir}\n`)
      })
      return { step: 'panel-guide', status: 'ok', summary: '已弹 zenity 引导面板' }
    }
    // Windows:无原生 msg 面板,降终端
    return panelGuideTerminal(plat, extensionDir, 120_000)
  } catch (e) {
    return panelGuideTerminal(plat, extensionDir, 120_000)
  }
}

/** 探活:留给 health-watch.ts,这里只打日志;集成在 main runner 时再调 */
async function watchExtensionReady(dryRun: boolean, sourceDir: string, extensionDir: string): Promise<OnboardingStep> {
  if (dryRun) return { step: 'watch-extension-ready', status: 'skip', summary: '[dry-run] skip health-watch' }
  // 真实集成由 cli/wizard runner 接管(避免 wizard 模块 import health-watch 形成环);
  // 这里只校验源文件齐全 + 落位目录可见
  if (!existsSync(extensionDir) || !existsSync(join(extensionDir, 'manifest.json'))) {
    return { step: 'watch-extension-ready', status: 'fail', summary: `落位缺失 manifest.json:${extensionDir}` }
  }
  const srcStat = statSync(sourceDir)
  const dstStat = statSync(extensionDir)
  if (srcStat.mtimeMs > dstStat.mtimeMs) {
    return { step: 'watch-extension-ready', status: 'fail', summary: `扩展文件可能过期(源比落位新);重跑 npx gotry setup` }
  }
  // 读 manifest 校验 key 存在(=扩展 ID 稳定)
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(extensionDir, 'manifest.json'), 'utf8'))
  if (typeof manifest.key !== 'string' || manifest.key.length < 100) {
    return { step: 'watch-extension-ready', status: 'fail', summary: 'manifest.key 缺失或过短,扩展 ID 不能稳定' }
  }
  return { step: 'watch-extension-ready', status: 'ok', summary: '扩展文件就绪(manifest.key 校验通过,后台轮询就绪态由 health-watch 接管)' }
}

/**
 * 主入口:wizard 编排 5 步闭环(ensure→open→clipboard→panel→watch-precheck)。
 * 真实 health-watch 由 cli runner 在面板按下「我装好了」后启,本函数只做静态预检。
 */
export async function runOnboardingWizard(opts: OnboardingOptions = {}): Promise<OnboardingResult> {
  const sp = opts.spawn ?? spawn
  const dryRun = opts.dryRun ?? false
  const plat = detectPlatform(opts.forcePlatform)
  const extensionDir = opts.extensionDir ?? defaultExtensionDir()
  const sourceDir = opts.sourceDir ?? resolveExtensionSourceDir()

  const steps: OnboardingStep[] = []
  steps.push(ensureExtensionFiles(sourceDir, extensionDir, dryRun))
  steps.push(openChromeExtensions(sp, plat, dryRun))
  if (plat !== 'headless') {
    steps.push(await clipboardExtensionPath(sp, plat, extensionDir, dryRun))
    steps.push(panelGuideGui(sp, plat, extensionDir, dryRun))
  } else {
    steps.push({ step: 'clipboard-extension-path', status: 'skip', summary: 'headless 跳过剪贴板' })
    steps.push(panelGuideTerminal(plat, extensionDir, 120_000))
  }
  steps.push(await watchExtensionReady(dryRun, sourceDir, extensionDir))

  const ok = steps.every((s) => s.status !== 'fail')
  return { ok, steps, platform: plat, extensionDir }
}

/** stdout 人话化打印(默认终端面板形态);测试可禁用 */
export function printWizardResult(result: OnboardingResult, destination: NodeJS.WritableStream = process.stdout): void {
  const tag = (s: OnboardingStep): string => {
    if (s.status === 'ok') return '✅'
    if (s.status === 'skip') return '⏭ '
    return '❌'
  }
  for (const s of result.steps) {
    destination.write(`${tag(s)} ${s.step}: ${s.summary}\n`)
  }
  destination.write(`platform=${result.platform}; extensionDir=${result.extensionDir}; overall=${result.ok ? 'ok' : 'has-failures'}\n`)
}

/** 留作 onboard final summary 的只读探针(便于 cli 输出「已就绪 / 待装」) */
export function describeExtensionDir(extensionDir: string): { exists: boolean; fileCount: number; hasManifest: boolean } {
  if (!existsSync(extensionDir)) return { exists: false, fileCount: 0, hasManifest: false }
  const files = readdirSync(extensionDir)
  return { exists: true, fileCount: files.length, hasManifest: files.includes('manifest.json') }
}
