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
 * 都已消失(进程组信号终止整个组)。单独的真实 PTY 验证输出和 spawn-helper 0755 模式。
 * finally 中 await ctx.fiber.dispose() 并移除临时文件。不向子进程传递整个环境变量。
 *
 * 运行:cd ts && npx tsx scripts/dsh-subprocess-local-proof.ts
 */
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'

const ctx = new Context()
const fiber = ctx.plugin(LocalSubprocessRuntime)
await fiber

const tmp = mkdtempSync(join(tmpdir(), 'subprocess-local-proof-'))

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
  let childPid: number | undefined
  const pollDeadline = Date.now() + 5000
  while (Date.now() < pollDeadline && childPid === undefined) {
    const read = stdoutReader.readFrom(0)
    const m = /CHILD_PID=(\d+)/.exec(read.text)
    if (m) childPid = Number(m[1])
    else await new Promise((r) => setTimeout(r, 20))
  }
  assert.ok(childPid !== undefined && childPid > 0, `必须从父进程 stdout 观察到有效 CHILD_PID(当前 ${childPid})`)

  // 4. 终止前:子进程必须存活(父进程已 spawn 它)。
  assert.ok(isPidAlive(childPid), `终止前子进程 PID ${childPid} 必须存活`)

  // 5. 调用公共 terminate() + await 公共 waitForExit(有界 abort 信号)。
  //    进程组信号(process.kill(-parentPid, SIGTERM))终止整个组,包括非分离子进程。
  handle.terminate()
  const rangeEmpty = await handle.waitForExit(AbortSignal.timeout(8000))
  assert.equal(rangeEmpty, true, 'waitForExit 必须返回 true——托管范围(含后代)已空')

  // 6. 断言直接进程结果:父进程被信号终止(非正常退出)。
  const outcome = await handle.done
  assert.ok(
    outcome.exitCode === null && outcome.signal !== null,
    `父进程必须被信号终止(exitCode=${outcome.exitCode}, signal=${outcome.signal})`,
  )

  // 7. 断言子进程 PID 不再存在——后代清理的真实证据(非已退出顶层进程替代)。
  assert.ok(
    !isPidAlive(childPid),
    `provider 终止后子进程 PID ${childPid} 必须已消失——进程组包含的真实后代清理证据`,
  )

  // 8. 单独的真实 PTY:验证输出和 spawn-helper 0755 模式。不传 env。
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

  let ptyOutput = ''
  term.output.on('data', (d: Buffer) => {
    ptyOutput += d.toString()
  })
  const termOutcome = await term.done
  assert.equal(termOutcome.exitCode, 0, `PTY 必须正常退出(exitCode=${termOutcome.exitCode})`)
  assert.ok(ptyOutput.includes('pty-line'), `PTY 输出必须包含 pty-line(当前 ${JSON.stringify(ptyOutput)})`)
  await term.terminate()

  // 9. node-pty spawn-helper 必须已安装且具有 0755 权限模式。
  const ptyEntry = fileURLToPath(import.meta.resolve('node-pty'))
  const ptyRoot = dirname(dirname(ptyEntry))
  const helperPath = join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  const helperStat = statSync(helperPath)
  const helperMode = helperStat.mode & 0o777
  assert.equal(
    helperMode,
    0o755,
    `spawn-helper 权限模式必须是 0755(当前 0o${helperMode.toString(8)})——ensure-spawn-helper.mjs 的终局面契约`,
  )

  console.log(
    `SUBPROCESS LOCAL PROOF: parent killed by signal ${outcome.signal}, child PID ${childPid} gone after terminate, ` +
      `waitForExit rangeEmpty=${rangeEmpty}, PTY pid=${term.pid} exitCode=${termOutcome.exitCode} output-has-pty-line=${ptyOutput.includes('pty-line')}, ` +
      `spawn-helper mode=0o${helperMode.toString(8)}`,
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