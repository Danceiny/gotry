/**
 * 崩溃注入探针(session-zone-ledger-tests 的子进程,P4-2 验收「kill -9 中途 =
 * 要么全有要么全无」):在**同一事务**里追加两条分区事件,然后按 mode 决定命运。
 *
 *   pre-commit  全部 INSERT 已执行、事务尚未提交时 SIGKILL 自己 → 账本必须零新行
 *   committed   同样两次追加,正常提交后 exit 0 → 账本必须有且仅有两行
 *
 * 用法:npx tsx scripts/session-zone-crash.ts <stateRoot> pre-commit|committed
 * 全离线:临时 stateRoot,零网络,零真实 LLM。
 */

import { ensureLedger } from '../src/state-ledger.ts'
import { appendZoneWrites, readZoneLog } from '../src/session-zone-ledger.ts'

const [root, mode] = process.argv.slice(2)
if (!root || (mode !== 'pre-commit' && mode !== 'committed')) {
  console.error('用法:npx tsx scripts/session-zone-crash.ts <stateRoot> pre-commit|committed')
  process.exit(1)
}

const TS = '2026-10-04T08:00:00.000Z'
const SESSION = 'sess-crash-probe'
const ledger = ensureLedger(root)

const results = appendZoneWrites(
  ledger,
  [
    {
      op: 'capture',
      input: {
        session_ref: SESSION,
        tier: 'intent',
        kind: 'destination',
        payload: { city: '大理' },
        evidence_ref: { session_ref: SESSION, turn: 1 },
        ts: TS,
      },
    },
    {
      op: 'capture',
      input: {
        session_ref: SESSION,
        tier: 'resource',
        kind: 'price_band',
        payload: { low: 400, high: 900 },
        evidence_ref: { session_ref: SESSION, turn: 2 },
        ts: TS,
      },
    },
  ],
  mode === 'pre-commit'
    ? { beforeCommit: () => process.kill(process.pid, 'SIGKILL') }
    : {},
)

// pre-commit 模式永远到不了这里(上一行已被 SIGKILL)
const appended = results.filter(r => r.ok && r.appended).length
console.log(`committed appended=${appended} folded=${Object.keys(readZoneLog(ledger).state.hot).length}`)
