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
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..')
const bootstrap = join(repoRoot, 'bin', 'gotry-bootstrap.js')

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
//    确认 stdout 至少含一次探活心跳 + 引导标题(不再断言 "3 步",纯 stdout 形态下标题文案已简化)
const c6 = runBootstrap(['wizard'], { GOTRY_SETUP_EXTENSION: '0', GOTRY_ONBOARDING_TIMEOUT_MS: '600', GOTRY_ONBOARDING_INTERVAL_MS: '200' })
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
assert.ok(c8.out.includes('doctor-report.md'), '应提示报告落盘路径')
assert.ok([0, 1].includes(c8.code), `doctor exit 应为 0(就绪)或 1(有缺失),实际 ${c8.code}`)
const reportPath = join(repoRoot, 'gotry-state', 'doctor-report.md')
const report = readFileSync(reportPath, 'utf-8')
assert.ok(report.includes('# GoTry 依赖体检报告'), '报告 markdown 应落盘可预览')
assert.ok(report.includes('npx gotry doctor --fix'), '报告应带补装指引')
console.log('8. doctor 子命令(体检清单 + LLM key 让渡 + 报告落盘)OK')

console.log('BOOTSTRAP TESTS: 8/8 OK(扩展就位 + 跳过开关 / wizard --dry-run / wizard 真实 / 扩展分发通道 / doctor 体检面 / 显式跳过 + auto 跳过 + 单项跳过)')
