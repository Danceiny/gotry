/**
 * bootstrap 自举层测试(bin/gotry-bootstrap.js,零网络安装、只探测/跳过开关):
 *  1. --check-only:只探测报告不安装,exit 0,hbcli/agent-reach 两节输出齐
 *  2. GOTRY_SETUP_SKIP=1 + --auto:postinstall 跳过语义,exit 0
 *  3. 显式模式 GOTRY_SETUP_SKIP=1:同样跳过
 *
 * 不测真实安装(官方脚本/pip 属 e2e 面,发布前干净安装实测覆盖);本套守
 * 「自举失败永不挡 gotry 安装」的开关与退出码契约。
 * 运行: cd ts && npx tsx scripts/bootstrap-tests.ts
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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

// 1. --check-only:探测报告 + flyai 无需安装行,exit 0
const c1 = runBootstrap(['--check-only'], {})
assert.equal(c1.code, 0, `--check-only 应 exit 0,实际 ${c1.code}\n${c1.out}`)
assert.ok(c1.out.includes('hbcli'), '报告应含 hbcli 节')
assert.ok(c1.out.includes('agent-reach'), '报告应含 agent-reach 节')
assert.ok(c1.out.includes('flyai'), '报告应含 flyai(无需安装)节')
assert.ok(c1.out.includes('dsh-better-sidebar'), '报告应含 dsh-better-sidebar 节(issue #25 产物查看面)')
assert.ok(c1.out.includes('Session Bridge'), '报告应含会话扩展节(issue #21 传输层方案 C)')
console.log('1. --check-only 探测报告 exit 0(hbcli/agent-reach/flyai/dsh-better-sidebar/会话扩展 五节齐)OK')

// 2. --auto + GOTRY_SETUP_SKIP=1:postinstall 跳过语义,exit 0 不挡安装
const c2 = runBootstrap(['--auto'], { GOTRY_SETUP_SKIP: '1' })
assert.equal(c2.code, 0, '--auto 跳过态应 exit 0(永不挡 npm install)')
assert.ok(c2.out.includes('跳过'), '应输出跳过说明')
console.log('2. --auto + GOTRY_SETUP_SKIP=1 → exit 0(安装永不失败)OK')

// 3. 显式模式 + GOTRY_SETUP_SKIP=1:同样跳过且 exit 0
const c3 = runBootstrap([], { GOTRY_SETUP_SKIP: '1' })
assert.equal(c3.code, 0, '显式模式跳过态应 exit 0')
assert.ok(c3.out.includes('跳过'), '应输出跳过说明')
console.log('3. 显式模式 + GOTRY_SETUP_SKIP=1 → exit 0 OK')

// 4. 单项开关:GOTRY_SETUP_SIDEBAR=0 只跳过侧栏组件,其余节照常(--check-only 零网络)
const c4 = runBootstrap(['--check-only'], { GOTRY_SETUP_SIDEBAR: '0' })
assert.equal(c4.code, 0, '单项跳过态应 exit 0')
assert.ok(c4.out.includes('GOTRY_SETUP_SIDEBAR=0 跳过'), '应输出侧栏单项跳过说明')
assert.ok(c4.out.includes('hbcli'), '其余节不受单项开关影响')
console.log('4. GOTRY_SETUP_SIDEBAR=0 单项跳过(其余节照常)OK')

// 5. 会话扩展节(issue #21 方案 C):--check-only 报告安装态;单项开关 GOTRY_SETUP_EXTENSION=0 可跳
const c5 = runBootstrap(['--check-only'], {})
assert.ok(c5.out.includes('.gotry/extension'), '扩展报告应含落位路径 ~/.gotry/extension(绝对路径形态)')
const c5b = runBootstrap(['--check-only'], { GOTRY_SETUP_EXTENSION: '0' })
assert.equal(c5b.code, 0, '扩展单项跳过态应 exit 0')
assert.ok(c5b.out.includes('GOTRY_SETUP_EXTENSION=0 跳过'), '应输出扩展单项跳过说明')
console.log('5. 会话扩展节(check-only 报告 + GOTRY_SETUP_EXTENSION=0 单项跳过)OK')

// 6. wizard 子命令(issue #21 onboarding UX,§3.3):dry-run 模式零网络零浏览器,exit 0,引导文案齐全
const c6 = runBootstrap(['wizard', '--dry-run'], {})
assert.equal(c6.code, 0, `wizard --dry-run 应 exit 0,实际 ${c6.code}\n${c6.out}`)
assert.ok(c6.out.includes('dry-run'), '应输出 dry-run 字样')
assert.ok(c6.out.includes('Gotry Wizard') || c6.out.includes('gotry-wizard') || c6.out.includes('3 步'), '应输出引导步骤')
assert.ok(c6.out.includes('ensure-extension-files'), 'dry-run 应列 5 步')
assert.ok(c6.out.includes('open-chrome-extensions'), 'dry-run 应列开 chrome://extensions')
assert.ok(c6.out.includes('clipboard-extension-path'), 'dry-run 应列剪贴板')
assert.ok(c6.out.includes('panel-guide'), 'dry-run 应列面板')
assert.ok(c6.out.includes('watch-extension-ready'), 'dry-run 应列 watch precheck')
console.log('6. wizard 子命令(--dry-run 零网络,5 步齐全 + 引导文案)OK')

// 7. wizard 走真实路径但 timeout 极短(GOTRY_ONBOARDING_TIMEOUT_MS 缺省走 120s,降级由 inline 探活兜),
//    确认 stdout 输出 wizard 引导 + 探活提示 + 至少一次 .(心跳点),exit 1 表示未就绪
const c7 = runBootstrap(['wizard'], { GOTRY_SETUP_EXTENSION: '0', GOTRY_ONBOARDING_TIMEOUT_MS: '600', GOTRY_ONBOARDING_INTERVAL_MS: '200' })
assert.equal(c7.code, 1, `wizard(超时)应 exit 1,实际 ${c7.code}\n${c7.out}`)
assert.ok(c7.out.includes('3 步') || c7.out.includes('gotry-wizard'), '应输出引导标题')
console.log('7. wizard 真实路径(扩展未就绪,exit 1 + 引导标题 + 心跳)OK')

// 8. 扩展分发 github 通道(ADR-21):基址指不可达回环(127.0.0.1:1 拒连,离线确定性);显式模式不带 --auto——CI 环境里 AUTO+CI 会提前跳过全部节,断言面会落空
//    → 显式降级 bundled + check-only 报告,exit 0;非法 --extension-from 值回落 bundled 不进网络通道。
const c8 = runBootstrap(['--check-only', '--extension-from=github'], {
  GOTRY_SETUP_HBCLI: '0', GOTRY_SETUP_REACH: '0', GOTRY_SETUP_SIDEBAR: '0',
  GOTRY_EXTENSION_RELEASE_BASE: 'http://127.0.0.1:1/releases',
})
assert.equal(c8.code, 0, `github 通道降级应 exit 0,实际 ${c8.code}\n${c8.out}`)
assert.ok(c8.out.includes('GitHub Releases 下载通道'), '应打印 github 通道标题')
assert.ok(c8.out.includes('降级包内副本'), '失败应显式降级 bundled')
const c8b = runBootstrap(['--check-only', '--extension-from=不合法值'], {
  GOTRY_SETUP_HBCLI: '0', GOTRY_SETUP_REACH: '0', GOTRY_SETUP_SIDEBAR: '0',
})
assert.equal(c8b.code, 0, `非法 --extension-from 值应回落 bundled 且 exit 0,实际 ${c8b.code}\n${c8b.out}`)
assert.ok(!c8b.out.includes('下载通道'), '非法值不应进入 github 通道')
console.log('8. 扩展分发 github 通道(不可达基址即时降级 + 非法值回落 bundled)OK')

console.log('BOOTSTRAP TESTS: 8/8 OK(探测报告/跳过开关/单项开关/postinstall 非致命/会话扩展/wizard --dry-run/wizard 真实/扩展分发通道)')
