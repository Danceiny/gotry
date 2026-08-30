#!/usr/bin/env node
/**
 * gotry 外部依赖自举(founder 2026-08-29 指令:安装 gotry 时按上游本身的方式装好外部依赖):
 *   hbcli(hotelbyte-cli)  → 官方 install.sh(原生二进制,~/.local/bin/hbcli)
 *   agent-reach            → 官方 pip 安装 git+ upstream(包内 .venv,与 z3-solver 同址原则)
 *   flyai                  → 无需安装(npx 每次自拉 @fly-ai/flyai-cli)
 *   dsh-better-sidebar     → dsh 宿主层插件市场组件(dshmarket.com #1 UI,18.9 万周装):
 *                           dsh web 侧栏工作台(文件浏览/Markdown/Mermaid/PDF 预览)——
 *                           gotry 产物(工单交付 md/行程 md)的成熟查看面(issue #25)。
 *                           宿主层安装(dsh plugin → ~/.dsh/profiles/web),不进 gotry 依赖。
 *   gotry-session-bridge   → 会话检索浏览器扩展(issue #21 传输层方案 C,2026-08-29 定案):
 *                           一次性安装替代逐连接 CDP 弹窗;幂等拷贝到 ~/.gotry/extension,
 *                           最后一步是用户在 chrome://extensions 「加载已解压的扩展程序」(约 30 秒,零系统弹窗)。
 *
 * 用法:
 *   node bin/gotry-bootstrap.js              # 显式安装(缺啥装啥;失败 exit 1)
 *   node bin/gotry-bootstrap.js --auto       # postinstall 模式:CI/跳过开关检测,任何失败不挡安装(exit 0)
 *   node bin/gotry-bootstrap.js --check-only # 只探测报告,不安装(测试钩子)
 *   node bin/gotry-bootstrap.js --extension-from=github
 *                                           # 扩展改走 GitHub Releases 下载通道(ADR-21):
 *                                           #   dist-manifest → tar.gz → SHA256 → key 钉扎 → 原子交换;
 *                                           #   任何失败显式降级回包内副本(离线确定性不变)。
 *   node bin/gotry-bootstrap.js wizard       # 会话扩展 onboarding 闭环(issue #21 onboarding UX,§3.3):
 *                                           #   5 步编排 + 后台 health-watch 等扩展心跳,
 *                                           #   扩展一就位 stdout 翻绿并自动重放同 query。
 *                                           # 详见 docs/user-session-data-rfc.md §3.3 / RFC P3.6。
 *
 * 环境开关:
 *   GOTRY_SETUP_SKIP=1            全部跳过
 *   GOTRY_SETUP_HBCLI=0           跳过 hbcli
 *   GOTRY_SETUP_REACH=0           跳过 agent-reach
 *   GOTRY_SETUP_SIDEBAR=0         跳过 dsh-better-sidebar
 *   GOTRY_SETUP_EXTENSION=0       跳过会话检索扩展落位
 *   GOTRY_EXTENSION_SOURCE=github 等效 --extension-from=github(显式 opt-in,默认 bundled)
 *   GOTRY_EXTENSION_RELEASE_BASE=<url> 下载通道基址覆盖(镜像/测试;缺省 GitHub 官方)
 *   GOTRY_ONBOARDING_HEADLESS=1   wizard 子命令强制走终端面板(SSH/CI 默认探测)
 *
 * 契约:安装外部依赖永远不挡 gotry 本体——能力层各有降级路径(静态包/not-installed
 * verdict),自举失败只降级体验,不产生故障。凭证(hbcli auth / agent-reach 渠道
 * cookie)属用户资产,不自动配置,装完二进制后给指引。
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const AUTO = process.argv.includes('--auto')
const CHECK_ONLY = process.argv.includes('--check-only')
const WIZARD = process.argv.includes('wizard') || process.argv.includes('--wizard')
const WIZARD_DRY_RUN = process.argv.includes('--dry-run')
// 扩展分发源(ADR-21):默认 bundled(包内副本,离线确定性);github 显式 opt-in
// (镜像 GOTRY_SESSION_TRANSPORT=cdp 的显式 opt-in 文化——不静默引入网络依赖)
const EXT_FROM_ARG = (process.argv.find((a) => a.startsWith('--extension-from=')) ?? '').split('=')[1]
const EXTENSION_FROM = EXT_FROM_ARG === 'github' || EXT_FROM_ARG === 'bundled' ? EXT_FROM_ARG : process.env.GOTRY_EXTENSION_SOURCE === 'github' ? 'github' : 'bundled'

const HBCLI_INSTALL_CMD = 'curl -fsSL https://github.com/hotelbyte-com/docs/releases/latest/download/install.sh | bash'
const REACH_INSTALL_URL = 'git+https://github.com/Panniantong/Agent-Reach.git'

/** 带超时的子进程(inherit stdio 让用户看见上游安装进度) */
function run(cmd, args, { timeoutMs, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd, env: process.env })
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL') } catch { /* ignore */ } }
    }, timeoutMs)
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: e.message }) } })
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: code === 0, error: code === 0 ? undefined : `exit ${code}` }) } })
  })
}

