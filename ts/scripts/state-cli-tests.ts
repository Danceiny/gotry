/**
 * 账本 CLI e2e(run-all §29):子进程走 state-cli 的操作面——
 * migrate(旧文件→账本)/ stats / log / export(视图单向导出)/ forget(物理硬删)/
 * pw-request→pw-confirm→pw-list(saga CLI 面)。
 * 运行(在 ts/ 下):npx tsx scripts/state-cli-tests.ts
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++
    console.log(`  ok - ${msg}`)
  } else {
    fail++
    console.error(`  FAIL - ${msg}`)
  }
}

function cli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('npx', ['tsx', 'scripts/state-cli.ts', ...args], { encoding: 'utf-8' }) as SpawnSyncReturns<string>
}

// 迁移面:旧文件 root → migrate → stats/log/export
const root = mkdtempSync(join(tmpdir(), 'gotry-cli-'))
const dir = join(root, 'gotry-state')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'motivation-profile.json'), JSON.stringify({ weights: { curiosity: 0.6 }, evidence: ['原话A'], hard: {} }))
writeFileSync(join(dir, 'wish-pool.json'), JSON.stringify([{ wish_id: 'wLEGACY1', name: '京都', conditions: { days: 7 }, added_at: '2026-08-01T00:00:00Z' }]))

const mig = cli(['migrate', root])
assert(mig.status === 0 && /账本就绪/.test(mig.stdout ?? ''), `migrate exit 0 且报告就绪(实际 ${mig.status}:${(mig.stderr ?? '').slice(0, 200)})`)
assert(existsSync(join(dir, 'gotry-state.db')), 'migrate 后账本文件存在')
assert(existsSync(join(dir, 'pre-ledger-backup', 'wish-pool.json')), 'migrate 前自动快照(pre-ledger-backup/)')

const stats = cli(['stats', root])
assert(stats.status === 0 && /wishes=1/.test(stats.stdout ?? '') && /events=\d+/.test(stats.stdout ?? ''), `stats 计数正确(${(stats.stdout ?? '').trim()})`)

const log = cli(['log', root, '--limit', '3'])
assert(log.status === 0 && /\bwish\.imported\b|\bmotivation\.imported\b/.test(log.stdout ?? ''), `log 呈现账本事件(append-only 审计面)`)

// export:视图单向导出(DB→文件)
rmSync(join(dir, 'wish-pool.json'))
const exp = cli(['export', root])
assert(exp.status === 0 && existsSync(join(dir, 'wish-pool.json')), 'export 重建旧文件名视图(红线 6:可见可导出)')
const exported = JSON.parse(readFileSync(join(dir, 'wish-pool.json'), 'utf-8')) as Array<{ wish_id?: string }>
assert(exported[0]?.wish_id === 'wLEGACY1', 'export 视图内容与账本一致')

// forget:物理硬删 + 审计一行
const fg = cli(['forget', root, 'wish', 'wLEGACY1'])
assert(fg.status === 0 && /物理硬删/.test(fg.stdout ?? ''), 'forget 执行成功')
const stats2 = cli(['stats', root])
assert(/wishes=0/.test(stats2.stdout ?? ''), 'forget 后愿望池归零(红线 6「可删除」,D5 物理硬删)')
const log2 = cli(['log', root, '--limit', '3'])
assert(/forget\.executed/.test(log2.stdout ?? ''), 'forget 留审计一行(删除本身可溯源)')

// saga CLI 面:fresh root → pw-request → pw-confirm → pw-list
const root2 = mkdtempSync(join(tmpdir(), 'gotry-cli2-'))
const req = cli(['pw-request', root2, 'booking:e2e-1', 'flight-order-confirm', '{"flight":"MU123"}'])
assert(req.status === 0 && /"created":true/.test(req.stdout ?? ''), 'pw-request 登记成功(L2:只登记不执行)')
const dup = cli(['pw-request', root2, 'booking:e2e-1', 'flight-order-confirm', '{"flight":"MU123"}'])
assert(/"created":false/.test(dup.stdout ?? ''), 'pw-request 幂等键去重')
const conf = cli(['pw-confirm', root2, 'booking:e2e-1', 'PNR-XYZ'])
assert(conf.status === 0 && /"ok":true/.test(conf.stdout ?? ''), 'pw-confirm 携 receipt 确认(L3)')
const list = cli(['pw-list', root2])
assert(/confirmed/.test(list.stdout ?? '') && /PNR-XYZ/.test(list.stdout ?? ''), 'pw-list 呈现终态与 receipt')

rmSync(root, { recursive: true, force: true })
rmSync(root2, { recursive: true, force: true })
console.log(`\nSTATE-CLI TESTS: ${pass} ok, ${fail} fail`)
if (fail > 0) process.exit(1)
