/**
 * bootstrap 自举层测试(bin/gotry-bootstrap.js,零网络安装、只探测/跳过开关)。
 * setup 面只剩扩展是否就位(2026-09-02 商店上架后职责返交 #2);可选依赖
 * (hbcli / agent-reach / dsh-better-sidebar)的状态与补装由 doctor 面接管
 * (founder 2026-09-02 拍板:不撒手,体检+引导;LLM key 仍归 dsh 宿主管)。
 * 守:
 *  1. --check-only:只探测报告不安装,exit 0,扩展就位节存在
 *  2. GOTRY_SETUP_SKIP=1 + --auto:跳过
 *  3. 显式模式 GOTRY_SETUP_SKIP=1:同样跳过
 *  4. GOTRY_SETUP_EXTENSION=0 单项跳过
 *  5. wizard --dry-run 与真实路径(probe 失败 exit 1)
 *  8. doctor 子命令:体检清单/LLM key 让渡/报告落盘(状态面回归)
 *
 * 不测真实安装(浏览器商店一键装已上架,扩展就位检测走 runHealthWatch 的回环端口)。
 * 运行: cd ts && npx tsx scripts/bootstrap-tests.ts
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..')
const bootstrap = join(repoRoot, 'bin', 'gotry-bootstrap.js')

// runOnboardingFix 返回元素形状(动态 import 的 .js 模块无类型,显式标注以过 noImplicitAny)
interface OnboardingFixResult {
  label: string
  status: 'installed' | 'needs-user-action' | 'unavailable'
  reason?: string
  retry?: string
}

// runOnboarding 返回形状(orchestrateWebLaunch 的 runOnboarding 依赖契约)
interface OnboardingResult {
  prompted: boolean
  reported?: boolean
  answered?: 'yes' | 'no'
  results?: OnboardingFixResult[]
  skipped?: string
  plan?: { promptable: boolean; auto: unknown[]; userAction: unknown[]; unavailable: unknown[] }
}

function runBootstrap(extraArgs: string[], extraEnv: Record<string, string>, bootstrapPath: string = bootstrap) {
  try {
    const out = execFileSync('node', [bootstrapPath, ...extraArgs], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, ...extraEnv },
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    return { code: err.status ?? 1, out: err.stdout ?? '' }
  }
}

// 1. --check-only:扩展就位探测,exit 0(已不替用户管 hbcli/agent-reach/sidebar)
const c1 = runBootstrap(['--check-only'], {})
assert.equal(c1.code, 0, `--check-only 应 exit 0,实际 ${c1.code}\n${c1.out}`)
assert.ok(c1.out.includes('Session Bridge'), '报告应含扩展就位节(issue #21 传输层方案 C)')
assert.ok(!c1.out.includes('hbcli'), 'setup 不再替用户管 hbcli(已让出)')
assert.ok(!c1.out.includes('agent-reach'), 'setup 不再替用户管 agent-reach(已让出)')
assert.ok(!c1.out.includes('dsh-better-sidebar'), 'setup 不再替用户管 dsh-better-sidebar(已让出)')
console.log('1. --check-only 探测报告 exit 0(扩展就位 + 让出 hbcli/agent-reach/sidebar)OK')

// 2. --auto + GOTRY_SETUP_SKIP=1:跳过
const c2 = runBootstrap(['--auto'], { GOTRY_SETUP_SKIP: '1' })
assert.equal(c2.code, 0, '--auto 跳过态应 exit 0')
assert.ok(c2.out.includes('跳过'), '应输出跳过说明')
console.log('2. --auto + GOTRY_SETUP_SKIP=1 → exit 0(永不挡 npm install)OK')

// 3. 显式模式 + GOTRY_SETUP_SKIP=1:同样跳过
const c3 = runBootstrap([], { GOTRY_SETUP_SKIP: '1' })
assert.equal(c3.code, 0, '显式模式跳过态应 exit 0')
assert.ok(c3.out.includes('跳过'), '应输出跳过说明')
console.log('3. 显式模式 + GOTRY_SETUP_SKIP=1 → exit 0 OK')

// 4. GOTRY_SETUP_EXTENSION=0 单项跳过
const c4 = runBootstrap(['--check-only'], { GOTRY_SETUP_EXTENSION: '0' })
assert.equal(c4.code, 0, '单项跳过态应 exit 0')
assert.ok(c4.out.includes('GOTRY_SETUP_EXTENSION=0 跳过'), '应输出扩展单项跳过说明')
console.log('4. GOTRY_SETUP_EXTENSION=0 单项跳过 OK')

// 5. wizard 子命令(2026-09-02 商店上架后退化):dry-run 模式零网络零浏览器零剪贴板,exit 0,2 步齐全
const c5 = runBootstrap(['wizard', '--dry-run'], {})
assert.equal(c5.code, 0, `wizard --dry-run 应 exit 0,实际 ${c5.code}\n${c5.out}`)
assert.ok(c5.out.includes('dry-run'), '应输出 dry-run 字样')
assert.ok(c5.out.includes('gotry-wizard'), '应输出 [gotry-wizard] 标签')
assert.ok(c5.out.includes('ensure-extension-files'), 'dry-run 应列 ensure-extension-files')
assert.ok(c5.out.includes('watch-extension-ready'), 'dry-run 应列 watch-extension-ready')
console.log('5. wizard 子命令(--dry-run 零网络,2 步齐全 + 极简 stdout)OK')

// 6. wizard 走真实路径但 timeout 极短(GOTRY_ONBOARDING_TIMEOUT_MS 缺省走 120s,降级由 inline 探活兜),
//    端口 0 让子进程绑定隔离的临时桥,避免本机已在线扩展污染 timeout 负例(issue #209)。
//    确认 stdout 至少含一次探活心跳 + 引导标题(不再断言 "3 步",纯 stdout 形态下标题文案已简化)
const c6 = runBootstrap(['wizard'], {
  GOTRY_SETUP_EXTENSION: '0',
  GOTRY_ONBOARDING_TIMEOUT_MS: '600',
  GOTRY_ONBOARDING_INTERVAL_MS: '200',
  GOTRY_ONBOARDING_BRIDGE_PORTS: '0',
})
assert.equal(c6.code, 1, `wizard(超时)应 exit 1,实际 ${c6.code}\n${c6.out}`)
assert.ok(c6.out.includes('gotry-wizard'), '应输出 [gotry-wizard] 标签')
console.log('6. wizard 真实路径(扩展未就绪,exit 1 + 心跳)OK')

// 7. 扩展分发 github 通道(ADR-21):基址指不可达回环(127.0.0.1:1 拒连,离线确定性);显式模式不带 --auto——CI 环境里 AUTO+CI 会提前跳过全部节,断言面会落空
//    → 显式降级 bundled + check-only 报告,exit 0;非法 --extension-from 值回落 bundled 不进网络通道。
const c7 = runBootstrap(['--check-only', '--extension-from=github'], {
  GOTRY_SETUP_HBCLI: '0', GOTRY_SETUP_REACH: '0', GOTRY_SETUP_SIDEBAR: '0',
  GOTRY_EXTENSION_RELEASE_BASE: 'http://127.0.0.1:1/releases',
})
assert.equal(c7.code, 0, `github 通道降级应 exit 0,实际 ${c7.code}\n${c7.out}`)
assert.ok(c7.out.includes('GitHub Releases 下载通道'), '应打印 github 通道标题')
assert.ok(c7.out.includes('降级包内副本'), '失败应显式降级 bundled')
const c7b = runBootstrap(['--check-only', '--extension-from=不合法值'], {
  GOTRY_SETUP_HBCLI: '0', GOTRY_SETUP_REACH: '0', GOTRY_SETUP_SIDEBAR: '0',
})
assert.equal(c7b.code, 0, `非法 --extension-from 值应回落 bundled 且 exit 0,实际 ${c7b.code}\n${c7b.out}`)
assert.ok(!c7b.out.includes('下载通道'), '非法值不应进入 github 通道')
console.log('7. 扩展分发 github 通道(不可达基址即时降级 + 非法值回落 bundled)OK')

// 8. doctor 子命令(2026-09-02 迪拜 session 复盘:可选依赖不撒手——doctor 统一
//    显示状态 + 精确补装指引;LLM key 显式让渡;报告落 gotry-state/doctor-report.md)
const c8 = runBootstrap(['doctor'], {})
assert.ok(c8.out.includes('[gotry-doctor]'), '应输出 [gotry-doctor] 标签')
assert.ok(c8.out.includes('Agent Reach'), '体检应含 agent-reach 项')
assert.ok(c8.out.includes('hbcli'), '体检应含 hbcli 项')
assert.ok(c8.out.includes('FLYAI_API_KEY'), '体检应含 flyai key 项(试用额度降级面)')
assert.ok(c8.out.includes('LLM key'), '体检应含 LLM key 让渡说明(doctor 不管 key)')
assert.ok(c8.out.includes('dsh-map-tools'), '体检应含 dsh-map-tools 项(#139;与 ts/capabilities/doctor.ts 两面成对)')
assert.ok(c8.out.includes('dsh-tool-ask-user'), '体检应含 dsh-tool-ask-user 项(与 ts/capabilities/doctor.ts 两面成对)')
assert.ok(c8.out.includes('doctor-report.md'), '应提示报告落盘路径')
assert.ok([0, 1].includes(c8.code), `doctor exit 应为 0(就绪)或 1(有缺失),实际 ${c8.code}`)
const reportPath = join(repoRoot, 'gotry-state', 'doctor-report.md')
const report = readFileSync(reportPath, 'utf-8')
assert.ok(report.includes('# GoTry 依赖体检报告'), '报告 markdown 应落盘可预览')
assert.ok(report.includes('npx @danceiny/gotry doctor --fix'), '报告应带补装指引')
console.log('8. doctor 子命令(体检清单 + LLM key 让渡 + 报告落盘)OK')

// 9. calendar 子命令(issue #106/D-9:setup 状态面,禁止 env 控制产品行为)。
//    HOME 隔离到 tmp(os.homedir() 尊重 $HOME):状态文件 ~/.gotry/calendar.json
//    的 on/off/status 三态全部走真实 bootstrap 路径验证。
const calHome = mkdtempSync(join(tmpdir(), 'gotry-cal-test-'))
const calEnv = { HOME: calHome }
const c9a = runBootstrap(['calendar', '--status'], calEnv)
assert.equal(c9a.code, 0, `calendar --status(默认态)应 exit 0\n${c9a.out}`)
assert.ok(c9a.out.includes('默认未挂载'), '默认态=未挂载')
assert.ok(c9a.out.includes(join(calHome, '.gotry', 'calendar.json')), '状态文件路径可见')
const c9b = runBootstrap(['calendar'], calEnv)
assert.equal(c9b.code, 0, `calendar(开启)应 exit 0\n${c9b.out}`)
assert.ok(c9b.out.includes('已开启挂载'), '开启态输出')
assert.ok(c9b.out.includes('cordis.patch.yml'), '未配置时给 profile 配置指引')
const c9c = runBootstrap(['calendar', '--status'], calEnv)
assert.ok(c9c.out.includes('已挂载'), '开启后 --status 显示已挂载')
const c9d = runBootstrap(['doctor'], { ...calEnv, GOTRY_SETUP_SKIP: '1' })
assert.ok(c9d.out.includes('dsh-calendar'), 'doctor 清单含 calendar 项(setup 状态面)')
assert.ok(c9d.out.includes('已挂载但 calendar 未配置'), '开启未配置=doctor 可见')
const c9e = runBootstrap(['calendar', '--off'], calEnv)
assert.equal(c9e.code, 0, `calendar --off 应 exit 0\n${c9e.out}`)
assert.ok(c9e.out.includes('恢复默认不挂载'), '关闭态输出')
const c9f = runBootstrap(['calendar', '--status'], calEnv)
assert.ok(c9f.out.includes('默认未挂载'), '关闭后回到默认态')
console.log('9. calendar 子命令(setup 状态面 on/off/status + doctor 三态,HOME 隔离)OK')

// 10. 启动一次性 doctor 摘要(issue #114,design §3.1③):inner 在 dsh 启动前以分离
//     子进程跑 `doctor --summary`——有待处理项一行 stderr,全 ok 静默;零 header 零写盘,
//     恒 exit 0(不挡启动语义)。HOME 隔离到 tmp 保证缺失项确定性。
{
  const sumHome = mkdtempSync(join(tmpdir(), 'gotry-sum-test-'))
  const r = spawnSync('node', [bootstrap, 'doctor', '--summary'], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, HOME: sumHome },
  })
  assert.equal(r.status, 0, `doctor --summary 应恒 exit 0(不挡启动),实际 ${r.status}\n${r.stderr}`)
  assert.ok(!r.stdout.includes('报告已写'), 'summary 模式零写盘(不落 doctor-report.md)')
  assert.ok(!r.stdout.includes('[gotry-doctor]'), 'summary 模式零 header(stdout 静默)')
  assert.match(r.stderr, /\[gotry\] doctor: \d+ 项待处理/, '隔离 HOME 有缺失项 → 一行摘要进 stderr')
  assert.match(r.stderr, /gotry_doctor/, '摘要带对话内指路')
  assert.match(r.stderr, /扩展=缺/, '缺失项人话=缺(降级类=半可用)')
}
console.log('10. 启动一次性 doctor 摘要(--summary:stderr 一行/零写盘/恒 exit 0)OK')

// 11. setupSidebar 落盘状态复核(2026-09-08 安装链修复):pnpm ≥10.5 在 profile 目录
//     不执行依赖构建脚本,严格态(pnpm 11)下 ERR_PNPM_IGNORED_BUILDS exit 1——但包已
//     完整落盘。安装器必须按落盘状态(与 doctor 同口径)判成功,不以 dsh→pnpm 两层
//     转手的 exit code 误报失败。注入 attemptInstall 模拟「安装器失败但状态落盘」。
{
  const sbHome = mkdtempSync(join(tmpdir(), 'gotry-sidebar-test-'))
  const prevHome = process.env.HOME
  process.env.HOME = sbHome // os.homedir() 在 POSIX 尊重 $HOME
  try {
    const { setupSidebar } = await import(bootstrap)
    // 模拟 pnpm 严格态:包完整落盘后 exit 1(ERR_PNPM_IGNORED_BUILDS)——落盘动作
    // 发生在安装器内部,调用前 profile 是空的,才会走到「失败→复核」新路径
    const r = await setupSidebar(async () => {
      const sbPkgDir = join(sbHome, '.dsh/profiles/web/node_modules/dsh-better-sidebar')
      mkdirSync(sbPkgDir, { recursive: true })
      writeFileSync(join(sbPkgDir, 'package.json'), JSON.stringify({ name: 'dsh-better-sidebar', version: '0.18.0' }))
      return { ok: false, error: 'exit 1' }
    })
    assert.equal(r.ok, true, '安装器 exit 非 0 但状态已落盘 → 按落盘判成功(不误报失败)')
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
  }
}
console.log('11. setupSidebar 落盘状态复核(pnpm 忽略构建脚本 exit 1 不再误报)OK')

// --- issue #258 web 启动交互式 onboarding(隔离 HOME/state + 注入 fakes,永不跑真安装器/开浏览器)---
// 合成 doctor items(与 bin/gotry-bootstrap.js doctorChecks 的 label/level 同形),供 12-17 复用。
// 真实 doctor 不会同帧返回同一 label 的两态(hbcli 是单条 missing 或 degraded),故此处 hbcli
// 只取 missing 一态;degraded 分类在 12 里用独立 item 单测,避免 label-keyed Map 碰撞。
const onboardingItems = [
  { label: 'Node 运行时', level: 'ok', detail: 'Node 22.x', fix: undefined },
  { label: 'GoTry Session Bridge 扩展', level: 'missing', detail: '未安装', fix: 'https://chromewebstore...' },
  { label: 'Agent Reach(网页/社媒读取)', level: 'missing', detail: '未装配', fix: 'npx @danceiny/gotry doctor --fix' },
  { label: 'hbcli(酒店实时源)', level: 'missing', detail: '未安装', fix: 'npx @danceiny/gotry doctor --fix' },
  { label: 'FlyAI(飞猪官方检索)', level: 'degraded', detail: '未配 FLYAI_API_KEY', fix: '到 flyai 控制台申请 key' },
  { label: 'dsh-better-sidebar(侧栏工作台)', level: 'missing', detail: '未安装', fix: 'npx @danceiny/gotry doctor --fix' },
  { label: 'dsh-calendar(日历工作窗口)', level: 'degraded', detail: '已挂载未配置 username', fix: 'cordis.patch.yml 覆盖 config' },
  { label: 'dsh-map-tools(地图/路线/POI)', level: 'missing', detail: '未随包解析', fix: '重装 @danceiny/gotry' },
  { label: 'dsh-tool-ask-user(结构化澄清卡)', level: 'missing', detail: '未解析', fix: '重装 @danceiny/gotry' },
  { label: 'LLM key', level: 'ok', detail: '由 dsh 宿主管', fix: undefined },
]
const hbcliDegraded = { label: 'hbcli(酒店实时源)', level: 'degraded', detail: '凭证未配置', fix: 'hbcli auth set-credentials ...' }

// 12. onboarding 纯函数分类与计划:classifyDoctorGap / buildOnboardingPlan(合成 items,不依赖真机)
{
  const { classifyDoctorGap, buildOnboardingPlan } = await import(bootstrap)
  assert.equal(classifyDoctorGap(onboardingItems[0]), 'ok')
  assert.equal(classifyDoctorGap(onboardingItems[1]), 'user-action')   // 扩展 = 浏览器商店
  assert.equal(classifyDoctorGap(onboardingItems[2]), 'auto')         // reach = pip 可装
  assert.equal(classifyDoctorGap(onboardingItems[3]), 'auto')         // hbcli missing = npm 可装
  assert.equal(classifyDoctorGap(hbcliDegraded), 'user-action')       // hbcli degraded = 凭证(用户操作)
  assert.equal(classifyDoctorGap(onboardingItems[4]), 'user-action')   // flyai = 上游 key
  assert.equal(classifyDoctorGap(onboardingItems[5]), 'auto')         // sidebar = dsh plugin 可装
  assert.equal(classifyDoctorGap(onboardingItems[6]), 'user-action')  // calendar = profile 配置
  assert.equal(classifyDoctorGap(onboardingItems[7]), 'unavailable')  // map-tools = 重装 gotry
  assert.equal(classifyDoctorGap(onboardingItems[8]), 'unavailable')  // ask-user = 重装 gotry
  assert.equal(classifyDoctorGap(onboardingItems[9]), 'ok')           // LLM key 永远 ok
  // env opt-out(GOTRY_SETUP_*=0)→ unavailable,不冒充 auto;env 注入,不依赖 ambient GOTRY_SETUP_*
  assert.equal(classifyDoctorGap(onboardingItems[2], { env: { GOTRY_SETUP_REACH: '0' } }), 'unavailable', 'reach opt-out → unavailable')
  assert.equal(classifyDoctorGap(onboardingItems[3], { env: { GOTRY_SETUP_HBCLI: '0' } }), 'unavailable', 'hbcli opt-out → unavailable')
  assert.equal(classifyDoctorGap(onboardingItems[5], { env: { GOTRY_SETUP_SIDEBAR: '0' } }), 'unavailable', 'sidebar opt-out → unavailable')
  assert.equal(classifyDoctorGap(onboardingItems[2], { platform: 'win32', env: { GOTRY_SETUP_REACH: '0' } }), 'unavailable', 'opt-out + win32 仍 unavailable')
  const plan = buildOnboardingPlan(onboardingItems)
  assert.equal(plan.promptable, true, '有可自动安装缺项 → promptable')
  assert.equal(plan.auto.length, 3, 'auto = reach + hbcli-missing + sidebar')
  assert.equal(plan.userAction.length, 3, 'user-action = 扩展 + flyai + calendar')
  assert.equal(plan.unavailable.length, 2, 'unavailable = map-tools + ask-user')
  // env opt-out 计划:三项 auto 全 opt-out → promptable=false,auto 空,三项进 unavailable(原 detail,非 win32 不叠平台原因)
  const planOptOut = buildOnboardingPlan(onboardingItems, { env: { GOTRY_SETUP_REACH: '0', GOTRY_SETUP_HBCLI: '0', GOTRY_SETUP_SIDEBAR: '0' } })
  assert.equal(planOptOut.promptable, false, '三项全 opt-out → 无 auto → 不 prompt')
  assert.equal(planOptOut.auto.length, 0)
  const optOutLabels = new Set((planOptOut.unavailable as Array<{ label: string }>).map((g) => g.label))
  assert.ok(optOutLabels.has('Agent Reach(网页/社媒读取)'), 'reach opt-out 进 unavailable')
  assert.ok(optOutLabels.has('hbcli(酒店实时源)'), 'hbcli opt-out 进 unavailable')
  assert.ok(optOutLabels.has('dsh-better-sidebar(侧栏工作台)'), 'sidebar opt-out 进 unavailable')
  // 全健康 → promptable=false(不弹问)
  const planOk = buildOnboardingPlan(onboardingItems.map((i) => ({ ...i, level: 'ok' })))
  assert.equal(planOk.promptable, false)
  assert.equal(planOk.auto.length, 0)
  assert.equal(planOk.userAction.length, 0)
  assert.equal(planOk.unavailable.length, 0)
}
console.log('12. onboarding 分类与计划(classifyDoctorGap/buildOnboardingPlan,合成 items + env opt-out + 全健康)OK')

// 13. onboardingSkipReason(纯函数):非 TTY / CI / benchmark / opt-out / non-web 全跳过,可 prompt 态返回 null
{
  const { onboardingSkipReason } = await import(bootstrap)
  assert.equal(onboardingSkipReason({ mode: 'headless' }), 'non-web-mode')
  assert.equal(onboardingSkipReason({ mode: 'web', benchmark: true }), 'benchmark')
  assert.equal(onboardingSkipReason({ mode: 'web', env: { GOTRY_SETUP_SKIP: '1' }, isTTY: true }), 'GOTRY_SETUP_SKIP=1')
  assert.equal(onboardingSkipReason({ mode: 'web', env: { GOTRY_ONBOARDING_SKIP: '1' }, isTTY: true }), 'GOTRY_ONBOARDING_SKIP=1')
  assert.equal(onboardingSkipReason({ mode: 'web', env: { CI: '1' }, isTTY: true }), 'CI')
  assert.equal(onboardingSkipReason({ mode: 'web', env: {}, argv: ['x', '--no-onboarding'], isTTY: true }), '--no-onboarding')
  assert.equal(onboardingSkipReason({ mode: 'web', env: {}, isTTY: false }), 'non-tty')
  assert.equal(onboardingSkipReason({ mode: 'web', env: {}, isTTY: true }), null, '可 prompt')
  // bootstrap 直接调用(mode 缺省)只检 env/argv/isTTY —— 用于 onboarding 子命令自身的防御
  assert.equal(onboardingSkipReason({ env: {}, isTTY: true }), null)
  assert.equal(onboardingSkipReason({ env: {}, isTTY: false }), 'non-tty')
}
console.log('13. onboardingSkipReason(非 TTY/CI/benchmark/--no-onboarding/SKIP 跳过 + 可 prompt)OK')

// 14. runOnboardingFix yes 路径:注入 fakes → auto 全 installed,user-action/unavailable 不动(不跑真安装器)
{
  const { buildOnboardingPlan, runOnboardingFix } = await import(bootstrap)
  const plan = buildOnboardingPlan(onboardingItems)
  const calls: string[] = []
  const fakeInstallers = {
    hbcli: async () => { calls.push('hbcli'); return { ok: true } },
    reach: async () => { calls.push('reach'); return { ok: true } },
    sidebar: async () => { calls.push('sidebar'); return { ok: true } },
  }
  const fakeRecheck = async () => onboardingItems.map((i) => ({ ...i, level: 'ok' }))
  const results = await runOnboardingFix(plan, { installers: fakeInstallers, recheck: fakeRecheck })
  assert.deepEqual(calls.slice().sort(), ['hbcli', 'reach', 'sidebar'], '三个 auto 安装器各调一次')
  assert.equal(calls.length, 3, '不重复安装,无额外调用')
  const byLabel = new Map(results.map((r: OnboardingFixResult) => [r.label, r]) as Array<[string, OnboardingFixResult]>)
  assert.equal(byLabel.get('Agent Reach(网页/社媒读取)')!.status, 'installed')
  assert.equal(byLabel.get('hbcli(酒店实时源)')!.status, 'installed')
  assert.equal(byLabel.get('dsh-better-sidebar(侧栏工作台)')!.status, 'installed')
  assert.equal(byLabel.get('GoTry Session Bridge 扩展')!.status, 'needs-user-action')
  assert.equal(byLabel.get('FlyAI(飞猪官方检索)')!.status, 'needs-user-action')
  assert.equal(byLabel.get('dsh-calendar(日历工作窗口)')!.status, 'needs-user-action')
  assert.equal(byLabel.get('dsh-map-tools(地图/路线/POI)')!.status, 'unavailable')
  assert.equal(byLabel.get('dsh-tool-ask-user(结构化澄清卡)')!.status, 'unavailable')
}
console.log('14. runOnboardingFix yes 路径(注入 fakes → auto=installed,余者不动,不跑真安装器)OK')

// 15. partial failure:hbcli 安装器失败 → 'unavailable' + 重试命令;reach/sidebar 仍 installed,不挡 web
{
  const { buildOnboardingPlan, runOnboardingFix } = await import(bootstrap)
  const plan = buildOnboardingPlan(onboardingItems)
  const fakeInstallers = {
    hbcli: async () => ({ ok: false, error: 'npm install timeout' }),
    reach: async () => ({ ok: true }),
    sidebar: async () => ({ ok: true }),
  }
  // 复检:hbcli 仍 missing(安装失败未装上),reach/sidebar 已 ok
  const fakeRecheck = async () => onboardingItems.map((i) => i.label.startsWith('hbcli') ? i : { ...i, level: 'ok' })
  const results = await runOnboardingFix(plan, { installers: fakeInstallers, recheck: fakeRecheck })
  const byLabel = new Map(results.map((r: OnboardingFixResult) => [r.label, r]) as Array<[string, OnboardingFixResult]>)
  const hbcliRes = byLabel.get('hbcli(酒店实时源)')!
  assert.equal(hbcliRes.status, 'unavailable', '安装失败 → unavailable(诚实,不冒充 installed)')
  assert.match(hbcliRes.reason!, /npm install timeout/, '失败原因透传')
  assert.equal(hbcliRes.retry, 'npx @danceiny/gotry doctor --fix', '给可重试命令')
  assert.equal(byLabel.get('Agent Reach(网页/社媒读取)')!.status, 'installed', '部分失败不挡其余')
  assert.equal(byLabel.get('dsh-better-sidebar(侧栏工作台)')!.status, 'installed')
}
console.log('15. partial failure(一项失败 → unavailable+重试命令,不挡其余已装项)OK')

// 16. idempotent retry:首次修复后复检全健康 → 新计划 promptable=false → 再跑零安装器调用(幂等)
{
  const { buildOnboardingPlan, runOnboardingFix } = await import(bootstrap)
  const plan1 = buildOnboardingPlan(onboardingItems)
  const calls: string[] = []
  const fakeInstallers = {
    hbcli: async () => { calls.push('hbcli'); return { ok: true } },
    reach: async () => { calls.push('reach'); return { ok: true } },
    sidebar: async () => { calls.push('sidebar'); return { ok: true } },
  }
  const allOk = async () => onboardingItems.map((i) => ({ ...i, level: 'ok' }))
  await runOnboardingFix(plan1, { installers: fakeInstallers, recheck: allOk })
  // 再跑:复检全 ok → 新计划无 auto → 不调任何安装器
  const plan2 = buildOnboardingPlan(await allOk())
  assert.equal(plan2.promptable, false, '全健康 → 不再 prompt')
  assert.equal(plan2.auto.length, 0)
  const callsBefore = calls.length
  const results2 = await runOnboardingFix(plan2, { installers: fakeInstallers, recheck: allOk })
  assert.equal(calls.length, callsBefore, '已健康项不重装(幂等,零安装器调用)')
  assert.equal(results2.length, 0, '无缺项 → 无结果')
}
console.log('16. idempotent retry(已健康项不再重装,安装器零调用)OK')

// 17. promptOnboarding yes/no/默认-no(注入流,不读真 stdin,不开浏览器)
{
  const { buildOnboardingPlan, promptOnboarding } = await import(bootstrap)
  const { PassThrough } = await import('node:stream')
  const plan = buildOnboardingPlan(onboardingItems)
  const sink = { write: () => true }
  // yes
  const yesIn = new PassThrough()
  const yesOut: string[] = []
  const yesP = promptOnboarding(plan, { input: yesIn, output: { write: (s: string) => { yesOut.push(s); return true } } })
  yesIn.end('y\n')
  assert.equal(await yesP, 'yes')
  assert.ok(yesOut.join('').includes('y/N'), 'prompt 文案含 y/N')
  assert.ok(yesOut.join('').includes('Agent Reach'), 'prompt 列出可自动配置项')
  // no
  const noIn = new PassThrough()
  const noP = promptOnboarding(plan, { input: noIn, output: sink })
  noIn.end('n\n')
  assert.equal(await noP, 'no')
  // 默认 no(空行)
  const emptyIn = new PassThrough()
  const emptyP = promptOnboarding(plan, { input: emptyIn, output: sink })
  emptyIn.end('\n')
  assert.equal(await emptyP, 'no', '空行默认 = no(立即继续 web)')
}
console.log('17. promptOnboarding yes/no/默认-no(注入流,不读真 stdin)OK')

// 18. onboarding CLI 跳过:非 TTY / CI / GOTRY_SETUP_SKIP / GOTRY_ONBOARDING_SKIP → 零 prompt 零安装,恒 exit 0
//     execFileSync 的 stdin 是 pipe(非 TTY),自然走 non-tty 跳过;CI/SKIP env 各自短路。
{
  const isolated = mkdtempSync(join(tmpdir(), 'gotry-onboard-skip-'))
  const r1 = runBootstrap(['onboarding'], { HOME: isolated })
  assert.equal(r1.code, 0, `非 TTY onboarding 应 exit 0\n${r1.out}`)
  assert.ok(!r1.out.includes('y/N'), '非 TTY 不应 prompt')
  assert.ok(!r1.out.includes('开始自动配置'), '非 TTY 不应安装')
  const r2 = runBootstrap(['onboarding'], { HOME: isolated, CI: '1' })
  assert.equal(r2.code, 0); assert.ok(!r2.out.includes('y/N'))
  const r3 = runBootstrap(['onboarding'], { HOME: isolated, GOTRY_SETUP_SKIP: '1' })
  assert.equal(r3.code, 0); assert.ok(!r3.out.includes('y/N'))
  const r4 = runBootstrap(['onboarding'], { HOME: isolated, GOTRY_ONBOARDING_SKIP: '1' })
  assert.equal(r4.code, 0); assert.ok(!r4.out.includes('y/N'))
}
console.log('18. onboarding CLI 跳过(非 TTY / CI / GOTRY_SETUP_SKIP / GOTRY_ONBOARDING_SKIP,零 prompt 零安装)OK')

// 19. onboarding --scan:临时包 fixture + 隔离 HOME + 受控 PATH → 确定性只读计划(零 prompt 零安装,不写 gotry-state)
//     PATH 不能直接置空(execFileSync 用 child env.PATH 解析 'node',空则 ENOENT)——
//     故前置 node bin 目录(execPath dirname)再接一个空目录:node 可解析、hbcli/python3 不可达;
//     隔离 HOME 排除真机 extension/sidebar/calendar。reach 检测键在 repoRoot/.venv,而 bootstrap 的
//     repoRoot 取自自身文件位置——HOME 隔离不了它:开发者 worktree 常已装 agent-reach(.venv 就位
//     → reach=ok,不进 auto 桶),「fresh checkout 无 .venv」假设不可依赖(2026-09-09 实测创始机
//     即中招)。故照 §21 的临时安装包 fixture 模式:bin/ 拷贝 + 随包 vendor 负载(map-tools/
//     ask-user)软链进 fixture,repoRoot 指 fixture → .venv 恒缺失(reach missing → auto),
//     payload 仍「随包就位」(非 unavailable),任意机器确定性。
{
  const isolated = mkdtempSync(join(tmpdir(), 'gotry-onboard-scan-'))
  const emptyPath = mkdtempSync(join(tmpdir(), 'gotry-empty-path-'))
  const fixture = mkdtempSync(join(tmpdir(), 'gotry-onboard-pkg-'))
  mkdirSync(join(fixture, 'bin'), { recursive: true })
  copyFileSync(bootstrap, join(fixture, 'bin', 'gotry-bootstrap.js'))
  copyFileSync(join(repoRoot, 'package.json'), join(fixture, 'package.json'))
  const vendorDir = join(fixture, 'ts', 'dsh-runtime', 'vendor')
  mkdirSync(vendorDir, { recursive: true })
  symlinkSync(join(repoRoot, 'ts/dsh-runtime/vendor/dsh-map-tools'), join(vendorDir, 'dsh-map-tools'))
  symlinkSync(join(repoRoot, 'ts/dsh-runtime/vendor/deepseek-ai-dsh-tool-ask-user'), join(vendorDir, 'deepseek-ai-dsh-tool-ask-user'))
  const safePath = `${dirname(process.execPath)}${delimiter}${emptyPath}`
  const r = runBootstrap(['onboarding', '--scan'], {
    HOME: isolated,
    PATH: safePath,
    FLYAI_API_KEY: '',
    GOTRY_SETUP_HBCLI: '',
    GOTRY_SETUP_REACH: '',
    GOTRY_SETUP_SIDEBAR: '',
  }, join(fixture, 'bin', 'gotry-bootstrap.js'))
  assert.equal(r.code, 0, `--scan 应 exit 0\n${r.out}`)
  assert.ok(!r.out.includes('y/N'), '--scan 不应 prompt')
  assert.ok(!r.out.includes('开始自动配置'), '--scan 不应安装')
  const plan = JSON.parse(r.out.trim().split('\n').pop()!)
  assert.equal(plan.promptable, true)
  const autoLabels: string[] = plan.auto.map((g: { label: string }) => g.label)
  assert.ok(autoLabels.includes('dsh-better-sidebar(侧栏工作台)'), 'sidebar missing(隔离 HOME)→ auto')
  assert.ok(autoLabels.includes('hbcli(酒店实时源)'), 'hbcli missing(空 PATH)→ auto')
  assert.ok(autoLabels.includes('Agent Reach(网页/社媒读取)'), 'reach missing(fixture 无 .venv)→ auto')
  const userActionLabels: string[] = plan.userAction.map((g: { label: string }) => g.label)
  assert.ok(userActionLabels.includes('GoTry Session Bridge 扩展'), '扩展 missing(隔离 HOME)→ user-action(浏览器商店)')
  assert.ok(userActionLabels.includes('FlyAI(飞猪官方检索)'), 'flyai 无 key → user-action')
  assert.ok(!plan.unavailable.some((g: { label: string }) => g.label.startsWith('dsh-map-tools')), 'map-tools 随包就位 → 非 unavailable')
  assert.ok(!plan.unavailable.some((g: { label: string }) => g.label.startsWith('dsh-tool-ask-user')), 'ask-user 随包就位 → 非 unavailable')
}
console.log('19. onboarding --scan(临时包 fixture + 隔离 HOME + 受控 PATH,确定性只读计划,零 prompt 零安装)OK')

// --- issue #258 E2E launch-boundary(orchestrateWebLaunch × 注入依赖,跨 inner→onboarding→web 边界)---
// 20. 生产编排缝覆盖:orchestrateWebLaunch 是 inner 启动 web 的真实编排(跳过判定 → onboarding →
//     后台摘要 → dsh web)。进程内用真实 runOnboarding(注入 scan/installers/stdin/isTTY/platform/env)
//     + 假 launchWeb 标记,证明 yes/no/非 TTY/部分失败/摘要抑制/win32 reported 六条路径都跨过边界且
//     到达 web 启动标记。隔离:合成 items + 假安装器 + 假复检 + 注入流,永不跑真安装器/开浏览器/spawn 真 dsh。
//     失败模式:任一路径未到达 launchWeb = 编排回归(用户卡在 onboarding 进不到 web)。
{
  const { orchestrateWebLaunch, runOnboarding } = await import(bootstrap)
  const { PassThrough } = await import('node:stream')
  const sink = { write: () => true }
  const noSummary = () => {}
  // 共享 fakes:okInstallers 记录调用顺序;allOkRecheck 模拟安装后复检全绿。
  const okInstallers = (calls: string[] = []) => ({
    hbcli: async () => { calls.push('hbcli'); return { ok: true } },
    reach: async () => { calls.push('reach'); return { ok: true } },
    sidebar: async () => { calls.push('sidebar'); return { ok: true } },
  })
  const allOkRecheck = async () => onboardingItems.map((i) => ({ ...i, level: 'ok' as const }))
  // launchWeb 标记:被调到即证明编排到达 web 启动边界(不 spawn 真 dsh)
  const makeLaunchWeb = () => { let n = 0; return { fn: async () => { n += 1; return { launched: true } }, count: () => n } }
  // 真实 runOnboarding(bootstrap)包成 orchestrateWebLaunch 依赖:注入合成 items/假安装器/假复检/流,
  // 强制 isTTY=true + 干净 env → 跨过真实 onboarding 逻辑。platform 默认 darwin。
  const wire = (o: {
    input: InstanceType<typeof PassThrough>
    installers?: Record<string, () => Promise<{ ok: boolean; error?: string }>>
    recheck?: () => Promise<typeof onboardingItems>
    platform?: string
    env?: Record<string, string>
  }) =>
    async () => runOnboarding([], {
      scan: async () => onboardingItems,
      isTTY: true, env: o.env ?? {}, argv: ['node', 'gotry-inner.js', 'web'],
      input: o.input, output: sink,
      installers: o.installers, recheck: o.recheck,
      platform: o.platform ?? 'darwin',
    }) as Promise<OnboardingResult>

  // 20a. interactive yes + 假成功安装器 → 三项 installed,launchWeb 到达 1 次
  {
    const lw = makeLaunchWeb()
    const yesIn = new PassThrough(); yesIn.end('y\n')
    const calls: string[] = []
    const r = await orchestrateWebLaunch({
      onboardingSkip: null,
      runOnboarding: wire({ input: yesIn, installers: okInstallers(calls), recheck: allOkRecheck }),
      runSummary: noSummary, launchWeb: lw.fn,
    })
    assert.equal(r.launched, true, 'yes 路径到达 web 启动标记')
    assert.equal(lw.count(), 1, 'launchWeb 恰好调一次')
    assert.equal(r.onboardingPrompted, true)
    assert.equal(r.onboardingResult!.answered, 'yes')
    assert.deepEqual(calls.slice().sort(), ['hbcli', 'reach', 'sidebar'], '三个假安装器各调一次')
    const installed = (r.onboardingResult!.results! as OnboardingFixResult[]).filter((x) => x.status === 'installed')
    assert.equal(installed.length, 3, '三项 auto 缺项 installed')
    assert.ok((r.onboardingResult!.results! as OnboardingFixResult[]).every((x) => ['installed', 'needs-user-action', 'unavailable'].includes(x.status)), '三态结果齐全')
  }
  console.log('20a. E2E yes + 假成功安装器 → 三项 installed,到达 web 启动标记 OK')

  // 20b. interactive refusal → 零安装器调用(零安装副作用),launchWeb 仍到达
  {
    const lw = makeLaunchWeb()
    const noIn = new PassThrough(); noIn.end('n\n')
    const calls: string[] = []
    const r = await orchestrateWebLaunch({
      onboardingSkip: null,
      runOnboarding: wire({ input: noIn, installers: okInstallers(calls) }),
      runSummary: noSummary, launchWeb: lw.fn,
    })
    assert.equal(r.launched, true, 'no 路径仍到达 web 启动标记')
    assert.equal(lw.count(), 1)
    assert.equal(r.onboardingPrompted, true)
    assert.equal(r.onboardingResult!.answered, 'no')
    assert.equal(calls.length, 0, '拒绝 → 零安装器调用,零安装副作用')
  }
  console.log('20b. E2E interactive refusal → 零安装副作用,仍到达 web OK')

  // 20c. non-TTY → onboardingSkip='non-tty' → runOnboarding 不被调(零 prompt 零安装),launchWeb 到达
  {
    const lw = makeLaunchWeb()
    let onboardingCalled = 0
    const r = await orchestrateWebLaunch({
      onboardingSkip: 'non-tty',
      runOnboarding: async () => { onboardingCalled += 1; return { prompted: false } },
      runSummary: noSummary, launchWeb: lw.fn,
    })
    assert.equal(r.launched, true, '非 TTY 仍到达 web 启动标记')
    assert.equal(lw.count(), 1)
    assert.equal(onboardingCalled, 0, '非 TTY → runOnboarding 不被调(零 prompt 零安装)')
    assert.equal(r.onboardingPrompted, false)
  }
  console.log('20c. E2E non-TTY → 零 prompt 零安装,仍到达 web OK')

  // 20d. partial installer failure(hbcli 失败)→ 仍到达 web;hbcli unavailable+重试,reach/sidebar installed
  {
    const lw = makeLaunchWeb()
    const yesIn = new PassThrough(); yesIn.end('y\n')
    const installers = {
      hbcli: async () => ({ ok: false, error: 'npm install timeout' }),
      reach: async () => ({ ok: true }),
      sidebar: async () => ({ ok: true }),
    }
    const recheck = async () => onboardingItems.map((i) => i.label.startsWith('hbcli') ? i : { ...i, level: 'ok' as const })
    const r = await orchestrateWebLaunch({
      onboardingSkip: null,
      runOnboarding: wire({ input: yesIn, installers, recheck }),
      runSummary: noSummary, launchWeb: lw.fn,
    })
    assert.equal(r.launched, true, '部分失败仍到达 web 启动标记')
    assert.equal(lw.count(), 1)
    const byLabel = new Map((r.onboardingResult!.results! as OnboardingFixResult[]).map((x) => [x.label, x] as [string, OnboardingFixResult]))
    assert.equal(byLabel.get('hbcli(酒店实时源)')!.status, 'unavailable', 'hbcli 安装失败 → unavailable(诚实)')
    assert.match(byLabel.get('hbcli(酒店实时源)')!.reason!, /npm install timeout/, '失败原因透传')
    assert.equal(byLabel.get('hbcli(酒店实时源)')!.retry, 'npx @danceiny/gotry doctor --fix', '给重试命令')
    assert.equal(byLabel.get('Agent Reach(网页/社媒读取)')!.status, 'installed', '部分失败不挡其余')
    assert.equal(byLabel.get('dsh-better-sidebar(侧栏工作台)')!.status, 'installed')
  }
  console.log('20d. E2E partial failure → hbcli unavailable+重试,reach/sidebar installed,仍到达 web OK')

  // 20e. 摘要抑制:onboarding prompt 过或 reported 过 → runSummary 不调;两者皆无 → 保留
  //      失败模式:prompted/reported 后仍跑摘要 = 重复打扰(分类计划 + 一行摘要叠显)。
  {
    // prompted(yes 路径)→ 抑制
    const lw1 = makeLaunchWeb()
    let sum1 = 0
    const yesIn = new PassThrough(); yesIn.end('y\n')
    await orchestrateWebLaunch({
      onboardingSkip: null,
      runOnboarding: wire({ input: yesIn, installers: okInstallers(), recheck: allOkRecheck }),
      runSummary: () => { sum1 += 1 }, launchWeb: lw1.fn,
    })
    assert.equal(sum1, 0, 'prompted → 后台摘要抑制')
    // reported(已渲染分类计划,如 win32 无 auto)→ 抑制
    const lw2 = makeLaunchWeb()
    let sum2 = 0
    await orchestrateWebLaunch({
      onboardingSkip: null,
      runOnboarding: async () => ({ prompted: false, reported: true, plan: { promptable: false, auto: [], userAction: [], unavailable: [] } }),
      runSummary: () => { sum2 += 1 }, launchWeb: lw2.fn,
    })
    assert.equal(sum2, 0, 'reported → 后台摘要抑制(不重复分类计划)')
    // 皆无(全健康,prompted=false 无 reported)→ 保留(全健康时摘要本身静默,此处只验调用)
    const lw3 = makeLaunchWeb()
    let sum3 = 0
    await orchestrateWebLaunch({
      onboardingSkip: null,
      runOnboarding: async () => ({ prompted: false, plan: { promptable: false, auto: [], userAction: [], unavailable: [] } }),
      runSummary: () => { sum3 += 1 }, launchWeb: lw3.fn,
    })
    assert.equal(sum3, 1, '未 prompt 未 reported → 后台摘要保留')
  }
  console.log('20e. E2E 摘要抑制(prompted 或 reported → 不重复;皆无 → 保留)OK')

  // 20f. win32 interactive 无 auto 缺项 → 渲染分类计划(unavailable + user-action 带具体 Windows 原因),
  //      不 prompt 不安装,reported:true。断言实际可见性:输出含分类行与平台原因,不含 y/N。
  //      失败模式:win32 缺项只进内部 plan 不渲染 = 用户看不到分类与原因(分类可见性回归)。
  {
    const lw = makeLaunchWeb()
    const out: string[] = []
    const output = { write: (s: string) => { out.push(s); return true } }
    const calls: string[] = []
    const r = await orchestrateWebLaunch({
      onboardingSkip: null,
      runOnboarding: async () => runOnboarding([], {
        scan: async () => onboardingItems,
        isTTY: true, env: {}, argv: ['node', 'gotry-inner.js', 'web'],
        input: new PassThrough(), output,
        installers: okInstallers(calls), platform: 'win32',
      }) as Promise<OnboardingResult>,
      runSummary: noSummary, launchWeb: lw.fn,
    })
    assert.equal(lw.count(), 1, 'win32 reported 路径仍到达 web 启动标记')
    assert.equal(r.onboardingResult!.prompted, false, 'win32 无 auto → 不 prompt')
    assert.equal(r.onboardingResult!.reported, true, 'win32 有 reportable 缺项 → reported:true')
    assert.equal(calls.length, 0, 'win32 reported → 零安装器调用')
    const visible = out.join('')
    assert.ok(!visible.includes('y/N'), 'reported 路径不 prompt(无 y/N)')
    assert.ok(!visible.includes('开始自动配置'), 'reported 路径不安装')
    // unavailable 项带 Windows 平台具体原因(诚实,不冒充 auto / 不给无效的 doctor --fix 指引)
    assert.ok(visible.includes('hbcli(酒店实时源)'), '渲染 hbcli 不可用行')
    assert.match(visible, /Windows[^\n]*hbcli/, 'hbcli 行带 Windows 原因')
    assert.ok(visible.includes('Agent Reach(网页/社媒读取)'), '渲染 reach 不可用行')
    assert.match(visible, /Windows[^\n]*agent-reach/, 'reach 行带 Windows 原因')
    assert.ok(visible.includes('dsh-better-sidebar(侧栏工作台)'), '渲染 sidebar 不可用行')
    assert.match(visible, /Windows[^\n]*dsh-better-sidebar/, 'sidebar 行带 Windows 原因')
    // user-action 项平台无关,仍渲染(扩展商店/flyai key/calendar)
    assert.ok(visible.includes('GoTry Session Bridge 扩展'), '渲染扩展 user-action 行')
    assert.ok(visible.includes('FlyAI(飞猪官方检索)'), '渲染 flyai user-action 行')
    assert.ok(visible.includes('dsh-calendar(日历工作窗口)'), '渲染 calendar user-action 行')
  }
  console.log('20f. E2E win32 reported → 渲染分类计划(带 Windows 原因)+ reported:true + 零安装,仍到达 web OK')
}
console.log('20. E2E launch-boundary(orchestrateWebLaunch × yes/no/non-TTY/partial-failure/摘要抑制/win32 reported,假 web 启动标记)OK')

// 21. spawned inner in a temporary installed-package fixture(真实跨进程 inner→bootstrap onboarding→dsh web 边界)。
//     不变量:全隔离在 temp 内,永不碰共享 ts/dsh-runtime/gotry-state 或真 dsh。确定性临时安装包
//     (无 .git → installed-package 模式):复制生产 bin/gotry-{inner,bootstrap,runtime-resolution}.js +
//     cordis.gotry-patch.yml(精确提交文件,不改生产代码);造 dist/src/index.js 占位;造假 @deepseek-ai/dsh
//     (lib/bin.js 写 web-launch 标记后逗留 1.5s 再 exit——给被误启动的 detached doctor --summary 在 stderr
//     露面窗口,使「摘要抑制」断言可信)。fixture-local CJS NODE_OPTIONS preload 让被 spawn 的 inner 与
//     bootstrap 子进程都认为 stdin 是 TTY,使 onboarding 走可 prompt 的生产路径(stdin 仍是 pipe,可喂确定性答案)。
//
//     21a(TTY eligible,喂 "n"):先观察到真实 prompt 再喂答案 → 断言 prompt 恰好一次、无安装/结果行、
//       假 dsh 恰好一次收到 web+--no-open、后台摘要被抑制、TMPDIR 无 gotry-onboarding-* 残留。
//     21b(non-TTY,无 preload):stdin pipe → onboarding 跳过 → 断言零 prompt、假 dsh 恰好一次。
//     21c(POSIX 信号,仅非 win32):不喂答案,onboarding 阻塞等输入;先观察到 prompt,向父进程单独发
//       SIGTERM,等终止 → 断言 TMPDIR 无 gotry-onboarding-* 与 gotry-cordis-* 残留、进程组无残留子进程、
//       假 dsh 未被调用。超时 = FAIL(非 skip)。win32 仅跳过信号子例。
//     21d(生产 onboarding 超时上界):TTY eligible + GOTRY_ONBOARDING_CHILD_TIMEOUT_MS=1000 + 不喂输入 →
//       onboarding 挂起;断言 1s 超时后 inner 继续 web(假 dsh 启动)、无 gotry-onboarding-* 残留、exit 0。
//     21f(POSIX yes 安装期间信号):喂 "y" 进入真实 setupHbcli → fake bash installer 睡眠;只向父进程
//       SIGTERM,断言 inner/onboarding/bootstrap/installer 子树 bounded reap,假 dsh 未启动,无 temp/process 残留。
//     21g(POSIX yes 安装期间 onboarding timeout):喂 "y" 进入 stubborn fake installer,等 child ready 后由 5s timeout 触发,
//       断言 outer grace 覆盖 bootstrap installer TERM+SIGKILL budget,installer 子树死净且继续 web。
function buildPkgFixture(tmpRoot: string) {
  const pkgRoot = join(tmpRoot, 'pkg')
  const pkgBin = join(pkgRoot, 'bin')
  const pkgDist = join(pkgRoot, 'dist', 'src')
  const dshDir = join(pkgRoot, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(pkgBin, { recursive: true })
  mkdirSync(pkgDist, { recursive: true })
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), `${JSON.stringify({ name: 'gotry', version: '0.0.1-test', type: 'module' })}\n`)
  copyFileSync(join(repoRoot, 'bin', 'gotry-inner.js'), join(pkgBin, 'gotry-inner.js'))
  copyFileSync(join(repoRoot, 'bin', 'gotry-bootstrap.js'), join(pkgBin, 'gotry-bootstrap.js'))
  copyFileSync(join(repoRoot, 'bin', 'gotry-runtime-resolution.js'), join(pkgBin, 'gotry-runtime-resolution.js'))
  copyFileSync(join(repoRoot, 'bin', 'gotry-process-liveness.js'), join(pkgBin, 'gotry-process-liveness.js'))
  copyFileSync(join(repoRoot, 'cordis.gotry-patch.yml'), join(pkgRoot, 'cordis.gotry-patch.yml'))
  writeFileSync(join(pkgDist, 'index.js'), 'export {}\n')
  writeFileSync(join(dshDir, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.1', type: 'module' })}\n`)
  const markerPath = join(tmpRoot, 'dsh-web-launch.log')
  // 假 dsh:写标记后逗留 1.5s 再 exit——若 detached doctor --summary 被误启动,会在此窗口向 stderr(继承)露面。
  writeFileSync(join(dshDir, 'lib', 'bin.js'),
`import { appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ args }) + '\\n')
console.log('[fake-dsh] web launch', JSON.stringify(args))
await sleep(Number.parseInt(process.env.FAKE_DSH_SLEEP_MS || '1500', 10))
process.exit(0)
`)
  // fixture-local CJS preload:让 inner 与 bootstrap 子进程认为 stdin 是 TTY,使 onboarding 走可 prompt 路径。
  // 仅作用于本临时 fixture,不复制/修改生产代码。
  const preloadPath = join(pkgRoot, 'fixture-tty-preload.cjs')
  writeFileSync(preloadPath,
`'use strict'
// fixture-only: make spawned children think stdin is a TTY so onboarding is eligible.
try { Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true }) } catch (e) {}
`)
  const cwdDir = join(tmpRoot, 'cwd')
  const homeDir = join(tmpRoot, 'home')
  const tmpDir = join(tmpRoot, 'tmp')
  const emptyDir = join(tmpRoot, 'empty-path')
  mkdirSync(cwdDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(emptyDir, { recursive: true })
  const safePath = `${dirname(process.execPath)}${delimiter}${emptyDir}`
  return { pkgRoot, pkgBin, markerPath, preloadPath, cwdDir, homeDir, tmpDir, safePath }
}

function addSleepingInstallerFixture(tmpRoot: string, fixture: ReturnType<typeof buildPkgFixture>) {
  const fakeBin = join(tmpRoot, 'fake-installer-bin')
  const installerMarkerPath = join(tmpRoot, 'sleeping-installer.log')
  const stubbornScriptPath = join(tmpRoot, 'stubborn-installer-child.js')
  mkdirSync(fakeBin, { recursive: true })
  writeFileSync(stubbornScriptPath,
`const { appendFileSync } = require('node:fs')
const marker = process.env.GOTRY_TEST_INSTALLER_MARKER
process.on('SIGTERM', () => appendFileSync(marker, 'child-term-ignored ' + process.pid + '\\n'))
process.on('SIGINT', () => appendFileSync(marker, 'child-int-ignored ' + process.pid + '\\n'))
appendFileSync(marker, 'stubborn-child-ready ' + process.pid + '\\n')
setInterval(() => {}, 1000)
`)
  const fakeBash = join(fakeBin, 'bash')
  writeFileSync(fakeBash,
`#!/bin/sh
echo "bash-start $$" >> "$GOTRY_TEST_INSTALLER_MARKER"
trap 'echo "bash-term-ignored $$" >> "$GOTRY_TEST_INSTALLER_MARKER"' TERM INT
"${process.execPath}" "${stubbornScriptPath}" &
sleep_pid=$!
echo "sleep-pid $sleep_pid" >> "$GOTRY_TEST_INSTALLER_MARKER"
while kill -0 "$sleep_pid" 2>/dev/null; do
  wait "$sleep_pid" 2>/dev/null || true
done
echo "bash-finished $$" >> "$GOTRY_TEST_INSTALLER_MARKER"
`)
  chmodSync(fakeBash, 0o755)
  return { path: `${fakeBin}${delimiter}${fixture.safePath}`, installerMarkerPath }
}

type FixtureChild = ReturnType<typeof spawn>
const closedFixtures = new WeakSet<FixtureChild>()

function spawnInner(fixture: ReturnType<typeof buildPkgFixture>, opts: { tty: boolean; env?: Record<string, string> }) {
  // NODE_OPTIONS:TTY 路径挂 fixture-local preload;非 TTY 路径清空(移除 tsx loader,temp 包无 tsx 会崩)。
  const nodeOptions = opts.tty ? `--require ${fixture.preloadPath}` : ''
  const child = spawn(process.execPath, [join(fixture.pkgBin, 'gotry-inner.js'), 'web', '--no-open'], {
    env: {
      ...process.env,
      HOME: fixture.homeDir,
      TMPDIR: fixture.tmpDir,
      PATH: fixture.safePath,
      NODE_OPTIONS: nodeOptions,
      CI: '',
      GOTRY_SETUP_SKIP: '',
      GOTRY_ONBOARDING_SKIP: '',
      GOTRY_DEBUG: '',
      ...(opts.env ?? {}),
    },
    cwd: fixture.cwdDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
  child.once('close', () => closedFixtures.add(child))
  return child
}

function collectOutput(child: FixtureChild) {
  const stdoutRef = { s: '' }
  let stderr = ''
  child.stdout!.on('data', (c: Buffer) => { stdoutRef.s += c.toString('utf8') })
  child.stderr!.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
  return { stdoutRef, getStderr: () => stderr }
}

function waitForChildCloseEvent(child: FixtureChild, ms: number) {
  if (closedFixtures.has(child)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let done = false
    const cleanup = (value: boolean) => {
      if (done) return
      done = true
      clearTimeout(t)
      child.off('close', onClose)
      child.off('error', onError)
      resolve(value)
    }
    const onClose = () => cleanup(true)
    const onError = () => cleanup(true)
    const t = setTimeout(() => cleanup(false), ms)
    child.once('close', onClose)
    child.once('error', onError)
  })
}

function childClosedMessage(label: string, stdoutRef: { s: string }, expected: string, code: number | null, signal: NodeJS.Signals | null) {
  return new Error(`${label}: 子进程在观察到 ${expected} 前退出(code=${code},signal=${signal})\nstdout:\n${stdoutRef.s.slice(-800)}`)
}

const fixtureReaps = new WeakMap<FixtureChild, Promise<void>>()

function rejectAfterFixtureReap(child: FixtureChild, reject: (reason?: unknown) => void, error: unknown) {
  void reapFixture(child)
    .catch(() => undefined)
    .then(() => reject(error))
}

// 等待 stdout 出现真实 onboarding prompt(证明 bootstrap 真的跑了 prompt 路径);超时 FAIL(非 skip)。
function waitForPrompt(child: FixtureChild, stdoutRef: { s: string }, label: string, ms = 30_000) {
  return new Promise<void>((resolve, reject) => {
    let done = false
    const cleanup = () => {
      if (done) return false
      done = true
      clearTimeout(t)
      child.stdout!.off('data', onData)
      child.off('error', onError)
      child.off('close', onClose)
      return true
    }
    const onError = (error: Error) => {
      if (cleanup()) rejectAfterFixtureReap(child, reject, error)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (cleanup()) rejectAfterFixtureReap(child, reject, childClosedMessage(label, stdoutRef, 'onboarding prompt', code, signal))
    }
    const onData = () => {
      if (stdoutRef.s.includes('现在自动配置可安装项吗') && cleanup()) resolve()
    }
    const t = setTimeout(() => {
      if (cleanup()) rejectAfterFixtureReap(child, reject, new Error(`${label}: 未在 ${ms}ms 内观察到 onboarding prompt\nstdout:\n${stdoutRef.s.slice(-800)}`))
    }, ms)
    child.stdout!.on('data', onData)
    child.once('error', onError)
    child.once('close', onClose)
    onData()
  })
}

function waitForStdout(child: FixtureChild, stdoutRef: { s: string }, needle: string, label: string, ms = 30_000) {
  return new Promise<void>((resolve, reject) => {
    let done = false
    const cleanup = () => {
      if (done) return false
      done = true
      clearTimeout(t)
      child.stdout!.off('data', onData)
      child.off('error', onError)
      child.off('close', onClose)
      return true
    }
    const onError = (error: Error) => {
      if (cleanup()) rejectAfterFixtureReap(child, reject, error)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (cleanup()) rejectAfterFixtureReap(child, reject, childClosedMessage(label, stdoutRef, needle, code, signal))
    }
    const onData = () => {
      if (stdoutRef.s.includes(needle) && cleanup()) resolve()
    }
    const t = setTimeout(() => {
      if (cleanup()) rejectAfterFixtureReap(child, reject, new Error(`${label}: 未在 ${ms}ms 内观察到 ${needle}\nstdout:\n${stdoutRef.s.slice(-800)}`))
    }, ms)
    child.stdout!.on('data', onData)
    child.once('error', onError)
    child.once('close', onClose)
    onData()
  })
}

function waitForFileText(child: FixtureChild, filePath: string, needle: string, stdoutRef: { s: string }, label: string, ms = 30_000) {
  return new Promise<void>((resolve, reject) => {
    let done = false
    const cleanup = () => {
      if (done) return false
      done = true
      clearTimeout(t)
      clearInterval(interval)
      child.off('error', onError)
      child.off('close', onClose)
      return true
    }
    const current = () => {
      try { return readFileSync(filePath, 'utf-8') } catch { return '' }
    }
    const onError = (error: Error) => {
      if (cleanup()) rejectAfterFixtureReap(child, reject, error)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (cleanup()) rejectAfterFixtureReap(child, reject, new Error(`${label}: 子进程在观察到 ${needle} 前退出(code=${code},signal=${signal})\ninstaller-log:\n${current().slice(-800)}\nstdout:\n${stdoutRef.s.slice(-800)}`))
    }
    const poll = () => {
      if (current().includes(needle) && cleanup()) resolve()
    }
    const interval = setInterval(poll, 50)
    const t = setTimeout(() => {
      if (cleanup()) rejectAfterFixtureReap(child, reject, new Error(`${label}: 未在 ${ms}ms 内观察到 ${needle}\ninstaller-log:\n${current().slice(-800)}\nstdout:\n${stdoutRef.s.slice(-800)}`))
    }, ms)
    child.once('error', onError)
    child.once('close', onClose)
    poll()
  })
}

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function processGroupId(pid: number) {
  if (process.platform === 'win32') return null
  try {
    const groupId = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    return Number.isInteger(groupId) && groupId > 1 ? groupId : null
  } catch {
    return null
  }
}

async function waitForGone(label: string, pid: number, ms = 1_000) {
  const deadline = Date.now() + ms
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`${label}: pid=${pid} 在 ${ms}ms 内仍存活`)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function processGroupAlive(groupId: number) {
  try { process.kill(-groupId, 0); return true } catch { return false }
}

// 创建完成 promise(必须在事件触发前创建,故在 spawn 后立即调用)。21a/21c 用 close 等流排空;
// mode='exit' 在 exit 后立即 destroy 流(有 detached grandchild 持 stderr 管道,避免悬挂)。带超时兜底:
// 超时则 SIGKILL 整个进程组 + destroy 流并 resolve(timedOut:true)——由调用方断言,永不 reject。
function runFixture(child: FixtureChild, mode: 'close' | 'exit', _label: string, ms = 30_000) {
  return new Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
    let done = false
    const destroyStreams = () => { try { child.stdout!.destroy() } catch { /* ignore */ } try { child.stderr!.destroy() } catch { /* ignore */ } }
    const finish = (info: { exitCode: number | null; signal: string | null; timedOut?: boolean }) => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve({ exitCode: info.exitCode, signal: info.signal, timedOut: !!info.timedOut })
    }
    const t = setTimeout(() => {
      void (async () => {
        await reapFixture(child)
        destroyStreams()
        finish({ exitCode: null, signal: null, timedOut: true })
      })()
    }, ms)
    // 所有 waiter 在调用后立即挂上，避免先 await exit 再错过 close；21a 的完成条件是 close。
    child.once('exit', (c, sig) => { if (mode === 'exit') { destroyStreams(); finish({ exitCode: c, signal: sig }) } })
    child.on('error', () => { destroyStreams(); finish({ exitCode: -2, signal: null }) })
    child.once('close', (c, sig) => { if (mode === 'close') finish({ exitCode: c, signal: sig }) })
  })
}