/** 静默探测命令是否可执行(带超时) */
function probe(cmd, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL') } catch { /* ignore */ } resolve(false) } }, timeoutMs)
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(false) } })
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(timer); resolve(code === 0) } })
  })
}

const say = (s) => console.log(s)

async function setupHbcli() {
  say('[gotry-setup] hbcli(hotelbyte-cli,可选酒店实时源)')
  const candidates = ['hbcli', join(homedir(), '.local/bin/hbcli'), join(homedir(), '.staicli/current/hbcli')]
  const present = candidates.some((p) => existsSync(p)) && (await probe(candidates[0], ['version']) || await probe(candidates[1], ['version']) || await probe(candidates[2], ['version']))
  const credFile = join(homedir(), '.staicli', 'credentials.json')
  if (present) {
    say('  ✓ 已安装')
    if (existsSync(credFile)) say('  ✓ 凭证已配置(自检: hbcli auth whoami)')
    else say('  ✗ 凭证未配置——酒店检索将用内置静态包(非实时),账号配置见下方指引')
    if (CHECK_ONLY) say('  (--check-only 只报告,不安装)')
    return { ok: true }
  }
  if (CHECK_ONLY) { say('  ✗ 未安装(--check-only 只报告)'); return { ok: true } }
  say(`  安装中(官方脚本): ${HBCLI_INSTALL_CMD}`)
  const r = await run('bash', ['-c', HBCLI_INSTALL_CMD], { timeoutMs: 120_000 })
  if (!r.ok) { say(`  ✗ 安装失败(${r.error})——不影响 gotry,酒店检索将用内置静态包;可稍后重试: npx gotry setup`); return { ok: false } }
  const binDir = join(homedir(), '.local/bin')
  if (!process.env.PATH.split(':').includes(binDir)) {
    say(`  ⚠ ${binDir} 不在当前 PATH —— gotry 工具已内建候选路径回退,无需手动处理;其他程序可用: export PATH="${binDir}:$PATH"`)
  }
  say('  ✓ 安装完成——账号配置(未配时酒店检索自动用静态包,非实时):')
  say('    · 快速试用(官方沙箱演示账号): hbcli auth set-credentials --app-key hotelbyte_api_demo --app-secret hotelbyte_api_demo')
  say('    · 正式接入: 向 HotelByte 申请专属 appKey/appSecret 后用同一命令替换')
  say('    · 门户账号(权限更大,酒店搜索无必要): hbcli auth login --username <email>')
  say('  自检: hbcli auth whoami(api_key.configured=true 即就位)')
  return { ok: true }
}

