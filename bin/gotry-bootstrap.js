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
 *                           一次性安装替代逐连接 CDP 弹窗;已上架 Chrome Web Store
 *                           (2026-09-02,一键装+自动更新)。**gory 不介入浏览器**——
 *                           商店页安装是浏览器的事;`gotry setup wizard` 仅作离线检测的
 *                           进程护栏(打印商店 URL + 健康探活等待),不动剪贴板、
 *                           不弹 osascript、不 open 浏览器。
 *
 * 用法:
 *   node bin/gotry-bootstrap.js              # 显式安装(缺啥装啥;失败 exit 1)
 *   node bin/gotry-bootstrap.js --auto       # postinstall 模式:CI/跳过开关检测,任何失败不挡安装(exit 0)
 *   node bin/gotry-bootstrap.js --check-only # 只探测报告,不安装(测试钩子)
 *   node bin/gotry-bootstrap.js --extension-from=github
 *                                           # 扩展改走 GitHub Releases 下载通道(ADR-21):
 *                                           #   dist-manifest → tar.gz → SHA256 → key 钉扎 → 原子交换;
 *                                           #   任何失败显式降级回包内副本(离线确定性不变)。
 *   node bin/gotry-bootstrap.js calendar        # 可选日历挂载开关(D-9,setup 状态面):
 *                                               #   默认写 ~/.gotry/calendar.json {"enabled":true};
 *                                               #   --off 删除恢复默认不挂载;--status 只读查看。
 *   node bin/gotry-bootstrap.js doctor      # 可选依赖体检(2026-09-02 迪拜 session 复盘):
 *                                           #   扩展/agent-reach/.venv/hbcli/flyai key/sidebar/calendar
 *                                           #   逐项只读检查 + 精确补装指引;
 *                                           #   报告落 gotry-state/doctor-report.md(侧栏工作台可预览)。
 *   node bin/gotry-bootstrap.js doctor --fix # 体检后按缺失项补装(复用下方三个安装器;LLM key 永不管)。
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
 *   GOTRY_ONBOARDING_HEADLESS=1   wizard 仅 stdout(SSH/CI 默认探测)
 *
 * 设计纪律(wizard 子命令,2026-09-02 商店上架后):
 * **浏览器自己当安装器**——浏览器商店页直达,点「添加至 Chrome」即完事;gotry
 * 不扮演 GUI/CLI 越界者:不动剪贴板、不动 osascript/zenity/msg、不 open 浏览器。
 * dsh host UI 是 gotry 工具渲染面,needs-extension 时 URL 走 verdict 字段给 UI
 * 自渲。wizard 子命令退化为「离线健康探活等待」,只输出 stdout,不挡用户。
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    say('  ✗ 安装失败——不影响 gotry:产物仍可在对话里说「看看我生成的行程」经 gotry_artifacts_list/read 查看;可稍后重试: npx gotry doctor --fix')
    return { ok: false }
  }
  say('  ✓ 安装完成(gotry web 刷新浏览器即见右侧工作台)')
  return { ok: true }
}

// ---------------------------------------------------------------------------
// doctor(可选依赖体检;与 ts/capabilities/doctor.ts 同一状态面,-bootstrap 是
// CLI 执行面纯 JS、capabilities 是 MCP 工具面 TS——两边清单/口径成对修改)
// ---------------------------------------------------------------------------

const DOCTOR = process.argv.includes('doctor')
const DOCTOR_FIX = process.argv.includes('--fix')
// calendar 子命令(issue #106/D-9):可选日历挂载的 setup 状态管理面。
// `gotry setup calendar`=开启;`--off`=关闭(删状态文件恢复默认);`--status`=只读查看。
const CALENDAR_CMD = process.argv.includes('calendar')
const CALENDAR_OFF = process.argv.includes('--off')
const CALENDAR_STATUS = process.argv.includes('--status')

