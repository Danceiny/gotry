#!/usr/bin/env tsx
/**
 * 会话双区记忆观测 CLI(P4-4,issue #255;#228 收集器同族的显式 opt-in 面)。
 *
 *   report --fixture <file>                    只读指标报告(夹具只证契约,不证价值)
 *   counters [--state-root <root>]             只读形状计数(零 id/零载荷/零时间戳)
 *   export --fixture <file> --consent <text> --hmac-key <key> --dataset <name>
 *          [--state-root <root>] [--out <file>]
 *                                              候选级导出(HMAC 假名引用 + 计数,
 *                                              永不自证;--out 不覆盖既有文件)
 *
 * 全程**只读**:不建库、不写账本、零网络、零定时器;--out 是唯一写动作且拒绝覆盖。
 * 运行:cd ts && npx tsx scripts/session-zone-observe.ts report --fixture data/session-zone-metric-fixture.json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { openLedgerIfExists } from '../src/state-ledger.ts'
import { readZoneLog } from '../src/session-zone-ledger.ts'
import {
  buildZoneObservationExport,
  projectZoneCounters,
  projectZoneMetrics,
  zeroSignalCounts,
  zoneSignalSnapshot,
  isZoneObservationOptIn,
  type ZoneShapeCounters,
} from '../src/session-zone-observation.ts'
import { ZONE_EVENT_KINDS } from '../src/session-zones.ts'

const HELP = `用法: npx tsx scripts/session-zone-observe.ts <report|counters|export> [options]
  report   --fixture <file>
  counters [--state-root <root>]
  export   --fixture <file> --consent <text> --hmac-key <key> --dataset <name> [--state-root <root>] [--out <file>]
纪律:全程只读(不建库/不写账本/零网络/零定时器);夹具只证契约不证价值;
      导出只带计数与 HMAC 假名引用,source_review 永远停在 candidate(自证不算证据)。`

function usage(message: string): never {
  console.error(message)
  console.error(HELP)
  process.exit(1)
}

const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = new Map<string, string>()
for (let i = 1; i < argv.length; i += 1) {
  const token = argv[i]!
  if (!token.startsWith('--')) usage(`未知位置参数:${token}`)
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) usage(`${token} 缺少值`)
  if (flags.has(token)) usage(`重复选项 ${token}`)
  flags.set(token, value)
  i += 1
}

function readFixture(): unknown {
  const path = flags.get('--fixture')
  if (!path) usage('需要 --fixture <file>')
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    usage(`夹具不可读或非法 JSON:${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 只读计数:无账本 = 全 0(不建库)。
 * 日志触读上界即拒:`readEvents` 丢的是最老事件,残缺日志算出的计数会被当成全量
 * (与 forget/export 同一条截断纪律)。
 */
function countersOf(now: string): ZoneShapeCounters {
  const root = flags.get('--state-root') ?? '.'
  const ledger = openLedgerIfExists(root)
  if (!ledger) return projectZoneCounters([], now)
  const read = readZoneLog(ledger)
  if (read.truncated) {
    console.error('log_truncated: 分区事件日志触到读上界,计数拒绝在残缺日志上输出(会被当成全量)')
    process.exit(2)
  }
  return projectZoneCounters(read.events, now)
}

const now = new Date().toISOString()

switch (cmd) {
  case 'report': {
    const r = projectZoneMetrics(readFixture())
    if (!r.ok) {
      console.error(`${r.code}: ${r.detail}`)
      process.exit(2)
    }
    console.log(JSON.stringify(r.report, null, 2))
    break
  }
  case 'counters': {
    console.log(JSON.stringify({ counters: countersOf(now), event_kinds: ZONE_EVENT_KINDS, observation_opt_in: isZoneObservationOptIn() }, null, 2))
    break
  }
  case 'export': {
    const consent = flags.get('--consent')
    const dataset = flags.get('--dataset')
    const hmacKey = flags.get('--hmac-key')
    if (!consent) usage('需要 --consent <text>(显式同意声明)')
    if (!dataset) usage('需要 --dataset <name>')
    const report = projectZoneMetrics(readFixture())
    if (!report.ok) {
      console.error(`${report.code}: ${report.detail}`)
      process.exit(2)
    }
    const optIn = isZoneObservationOptIn()
    const built = buildZoneObservationExport({
      evidenceKind: report.report.evidence_kind,
      dataset,
      consent,
      hmacKey,
      counters: countersOf(now),
      signals: optIn ? zoneSignalSnapshot() : zeroSignalCounts(),
      observationOptIn: optIn,
      report: report.report,
      generatedAt: now,
    })
    if (!built.ok) {
      console.error(`${built.code}: ${built.detail}`)
      process.exit(2)
    }
    const text = JSON.stringify(built.export, null, 2)
    const out = flags.get('--out')
    if (out) {
      if (existsSync(out)) {
        console.error(`output_exists: ${out}(拒绝覆盖既有导出)`)
        process.exit(2)
      }
      writeFileSync(out, text + '\n', 'utf-8')
      console.log(`候选级导出已写出(只带计数与假名引用,未自证):${out}`)
    } else {
      console.log(text)
    }
    break
  }
  default:
    usage(cmd ? `未知命令 ${cmd}` : '缺少命令')
}