async function setupReach() {
  say('[gotry-setup] agent-reach(可选网页/社媒读取源,pip 装入包内 .venv)')
  const venvBin = join(repoRoot, '.venv/bin/agent-reach')
  if (existsSync(venvBin)) { say('  ✓ 已安装(.venv)'); return { ok: true } }
  if (CHECK_ONLY) { say('  ✗ 未安装(--check-only 只报告)'); return { ok: true } }
  const hasPy = await probe('python3', ['--version'], 10_000)
  if (!hasPy) { say('  ✗ 跳过:未找到 python3(agent-reach 需 Python 3;装好后重跑 npx gotry setup)'); return { ok: false } }
  say(`  创建 .venv 并安装上游(${REACH_INSTALL_URL})`)
  const venv = await run('python3', ['-m', 'venv', join(repoRoot, '.venv')], { timeoutMs: 120_000 })
  if (!venv.ok) { say(`  ✗ venv 创建失败(${venv.error})——不影响 gotry,gotry_agent_reach 将返回 not-installed 指引`); return { ok: false } }
  const pip = join(repoRoot, '.venv/bin/pip')
  const inst = await run(pip, ['install', '-q', REACH_INSTALL_URL], { timeoutMs: 300_000 })
  if (!inst.ok) { say(`  ✗ pip 安装失败(${inst.error})——可稍后重试: npx gotry setup`); return { ok: false } }
  say('  ✓ 安装完成(渠道凭证选配见 docs/tokens.md: .venv/bin/agent-reach configure --from-browser chrome --platform <渠道>)')
  return { ok: true }
}

async function setupSidebar() {  say('[gotry-setup] dsh-better-sidebar(dsh web 侧栏工作台,产物查看面 issue #25)')
  const installed = existsSync(join(homedir(), '.dsh/profiles/web/node_modules/dsh-better-sidebar/package.json'))
  if (installed) { say('  ✓ 已安装(~/.dsh/profiles/web)'); return { ok: true } }
  if (CHECK_ONLY) { say('  ✗ 未安装(--check-only 只报告)'); return { ok: true } }
  const SIDEBAR_PKG = 'dsh-better-sidebar@latest'
  // dsh CLI:本包依赖里的 @deepseek-ai/dsh 优先;解析不到走 npx 自拉(官方安装途径同款)
  const { createRequire } = await import('node:module')
  const require_ = createRequire(join(repoRoot, 'package.json'))
  let launched = false
  try {
    const dshBin = require_.resolve('@deepseek-ai/dsh/lib/bin.js')
    say(`  安装中(dsh plugin → web profile): ${SIDEBAR_PKG}`)
    const r = await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', SIDEBAR_PKG], { timeoutMs: 300_000 })
    launched = true
    if (r.ok) {
      say('  ✓ 安装完成(gotry web 刷新浏览器即见右侧工作台;工作区里的产物 md 可直接预览)')
      return { ok: true }
    }
    say(`  ✗ dsh plugin 安装失败(${r.error})——尝试 npx 途径`)
  } catch { /* 本包未携带 @deepseek-ai/dsh */ }
  if (!launched) say('  本包未携带 @deepseek-ai/dsh,走 npx 途径安装')
  const r2 = await run('npx', ['-y', '--package', '@deepseek-ai/dsh', 'dsh', 'plugin', '--profile', 'web', 'add', SIDEBAR_PKG], { timeoutMs: 300_000 })
  if (!r2.ok) {
    say('  ✗ 安装失败——不影响 gotry:产物仍可在对话里说「看看我生成的行程」经 gotry_artifacts_list/read 查看;可稍后重试: npx gotry setup')
    return { ok: false }
  }
  say('  ✓ 安装完成(gotry web 刷新浏览器即见右侧工作台)')
  return { ok: true }
}

const EXTENSION_FILES = ['manifest.json', 'background.js', 'content-main.js', 'content-bridge.js', 'README.md']

function readManifestVersion(manifestPath) {
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')).version ?? null } catch { return null }
}

function copyExtensionDir(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true })
  for (const f of EXTENSION_FILES) {
    const s = join(srcDir, f)
    if (!existsSync(s)) continue
    copyFileSync(s, join(dstDir, f))
  }
}

