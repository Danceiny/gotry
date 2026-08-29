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
console.log('1. --check-only 探测报告 exit 0(hbcli/agent-reach/flyai 三节齐)OK')

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

console.log('BOOTSTRAP TESTS: 3/3 OK(探测报告/跳过开关/postinstall 非致命)')
