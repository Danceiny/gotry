/**
 * hbcli 封装单元测试:用临时脚本作为假 hbcli 二进制测三条路径。
 * - 路径 1: 假 hbcli 回 exit 0 + JSON → via=hbcli-realtime
 * - 路径 2: 假 hbcli exit 1 → via=hbcli-error + 证据链标注 error@ts
 * - 路径 3: 不存在的 hbcli → via=hbcli-error + 证据链标注 spawn_error@ts
 * 运行: cd ts && node --experimental-strip-types scripts/hbcli-tests.ts
 */

import assert from 'node:assert/strict'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callHbcliJson, searchHotels } from '../capabilities/hbcli.ts'

const tmp = await mkdtemp(join(tmpdir(), 'hbcli-test-'))
async function fakeBin(name: string, code: number, payload: string): Promise<string> {
  const p = join(tmp, name)
  await writeFile(p, `#!/bin/sh\necho '${payload}'\nexit ${code}\n`, { mode: 0o755 })
  return p
}

const okBin = await fakeBin('hbcli-ok', 0, '{"hotels":[{"id":"h1","name":"x"}]}')
const failBin = await fakeBin('hbcli-fail', 1, 'certificate has expired')
// 重写:失败时把 message 写到 stderr
const failBin2 = join(tmp, 'hbcli-fail2')
await writeFile(failBin2, `#!/bin/sh\nexit 1\n`, { mode: 0o755 })

// 1. 实时成功
const r1 = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: okBin })
assert.equal(r1.via, 'hbcli-realtime', 'happy path')
assert.deepEqual(r1.result, { hotels: [{ id: 'h1', name: 'x' }] })
assert.match(r1.evidence, /^\[实时API:hbcli@/)
assert.ok(r1.latencyMs >= 0)

// 2. 实时失败(exit 1)
const r2 = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: failBin2, timeoutMs: 5000 })
assert.equal(r2.via, 'hbcli-error', 'error path')
assert.match(r2.evidence, /\[实时API:hbcli@error@/, `evidence got: ${r2.evidence}`)
assert.equal(r2.exitCode, 1, '失败时 exitCode 透传')
assert.ok(r2.error, '有 error 字段')

// 3. 二进制不存在
const r3 = await callHbcliJson(['search', 'hotel-list', '--json'], { hbcliBin: '/nope/hbcli', timeoutMs: 5000 })
assert.equal(r3.via, 'hbcli-error', 'no-binary path')
assert.match(r3.evidence, /spawn_error/, `evidence got: ${r3.evidence}`)

// 4. searchHotels 高层降级:静态包按目的地过滤命中块(issue #24 契约,不整包倾倒)
const fallback = join(tmp, 'hotels-fallback.json')
await writeFile(fallback, JSON.stringify({ meta: 'fake', stays: [{ id: 's1', note: '普吉岛 workation 两周(13 晚)' }, { id: 's2', note: '曼谷周末(2 晚)' }] }))
// v0.3.0 旗标回归:上游扁平化后旗标是 --destination-name/--room-occupancies
{
  const { writeFileSync, chmodSync } = await import('node:fs')
  const echoBin = join(tmp, 'hbcli-echo')
  writeFileSync(echoBin, '#!/bin/sh\necho "ARGS:$@"; echo \'{}\' ')
  chmodSync(echoBin, 0o755)
  const re = await searchHotels({ destination: '普吉', adults: 2 }, { hbcliBin: echoBin })
  const argLine = JSON.stringify(re)
  if (!argLine.includes('destination-name') || !argLine.includes('room-occupancies')) {
    throw new Error(`FAIL: v0.3.0 旗标未对齐,实际 ${argLine.slice(0, 200)}`)
  }
  console.log('5. v0.3.0 旗标(--destination-name/--room-occupancies)对齐 OK')
}

const r4 = await searchHotels({ destination: '普吉岛' }, { hbcliBin: failBin2, fallbackPath: fallback })
assert.equal(r4.via, 'hbcli-error', 'searchHotels: fails to hbcli → fallback')
assert.equal(r4.summary.includes('降级到静态包'), true, 'summary 指明降级')
assert.deepEqual(r4.hotels, { stays: [{ id: 's1', note: '普吉岛 workation 两周(13 晚)' }] }, 'hotels 只含目的地命中的住宿块')
assert.equal(r4.summary.includes('命中 1 个住宿块'), true, 'summary 指明命中块数')

// 5. 静态包无该目的地 → hotels=null 明示无数据,不伪装成可用结果
const r5 = await searchHotels({ destination: '巴黎' }, { hbcliBin: failBin2, fallbackPath: fallback })
assert.equal(r5.hotels ?? null, null, '无目的地命中时 hotels 为 null(不整包倾倒)')
assert.match(r5.summary, /无「巴黎」住宿数据/, 'summary 明示静态包无该目的地')

await rm(tmp, { recursive: true, force: true })
console.log('HBCLI TESTS: 6/6 OK (happy / error / no-binary / fallback-filter / fallback-no-match / v0.3.0 旗标回归)')