/** 会话检索扩展(issue #21 方案 C):包内 extension/ → ~/.gotry/extension 幂等落位 + 一次性加载指引 */
async function setupExtension() {
  say('[gotry-setup] GoTry Session Bridge 扩展(会话检索数据面 issue #21;一次性安装,替代逐连接弹窗)')
  const srcDir = join(repoRoot, 'extension')
  const srcManifest = join(srcDir, 'manifest.json')
  if (!existsSync(srcManifest)) {
    say(`  ✗ 包内未找到扩展文件(${srcDir})——不影响 gotry:会话检索降级,重装 npx gotry 可恢复`)
    return { ok: false }
  }
  const srcVersion = readManifestVersion(srcManifest)
  const dstDir = join(homedir(), '.gotry', 'extension')
  const dstVersion = readManifestVersion(join(dstDir, 'manifest.json'))
  if (dstVersion != null && dstVersion === srcVersion) {
    say(`  ✓ 已就位(~/.gotry/extension,v${dstVersion};若浏览器里尚未加载:chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 ~/.gotry/extension)`)
    return { ok: true }
  }
  if (CHECK_ONLY) { say(`  ✗ ${dstVersion == null ? `未安装(落位 ${dstDir})` : `待更新 v${dstVersion} → v${srcVersion},落位 ${dstDir}`}(--check-only 只报告)`); return { ok: true } }
  try {
    copyExtensionDir(srcDir, dstDir)
  } catch (e) {
    say(`  ✗ 落位失败(${e.message})——不影响 gotry:会话检索降级;可手动拷贝 ${srcDir} → ${dstDir}`)
    return { ok: false }
  }
  say(`  ✓ 已落位 ${dstDir}(v${srcVersion};manifest 带固定 key,扩展 ID 恒为 olpgkofjhhiiiahdkkbcninhjmegghfe)`)
  say('  最后一步(每台浏览器一次,约 30 秒):Chrome 打开 chrome://extensions → 右上角开启「开发者模式」→「加载已解压的扩展程序」→ 选择 ~/.gotry/extension')
  say('  装好即生效,零系统弹窗;扩展卡片开关=总闸(与 gotry 授权闸 sessionAccess 双重控制)')
  return { ok: true }
}

/**
 * GitHub Releases 下载通道(ADR-21 分发 A,--extension-from=github 显式 opt-in):
 * repo 态 spawn tsx CLI(与 wizard/health-watch 同款单行 JSON 回传),npm 态 import dist JS;
 * 任何失败显式降级 bundled 包内副本——安装外部产物永远不挡 gotry 本体。
 */
