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
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

function runBootstrap(extraArgs: string[], extraEnv: Record<string, string>) {
  try {
    const out = execFileSync('node', [bootstrap, ...extraArgs], {
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
assert.ok(report.includes('npx gotry doctor --fix'), '报告应带补装指引')
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
  { label: 'Agent Reach(网页/社媒读取)', level: 'missing', detail: '未装配', fix: 'npx gotry doctor --fix' },
  { label: 'hbcli(酒店实时源)', level: 'missing', detail: '未安装', fix: 'npx gotry doctor --fix' },
  { label: 'FlyAI(飞猪官方检索)', level: 'degraded', detail: '未配 FLYAI_API_KEY', fix: '到 flyai 控制台申请 key' },
  { label: 'dsh-better-sidebar(侧栏工作台)', level: 'missing', detail: '未安装', fix: 'npx gotry doctor --fix' },
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
  const plan = buildOnboardingPlan(onboardingItems)
  assert.equal(plan.promptable, true, '有可自动安装缺项 → promptable')
  assert.equal(plan.auto.length, 3, 'auto = reach + hbcli-missing + sidebar')
  assert.equal(plan.userAction.length, 3, 'user-action = 扩展 + flyai + calendar')
  assert.equal(plan.unavailable.length, 2, 'unavailable = map-tools + ask-user')
  // 全健康 → promptable=false(不弹问)
  const planOk = buildOnboardingPlan(onboardingItems.map((i) => ({ ...i, level: 'ok' })))
  assert.equal(planOk.promptable, false)
  assert.equal(planOk.auto.length, 0)
  assert.equal(planOk.userAction.length, 0)
  assert.equal(planOk.unavailable.length, 0)
}
console.log('12. onboarding 分类与计划(classifyDoctorGap/buildOnboardingPlan,合成 items + 全健康)OK')

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
  assert.equal(hbcliRes.retry, 'npx gotry doctor --fix', '给可重试命令')
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

// 19. onboarding --scan:隔离 HOME + 受控 PATH → 确定性只读计划(零 prompt 零安装,不写 gotry-state)
//     PATH 不能直接置空(execFileSync 用 child env.PATH 解析 'node',空则 ENOENT)——
//     故前置 node bin 目录(execPath dirname)再接一个空目录:node 可解析、hbcli/python3 不可达;
//     隔离 HOME 排除真机 extension/sidebar/calendar;reach 依赖 worktree 的 repoRoot/.venv
//     (本 fresh checkout 无 .venv → missing → auto);map-tools/ask-user 随包 vendor 就位 → ok。
{
  const isolated = mkdtempSync(join(tmpdir(), 'gotry-onboard-scan-'))
  const emptyPath = mkdtempSync(join(tmpdir(), 'gotry-empty-path-'))
  const safePath = `${dirname(process.execPath)}${delimiter}${emptyPath}`
  const r = runBootstrap(['onboarding', '--scan'], {
    HOME: isolated,
    PATH: safePath,
    FLYAI_API_KEY: '',
    GOTRY_SETUP_HBCLI: '',
    GOTRY_SETUP_REACH: '',
    GOTRY_SETUP_SIDEBAR: '',
  })
  assert.equal(r.code, 0, `--scan 应 exit 0\n${r.out}`)
  assert.ok(!r.out.includes('y/N'), '--scan 不应 prompt')
  assert.ok(!r.out.includes('开始自动配置'), '--scan 不应安装')
  const plan = JSON.parse(r.out.trim().split('\n').pop()!)
  assert.equal(plan.promptable, true)
  const autoLabels: string[] = plan.auto.map((g: { label: string }) => g.label)
  assert.ok(autoLabels.includes('dsh-better-sidebar(侧栏工作台)'), 'sidebar missing(隔离 HOME)→ auto')
  assert.ok(autoLabels.includes('hbcli(酒店实时源)'), 'hbcli missing(空 PATH)→ auto')
  assert.ok(autoLabels.includes('Agent Reach(网页/社媒读取)'), 'reach missing(fresh checkout 无 .venv)→ auto')
  const userActionLabels: string[] = plan.userAction.map((g: { label: string }) => g.label)
  assert.ok(userActionLabels.includes('GoTry Session Bridge 扩展'), '扩展 missing(隔离 HOME)→ user-action(浏览器商店)')
  assert.ok(userActionLabels.includes('FlyAI(飞猪官方检索)'), 'flyai 无 key → user-action')
  assert.ok(!plan.unavailable.some((g: { label: string }) => g.label.startsWith('dsh-map-tools')), 'map-tools 随包就位 → 非 unavailable')
  assert.ok(!plan.unavailable.some((g: { label: string }) => g.label.startsWith('dsh-tool-ask-user')), 'ask-user 随包就位 → 非 unavailable')
}
console.log('19. onboarding --scan(隔离 HOME + 受控 PATH,确定性只读计划,零 prompt 零安装)OK')

console.log('BOOTSTRAP TESTS: 19/19 OK(扩展就位 + 跳过开关 / wizard --dry-run / wizard 真实 / 扩展分发通道 / doctor 体检面 / calendar setup 状态面 / 显式跳过 + auto 跳过 + 单项跳过 / 启动摘要 / sidebar 落盘状态复核 / onboarding 分类+计划+跳过原因+yes+partial-failure+幂等+prompt+CLI 跳过+--scan)')
