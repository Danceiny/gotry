/**
 * extension-distribution CLI 入口(gotry setup --extension-from=github,ADR-21):
 *
 * bin/gotry-bootstrap.js setup 子命令 spawn `npx tsx scripts/extension-distribution-cli.ts`,
 * 本脚本调 installExtensionFromGithub,把结果以单行 JSON stdout 打印(父进程解析后人话化)。
 *
 * 参数:
 *   --dest <dir>             落位目录(默认 ~/.gotry/extension)
 *   --source-dir <dir>       bundled 钉扎参照(默认仓库 extension/,由 bootstrap 传入)
 *   --release-base <url>     Releases 基址(默认 GitHub 官方;测试/镜像可覆盖)
 *   --check-only             只报告远端版本,不落盘
 *
 * 退出码:0 = installed/up-to-date;2 = fallback-bundled(JSON 字段区分原因,父进程据此降级);
 * 非 0 且无 JSON = 脚本自身异常。
 */

import process from 'node:process'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_RELEASE_BASE, installExtensionFromGithub } from '../capabilities/session/extension-distribution.ts'

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const argv = process.argv.slice(2)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const dest = argValue(argv, '--dest') ?? join(homedir(), '.gotry', 'extension')
const sourceDir = argValue(argv, '--source-dir') ?? join(repoRoot, 'extension')
const releaseBase = argValue(argv, '--release-base') ?? DEFAULT_RELEASE_BASE
const checkOnly = argv.includes('--check-only')

try {
  const r = await installExtensionFromGithub({ destDir: dest, pinnedSourceDir: sourceDir, releaseBase, checkOnly })
  process.stdout.write(`${JSON.stringify(r)}\n`)
  process.exit(r.ok ? 0 : 2)
} catch (e) {
  process.stdout.write(`${JSON.stringify({ ok: false, action: 'fallback-bundled', error: `CLI 异常 ${(e as Error).message}` })}\n`)
  process.exit(2)
}