async function setupExtensionFromGithub() {
  say('[gotry-setup] GoTry Session Bridge 扩展 · GitHub Releases 下载通道(dist-manifest → tar.gz → SHA256 → key 钉扎)')
  const destDir = join(homedir(), '.gotry', 'extension')
  const cliScript = join(repoRoot, 'ts', 'scripts', 'extension-distribution-cli.ts')
  const releaseBase = process.env.GOTRY_EXTENSION_RELEASE_BASE // 镜像/测试基址覆盖;缺省 GitHub 官方
  let r = null
  if (existsSync(cliScript)) {
    r = await new Promise((resolve) => {
      const child = spawn('npx', ['--yes', 'tsx', cliScript, '--dest', destDir, '--source-dir', join(repoRoot, 'extension'), ...(releaseBase ? ['--release-base', releaseBase] : []), ...(CHECK_ONLY ? ['--check-only'] : [])], {
        cwd: join(repoRoot, 'ts'),
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      let buf = ''
      child.stdout.on('data', (c) => { buf += c.toString('utf8') })
      child.on('close', () => {
        const line = (buf.trim().split('\n').pop() ?? '')
        if (line.startsWith('{')) { try { resolve(JSON.parse(line)); return } catch { /* 落到下一行 */ } }
        resolve({ ok: false, action: 'fallback-bundled', error: `CLI 无 JSON 输出(末行:${line.slice(0, 120)})` })
      })
      child.on('error', (e) => resolve({ ok: false, action: 'fallback-bundled', error: `CLI 启动失败 ${e.message}` }))
    })
  } else {
    try {
      const mod = await import('../dist/capabilities/session/extension-distribution.js')
      r = await mod.installExtensionFromGithub({ destDir, pinnedSourceDir: join(repoRoot, 'extension'), ...(releaseBase ? { releaseBase } : {}), checkOnly: CHECK_ONLY })
    } catch (e) {
      r = { ok: false, action: 'fallback-bundled', error: `dist 模块不可用:${e.message}` }
    }
  }
  if (r && r.ok) {
    if (r.action === 'installed') {
      say(`  ✓ 已从 GitHub Releases 落位 ${destDir}(v${r.version}${r.previousVersion ? `,旧 v${r.previousVersion}` : ''})`)
      say('  已装过旧版的浏览器:chrome://extensions → GoTry Session Bridge 卡片 → 「重新加载」一次即生效(新装跳过)。')
      return { ok: true }
    }
    // up-to-date(check-only 下远端更新也会走到这里,只报告不落盘)
    if (r.version != null && r.previousVersion != null && r.version !== r.previousVersion) {
      say(`  ✓ 远端有新版 v${r.version}(本地 v${r.previousVersion})${CHECK_ONLY ? '(--check-only 只报告)' : ''}`)
      return { ok: true }
    }
    say(`  ✓ 已是最新(v${r.version ?? '?'});若浏览器里尚未加载:chrome://extensions → 开发者模式 → 加载已解压 → 选 ${destDir}`)
    return { ok: true }
  }
  say(`  ✗ GitHub 通道失败(${r && r.error ? r.error : '未知'})——显式降级包内副本:`)
  return setupExtension()
}

/**
 * 调 wizard-bootstrap.ts(wizard.ts 的 CLI 入口):拿 5 步 OnboardingResult 打印到 stdout。
 * tsx 子进程跑 wizard 全套(扩展落位 + 开 Chrome + pbcopy 真实覆写剪贴板 + osascript GUI 面板);
 * bootstrap 不再 inline 任何 spawn——所有 UX 都走 wizard.ts,与 onboarding-tests §40 同一份代码。
 * npm 安装态(无 ts/目录):降级 inline 跑 5 步的最小子集——只调 setupExtension + 打印路径,UI 面板/剪贴板由用户手动。
 */
async function runWizardBootstrap() {
  const wizardScript = join(repoRoot, 'ts', 'scripts', 'wizard-bootstrap.ts')
  const extensionDir = join(homedir(), '.gotry', 'extension')
  if (!existsSync(wizardScript)) {
    // npm 安装态降级:只确保扩展落位,文案照常打
    say('[gotry-wizard] 内置 wizard 脚本缺失(已装 npm 包态)——降级手动模式:')
    await setupExtension()
    return { ok: true }
  }
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', 'tsx', wizardScript, '--extension-dir', extensionDir, '--source-dir', join(repoRoot, 'extension')], {
      cwd: join(repoRoot, 'ts'),
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdoutBuf = ''
    let resolved = false
    const finish = (r) => {
      if (resolved) return
      resolved = true
      resolve(r)
    }
    child.stdout.on('data', (c) => {
      stdoutBuf += c.toString('utf8')
      let nl = stdoutBuf.indexOf('\n')
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line.startsWith('{')) {
          try {
            const o = JSON.parse(line)
            // 打印 5 步 status(wizard 自己的 print 已在子进程跑了;此处父进程再 human-friendly 一次)
            if (Array.isArray(o.steps)) {
              for (const s of o.steps) {
                const tag = s.status === 'ok' ? '✅' : s.status === 'skip' ? '⏭ ' : '❌'
                say(`[gotry-wizard] ${tag} ${s.step}: ${s.summary}`)
              }
            }
            say(`[gotry-wizard] platform=${o.platform}; extensionDir=${o.extensionDir}; ok=${o.ok}`)
            finish({ ok: o.ok === true })
          } catch {
            say(`[gotry-wizard] ✗ wizard JSON 解析失败`)
            finish({ ok: false })
          }
          try { child.kill('SIGTERM') } catch { /* ignore */ }
          return
        }
        nl = stdoutBuf.indexOf('\n')
      }
    })
    child.on('exit', (code) => {
      if (!resolved) {
        say(`[gotry-wizard] ✗ wizard 子进程 exit ${code}(stdout 无 JSON)`)
        finish({ ok: code === 0 })
      }
    })
    child.on('error', (e) => {
      say(`[gotry-wizard] ✗ wizard 子进程启动失败: ${e.message}`)
      finish({ ok: false })
    })
  })
}