// --- calendar setup 状态面(与扩展 manifest 同居 ~/.gotry;运行时 inner 与
// doctor 两端同读这一份,禁止 env 控制产品行为——founder 2026-09-03 纠偏)---
function calendarStatePath() { return join(homedir(), '.gotry', 'calendar.json') }
function readCalendarState() {
  try { return JSON.parse(readFileSync(calendarStatePath(), 'utf8')) } catch { return null }
}
function calendarProfileConfigured() {
  try {
    const patch = readFileSync(join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    return /calendar/.test(patch) && /username\s*:/.test(patch)
  } catch { return false }
}

/** 挂载/配置双态人话(bootstrap doctor 与 calendar 子命令共用) */
function calendarDetail(state) {
  if (!state || state.enabled !== true) return '默认未挂载(D-9:未配置的日历工具不进工具箱;工作窗口由访谈覆盖,不影响任何检索)'
  return calendarProfileConfigured()
    ? `已挂载且已配置(${calendarStatePath()})`
    : '已挂载但 calendar 未配置 username——日历工具会话中会报「未配置」'
}

async function runCalendar() {
  say('[gotry-setup] dsh-calendar(可选日历,CalDAV 工作窗口读取;默认不挂载)')
  if (CALENDAR_STATUS) {
    const state = readCalendarState()
    say(`  状态: ${calendarDetail(state)}`)
    say(`  状态文件: ${calendarStatePath()}`)
    say('  说明: 挂载=`npx gotry setup calendar`;关闭=`npx gotry setup calendar --off`;配置在 dsh profile 的 cordis.patch.yml 覆盖 calendar 行 config 填 username')
    return 0
  }
  if (CALENDAR_OFF) {
    try { rmSync(calendarStatePath()) } catch { /* 本就未开启 */ }
    say('  ✓ 已关闭——恢复默认不挂载(状态文件已删除;如需再开: npx gotry setup calendar)')
    return 0
  }
  mkdirSync(dirname(calendarStatePath()), { recursive: true })
  writeFileSync(calendarStatePath(), `${JSON.stringify({ enabled: true, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  say(`  ✓ 已开启挂载(状态文件 ${calendarStatePath()};重启 gotry web/headless 生效)`)
  if (calendarProfileConfigured()) {
    say('  ✓ calendar 已在 dsh profile 配置 username——全部就绪')
  } else {
    say('  ⚠ 还差最后一步:在 dsh profile 的 cordis.patch.yml 覆盖 calendar 行的 config,填你的 CalDAV username,例如:')
    say('      - id: dsh-calendar')
    say('        config:')
    say('          username: <你的日历账号>')
    say('    未配置时日历工具会话中会报「未配置」;不需要日历时可用 --off 恢复默认不挂载。')
  }
  return 0
}

/** 逐项只读检查(永不抛错;LLM key 显式让渡给 dsh 宿主,不体检)。
 *  level 与 ts/capabilities/doctor.ts DoctorStatus 同构:ok / missing / degraded。 */
async function doctorChecks() {
  const items = []
  // Node 运行时
  const nv = process.versions.node
  const [maj, min] = nv.split('.').map(Number)
  const nodeFine = maj > 22 || (maj === 22 && min >= 15)
  items.push({ label: 'Node 运行时', ok: nodeFine, level: nodeFine ? 'ok' : 'missing', detail: `Node ${nv}(需 ≥22.15)`, fix: nodeFine ? undefined : '升级 Node.js 至 22.15+(https://nodejs.org)' })
  // 扩展
  const extManifest = join(homedir(), '.gotry', 'extension', 'manifest.json')
  const extOk = existsSync(extManifest)
  items.push({ label: 'GoTry Session Bridge 扩展', ok: extOk, level: extOk ? 'ok' : 'missing', detail: extOk ? `已就位(${extManifest})` : '未安装——gotry_session_search / gotry_session_login(账号会话通道)不可用,其余工具不受影响', fix: extOk ? undefined : '在 Chrome 应用商店一键安装(自动更新): https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd' })
  // agent-reach(.venv 装在包内)
  const venvPython = join(repoRoot, '.venv/bin/python')
  const reachBin = join(repoRoot, '.venv/bin/agent-reach')
  const reachOk = existsSync(reachBin)
  const reachLevel = reachOk ? 'ok' : existsSync(venvPython) ? 'degraded' : 'missing'
  items.push({ label: 'Agent Reach(网页/社媒读取)', ok: reachOk, level: reachLevel, detail: reachOk ? `已安装(${reachBin})` : reachLevel === 'degraded' ? '.venv 在但缺 agent-reach 包——gotry_agent_reach / gotry_web_search 读页会失败' : '未装配——gotry_agent_reach / gotry_web_search(读网页)/ gotry_video_subtitle / gotry_github_search 全部不可用', fix: reachOk ? undefined : 'npx gotry doctor --fix' })
  // hbcli(裸名靠 PATH 探测;绝对路径 existsSync)
  let hbBin = ''
  for (const p of ['hbcli', join(homedir(), '.local/bin/hbcli'), join(homedir(), '.staicli/current/hbcli')]) {
    if (p === 'hbcli') { if (await probe(p, ['version'])) { hbBin = 'hbcli(PATH)'; break } } else if (existsSync(p)) { hbBin = p; break }
  }
  if (hbBin) {
    const whoami = await probe(hbBin === 'hbcli(PATH)' ? 'hbcli' : hbBin, ['auth', 'whoami'])
    items.push({ label: 'hbcli(酒店实时源)', ok: whoami, level: whoami ? 'ok' : 'degraded', detail: whoami ? `已安装且凭证有效(${hbBin})` : '二进制在,但凭证未配置/失效——酒店检索将降级静态包(非实时)', fix: whoami ? undefined : 'hbcli auth set-credentials --app-key hotelbyte_api_demo --app-secret hotelbyte_api_demo(快速试用沙箱;正式 key 向 HotelByte 申请)' })
  } else {
    items.push({ label: 'hbcli(酒店实时源)', ok: false, level: 'missing', detail: '未安装——酒店检索降级静态包(公开渠道估算,非实时,仅覆盖内置场景)', fix: 'npx gotry doctor --fix' })
  }
  // flyai key(匿名试用额度共享易达限;正式 key 即免)
  const flyaiKey = (process.env.FLYAI_API_KEY ?? '').trim()
  items.push({ label: 'FlyAI(飞猪官方检索)', ok: Boolean(flyaiKey), level: flyaiKey ? 'ok' : 'degraded', detail: flyaiKey ? 'FLYAI_API_KEY 已配(正式 key,无试用额度限制)' : '未配 FLYAI_API_KEY——走匿名试用额度(共享,易达限;达限报 "Trial limit reached")', fix: flyaiKey ? undefined : '到 flyai.open.fliggy.com 控制台申请正式 key,配进环境变量 FLYAI_API_KEY' })
  // sidebar
  const sidebarPkg = join(homedir(), '.dsh/profiles/web/node_modules/dsh-better-sidebar/package.json')
  const sbOk = existsSync(sidebarPkg)
  items.push({ label: 'dsh-better-sidebar(侧栏工作台)', ok: sbOk, level: sbOk ? 'ok' : 'missing', detail: sbOk ? '已安装——web UI 右侧工作台可预览产物与 doctor 报告(gotry-state/doctor-report.md)' : '未安装——dsh web 无右侧工作台,产物与 doctor 报告只能在对话里看(gotry_artifacts_list)', fix: sbOk ? undefined : 'npx gotry doctor --fix' })
  // dsh-calendar(setup 状态面;默认不挂载=ok 是合法态,opt-in 未配置才 degraded)
  const calState = readCalendarState()
  const calOn = calState?.enabled === true
  const calConfigured = calOn && calendarProfileConfigured()
  items.push({ label: 'dsh-calendar(日历工作窗口)', ok: !calOn || calConfigured, level: !calOn ? 'ok' : calConfigured ? 'ok' : 'degraded', detail: calendarDetail(calState), fix: !calOn ? undefined : calConfigured ? undefined : '在 ~/.dsh/profiles/web/cordis.patch.yml 覆盖 calendar 行 config 填 username(或 npx gotry setup calendar --off 恢复默认不挂载)' })
  // LLM key:显式让渡(founder 2026-09-02:doctor 不管 key)
  items.push({ label: 'LLM key', ok: true, level: 'ok', detail: '由 dsh 宿主 UI 管理——不在体检范围(gotry 不接触、不回显凭证)', fix: undefined })
  return items
}

const doctorIcon = { ok: '✅', missing: '❌', degraded: '⚠️' }

/** 修复指引入表:命令类才加反引号( prose 类如「到控制台申请 key」原样) */
const fixCell = (fix) => (!fix ? '—' : /^(npx|hbcli|curl|pip|python|\$)/.test(fix) ? `\`${fix}\`` : fix)

/** 启动一次性摘要行(issue #114,design §3.1③):全 ok 返回 null(静默零输出);
 *  有待处理项给一行人话 + 指路(对话里 gotry_doctor 看详情 / 终端 npx gotry doctor)。
 *  纯函数,bootstrap-tests 直接断言。 */
function startupDoctorLine(items) {
  const broken = (items ?? []).filter((i) => i.level && i.level !== 'ok')
  if (broken.length === 0) return null
  const human = (lv) => (lv === 'missing' ? '缺' : '半可用')
  return `[gotry] doctor: ${broken.length} 项待处理(${broken.map((i) => `${i.label}=${human(i.level)}`).join('、')})——对话里让助手调 gotry_doctor 看详情与指引,或终端跑 npx gotry doctor`
}

/** 体检报告 markdown(与 ts/capabilities/doctor.ts renderDoctorReportMd 同形) */
function renderDoctorReportMd(items) {
  const broken = items.filter((i) => i.level !== 'ok' && i.label !== 'LLM key')
  const lines = [
    '# GoTry 依赖体检报告(doctor)',
    '',
    `> 生成于 ${new Date().toISOString()};重新生成:终端 \`npx gotry doctor\`,或在对话里让助手调 gotry_doctor。`,
    '',
    '| 状态 | 依赖 | 现状 | 修复指引 |',
    '|---|---|---|---|',
    ...items.map((i) => `| ${doctorIcon[i.level]} | ${i.label} | ${i.detail} | ${fixCell(i.fix)} |`),
    '',
    `**结论**:${broken.length === 0 ? '全部就绪(可选依赖齐,LLM key 归 dsh 宿主管)。' : `${broken.length} 项待处理:${broken.map((i) => i.label).join('、')}。补装: npx gotry doctor --fix`}`,
    '',
    '---',
    '',
    '- `npx gotry doctor` 随时可重跑(只读,不改任何东西);',
    '- `npx gotry doctor --fix` 按上表补装(hbcli 官方脚本 / agent-reach pip / dsh-better-sidebar 插件);',
    '- LLM key 由 dsh 宿主 UI 管理,gotry 永不体检、不回显。',
    '',
  ]
  return lines.join('\n')
}

/** doctor 主流程:体检 → 打印 →(可选)fix → 报告落盘。
 *  exit 0=就绪(或仅剩有自动回退的降级项);exit 1=仍有缺失类问题。 */
async function runDoctor() {
  let items = await doctorChecks()
  // 启动一次性摘要(issue #114):inner 分离子进程带 --summary 调用——只读体检,
  // 有待处理项打一行 stderr,零写盘零 header;全 ok 静默。与完整体检面(逐项/报告落盘/exit 语义)分离。
  if (process.argv.includes('--summary')) {
    const line = startupDoctorLine(items)
    if (line) console.error(line)
    return 0
  }
  say('[gotry-doctor] GoTry 可选依赖体检(只读;LLM key 归 dsh 宿主管,不在范围)')
  for (const i of items) {
    say(`  ${doctorIcon[i.level]} ${i.label}:${i.detail}`)
    if (i.level !== 'ok' && i.fix) say(`      ↳ 修复: ${i.fix}`)
  }
  if (DOCTOR_FIX) {
    if (process.platform === 'win32') {
      say('[gotry-doctor] --fix 在 Windows 暂不支持自动安装(hbcli/agent-reach 上游无 win 安装面);请按各项修复指引手动处理')
    } else {
      say('[gotry-doctor] 开始补装缺失项(--fix)…')
      const results = []
      if (process.env.GOTRY_SETUP_HBCLI !== '0') results.push(await setupHbcli())
      if (process.env.GOTRY_SETUP_REACH !== '0') results.push(await setupReach())
      if (process.env.GOTRY_SETUP_SIDEBAR !== '0') results.push(await setupSidebar())
      const failedFix = results.filter((r) => !r.ok).length
      say(failedFix === 0 ? '[gotry-doctor] 补装完成;下面是补装后复检。' : `[gotry-doctor] ${failedFix} 项补装失败——见上方安装器输出;可重跑 npx gotry doctor --fix`)
      items = await doctorChecks()
      for (const i of items) {
        say(`  ${doctorIcon[i.level]} ${i.label}:${i.detail}`)
      }
    }
  }
  // 报告落盘(侧栏工作台预览面;写失败不挡体检结论)
  try {
    const stateDir = join(repoRoot, 'gotry-state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'doctor-report.md'), renderDoctorReportMd(items), 'utf8')
    say(`[gotry-doctor] 报告已写: ${join(stateDir, 'doctor-report.md')}(dsh 侧栏工作台可直接预览)`)
  } catch (e) {
    say(`[gotry-doctor] 报告写盘失败(${e.message})——体检结论仍有效`)
  }
  // 降级类(凭证未配/flyai 试用)不挡 exit 0——降级有自动回退路径,缺失类才挡
  const stillMissing = items.filter((i) => i.level === 'missing').length
  return stillMissing === 0 ? 0 : 1
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
  say(`  ✓ 已落位 ${dstDir}(v${srcVersion};manifest 带固定 key,unpacked 扩展 ID 恒为 olpgkofjhhiiiahdkkbcninhjmegghfe)`)
  say('  推荐(免下面三步):Chrome 应用商店一键安装 GoTry Session Bridge(自动更新): https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd')
  say('  本地加载(每台浏览器一次,约 30 秒):Chrome 打开 chrome://extensions → 右上角开启「开发者模式」→「加载已解压的扩展程序」→ 选择 ~/.gotry/extension')
  say('  获取/更新本地通道扩展可走 GitHub Releases:npx gotry setup --extension-from=github(自动下载校验落位;手动下载: github.com/Danceiny/gotry/releases 标签 ext-*)')
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
 * 调 (npm 安装态降级)只确保扩展落位后跑扩展分支 hydration。wizard.ts 现在
 * 只做 ensure + watch precheck(Node 端职责),不 spawn 任何 GUI;真正的浏览器
 * 商店页安装走 dsh UI 渲染的 verdict.installUrl,健康探活走 runHealthWatch。
 *
 * 历史:wizard-bootstrap.ts(此文件之前 spawn 的 tsx 子进程)已删除;
 * run-all §40 onboarding-tests 直接 import wizard.ts 的 runOnboardingWizard。
 */
async function runWizardBootstrap() {
  // wizard.ts 已退化为纯 Node 2 步(ensure + watch precheck),不 spawn 任何东西;
  // tsx 子进程路径 = <repoRoot>/ts;npm 安装态(wizard-bootstrap.ts 已删除)走包内 setupExtension。
  const wizardScript = join(repoRoot, 'ts', 'scripts', 'wizard-bootstrap.ts')
  if (!existsSync(wizardScript)) {
    say('[gotry-wizard] 内置 wizard 脚本缺失(已装 npm 包态;npm 安装态应在浏览器商店一键装,不需要 wizard 跑落位)——只跑包内扩展落位:')
    await setupExtension()
    return { ok: true }
  }
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', 'tsx', wizardScript, '--extension-dir', join(homedir(), '.gotry', 'extension'), '--source-dir', join(repoRoot, 'extension')], {
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
            // 打印 2 步 status(wizard 自己的 print 已在子进程跑了;此处父进程再 human-friendly 一次)
            if (Array.isArray(o.steps)) {
              for (const s of o.steps) {
                const tag = s.status === 'ok' ? '✅' : s.status === 'skip' ? '⏭ ' : '❌'
                say(`[gotry-wizard] ${tag} ${s.step}: ${s.summary}`)
              }
            }
            say(`[gotry-wizard] extensionDir=${o.extensionDir}; ok=${o.ok}`)
            finish({ ok: o.ok === true })
          } catch {
            say('[gotry-wizard] ✗ wizard JSON 解析失败')
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
  // calendar 子命令(issue #106/D-9):可选日历挂载的 setup 状态管理(on/off/status)
  if (CALENDAR_CMD) process.exit(await runCalendar())

  // doctor 子命令(2026-09-02 迪拜 session 复盘):可选依赖体检 + 补装指引/补装执行;
  // 只读体检零副作用(--fix 才装),win32 也可跑体检(fix 面另有提示)。
  if (DOCTOR) process.exit(await runDoctor())

// wizard 子命令(2026-09-02 商店上架后退化):**只走 stdout 提示 + 健康探活等待**;
// 不 spawn 任何 GUI 工具(不动 pbcopy / osascript / open / xdg-open / zenity),
// 不打开 chrome://extensions,不动扩展路径——浏览器自己当安装器,gotry 不越界。
if (WIZARD) {
    if (WIZARD_DRY_RUN) {
      say('[gotry-wizard] dry-run(零网络零浏览器零剪贴板;run-all §40 走这条)')
      say('  步骤: ensure-extension-files → watch-extension-ready(2 步纯 Node 端)')
      say('  平台: 不依赖 darwin/linux/win32(只 stdout)')
      say('  ✅ exit 0')
      process.exit(0)
    }
    say('')
    say('[gotry-wizard] ────────────────────────────────')
    say('[gotry-wizard] GoTry Session Bridge 是浏览器的事——在 Chrome 应用商店一键装:')
    say('[gotry-wizard]   https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd')
    say('[gotry-wizard] 装好即生效;装完后我会自动检测到(下方探活等待,最长 120s)。')
    say('[gotry-wizard] 全过程 gotry 不动你的剪贴板、不开你的 Chrome、不弹任何面板。')
    say('[gotry-wizard] ────────────────────────────────')
    say('')
    say('[gotry-wizard] 探活中(Ctrl+C 立即退出)…')

    // 健康探活等待:扩展一就位即返回;无 GUI/剪贴板副作用
    const watchResult = await runHealthWatch()
    if (watchResult.ready) {
      say(`[gotry-wizard] ✅ 扩展就绪(${watchResult.attempts} 次探活,等待 ${watchResult.waitedMs}ms)`)
      process.exit(0)
    } else {
      say(`[gotry-wizard] ✗ ${watchResult.reason}——未在 ${watchResult.timeoutMs}ms 内就绪`)
      say('[gotry-wizard] 不需重跑;扩展未装时 dsh UI 中 gotry_session_search 的 needs-extension 会带商店链接,wizard 完全幂等。')
      process.exit(1)
    }
  }

  if (process.platform === 'win32') {
    say('[gotry-setup] GoTry Session Bridge 扩展:推荐 Chrome 应用商店一键安装 https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd ;本地通道:手动把包内 extension/ 目录拷到 %USERPROFILE%\\.gotry\\extension,再在 chrome://extensions 开发者模式「加载已解压的扩展程序」')
    process.exit(AUTO ? 0 : 1)
  }
  if (AUTO && (process.env.CI || process.env.GOTRY_SETUP_SKIP === '1')) {
    say('[gotry-setup] CI/GOTRY_SETUP_SKIP 检测——跳过')
    process.exit(0)
  }
  if (!AUTO && process.env.GOTRY_SETUP_SKIP === '1') { say('[gotry-setup] GOTRY_SETUP_SKIP=1——跳过'); process.exit(0) }
  const results = []
  // gotry 自留面只剩扩展是否就位;hbcli/agent-reach/dsh-better-sidebar 由各自宿主生态自管。
  if (process.env.GOTRY_SETUP_EXTENSION !== '0') results.push(await (EXTENSION_FROM === 'github' ? setupExtensionFromGithub() : setupExtension()))
  else say('[gotry-setup] GoTry Session Bridge 扩展:GOTRY_SETUP_EXTENSION=0 跳过')
  const failed = results.filter((r) => !r.ok).length
  if (failed > 0) {
    say(`[gotry-setup] ${failed} 项未就绪——gotry 本体不受影响;可稍后重跑: npx gotry setup`)
    process.exit(AUTO ? 0 : 1)
  }
  say('[gotry-setup] 扩展就绪检查完成。')
  process.exit(0)
}

main().catch((e) => {
  say(`[gotry-setup] 异常:${e.message}(不影响 gotry 本体;可重试 npx gotry setup)`)
  process.exit(AUTO ? 0 : 1)
})
