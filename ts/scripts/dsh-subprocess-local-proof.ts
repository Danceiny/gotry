/**
 * dsh-subprocess-local 确定性证明(issue #268):仅通过公共 API 挂载 provider,
 * 执行真实的本地托管子进程与 PTY,观察真实输出,终止它,await 公共 waitForExit,
 * 并证明派生后代已消失。平台中立(Ubuntu CI + macOS)——不调用私有
 * selectContainmentMode()/disposeManagedProcesses(),不断言主机是 macOS fallback,
 * 不用已退出的顶层进程作为后代清理替代。
 *
 * 公共挂载模式:await ctx.plugin(LocalSubprocessRuntime) → ctx.subprocess 可用。
 * spawn 一个活跃的 node 父进程(被 provider 以 detached:true 启动,自成进程组领袖),
 * 该父进程用 child_process.spawn 创建一个非分离的真实长运行子进程(继承父进程组),
 * 并将子进程 PID 输出到 stdout。证明通过收集 stdout 读取子进程 PID,调用公共
 * terminate() + await waitForExit(有界 abort 信号),断言父进程结果和子进程 PID
 * 都已消失(进程组信号终止整个组)。
 *
 * 真实 PTY 验证在每个支持平台(Linux/darwin/win32)都执行:spawnTerminal 启动 node 子进程,
 * 子进程向 stdout 写入 'pty-line\n' 并正常退出;断言 PTY 输出包含 'pty-line' 且 exitCode=0。
 * node-pty 的 native PTY 后端通过 pty.node 的 N-API 工作,不经 spawn-helper 间接寻址——
 * 每平台预构建都带 `pty.node`(Darwin 加 `spawn-helper` 作为 setuid launchd 助手;
 * Linux/Windows 预构建仅 `pty.node`,不携带 spawn-helper,因为 PTY fork 由 libc/glibc
 * 与 Windows ConPTY 直接提供)。本证明在每平台都跑真实 PTY 行为;filesystem 上
 * spawn-helper 存在性与 0755 模式断言仅在 Darwin 下生效——非 Darwin 报告
 * "helper not-applicable" 事实,同时真实 PTY 行为(输出+成功退出)仍被验证,
 * 不在 Linux 上伪造、不复制、不 stat 实际不存在的 helper。
 *
 * finally 中 await ctx.fiber.dispose() 并移除临时文件。不向子进程传递整个环境变量。
 *
 * 运行:cd ts && npx tsx scripts/dsh-subprocess-local-proof.ts
 */
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'

const ctx = new Context()
const fiber = ctx.plugin(LocalSubprocessRuntime)
await fiber

const tmp = mkdtempSync(join(tmpdir(), 'subprocess-local-proof-'))

let childPid: number
let childGoneAfter = false
let parentOutcome: { exitCode: number | null; signal: NodeJS.Signals | null }
let rangeEmpty: boolean
let ptyExitCode = 0
let ptyOutput = ''
let helperFact: string
let helperMode: number | null

