import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tsRoot = join(import.meta.dirname, '..')
const tsxCli = join(tsRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const runner = join(import.meta.dirname, 'sf-live-benchmark.ts')

interface CliRun {
  status: number | null
  output: string
}

const root = mkdtempSync(join(tmpdir(), 'gotry-sf503-cli-'))
const home = join(root, 'home')
const explicitRoot = join(root, 'explicit evidence root')
const defaultRoot = join(home, '.gotry', 'evidence', 'session')
const fetchMarker = join(root, 'fetch-attempts')
const fetchTrap = join(root, 'fetch-trap.mjs')
mkdirSync(home, { recursive: true })
writeFileSync(fetchTrap, `import { appendFileSync } from 'node:fs'
globalThis.fetch = async (...args) => {
  appendFileSync(${JSON.stringify(fetchMarker)}, JSON.stringify(String(args[0])) + '\\n')
  throw new Error('blocked network in sf503 CLI argument proof')
}
`)

function run(args: string[]): CliRun {
  const result = spawnSync(process.execPath, [tsxCli, runner, ...args], {
    cwd: tsRoot,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: home,
      NODE_OPTIONS: `--import=${fetchTrap}`,
      GOTRY_SESSION_LIVE: '0',
      GOTRY_HBCLI_LIVE: '0',
      GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
    },
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

function assertNoQueryOrNetwork(result: CliRun, label: string): void {
  assert.equal(result.output.includes('[sf-live-benchmark] sf-01'), false, `${label}: fail-closed 前不得启动 query`)
  assert.equal(existsSync(fetchMarker), false, `${label}: 参数/目标失败前不得触发网络`)
}

try {
  for (const helpArg of ['--help', '-h']) {
    const result = run([helpArg])
    assert.equal(result.status, 0, `${helpArg} 应正常退出: ${result.output}`)
    assert.match(result.output, /Usage: sf-live-benchmark\.ts/)
    assertNoQueryOrNetwork(result, helpArg)
    assert.equal(existsSync(defaultRoot), false, `${helpArg} 不得创建默认 evidence root`)
    assert.equal(existsSync(explicitRoot), false, `${helpArg} 不得创建显式 evidence root`)
  }

  const invalidCases: Array<{ name: string; args: string[]; message: RegExp }> = [
    { name: 'unknown golden', args: ['--golden=ctrip-open'], message: /不支持的 golden vendor: ctrip-open/ },
    { name: 'missing root value', args: ['--evidence-root'], message: /--evidence-root requires a path/ },
    { name: 'empty equals root', args: ['--evidence-root='], message: /--evidence-root requires a path/ },
    { name: 'empty split root', args: ['--evidence-root', ''], message: /--evidence-root requires a path/ },
    { name: 'whitespace root', args: ['--evidence-root', '   '], message: /--evidence-root requires a path/ },
    { name: 'next flag as root value', args: ['--evidence-root', '--golden=manual'], message: /--evidence-root requires a path/ },
    { name: 'duplicate root', args: ['--evidence-root', explicitRoot, '--evidence-root', join(root, 'other root')], message: /--evidence-root must be specified once/ },
    { name: 'duplicate golden', args: ['--golden=manual', '--golden=static'], message: /--golden must be specified once/ },
    { name: 'unknown argument', args: ['--definitely-invalid'], message: /unknown argument: --definitely-invalid/ },
    { name: 'separate golden flag', args: ['--golden'], message: /unknown argument: --golden/ },
  ]

  for (const testCase of invalidCases) {
    const result = run(testCase.args)
    assert.equal(result.status, 1, `${testCase.name} 应 exit 1: ${result.output}`)
    assert.match(result.output, testCase.message)
    assertNoQueryOrNetwork(result, testCase.name)
    assert.equal(existsSync(defaultRoot), false, `${testCase.name}: 不得创建默认 evidence root`)
    assert.equal(existsSync(explicitRoot), false, `${testCase.name}: 不得提前创建显式 evidence root`)
    assert.equal(existsSync(join(root, 'other root')), false, `${testCase.name}: 不得创建重复参数中的目录`)
  }

  const fileTarget = join(root, 'evidence target file')
  writeFileSync(fileTarget, 'not a directory')
  const filesystemCases = [
    ['file target', ['--golden=manual', '--evidence-root', fileTarget]],
    ['child under file', ['--golden=manual', '--evidence-root', join(fileTarget, 'child')]],
  ] as const
  for (const [name, args] of filesystemCases) {
    const result = run([...args])
    assert.equal(result.status, 1, `${name} 应在 supplier/search 前失败: ${result.output}`)
    assertNoQueryOrNetwork(result, name)
    assert.equal(existsSync(defaultRoot), false, `${name}: 不得回落写入默认 evidence root`)
  }

  console.log('SF LIVE CLI TESTS: 14 cases OK (2 help, 10 invalid arguments, 2 filesystem failures; no query output or fetch attempts)')
} finally {
  rmSync(root, { recursive: true, force: true })
  assert.equal(existsSync(root), false, 'CLI argument test root must be cleaned up')
}
