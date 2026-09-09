/**
 * #232 supplier-release contract 离线钉版证明:
 *   - staicli@0.0.3 NPM tarball integrity 钉版(避免源码 vs 实际发布物漂移时 evidence 失锚);
 *   - 顶层子命令 / 全局旗标前缀 / selector 缺口 钉版(#232 §6 adapter 准入矩阵 CLI source 维度);
 *   - honest unknown/query-miss outcome 分类(timeout / kill / exit0-non-JSON / spawn-err → unknown;
 *     exit≠0 → failed;exit0+JSON → success),与 #232 §7「exit0 ≠ success」「窗口内 query miss
 *     不得变 reconciled_failed」语义对齐;
 *   - 全程隔离 STAICLI_HOME=tmp,不读不写真实 ~/.staicli/credentials.json,无 supplier 请求,
 *     无任何 HotelByte 凭证访问。
 *
 * 不重复 hbcli-tests.ts 已覆盖的:旗标回归 / ENOENT 人话化 / 候选路径 / 数据行 summary。
 * 不重复 hbcli-e2e-tests.ts 已覆盖的:真实 UAT 通道(本测试纯离线)。
 * 不实现任何 supplier write 路径,不动 #231/#232 owner PR 核心代码(只新增 outcome 字段
 * 与两个常量的最小切片)。
 *
 * 运行: cd ts && npx tsx scripts/hbcli-release-contract-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  callHbcliJson,
  STAICLI_0_0_3_INTEGRITY,
  STAICLI_COMMAND_SCHEMA,
} from '../capabilities/hbcli.ts'

const tmp = await mkdtemp(join(tmpdir(), 'hbcli-relcontract-'))
async function fakeBin(name: string, script: string): Promise<string> {
  const p = join(tmp, name)
  await writeFile(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return p
}

let passed = 0

// 1. integrity 钉版:staicli@0.0.3 NPM tarball sha512 必须等于 owner 评论锚定字符串;
//    离线断言,无需任何网络/凭证/供应商调用。
assert.equal(
  STAICLI_0_0_3_INTEGRITY,
  'sha512-xGzw6KBQ4r5l+CXDbU/35p2nh6ia4t7Hjh+D34IxQEgtaOOkt9iUATmxlFwcspmXCo6NuHoYFhCJ/rJ3rso5fg==',
  'STAICLI_0_0_3_INTEGRITY 必须等于 #136/#232 owner 评论 2026-09-08 锚定字符串',
)
assert.equal(STAICLI_COMMAND_SCHEMA.integrity, STAICLI_0_0_3_INTEGRITY,
  'STAICLI_COMMAND_SCHEMA.integrity 必须复用同一锚定字符串')
passed++
console.log('1. integrity 钉版(sha512 字符串 + schema 引用一致)OK')

// 2. command schema 钉版:子命令集合 + 全局旗标前缀 + selector 缺口
assert.equal(STAICLI_COMMAND_SCHEMA.version, '0.0.3', '钉 0.0.3')
assert.deepEqual([...STAICLI_COMMAND_SCHEMA.topLevelSubcommands], ['search', 'trade', 'auth'])
assert.ok(STAICLI_COMMAND_SCHEMA.topLevelSubcommands.includes('search'),
  '必须包含 search(#232 §6 检索三端点)')
assert.ok(STAICLI_COMMAND_SCHEMA.topLevelSubcommands.includes('trade'),
  '必须包含 trade(#232 §6 book/query-orders/cancel)')
assert.ok(STAICLI_COMMAND_SCHEMA.globalFlagPrefix.includes('--json'),
  '必须包含 --json 全局旗标(#232 §6 固定前缀)')
assert.ok(STAICLI_COMMAND_SCHEMA.globalFlagPrefix.includes('--env='),
  '必须包含 --env= 全局旗标(#232 §6 固定 env allowlist)')
assert.ok(STAICLI_COMMAND_SCHEMA.selectorUnsupported.includes('--tenant-entity-id'),
  'selector 缺口必须显式登记(0.0.3 实包无此参数)')
passed++
console.log('2. command schema 钉版(search/trade/auth + --json/--env= + --tenant-entity-id 缺口)OK')

// 3. outcome=failed:exit≠0 + stderr 有错误
{
  const failBin = await fakeBin('hbcli-fail', 'echo "ratePkgId validation failed" 1>&2\nexit 1\n')
  const r = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: failBin, timeoutMs: 5000 })
  assert.equal(r.outcome, 'failed', `exit≠0 应 outcome=failed,实际 ${r.outcome}`)
  assert.equal(r.via, 'hbcli-error', 'via 仍为 hbcli-error(向后兼容)')
  assert.equal(r.exitCode, 1, 'exitCode 透传')
  assert.ok(r.error, 'error 字段存在')
  passed++
  console.log('3. exit≠0 + stderr → outcome=failed, via=hbcli-error(向后兼容)OK')
}

// 4. outcome=success:exit 0 + JSON 可解析 + result 非空
{
  const okBin = await fakeBin('hbcli-ok', `echo '{"list":[]}'\nexit 0\n`)
  const r = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: okBin, timeoutMs: 5000 })
  assert.equal(r.outcome, 'success', `exit0+JSON 应 outcome=success,实际 ${r.outcome}`)
  assert.equal(r.via, 'hbcli-realtime', 'via=hbcli-realtime')
  assert.deepEqual(r.result, { list: [] }, 'result 可消费')
  passed++
  console.log('4. exit 0 + JSON → outcome=success, via=hbcli-realtimeOK')
}

// 5. outcome=unknown(关键:#232 §7 exit0 ≠ success):exit 0 但 stdout 非 JSON
{
  const nonJsonBin = await fakeBin('hbcli-nonjson', 'echo "OK" -- 0.0.3\nexit 0\n')
  const r = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: nonJsonBin, timeoutMs: 5000 })
  assert.equal(r.outcome, 'unknown', `exit0+非 JSON 应 outcome=unknown(exit0≠success),实际 ${r.outcome}`)
  assert.equal(r.via, 'hbcli-realtime', 'via 仍记为 hbcli-realtime(向后兼容;渠道可达但 outcome 不可信)')
  assert.equal(r.result, null, '非 JSON → result=null')
  passed++
  console.log('5. exit 0 + 非 JSON stdout → outcome=unknown, via=hbcli-realtime(诚实 unknown)OK')
}

// 6. outcome=unknown:timeout → SIGKILL,无法判定 supplier outcome
{
  const slowBin = await fakeBin('hbcli-slow', 'sleep 5\nexit 0\n')
  const r = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: slowBin, timeoutMs: 100 })
  assert.equal(r.outcome, 'unknown', `timeout 应 outcome=unknown,实际 ${r.outcome}`)
  assert.equal(r.via, 'hbcli-error', 'via=hbcli-error(超时归 error 类)')
  assert.match(r.evidence, /timeout/, 'evidence 应带 timeout 标记')
  passed++
  console.log('6. timeout(100ms vs 5s sleep) → outcome=unknown, via=hbcli-errorOK')
}

// 7. outcome=unknown:spawn ENOENT(无 binary,无法判定 supplier 端)
{
  const r = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: '/nope/hbcli-relcontract', timeoutMs: 5000 })
  assert.equal(r.outcome, 'unknown', `ENOENT 应 outcome=unknown(无 supplier 触达),实际 ${r.outcome}`)
  assert.equal(r.via, 'hbcli-error', 'via=hbcli-error')
  passed++
  console.log('7. ENOENT(spawn_error) → outcome=unknown, via=hbcli-errorOK')
}

// 8. 隔离:STAICLI_HOME=tmp + 调用真二进制时仍正常降级;真实 ~/.staicli 不被读取
//    (spawn wrapper 通过 process.env 继承 STAICLI_HOME,但 hbcli.ts 不主动读该变量;
//    隔离面是 hbcli.ts 本身不触碰用户共享状态——这里用 /nope 二进制走 ENOENT 路径)
{
  const isolatedHome = join(tmp, 'staicli-home')
  const prev = process.env.STAICLI_HOME
  process.env.STAICLI_HOME = isolatedHome
  try {
    const r = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: '/nope/hbcli-iso', timeoutMs: 5000 })
    assert.equal(r.outcome, 'unknown', '隔离 STAICLI_HOME 下 ENOENT 仍 outcome=unknown')
    assert.equal(r.via, 'hbcli-error')
    passed++
    console.log(`8. 隔离 STAICLI_HOME=${isolatedHome.replace(tmpdir(), '$TMPDIR')} 不影响 outcome 分类OK`)
  } finally {
    if (prev === undefined) delete process.env.STAICLI_HOME
    else process.env.STAICLI_HOME = prev
  }
}

// 9. evidence 链保留:#232 §12 audit redaction 仍走原 evidence 字段(outcome 增强,不破坏审计链)
{
  const okBin = await fakeBin('hbcli-ok-ev', `echo '{"hotels":[{"id":"h1"}]}'\nexit 0\n`)
  const r = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: okBin, timeoutMs: 5000 })
  assert.match(r.evidence, /^\[实时API:hbcli@/, 'evidence 仍带实时通道时间戳标注(L4 不变量)')
  assert.equal(r.outcome, 'success')
  passed++
  console.log('9. evidence 链(L4 不变量)保持 + outcome 增强不破坏审计链OK')
}

// 10. honest unknown 在 unknown fixtures 中不被误投影为 reconciled_failed:
//     outcome=unknown 的结果不应被自动重试同 write effect(#232 §6 否证):
//     本断言只为「outcome 字段明确区分 unknown 与 failed」做事实钉版,不测试重试策略。
{
  const failBin = await fakeBin('hbcli-fail-ev', 'echo "denied" 1>&2\nexit 1\n')
  const rf = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: failBin, timeoutMs: 5000 })
  const ru = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: '/nope/hbcli-x', timeoutMs: 5000 })
  assert.notEqual(rf.outcome, ru.outcome,
    `failed 与 unknown 必须可区分(failed=${rf.outcome}, unknown=${ru.outcome})`)
  assert.equal(rf.outcome, 'failed')
  assert.equal(ru.outcome, 'unknown')
  passed++
  console.log('10. outcome failed ≠ unknown(failed=有据报错;unknown=无法判定)OK')
}

await rm(tmp, { recursive: true, force: true })
console.log(`HBCLI RELEASE CONTRACT TESTS: ${passed}/10 OK (integrity/schema × 4 path classification × 4 isolation/evidence × 2)`)