try {
  // 1. 父进程脚本:spawn 一个非分离的长运行子进程(继承父进程组),输出子进程 PID。
  //    父进程自身保持活跃(setInterval),直到被 provider 终止。
  const parentScript = join(tmp, 'parent.mjs')
  writeFileSync(
    parentScript,
    [
      "import { spawn } from 'node:child_process'",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'inherit' })",
      "process.stdout.write('CHILD_PID=' + child.pid + '\\n')",
      'setInterval(() => {}, 60000)',
      '',
    ].join('\n'),
  )

  // 2. 通过公共 ctx.subprocess.spawn 启动父进程。不传 env——让 provider 用
  //    scrubbedParentEnv() 清洗环境(保留 PATH/HOME,剥离凭据/DSH_*),不传递整个环境变量。
  const handle = ctx.subprocess.spawn({
    argv: [process.execPath, parentScript],
    cwd: tmp,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } },
    graceMs: 8000,
  })

  const stdoutReader = handle.collected.stdout
  assert.ok(stdoutReader, 'collect 模式下 collected.stdout reader 必须存在')

  // 3. 通过观察父进程输出获取子进程 PID(有界轮询,不假设即时可用)。
  let observedChildPid: number | undefined
  const pollDeadline = Date.now() + 5000
  while (Date.now() < pollDeadline && observedChildPid === undefined) {
    const read = stdoutReader.readFrom(0)
    const m = /CHILD_PID=(\d+)/.exec(read.text)
    if (m) observedChildPid = Number(m[1])
    else await new Promise((r) => setTimeout(r, 20))
  }
  assert.ok(
    observedChildPid !== undefined && observedChildPid > 0,
    `必须从父进程 stdout 观察到有效 CHILD_PID(当前 ${observedChildPid})`,
  )
  childPid = observedChildPid

  // 4. 终止前:子进程必须存活(父进程已 spawn 它)。
  assert.ok(isPidAlive(childPid), `终止前子进程 PID ${childPid} 必须存活`)

  // 5. 调用公共 terminate() + await 公共 waitForExit(有界 abort 信号)。
  //    进程组信号(process.kill(-parentPid, SIGTERM))终止整个组,包括非分离子进程。
  handle.terminate()
  rangeEmpty = await handle.waitForExit(AbortSignal.timeout(8000))
  assert.equal(rangeEmpty, true, 'waitForExit 必须返回 true——托管范围(含后代)已空')

  // 6. 断言直接进程结果:父进程被信号终止(非正常退出)。
  parentOutcome = await handle.done
  assert.ok(
    parentOutcome.exitCode === null && parentOutcome.signal !== null,
    `父进程必须被信号终止(exitCode=${parentOutcome.exitCode}, signal=${parentOutcome.signal})`,
  )

  // 7. 断言子进程 PID 不再存在——后代清理的真实证据(非已退出顶层进程替代)。
  childGoneAfter = !isPidAlive(childPid)
  assert.ok(
    childGoneAfter,
    `provider 终止后子进程 PID ${childPid} 必须已消失——进程组包含的真实后代清理证据`,
  )

  // 8. 真实 PTY 验证(每个支持平台都执行):spawnTerminal 用 native PTY 后端 fork/exec,
  //    子进程写 'pty-line\n' 并正常退出。原生 PTY 输出经 PTY 终端层到达 PTY 主面,
  //    再被 node-pty 回调成 output 'data' 事件——这是跨平台的 PTY 行为证明。
  const ptyScript = join(tmp, 'pty.mjs')
  writeFileSync(ptyScript, "process.stdout.write('pty-line\\n'); process.exit(0);\n")
  const term = await ctx.subprocess.spawnTerminal({
    argv: [process.execPath, ptyScript],
    cwd: tmp,
    rows: 24,
    cols: 80,
    graceMs: 8000,
  })
  assert.equal(typeof term.pid, 'number', `PTY pid 必须是数字(当前 ${typeof term.pid})`)
  assert.ok(term.pid > 0, `PTY pid 必须为正(当前 ${term.pid})`)

  term.output.on('data', (d: Buffer) => {
    ptyOutput += d.toString()
  })
  ptyExitCode = (await term.done).exitCode ?? 0
  assert.equal(ptyExitCode, 0, `PTY 必须正常退出(exitCode=${ptyExitCode})`)
  assert.ok(
    ptyOutput.includes('pty-line'),
    `PTY 输出必须包含 pty-line(当前 ${JSON.stringify(ptyOutput)})`,
  )
  await term.terminate()

  // 9. node-pty spawn-helper 文件系统断言仅在 Darwin 下生效。
  //    真实平台事实:darwin-{x64,arm64}/prebuilds 同时带 pty.node 与 spawn-helper
  //    (spawn-helper 是 macOS 下 setuid launchd 助手,确保 fork 出的子进程能继承
  //    一个可控的 controlling terminal 上下文,需 0755);linux-{x64,arm64}/prebuilds
  //    仅带 pty.node(Linux PTY fork 由 libc/glibc 直接提供,不需要单独 helper);
  //    windows/{x64,arm64}/prebuilds 携带 conpty/(ConPTY 接口)。
  //    本证明不构造、不复制、不 stat 实际不存在的 helper——这是事实陈述而非弱化断言。
  helperMode = null
  if (process.platform === 'darwin') {
    const ptyEntry = fileURLToPath(import.meta.resolve('node-pty'))
    const ptyRoot = dirname(dirname(ptyEntry))
    const helperPath = join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    assert.ok(
      existsSync(helperPath),
      `Darwin prebuilds 必须携带 spawn-helper(实际不存在:${helperPath})——ensure-spawn-helper.mjs 的终局面契约`,
    )
    helperMode = statSync(helperPath).mode & 0o777
    assert.equal(
      helperMode,
      0o755,
      `Darwin spawn-helper 权限模式必须是 0755(当前 0o${helperMode.toString(8)})——ensure-spawn-helper.mjs 的终局面契约`,
    )
    helperFact = `helper=darwin 0o${helperMode.toString(8)}`
  } else {
    helperFact = `helper=not-applicable:${process.platform}-${process.arch} prebuilds 不携带 spawn-helper(Linux PTY fork 由 libc/glibc 直接提供,Windows 由 ConPTY),真实 PTY 行为(PTY 输出='pty-line' present, exitCode=0)已被独立验证`
    assert.ok(
      ptyExitCode === 0 && ptyOutput.includes('pty-line'),
      '非 Darwin 平台必须仍证明真实 PTY 行为:PTY 输出包含 pty-line 且 exitCode=0',
    )
  }

  console.log(
    `SUBPROCESS LOCAL PROOF: parent killed by signal ${parentOutcome.signal}, child PID ${childPid} gone after terminate=${childGoneAfter}, ` +
      `waitForExit rangeEmpty=${rangeEmpty}, PTY pid=${term.pid} exitCode=${ptyExitCode} output-has-pty-line=${ptyOutput.includes('pty-line')}, ` +
      `${helperFact}`,
  )
} finally {
  await ctx.fiber.dispose()
  rmSync(tmp, { recursive: true, force: true })
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
