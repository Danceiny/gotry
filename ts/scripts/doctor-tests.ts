/**
 * doctor 能力层测试(离线,注入 repoRoot/homeDir/env,零安装零网络写路径):
 *  1. 空 tmp 环境 → agent-reach=missing / 扩展=missing / flyai=degraded(无 key)/ LLM key 恒 ok 且不进 broken
 *  2. 补齐假 .venv 双文件 → agent-reach=ok;只补 python → degraded(半可用态被显式区分)
 *  3. FLYAI_API_KEY 注入 → flyai=ok
 *  4. nodeOk 边界(22.14/22.15/23.0)
 *  5. renderDoctorReportMd:命令类 fix 加反引号、prose 类不加;报告含全部条目
 *  6. MCP 工具面:gotry_doctor 注册可执行,isolated stateRoot 落 doctor-report.md
 *
 * 运行: cd ts && npx tsx scripts/doctor-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDoctorChecks, renderDoctorReportMd, nodeOk } from '../capabilities/doctor.ts'
import { apply } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

const tmp = await mkdtemp(join(tmpdir(), 'gotry-doctor-test-'))
const emptyRepo = join(tmp, 'repo-empty')
const emptyHome = join(tmp, 'home-empty')
await mkdir(emptyRepo, { recursive: true })
await mkdir(emptyHome, { recursive: true })

// 1. 空 tmp 环境:全部缺省态;LLM key 让渡面不进 broken 计数
const r1 = await runDoctorChecks({ repoRoot: emptyRepo, homeDir: emptyHome, env: {} })
const byId = (id: string) => r1.items.find(i => i.id === id)
assert.ok(byId('agent-reach'), 'agent-reach 项存在')
assert.equal(byId('agent-reach')!.status, 'missing', `空仓 agent-reach=missing,实际 ${byId('agent-reach')!.status}`)
assert.match(byId('agent-reach')!.fix ?? '', /npx gotry doctor --fix/, 'missing 项带精确补装指引')
assert.equal(byId('extension')!.status, 'missing', '空 home 扩展=missing')
assert.equal(byId('flyai')!.status, 'degraded', '无 key flyai=degraded(有共享试用,非缺失)')
assert.equal(byId('llm-key')!.status, 'ok', 'LLM key 恒 ok(让渡面)')
assert.equal(r1.ok, false, '有 missing 项时报告 ok=false')
assert.match(r1.summary, /待处理/, 'summary 指明待处理项')
console.log('1. 空 tmp 环境 → missing/degraded 分级正确,LLM key 让渡 OK')

// 2. 假 .venv:双文件齐 → ok;只 python → degraded
const repoPartial = join(tmp, 'repo-partial')
await mkdir(join(repoPartial, '.venv/bin'), { recursive: true })
await writeFile(join(repoPartial, '.venv/bin/python'), '#!/bin/sh\n', { mode: 0o755 })
const r2a = await runDoctorChecks({ repoRoot: repoPartial, homeDir: emptyHome, env: {} })
assert.equal(r2a.items.find(i => i.id === 'agent-reach')!.status, 'degraded', '只 python → degraded(半可用显式区分)')
const repoFull = join(tmp, 'repo-full')
await mkdir(join(repoFull, '.venv/bin'), { recursive: true })
await writeFile(join(repoFull, '.venv/bin/python'), '#!/bin/sh\n', { mode: 0o755 })
await writeFile(join(repoFull, '.venv/bin/agent-reach'), '#!/bin/sh\n', { mode: 0o755 })
const r2b = await runDoctorChecks({ repoRoot: repoFull, homeDir: emptyHome, env: {} })
assert.equal(r2b.items.find(i => i.id === 'agent-reach')!.status, 'ok', 'python+agent-reach 齐 → ok')
console.log('2. .venv 三态(missing/degraded/ok)分级 OK')

// 3. FLYAI_API_KEY 注入 → ok
const r3 = await runDoctorChecks({ repoRoot: emptyRepo, homeDir: emptyHome, env: { FLYAI_API_KEY: 'test-key' } })
assert.equal(r3.items.find(i => i.id === 'flyai')!.status, 'ok', '有正式 key → flyai=ok')
console.log('3. FLYAI_API_KEY 注入 → flyai ok OK')

// 4. nodeOk 边界
assert.equal(nodeOk('22.14.0'), false, '22.14 不足')
assert.equal(nodeOk('22.15.0'), true, '22.15 达标')
assert.equal(nodeOk('23.0.0'), true, '23.x 达标')
console.log('4. nodeOk 边界 OK')

// 5. 报告渲染:命令类反引号、prose 类原样
const md = renderDoctorReportMd(r1)
assert.match(md, /# GoTry 依赖体检报告/, '报告标题')
assert.match(md, /`npx gotry doctor --fix`/, '命令类 fix 加反引号')
assert.match(md, /flyai\.open\.fliggy\.com 控制台申请正式 key/, 'prose 类 fix 原样呈现')
assert.ok(!md.includes('`到 flyai'), 'prose 类 fix 不应整体包反引号')
assert.match(md, /LLM key/, '让渡面(LLM key)照常入表')
console.log('5. 报告渲染 OK')

// 6. MCP 工具面:gotry_doctor 注册 + isolated stateRoot 报告落盘
const smokeRoot = await mkdtemp(join(tmpdir(), 'gotry-doctor-state-'))
const registered: Array<{ name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }> = []
const ctx = {
  tools: { register: (t: unknown) => registered.push(t as never) },
  systemPrompt: { variable: () => {} },
  on: () => () => {},
} as unknown as Context
apply(ctx, { stateRoot: smokeRoot, timeoutMs: 30_000, hbcliBin: 'hbcli-not-on-path', sessionAccess: 'ask' } as never)
const doctorTool = registered.find(t => t.name === 'gotry_doctor')
assert.ok(doctorTool, 'gotry_doctor 已注册')
const out = await doctorTool!.execute({ query: {} }, null) as { ok?: boolean; verdict?: string; items?: unknown[]; report_path?: string; summary?: string }
assert.equal(out.ok, true, '体检工具 ok=true(体检本身成功,与依赖是否缺失无关)')
assert.equal(out.verdict, 'needs-attention', '注入环境外仍能出 verdict(本机真实状态,不判 all-clear)')
assert.ok(Array.isArray(out.items) && out.items.length >= 6, 'items 齐全')
assert.ok(out.report_path && out.report_path.includes(smokeRoot), `报告落在 isolated stateRoot: ${out.report_path}`)
const reportMd = await readFile(out.report_path!, 'utf-8')
assert.match(reportMd, /# GoTry 依赖体检报告/, '落盘报告可预览')
await rm(tmp, { recursive: true, force: true })
await rm(smokeRoot, { recursive: true, force: true })
console.log('6. gotry_doctor 工具面 + 报告落盘 OK')

console.log('doctor-tests: 全部通过')
