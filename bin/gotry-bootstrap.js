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
 *
 * 环境开关:
 *   GOTRY_SETUP_SKIP=1            全部跳过
 *   GOTRY_SETUP_HBCLI=0           跳过 hbcli
 *   GOTRY_SETUP_REACH=0           跳过 agent-reach
 *   GOTRY_SETUP_SIDEBAR=0         跳过 dsh-better-sidebar
 *   GOTRY_SETUP_EXTENSION=0       跳过会话检索扩展落位
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
  if (present) { say('  ✓ 已安装'); return { ok: true } }
  if (CHECK_ONLY) { say('  ✗ 未安装(--check-only 只报告)'); return { ok: true } }
  say(`  安装中(官方脚本): ${HBCLI_INSTALL_CMD}`)
  const r = await run('bash', ['-c', HBCLI_INSTALL_CMD], { timeoutMs: 120_000 })
  if (!r.ok) { say(`  ✗ 安装失败(${r.error})——不影响 gotry,酒店检索将用内置静态包;可稍后重试: npx gotry setup`); return { ok: false } }
  const binDir = join(homedir(), '.local/bin')
  if (!process.env.PATH.split(':').includes(binDir)) {
    say(`  ⚠ ${binDir} 不在当前 PATH —— gotry 工具已内建候选路径回退,无需手动处理;其他程序可用: export PATH="${binDir}:$PATH"`)
  }
  say('  ✓ 安装完成(凭证选配: hbcli auth set-credentials --app-key ... --app-secret ...,或 HOTELBYTE_TOKEN;未配时酒店检索自动用静态包)')
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

async function main() {
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
  if (process.env.GOTRY_SETUP_EXTENSION !== '0') results.push(await setupExtension())
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