// 清理兜底:kill/reap 进程组 + 关闭流。幂等。任一超时/断言失败/正常退出后调用,确保无悬挂 grandchild。
async function reapFixture(child: FixtureChild) {
  const existing = fixtureReaps.get(child)
  if (existing) return existing
  const reap = (async () => {
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* dead */ } }
    try { child.stdin!.destroy() } catch { /* ignore */ }
    await waitForChildCloseEvent(child, 1_000)
    try { child.stdout!.destroy() } catch { /* ignore */ }
    try { child.stderr!.destroy() } catch { /* ignore */ }
  })()
  fixtureReaps.set(child, reap)
  return reap
}

// 20g. prompt waiter 超时本身必须完成进程组清理,不能把 kill/reap 责任留给调用方 finally。
//     父进程先启动并报告同组 grandchild;清理验证等待父/后代都消失,不依赖固定 sleep 调度。
if (process.platform === 'win32') {
  console.log('20g. prompt waiter timeout → process-group grandchild reap(SKIP on win32:POSIX process groups 不适用)')
} else {
  const child = spawn(process.execPath, ['-e', [
    "const { spawn } = require('node:child_process')",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    "process.stdout.write('grandchild-ready ' + grandchild.pid + '\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
  const stdoutRef = { s: '' }
  child.stdout!.on('data', (chunk: Buffer) => { stdoutRef.s += chunk.toString('utf8') })
  try {
    await waitForStdout(child, stdoutRef, 'grandchild-ready ', '20g', 1_000)
    const grandchildPid = Number(stdoutRef.s.match(/grandchild-ready (\d+)/)?.[1])
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1, `20g: 必须报告有效 grandchild pid\n${stdoutRef.s}`)
    assert.equal(pidAlive(grandchildPid), true, `20g: grandchild(pid=${grandchildPid}) 必须在 waiter 前存活`)
    const parentGroup = processGroupId(child.pid!)
    const grandchildGroup = processGroupId(grandchildPid)
    assert.ok(parentGroup, `20g: 无法读取 parent(pid=${child.pid!}) PGID`)
    assert.equal(grandchildGroup, parentGroup, `20g: parent/grandchild 必须同组(parent=${parentGroup},grandchild=${grandchildGroup})`)
    await assert.rejects(waitForPrompt(child, stdoutRef, '20g', 0), /未在 0ms 内观察到 onboarding prompt/)
    await waitForGone('20g parent', child.pid!, 1_000)
    await waitForGone('20g grandchild', grandchildPid, 1_000)
    assert.equal(pidAlive(child.pid!), false, '20g: prompt waiter 失败后 parent 必须消失')
    assert.equal(pidAlive(grandchildPid), false, '20g: prompt waiter 失败后 grandchild 必须消失')
    assert.equal(processGroupAlive(parentGroup!), false, `20g: process group(${parentGroup}) 必须无残留成员`)
  } finally {
    await reapFixture(child)
  }
}
console.log('20g. prompt waiter timeout → active same-group grandchild + bounded parent/descendant reap OK')

// 20h. cleanup timeout/stream destroy failure 不能吞掉原始 waiter 错误或制造 unhandled rejection。
{
  const fakeChild = new EventEmitter() as unknown as FixtureChild
  const failingStream = Object.assign(new EventEmitter(), {
    destroy() { throw new Error('synthetic cleanup stream failure') },
  })
  Object.assign(fakeChild, {
    pid: 2_147_483_647,
    stdin: failingStream,
    stdout: failingStream,
    stderr: failingStream,
  })
  const stdoutRef = { s: '' }
  let unhandled: unknown = null
  const onUnhandled = (reason: unknown) => { unhandled = reason }
  process.once('unhandledRejection', onUnhandled)
  const started = Date.now()
  try {
    await assert.rejects(waitForPrompt(fakeChild, stdoutRef, '20h', 0), /未在 0ms 内观察到 onboarding prompt/)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(unhandled, null, '20h: cleanup timeout/failure 不得产生 unhandled rejection')
    assert.ok(Date.now() - started < 1_500, '20h: cleanup timeout 必须有界返回')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}
console.log('20h. waiter 原始错误 + cleanup timeout/failure bounded and handled OK')

// 21a. TTY eligible,喂 "n":真实 prompt 恰好一次 → 拒绝 → web 启动,摘要抑制,无 result 目录残留
{
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gotry-pkg-21a-'))
  let child: FixtureChild | null = null
  try {
    const fixture = buildPkgFixture(tmpRoot)
    child = spawnInner(fixture, { tty: true })
    const { stdoutRef, getStderr } = collectOutput(child)
    const done = runFixture(child, 'close', '21a')          // prompted → 无 detached doctor → 等 close 排空流
    await waitForPrompt(child, stdoutRef, '21a')
    child.stdin!.write('n\n')
    const res = await done
    const stdout = stdoutRef.s
    const stderr = getStderr()
    assert.equal(res.timedOut, false, `21a: 应正常退出而非超时\nstderr:\n${stderr.slice(-1500)}\nstdout:\n${stdout.slice(-800)}`)
    assert.equal(res.exitCode, 0, `21a: inner web(n) 应 exit 0\nstderr:\n${stderr.slice(-1500)}\nstdout:\n${stdout.slice(-800)}`)
    const promptCount = (stdout.match(/现在自动配置可安装项吗/g) ?? []).length
    assert.equal(promptCount, 1, '21a: 真实 onboarding prompt 恰好出现一次(跨过 inner→bootstrap 边界)')
    assert.ok(!stdout.includes('开始自动配置'), '21a: 拒绝 → 不安装')
    assert.ok(!stdout.includes('配置结果:'), '21a: 拒绝 → 无安装结果行')
    assert.ok(existsSync(fixture.markerPath), '21a: 假 dsh 被调用(跨过 onboarding 到达 web 启动边界)')
    const lines = readFileSync(fixture.markerPath, 'utf-8').split('\n').filter((l) => l.trim())
    assert.equal(lines.length, 1, '21a: 假 dsh 恰好被调用一次')
    const dshArgs: string[] = JSON.parse(lines[0]).args
    assert.ok(dshArgs.includes('web') && dshArgs.includes('--no-open'), '21a: 假 dsh 收到 web + --no-open')
    // 摘要抑制:onboarding prompted → 后台 doctor 摘要不跑(假 dsh 逗留 1.5s 给它露面窗口)
    assert.ok(!stderr.includes('[gotry] doctor:'), '21a: onboarding prompted → 重复后台摘要被抑制')
    // TMPDIR 无残留 gotry-onboarding-* / gotry-cordis-*(正常退出清理)
    const leftovers = readdirSync(fixture.tmpDir).filter((n) => n.startsWith('gotry-onboarding-') || n.startsWith('gotry-cordis-'))
    assert.equal(leftovers.length, 0, `21a: 正常退出清了 temp 目录,残留: ${leftovers.join(',')}`)
  } finally {
    if (child) await reapFixture(child)
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
console.log('21a. TTY-eligible installed-package inner(真实 prompt 恰好一次 → n → web,摘要抑制,无 temp 残留)OK')

// 21b. non-TTY(无 preload):stdin pipe → onboarding 跳过 → 零 prompt,假 dsh 恰好一次
{
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gotry-pkg-21b-'))
  let child: FixtureChild | null = null
  try {
    const fixture = buildPkgFixture(tmpRoot)
    child = spawnInner(fixture, { tty: false })
    const { stdoutRef, getStderr } = collectOutput(child)
    // non-TTY → onboarding 跳过 → runSummary 跑 detached doctor --summary(持 stderr 管道);用 'exit' 不等 'close',
    // exit 后立即 destroy 读端令其 EPIPE 自退,避免悬挂。doctor 只读零写盘,不触共享状态。
    const res = await runFixture(child, 'exit', '21b')
    const stdout = stdoutRef.s
    const stderr = getStderr()
    assert.equal(res.timedOut, false, `21b: 应正常退出而非超时\nstderr:\n${stderr.slice(-1200)}`)
    assert.equal(res.exitCode, 0, `21b: non-TTY inner web 应 exit 0\nstderr:\n${stderr.slice(-1200)}\nstdout:\n${stdout.slice(-600)}`)
    assert.ok(!stdout.includes('现在自动配置可安装项吗'), '21b: 非 TTY 路径不应 prompt')
    assert.ok(!stdout.includes('开始自动配置'), '21b: 非 TTY 路径不应安装')
    assert.ok(existsSync(fixture.markerPath), '21b: 假 dsh 被调用')
    const lines = readFileSync(fixture.markerPath, 'utf-8').split('\n').filter((l) => l.trim())
    assert.equal(lines.length, 1, '21b: 假 dsh 恰好被调用一次')
    const dshArgs: string[] = JSON.parse(lines[0]).args
    assert.ok(dshArgs.includes('web') && dshArgs.includes('--no-open'), '21b: 假 dsh 收到 web + --no-open')
  } finally {
    if (child) await reapFixture(child)
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
console.log('21b. non-TTY installed-package inner(零 prompt,假 dsh 恰好一次,全隔离)OK')

// 21c. POSIX 信号清理(仅非 win32):onboarding 阻塞等输入时向父进程单独发 SIGTERM → 清 result+patch 目录,无残留子进程
if (process.platform === 'win32') {
  console.log('21c. POSIX signal cleanup(SKIP on win32:POSIX 信号子例不适用,平台限制)')
} else {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gotry-pkg-21c-'))
  let child: FixtureChild | null = null
  try {
    const fixture = buildPkgFixture(tmpRoot)
    child = spawnInner(fixture, { tty: true })
    const { stdoutRef, getStderr } = collectOutput(child)
    // 完成 promise 必须在 process.kill 之前创建,避免错过 'exit'/'close' 事件。
    // 信号时未到 launchWeb → 无 detached doctor grandchild → 等 close 排空流。
    const done = runFixture(child, 'close', '21c', 15_000)
    // 先观察到真实 prompt(证明 onboarding 子进程真的在等输入)
    await waitForPrompt(child, stdoutRef, '21c')
    // 不喂答案,onboarding 阻塞等输入;向父进程(inner)单独发 SIGTERM
    process.kill(child.pid!, 'SIGTERM')
    const res = await done
    assert.equal(res.timedOut, false, '21c: inner 应在超时前响应 SIGTERM 终止(超时=FAIL,非 skip)')
    // 给 OS 一点回收时间
    await new Promise((r) => setTimeout(r, 500))
    // TMPDIR 无残留 gotry-onboarding-* 与 gotry-cordis-*(信号路径清理)
    const leftoverOnboard = readdirSync(fixture.tmpDir).filter((n) => n.startsWith('gotry-onboarding-'))
    const leftoverCordis = readdirSync(fixture.tmpDir).filter((n) => n.startsWith('gotry-cordis-'))
    assert.equal(leftoverOnboard.length, 0, `21c: 信号路径清了 result 目录,残留: ${leftoverOnboard.join(',')}`)
    assert.equal(leftoverCordis.length, 0, `21c: 信号路径清了 patch 目录,残留: ${leftoverCordis.join(',')}`)
    // 进程组无残留子进程
    let groupAlive = true
    try { process.kill(-child.pid!, 0) } catch { groupAlive = false }
    assert.equal(groupAlive, false, '21c: inner 退出后进程组无残留子进程')
    // 信号时还在 onboarding,未到 launchWeb → 假 dsh 未被调用
    assert.ok(!existsSync(fixture.markerPath), '21c: 信号时未到 web 启动,假 dsh 未被调用')
    void getStderr
  } finally {
    if (child) await reapFixture(child)
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log('21c. POSIX signal cleanup(SIGTERM→清 result+patch 目录,无残留子进程;win32 skip)OK')
}

// 21f. POSIX yes 安装期间信号:进入真实 hbcli installer 后只打父进程,installer 子树也必须被进程组转发/升级清理。
if (process.platform === 'win32') {
  console.log('21f. POSIX yes-path installer signal cleanup(SKIP on win32:POSIX 安装器进程组子例不适用,平台限制)')
} else {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gotry-pkg-21f-'))
  let child: FixtureChild | null = null
  try {
    const fixture = buildPkgFixture(tmpRoot)
    const installer = addSleepingInstallerFixture(tmpRoot, fixture)
    child = spawnInner(fixture, {
      tty: true,
      env: {
        PATH: installer.path,
        GOTRY_SETUP_REACH: '0',
        GOTRY_SETUP_SIDEBAR: '0',
        GOTRY_TEST_INSTALLER_MARKER: installer.installerMarkerPath,
      },
    })
    const { stdoutRef, getStderr } = collectOutput(child)
    const done = runFixture(child, 'close', '21f', 15_000)
    await waitForPrompt(child, stdoutRef, '21f')
    child.stdin!.write('y\n')
    await waitForStdout(child, stdoutRef, '开始自动配置可安装项', '21f')
    await waitForFileText(child, installer.installerMarkerPath, 'stubborn-child-ready ', stdoutRef, '21f')
    process.kill(child.pid!, 'SIGTERM')
    const res = await done
    const stderr = getStderr()
    assert.equal(res.timedOut, false, `21f: yes 安装期间 parent SIGTERM 应有界终止\nstderr:\n${stderr.slice(-1200)}\nstdout:\n${stdoutRef.s.slice(-800)}`)
    assert.ok(res.signal === 'SIGTERM' || res.exitCode === 143, `21f: 父进程应以 SIGTERM 或 143 fallback 终止,实际 code=${res.exitCode},signal=${res.signal}\nstderr:\n${stderr.slice(-1200)}\nstdout:\n${stdoutRef.s.slice(-800)}`)
    await new Promise((r) => setTimeout(r, 500))
    const installerLog = readFileSync(installer.installerMarkerPath, 'utf-8')
    assert.match(installerLog, /bash-start \d+/, '21f: fake bash installer 已启动')
    assert.match(installerLog, /bash-term-ignored \d+/, `21f: fake installer 必须忽略 TERM,证明后续依赖 SIGKILL group\n${installerLog}`)
    assert.match(installerLog, /child-term-ignored \d+/, `21f: stubborn child 必须已装好 handler 并忽略 TERM\n${installerLog}`)
    const sleepPid = Number((installerLog.match(/sleep-pid (\d+)/) ?? [])[1])
    assert.ok(Number.isInteger(sleepPid) && sleepPid > 1, `21f: installer log 应记录 sleep 子进程 pid\n${installerLog}`)
    assert.equal(pidAlive(sleepPid), false, `21f: fake installer 的 sleep 子进程应已被 reap(pid=${sleepPid})\n${installerLog}`)
    assert.ok(!installerLog.includes('bash-finished'), `21f: 安装器不应自然跑完\n${installerLog}`)
    const leftoverOnboard = readdirSync(fixture.tmpDir).filter((n) => n.startsWith('gotry-onboarding-'))
    const leftoverCordis = readdirSync(fixture.tmpDir).filter((n) => n.startsWith('gotry-cordis-'))
    assert.equal(leftoverOnboard.length, 0, `21f: yes 安装信号路径清了 result 目录,残留: ${leftoverOnboard.join(',')}`)
    assert.equal(leftoverCordis.length, 0, `21f: yes 安装信号路径清了 patch 目录,残留: ${leftoverCordis.join(',')}`)
    let groupAlive = true
    try { process.kill(-child.pid!, 0) } catch { groupAlive = false }
    assert.equal(groupAlive, false, '21f: yes 安装信号后 inner 进程组无残留子进程')
    assert.ok(!existsSync(fixture.markerPath), '21f: 信号时仍在安装,onboarding 未到 web 启动,假 dsh 未被调用')
  } finally {
    if (child) await reapFixture(child)
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log('21f. POSIX yes-path installer signal cleanup(parent SIGTERM during fake hbcli install → installer subtree reaped + no temp/process leftovers)OK')
}

// 21g. POSIX yes 安装期间 onboarding timeout:outer grace 必须覆盖 bootstrap installer TERM+SIGKILL budget。
if (process.platform === 'win32') {
  console.log('21g. POSIX yes-path installer timeout cleanup(SKIP on win32:POSIX 安装器进程组子例不适用,平台限制)')
} else {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gotry-pkg-21g-'))
  let child: FixtureChild | null = null
  try {
    const fixture = buildPkgFixture(tmpRoot)
    const installer = addSleepingInstallerFixture(tmpRoot, fixture)
    child = spawnInner(fixture, {
      tty: true,
      env: {
        PATH: installer.path,
        GOTRY_SETUP_REACH: '0',
        GOTRY_SETUP_SIDEBAR: '0',
        GOTRY_TEST_INSTALLER_MARKER: installer.installerMarkerPath,
        GOTRY_ONBOARDING_CHILD_TIMEOUT_MS: '5000',
      },
    })
    const { stdoutRef, getStderr } = collectOutput(child)
    const done = runFixture(child, 'exit', '21g', 30_000)
    await waitForPrompt(child, stdoutRef, '21g')
    child.stdin!.write('y\n')
    await waitForStdout(child, stdoutRef, '开始自动配置可安装项', '21g')
    await waitForFileText(child, installer.installerMarkerPath, 'stubborn-child-ready ', stdoutRef, '21g')
    const res = await done
    const stderr = getStderr()
    assert.equal(res.timedOut, false, `21g: accepted install timeout 后应继续 web,不应整体超时\nstderr:\n${stderr.slice(-1200)}\nstdout:\n${stdoutRef.s.slice(-800)}`)
    assert.equal(res.exitCode, 0, `21g: accepted install timeout 后 inner 继续 web 应 exit 0\nstderr:\n${stderr.slice(-1200)}\nstdout:\n${stdoutRef.s.slice(-800)}`)
    assert.match(stderr, /onboarding child timeout after 5000ms; continuing to web/, '21g: stderr 应含精简 timeout 诊断')
    assert.ok(existsSync(fixture.markerPath), '21g: timeout 后应继续到 fake dsh web')
    const lines = readFileSync(fixture.markerPath, 'utf-8').split('\n').filter((l) => l.trim())
    assert.equal(lines.length, 1, '21g: fake dsh 恰好启动一次')
    await new Promise((r) => setTimeout(r, 500))
    const installerLog = readFileSync(installer.installerMarkerPath, 'utf-8')
    assert.match(installerLog, /bash-start \d+/, '21g: fake bash installer 已启动')
    assert.match(installerLog, /bash-term-ignored \d+/, `21g: fake installer 必须忽略 TERM,证明 timeout 依赖 SIGKILL group\n${installerLog}`)
    assert.match(installerLog, /child-term-ignored \d+/, `21g: stubborn child 必须已装好 handler 并忽略 TERM\n${installerLog}`)
    const sleepPid = Number((installerLog.match(/sleep-pid (\d+)/) ?? [])[1])
    assert.ok(Number.isInteger(sleepPid) && sleepPid > 1, `21g: installer log 应记录 stubborn 子进程 pid\n${installerLog}`)
    assert.equal(pidAlive(sleepPid), false, `21g: timeout 后 stubborn installer 子进程应已被 reap(pid=${sleepPid})\n${installerLog}`)
    assert.ok(!installerLog.includes('bash-finished'), `21g: stubborn 安装器不应自然跑完\n${installerLog}`)
    const leftoverOnboard = readdirSync(fixture.tmpDir).filter((n) => n.startsWith('gotry-onboarding-'))
    const leftoverCordis = readdirSync(fixture.tmpDir).filter((n) => n.startsWith('gotry-cordis-'))
    assert.equal(leftoverOnboard.length, 0, `21g: timeout yes 安装路径清了 result 目录,残留: ${leftoverOnboard.join(',')}`)
    assert.equal(leftoverCordis.length, 0, `21g: timeout yes 安装路径清了 patch 目录,残留: ${leftoverCordis.join(',')}`)
    let groupAlive = true
    try { process.kill(-child.pid!, 0) } catch { groupAlive = false }
    assert.equal(groupAlive, false, '21g: timeout yes 安装后 inner 进程组无残留子进程')
  } finally {
    if (child) await reapFixture(child)
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log('21g. POSIX yes-path installer timeout cleanup(onboarding timeout during fake hbcli install → installer SIGKILL group + web continues)OK')
}

// 21d. 生产 onboarding 超时上界:TTY eligible + 注入 1000ms 超时 + 不喂输入 → onboarding 挂起被 SIGTERM/SIGKILL,
//     inner 继续 web(prompted:false),无 result 目录残留,exit 0。证明超时不挡 web、不留进程/目录。
{
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gotry-pkg-21d-'))
  let child: FixtureChild | null = null
  try {
    const fixture = buildPkgFixture(tmpRoot)
    child = spawnInner(fixture, { tty: true, env: { GOTRY_ONBOARDING_CHILD_TIMEOUT_MS: '1000' } })
    const { stdoutRef, getStderr } = collectOutput(child)
    // 超时后 prompted:false → runSummary 跑 detached doctor(持 stderr);用 'exit' + destroy 避免悬挂。
    const done = runFixture(child, 'exit', '21d', 30_000)
    // 先观察到 prompt(证明 onboarding 真的进入了可 prompt 路径并在等输入)
    await waitForPrompt(child, stdoutRef, '21d')
    // 不喂输入:1s 后 inner 超时杀 onboarding 子,继续 web
    const res = await done
    const stdout = stdoutRef.s
    const stderr = getStderr()
    assert.equal(res.timedOut, false, `21d: 超时后应继续 web 并正常退出而非整体超时\nstderr:\n${stderr.slice(-1200)}`)
    assert.equal(res.exitCode, 0, `21d: 超时后 inner 继续 web 应 exit 0\nstderr:\n${stderr.slice(-1200)}\nstdout:\n${stdout.slice(-600)}`)
    assert.ok(existsSync(fixture.markerPath), '21d: onboarding 超时后 inner 继续 web → 假 dsh 被调用(超时不挡 web)')
    const lines = readFileSync(fixture.markerPath, 'utf-8').split('\n').filter((l) => l.trim())
    assert.equal(lines.length, 1, '21d: 假 dsh 恰好被调用一次')
    assert.match(stderr, /onboarding child timeout after 1000ms; continuing to web/, '21d: stderr 应含精简 timeout 诊断')
    // 超时路径清了 result 目录(finally)
    const leftoverOnboard = readdirSync(fixture.tmpDir).filter((n) => n.startsWith('gotry-onboarding-'))
    const leftoverCordis = readdirSync(fixture.tmpDir).filter((n) => n.startsWith('gotry-cordis-'))
    assert.equal(leftoverOnboard.length, 0, `21d: 超时路径清了 result 目录,残留: ${leftoverOnboard.join(',')}`)
    assert.equal(leftoverCordis.length, 0, `21d: 超时后正常退出清了 patch 目录,残留: ${leftoverCordis.join(',')}`)
    await new Promise((r) => setTimeout(r, 500))
    let groupAlive = true
    try { process.kill(-child.pid!, 0) } catch { groupAlive = false }
    assert.equal(groupAlive, false, '21d: 超时后进程组无残留子进程')
  } finally {
    if (child) await reapFixture(child)
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
console.log('21d. onboarding 超时上界(1000ms 注入 → 杀子继续 web,无残留,exit 0)OK')

// 21e. POSIX later-lifecycle signal:先拒绝 onboarding,等假 dsh 已启动,只打父进程 SIGTERM。
//      证明信号转发监听器没有在 onboarding 后过早注销,仍会终止活跃 dsh 子进程并清 patch/result。
if (process.platform === 'win32') {
  console.log('21e. POSIX later-lifecycle signal forwarding(SKIP on win32:POSIX 信号子例不适用,平台限制)')
} else {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gotry-pkg-21e-'))
  let child: FixtureChild | null = null
  try {
    const fixture = buildPkgFixture(tmpRoot)
    child = spawnInner(fixture, { tty: true, env: { FAKE_DSH_SLEEP_MS: '30000' } })
    const { stdoutRef, getStderr } = collectOutput(child)
    const done = runFixture(child, 'close', '21e', 15_000)
    await waitForPrompt(child, stdoutRef, '21e')
    child.stdin!.write('n\n')
    await waitForStdout(child, stdoutRef, '[fake-dsh] web launch', '21e')
    process.kill(child.pid!, 'SIGTERM')
    const res = await done
    const stderr = getStderr()
    assert.equal(res.timedOut, false, `21e: inner 应在超时前响应 later-lifecycle SIGTERM\nstderr:\n${stderr.slice(-1200)}`)
    assert.ok(res.signal === 'SIGTERM' || res.exitCode === 143, `21e: 父进程应以 SIGTERM 或 143 fallback 终止,实际 code=${res.exitCode},signal=${res.signal}\nstderr:\n${stderr.slice(-1200)}`)
    const lines = readFileSync(fixture.markerPath, 'utf-8').split('\n').filter((l) => l.trim())
    assert.equal(lines.length, 1, '21e: 假 dsh 恰好启动一次')
    await new Promise((r) => setTimeout(r, 500))
    const leftoverOnboard = readdirSync(fixture.tmpDir).filter((n) => n.startsWith('gotry-onboarding-'))
    const leftoverCordis = readdirSync(fixture.tmpDir).filter((n) => n.startsWith('gotry-cordis-'))
    assert.equal(leftoverOnboard.length, 0, `21e: later-lifecycle 信号后无 result 目录残留: ${leftoverOnboard.join(',')}`)
    assert.equal(leftoverCordis.length, 0, `21e: later-lifecycle 信号后无 patch 目录残留: ${leftoverCordis.join(',')}`)
    let groupAlive = true
    try { process.kill(-child.pid!, 0) } catch { groupAlive = false }
    assert.equal(groupAlive, false, '21e: later-lifecycle 信号后进程组无残留子进程')
  } finally {
    if (child) await reapFixture(child)
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  console.log('21e. POSIX later-lifecycle signal forwarding(parent SIGTERM after fake dsh active → forwarded + no temp/process leftovers)OK')
}
console.log('21. spawned installed-package inner(21a TTY-eligible 真实 prompt→n→web + 摘要抑制 + 无残留 / 21b non-TTY 零 prompt / 21c POSIX onboarding 信号清理 / 21f POSIX yes-path installer 信号清理 / 21g POSIX yes-path timeout installer 清理 / 21d onboarding 超时上界 / 21e POSIX dsh-lifecycle 信号转发)OK')

// 22. win32 platform boundary:复用 doctor --fix 的平台能力边界(doctorFixAutoSupported)。win32 上
//     hbcli/agent-reach 上游无 win 安装面、sidebar(dsh plugin→pnpm)在 win32 同样不自动跑——onboarding
//     不得把它们分到 auto 桶(否则 prompt 了却装不上);分类为 unavailable 且给具体平台原因。hbcli
//     degraded(凭证)= user-action(平台无关)。{ platform, env }注入,确定性,不依赖真机平台或 ambient env。
{
  const { classifyDoctorGap, buildOnboardingPlan, doctorFixAutoSupported } = await import(bootstrap)
  const cleanEnv = {} // 无 GOTRY_SETUP_*=0 → 安装器全启用,隔离 ambient env
  assert.equal(doctorFixAutoSupported('darwin'), true)
  assert.equal(doctorFixAutoSupported('linux'), true)
  assert.equal(doctorFixAutoSupported('win32'), false, 'win32 doctor --fix 不跑自动安装')
  // win32: hbcli missing/reach/sidebar → unavailable(非 auto);hbcli degraded → user-action(凭证,平台无关)
  assert.equal(classifyDoctorGap(onboardingItems[3], { platform: 'win32', env: cleanEnv }), 'unavailable', 'win32 hbcli missing = unavailable')
  assert.equal(classifyDoctorGap(hbcliDegraded, { platform: 'win32', env: cleanEnv }), 'user-action', 'win32 hbcli degraded = user-action(凭证平台无关)')
  assert.equal(classifyDoctorGap(onboardingItems[2], { platform: 'win32', env: cleanEnv }), 'unavailable', 'win32 reach = unavailable')
  assert.equal(classifyDoctorGap(onboardingItems[5], { platform: 'win32', env: cleanEnv }), 'unavailable', 'win32 sidebar = unavailable(与 doctor 守卫同口径)')
  // darwin 对照:auto 桶正常(不回归)
  assert.equal(classifyDoctorGap(onboardingItems[3], { platform: 'darwin', env: cleanEnv }), 'auto')
  assert.equal(classifyDoctorGap(onboardingItems[2], { platform: 'darwin', env: cleanEnv }), 'auto')
  assert.equal(classifyDoctorGap(onboardingItems[5], { platform: 'darwin', env: cleanEnv }), 'auto')
  // win32 计划:promptable=false(无 auto,与 doctor --fix 不装一致),unavailable 含三项 + 平台原因
  const plan = buildOnboardingPlan(onboardingItems, { platform: 'win32', env: cleanEnv })
  assert.equal(plan.promptable, false, 'win32 无 auto 缺项 → 不 prompt')
  assert.equal(plan.auto.length, 0)
  const unavail = new Map((plan.unavailable as Array<{ label: string; detail: string }>).map((g) => [g.label, g] as [string, { label: string; detail: string }]))
  assert.ok(unavail.has('hbcli(酒店实时源)'), 'hbcli 进 unavailable')
  assert.ok(unavail.has('Agent Reach(网页/社媒读取)'), 'reach 进 unavailable')
  assert.ok(unavail.has('dsh-better-sidebar(侧栏工作台)'), 'sidebar 进 unavailable')
  assert.match(unavail.get('hbcli(酒店实时源)')!.detail, /Windows/, 'hbcli unavailable 给 win 平台具体原因')
  assert.match(unavail.get('Agent Reach(网页/社媒读取)')!.detail, /Windows/, 'reach unavailable 给 win 平台具体原因')
  assert.match(unavail.get('dsh-better-sidebar(侧栏工作台)')!.detail, /Windows/, 'sidebar unavailable 给 win 平台具体原因')
  // user-action 项不受平台影响(扩展商店/flyai key/calendar profile)
  const ua = new Set((plan.userAction as Array<{ label: string }>).map((g) => g.label))
  assert.ok(ua.has('GoTry Session Bridge 扩展'), 'win32 扩展仍 user-action(平台无关)')
  assert.ok(ua.has('FlyAI(飞猪官方检索)'), 'win32 flyai 仍 user-action(平台无关)')
  assert.ok(ua.has('dsh-calendar(日历工作窗口)'), 'win32 calendar 仍 user-action(平台无关)')
  // darwin 计划对照:auto=3,promptable=true(不回归)
  const planDarwin = buildOnboardingPlan(onboardingItems, { platform: 'darwin', env: cleanEnv })
  assert.equal(planDarwin.promptable, true)
  assert.equal(planDarwin.auto.length, 3, 'darwin auto=reach+hbcli+sidebar(不回归)')
}
console.log('22. win32 platform boundary(hbcli/reach/sidebar → unavailable + 具体原因;hbcli degraded → user-action;不 prompt;darwin 不回归;env 注入隔离)OK')

// 23. result 通道排他写入(result channel hardening):bootstrap writeResult 用 mode 0600 + flag wx,
//     inner 在 0700 mkdtemp 私有目录下传 result.json。本测试验证 wx 的两条护城:
//       (a) 预存普通文件在 result 路径 → wx EEXIST 拒绝覆盖,原内容保留;
//       (b) result 路径是符号链接指向 victim → wx 不跟随/不覆盖 victim(symlink 互换攻击防护)。
//     非 TTY(execFileSync stdin=pipe)→ 走 non-tty 跳过路径仍调 writeResult,正好触发 wx;HOME 隔离。
//     不变量:symlink 创建失败(平台不支持)只跳过 (b),(a) 与 CLI/断言必须独立失败——不得被
//     symlink 回退吞掉 AssertionError(否则 symlink 平台绿、断言红时假绿)。
{
  const isolated = mkdtempSync(join(tmpdir(), 'gotry-result-excl-'))
  try {
    // (a) 预存普通文件 → 不被覆盖
    const resultPath = join(isolated, 'result.json')
    writeFileSync(resultPath, 'ORIGINAL-NO-OVERWRITE', { mode: 0o600 })
    const r1 = runBootstrap(['onboarding', `--result-file=${resultPath}`], { HOME: isolated })
    assert.equal(r1.code, 0, `onboarding 应恒 exit 0\n${r1.out}`)
    assert.equal(readFileSync(resultPath, 'utf-8'), 'ORIGINAL-NO-OVERWRITE', 'wx: 预存 result 文件不被覆盖(排他写入)')
    // (b) result 路径是符号链接 → victim 不被跟随/覆盖。symlink 创建单独 try/catch:仅平台不支持时跳过;
    //     CLI 执行与 victim 断言在 catch 之外,symlink 平台上必须如实失败,不回退吞断言。
    const victimDir = mkdtempSync(join(tmpdir(), 'gotry-victim-'))
    try {
      const victimFile = join(victimDir, 'victim.txt')
      writeFileSync(victimFile, 'VICTIM-ORIGINAL', { mode: 0o600 })
      const symlinkPath = join(isolated, 'symlink-result.json')
      let symlinkCreated = false
      try {
        symlinkSync(victimFile, symlinkPath)
        symlinkCreated = true
      } catch {
        // symlink 创建不被支持(win32 无权限/平台限制)→ 跳过 (b);文件态断言 (a) 已覆盖核心 wx 行为
      }
      if (symlinkCreated) {
        const r2 = runBootstrap(['onboarding', `--result-file=${symlinkPath}`], { HOME: isolated })
        assert.equal(r2.code, 0, `onboarding(symlink)应恒 exit 0\n${r2.out}`)
        assert.equal(readFileSync(victimFile, 'utf-8'), 'VICTIM-ORIGINAL', 'wx: symlink 不被跟随/覆盖 victim(防 symlink 互换攻击)')
      }
    } finally {
      try { rmSync(victimDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  } finally {
    try { rmSync(isolated, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
console.log('23. result 通道排他写入(预存文件不被覆盖 + symlink 不跟随 victim,mode 0600 + flag wx)OK')

console.log('BOOTSTRAP TESTS: 25/25 OK(扩展就位 + 跳过开关 / wizard --dry-run / wizard 真实 / 扩展分发通道 / doctor 体检面 / calendar setup 状态面 / 显式跳过 + auto 跳过 + 单项跳过 / 启动摘要 / sidebar 落盘状态复核 / onboarding 分类+计划+env opt-out+跳过原因+yes+partial-failure+幂等+prompt+CLI 跳过+--scan / 编排缝 orchestrateWebLaunch × 6 / prompt waiter failure deterministic process-group reap / waiter 原始错误 + cleanup timeout/failure handled / 临时安装包 spawned inner 21a TTY-eligible 真实 prompt→n→web + 摘要抑制 + 无残留 / 21b non-TTY 零 prompt / 21c POSIX 信号清理 SIGTERM→清 result+patch 目录 + 无残留子进程 / 21f yes-path installer 子树信号清理 / 21g yes-path timeout installer 子树清理 / 21d timeout 诊断 + 无残留 / 21e dsh-lifecycle 信号转发 / win32 平台边界 / result 通道排他写入)')