/**
 * 后台探活扩展心跳(wizard 闭环「装完零重跑」,§3.3):
 * spawn tsx 跑 health-watch.ts(纯 TS 探活,run-all §40 同一份代码),接 stdout JSON 结果行。
 * 探活期间每 5s stdout 一行 `.`,用户看见 stdout 持续推进,不卡死假象。
 * 默认 120s 超时;若用户提前 Ctrl+C,timeoutMs 走 0 立即返回 cancelled。
 */
async function runHealthWatch() {
  // 跨语言:bootstrap 是纯 JS,health-watch 是 TS;走 spawn npx tsx 子进程,stdout 解析。
  // tsx 子进程路径 = <repoRoot>/ts;不在 npm 包里跑(发布面只走 src/bin,不走 wizard 自动化)
  const watcherScript = join(repoRoot, 'ts', 'scripts', 'health-watch-cli.ts')
  // 默认 120s / 5s,§3.3 设计值;env 可覆盖(bootstrap-tests 跑真实路径用)
  const timeoutMs = parseInt(process.env.GOTRY_ONBOARDING_TIMEOUT_MS ?? '120000', 10) || 120_000
  const probeIntervalMs = parseInt(process.env.GOTRY_ONBOARDING_INTERVAL_MS ?? '5000', 10) || 5_000
  return new Promise((resolve) => {
    const args = [watcherScript, '--timeout', String(timeoutMs), '--interval', String(probeIntervalMs), '--json']
    // 先确认 watcher 脚本存在(npm 安装态可能未带 ts/目录——降级:走内联 node:http 短探活,避免挡用户)
    if (!existsSync(watcherScript)) {
      say(`[gotry-wizard] 内置探活脚本缺失(${watcherScript})——改用内置 5s 轮询`)
      resolve(runInlineHealthWatch(timeoutMs))
      return
    }
    const child = spawn('npx', ['--yes', 'tsx', ...args], {
      cwd: join(repoRoot, 'ts'),
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, GOTRY_ONBOARDING_HEADLESS: process.env.GOTRY_ONBOARDING_HEADLESS ?? '1' },
    })
    let stdoutBuf = ''
    let heartbeatTicker = 0
    const hbInterval = setInterval(() => {
      heartbeatTicker += 1
      process.stdout.write('.')
      if (heartbeatTicker % 12 === 0) process.stdout.write(`(${Math.round(heartbeatTicker * probeIntervalMs / 1000)}s)\n`)
    }, probeIntervalMs)
    child.stdout.on('data', (c) => {
      const s = c.toString('utf8')
      stdoutBuf += s
      // JSON 结果行以 \n 分隔;watcher 一次性 stdout 一行 JSON 退出
      let nl = stdoutBuf.indexOf('\n')
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line.startsWith('{')) {
          clearInterval(hbInterval)
          try {
            const o = JSON.parse(line)
            resolve({ ready: o.ready === true, attempts: o.attempts ?? 0, waitedMs: o.waitedMs ?? 0, reason: o.reason ?? 'timeout', timeoutMs })
          } catch {
            resolve({ ready: false, attempts: 0, waitedMs: 0, reason: 'parse-error', timeoutMs })
          }
          try { child.kill('SIGTERM') } catch { /* ignore */ }
          return
        }
        nl = stdoutBuf.indexOf('\n')
      }
    })
    child.on('exit', (code) => {
      clearInterval(hbInterval)
      process.stdout.write('\n')
      if (code !== 0 && stdoutBuf.trim() === '') {
        resolve({ ready: false, attempts: 0, waitedMs: 0, reason: `watcher-exit-${code}`, timeoutMs })
      }
    })
    child.on('error', () => {
      clearInterval(hbInterval)
      resolve({ ready: false, attempts: 0, waitedMs: 0, reason: 'watcher-spawn-error', timeoutMs })
    })
  })
}

