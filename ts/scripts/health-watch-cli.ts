/**
 * health-watch CLI 入口(gotry setup wizard 闭环 §3.3):
 *
 * bin/gotry-bootstrap.js wizard 子命令 spawn `npx tsx scripts/health-watch-cli.ts`,
 * 本脚本启 startExtensionHealthWatch 后,把 waitReady 结果以单行 JSON 形式 stdout 打印。
 *
 * 参数(全部 env/argv 可读,缺省走 §3.3 设计默认值):
 *   --timeout <ms>   最长等多久(默认 120_000)
 *   --interval <ms>  探活间隔(默认 5_000)
 *   --json           单行 JSON 输出(默认开,方便父进程解析)
 *
 * 退出码:0 = ready 或 timeout(语义由 JSON 字段区分,父进程据此 exit 0/1);非 0 = 异常。
 *
 * 不打 .(心跳点)给父进程——父进程单独打,避免双源混 stdout(JSON 行被 . 切断)。
 */

import process from 'node:process'
import { startExtensionHealthWatch } from '../capabilities/session/health-watch.ts'

interface Args {
  timeoutMs: number
  intervalMs: number
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { timeoutMs: 120_000, intervalMs: 5_000, json: true }
  for (let i = 0; i < argv.length; i += 1) {
    const cur = argv[i]!
    if (cur === '--timeout') args.timeoutMs = parseInt(argv[++i] ?? '120000', 10)
    else if (cur === '--interval') args.intervalMs = parseInt(argv[++i] ?? '5000', 10)
    else if (cur === '--json') args.json = true
    else if (cur === '--no-json') args.json = false
  }
  if (Number.isNaN(args.timeoutMs) || args.timeoutMs < 0) args.timeoutMs = 120_000
  if (Number.isNaN(args.intervalMs) || args.intervalMs < 1_000) args.intervalMs = 5_000
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  // 双因子业务探针默认关:心跳 + cookie-names 双通过才算 ready,wizard 30s 内难凑齐。
  // 单心跳就够(扩展真在线 = SW 在跑,permission 缺时 cookie job 失败会显式 verdict 报错);
  // 想要严格双因子,CLI 显式 --business-probe。
  const businessProbe = process.argv.includes('--business-probe')
  const watch = startExtensionHealthWatch({
    timeoutMs: args.timeoutMs,
    intervalMs: args.intervalMs,
    keepBridge: true,
    businessProbe,
  })
  // Ctrl+C 转 cancelled
  process.on('SIGINT', () => { watch.cancel('SIGINT'); process.exit(0) })
  process.on('SIGTERM', () => { watch.cancel('SIGTERM'); process.exit(0) })
  const outcome = await watch.waitReady()
  if (args.json) {
    process.stdout.write(JSON.stringify(outcome) + '\n')
  } else {
    process.stdout.write(`ready=${outcome.ready} attempts=${outcome.attempts} waitedMs=${outcome.waitedMs} reason=${'reason' in outcome ? outcome.reason : 'ok'}\n`)
  }
  process.exit(0)
}

main().catch((e: unknown) => {
  process.stderr.write(`[health-watch-cli] error: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(2)
})
