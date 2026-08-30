/**
 * wizard bootstrap CLI(bin/gotry-bootstrap.js wizard 调这个 tsx 子进程):
 * 把 wizard.ts 的 5 步编排 + 剪贴板 + GUI 面板完整跑通,产物 JSON 单行 stdout 给父进程。
 *
 * 与 health-watch-cli 同模式:bootstrap 是纯 JS,wizard.ts 是 TS;走 spawn npx tsx。
 * **不重复实现** wizard.ts 任何逻辑——只读 stdin args、await wizard.runOnboardingWizard()、
 * 把 OnboardingResult JSON 单行输出。
 *
 * 退出码:0 = wizard 编排完成(成功或部分 skip;exit 由 stdout JSON 表达);
 *        非 0 = 异常。
 *
 * argv:
 *   --timeout <ms>  health-watch timeout(留作扩展,本期未用)
 *   --extension-dir <path>  覆盖 ~/.gotry/extension
 */

import process from 'node:process'
import { runOnboardingWizard, type OnboardingResult } from '../capabilities/session/wizard.ts'

interface Args {
  extensionDir?: string
  sourceDir?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const cur = argv[i]!
    if (cur === '--extension-dir') args.extensionDir = argv[++i]
    else if (cur === '--source-dir') args.sourceDir = argv[++i]
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result: OnboardingResult = await runOnboardingWizard({
    dryRun: false,
    ...(args.extensionDir ? { extensionDir: args.extensionDir } : {}),
    ...(args.sourceDir ? { sourceDir: args.sourceDir } : {}),
    // 不强制 platform:让 wizard 内部 detectPlatform 走;CI/headless 自然降级
  })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(0)
}

main().catch((e: unknown) => {
  process.stderr.write(`[wizard-bootstrap] error: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(2)
})