/** npm 安装态(无 ts/目录)降级:内置 5s 轮询 node:http,与 health-watch 同节奏 */
async function runInlineHealthWatch(timeoutMs) {
  const intervalMs = parseInt(process.env.GOTRY_ONBOARDING_INTERVAL_MS ?? '5000', 10) || 5_000
  const ports = [8791, 8792, 8793, 8794, 8795]
  const http = await import('node:http')
  const startedAt = Date.now()
  let attempts = 0
  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1
    for (const port of ports) {
      const ok = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/status', method: 'GET', timeout: 2_000 }, (res) => {
          if (!res.statusCode || res.statusCode >= 400) { resolve(false); return }
          let buf = ''
          res.setEncoding('utf8')
          res.on('data', (c) => { buf += c })
          res.on('end', () => {
            try { resolve(JSON.parse(buf).extensionConnected === true) } catch { resolve(false) }
          })
          res.on('error', () => resolve(false))
        })
        req.on('error', () => resolve(false))
        req.on('timeout', () => { req.destroy(); resolve(false) })
        req.end()
      })
      if (ok) {
        process.stdout.write('\n')
        return { ready: true, attempts, waitedMs: Date.now() - startedAt, reason: 'ready', timeoutMs }
      }
    }
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  process.stdout.write('\n')
  return { ready: false, attempts, waitedMs: Date.now() - startedAt, reason: 'timeout', timeoutMs }
}

