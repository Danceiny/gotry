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
 *
 * 用法:
 *   node bin/gotry-bootstrap.js              # 显式安装(缺啥装啥;失败 exit 1)
 *   node bin/gotry-bootstrap.js --auto       # postinstall 模式:CI/跳过开关检测,任何失败不挡安装(exit 0)
 *   node bin/gotry-bootstrap.js --check-only # 只探测报告,不安装(测试钩子)
 *
 * 环境开关:
 *   GOTRY_SETUP_SKIP=1            全部跳过
 *   GOTRY_SETUP_HBCLI=0           跳过 hbcli
 *   GOTRY_SETUP_REACH=0           跳过 agent-reach
 *   GOTRY_SETUP_SIDEBAR=0         跳过 dsh-better-sidebar
 *
 * 契约:安装外部依赖永远不挡 gotry 本体——能力层各有降级路径(静态包/not-installed
 * verdict),自举失败只降级体验,不产生故障。凭证(hbcli auth / agent-reach 渠道
 * cookie)属用户资产,不自动配置,装完二进制后给指引。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const AUTO = process.argv.includes('--auto')
const CHECK_ONLY = process.argv.includes('--check-only')

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

async function setupSidebar() {
  say('[gotry-setup] dsh-better-sidebar(dsh web 侧栏工作台,产物查看面 issue #25)')
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

async function main() {
  if (process.platform === 'win32') {
    say('[gotry-setup] Windows 暂不支持自动安装(hbcli 上游仅 darwin/linux)。手动指引:')
    say(`  hbcli: ${HBCLI_INSTALL_CMD}(WSL);agent-reach: python -m venv .venv && .venv/Scripts/pip install ${REACH_INSTALL_URL}`)
    say('  dsh-better-sidebar: npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-better-sidebar@latest')
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
