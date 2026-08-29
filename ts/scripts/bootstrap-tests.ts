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

console.log('BOOTSTRAP TESTS: 5/5 OK(探测报告/跳过开关/单项开关/postinstall 非致命/会话扩展)')