async function main() {
  // wizard 子命令(issue #21 onboarding UX,§3.3 / P3.6):扩展安装闭环,5 步 + 后台 health-watch。
  // **纯 onboarding**,不调 hbcli/agent-reach/sidebar 等其他节——只跑扩展落位 + 健康探活;
  // 想要全量安装仍走 `npx gotry setup`(无 wizard)。
  if (WIZARD) {
    if (WIZARD_DRY_RUN) {
      say('[gotry-wizard] dry-run 模式(零网络零浏览器,只校验命令编排与输出形态;run-all §40 走这条)')
      say('  步骤: ensure-extension-files → open-chrome-extensions → clipboard-extension-path → panel-guide → watch-extension-ready')
      say('  平台: darwin(zh-CN stdout);headless/Linux/Windows 同理降级')
      say('  ✅ exit 0')
      process.exit(0)
    }
    // 真实路径:spawn tsx 子进程跑 wizard-bootstrap.ts(同一份 wizard.ts 代码),
    // 拿 5 步 OnboardingResult 打印 status(ok/✅/⏭ /❌)+ 剪贴板/GUI 面板/落位实跑。
    const wizardResult = await runWizardBootstrap()
    if (!wizardResult.ok) {
      say('[gotry-wizard] ✗ wizard 编排有失败步——见上方;扩展未引导到位;可手动 chrome://extensions 加载 ~/.gotry/extension')
      process.exit(1)
    }
    // wizard 闭环:装完扩展就位 stdout 翻「✅ 就绪」(由 health-watch 推动)
    say('')
    say('[gotry-wizard] ────────────────────────────────')
    say('[gotry-wizard] 共 3 步,约 30 秒,装完零弹窗:')
    say('[gotry-wizard]   ① Chrome 右上角开启「开发者模式」')
    say(`[gotry-wizard]   ② 点「加载已解压的扩展程序」,选这个目录(已复制到剪贴板):`)
    say(`[gotry-wizard]      ${join(homedir(), '.gotry', 'extension')}`)
    say('[gotry-wizard]   ③ 弹窗「添加扩展」点「添加」')
    say('[gotry-wizard] ────────────────────────────────')
    say('[gotry-wizard] 装好后**无需重跑任何命令**——下面会自动探活,扩展一就位 stdout 翻绿。')
    say('')
    say('[gotry-wizard] 正在后台探活扩展心跳(最长 120s;Ctrl+C 取消)...')
    // 后台 health-watch:spawn tsx 子进程跑 health-watch.ts(纯 TS 模块,browser-only),
    // 探活逻辑与 onboarding-tests §40 同一份代码;无 GUI 依赖。
    const watchResult = await runHealthWatch()
    if (watchResult.ready) {
      say(`[gotry-wizard] ✅ 扩展就绪(等待 ${watchResult.waitedMs}ms,${watchResult.attempts} 次探活)`)
      say('[gotry-wizard] 现在调用 gotry_session_search 即可拿到会话检索结果(零后续手工动作)。')
      say('[gotry-wizard] 入口示例:')
      say('  ./gotry        # 启动 dsh → 用 gotry_session_search 工具')
      say('  ./gotry session-check  # 跑 sf-01..08 八条 query 双源 scorer(goal 2)')
      process.exit(0)
    } else {
      say(`[gotry-wizard] ✗ ${watchResult.reason}(${watchResult.attempts} 次探活)——扩展未在 ${watchResult.timeoutMs}ms 内就绪`)
      say('[gotry-wizard] 重新打开 chrome://extensions 确认「GoTry Session Bridge · 已启用」,再跑 `npx gotry setup wizard` 重试。')
      process.exit(1)
    }
  }

  if (process.platform === 'win32') {
    say('[gotry-setup] Windows 暂不支持自动安装(hbcli 上游仅 darwin/linux)。手动指引:')
    say(`  hbcli: ${HBCLI_INSTALL_CMD}(WSL);agent-reach: python -m venv .venv && .venv/Scripts/pip install ${REACH_INSTALL_URL}`)
    say('  dsh-better-sidebar: npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar@latest')
    say('  GoTry Session Bridge 扩展:手动把包内 extension/ 目录拷到 %USERPROFILE%\\.gotry\\extension,再在 chrome://extensions 开发者模式「加载已解压的扩展程序」')
    process.exit(AUTO ? 0 : 1)
  }
  if (AUTO && (process.env.CI || process.env.GOTRY_SETUP_SKIP === '1')) {
    say('[gotry-setup] CI/GOTRY_SETUP_SKIP 检测——跳过外部依赖自举(可随时手动: npx gotry setup)')
    say('GoTry installed. Run: npx gotry web   (dsh Web UI on :3080)')
    process.exit(0)
  }
  if (!AUTO && process.env.GOTRY_SETUP_SKIP === '1') { say('[gotry-setup] GOTRY_SETUP_SKIP=1——跳过'); process.exit(0) }
  const results = []
  if (process.env.GOTRY_SETUP_HBCLI !== '0') results.push(await setupHbcli())
  else say('[gotry-setup] hbcli:GOTRY_SETUP_HBCLI=0 跳过')
  if (process.env.GOTRY_SETUP_REACH !== '0') results.push(await setupReach())
  else say('[gotry-setup] agent-reach:GOTRY_SETUP_REACH=0 跳过')
  if (process.env.GOTRY_SETUP_SIDEBAR !== '0') results.push(await setupSidebar())
  else say('[gotry-setup] dsh-better-sidebar:GOTRY_SETUP_SIDEBAR=0 跳过')
  if (process.env.GOTRY_SETUP_EXTENSION !== '0') results.push(await (EXTENSION_FROM === 'github' ? setupExtensionFromGithub() : setupExtension()))
  else say('[gotry-setup] GoTry Session Bridge 扩展:GOTRY_SETUP_EXTENSION=0 跳过')
  say('[gotry-setup] flyai:无需安装(npx 每次自拉 @fly-ai/flyai-cli,免 key)')
  const failed = results.filter((r) => !r.ok).length
  if (failed > 0) {
    say(`[gotry-setup] ${failed} 项未就绪——gotry 本体不受影响(各能力均有降级路径);可稍后重跑: npx gotry setup`)
    process.exit(AUTO ? 0 : 1)
  }
  say('[gotry-setup] 全部就绪。Run: npx gotry web')
  process.exit(0)
}

main().catch((e) => {
  say(`[gotry-setup] 异常:${e.message}(不影响 gotry 本体;可重试 npx gotry setup)`)
  process.exit(AUTO ? 0 : 1)
})
