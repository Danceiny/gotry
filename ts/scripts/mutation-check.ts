/**
 * Mutation check runner (AaaS A2, docs/rfc/aaas-rfc.md §8.3: "falsification tests that must fail against a
 * deliberately broken guard").
 *
 * A mutation list names a suite and a set of source edits. For each edit the runner clones the source trees into a
 * scratch directory, breaks exactly one guard there, runs the suite, and requires it to fail. A suite that stays
 * green under a broken guard proves nothing about that guard, so a surviving mutation fails the run. The list's
 * unmutated baseline must pass first, otherwise "red" would only mean the harness is broken.
 *
 * The working tree is never edited: mutations happen in the clone, so a run can sit beside other work.
 *
 *   cd ts && npx tsx scripts/mutation-check.ts scripts/tenant-seam-mutations.json [--only <id>] [--keep] [--scratch <dir>]
 *
 * List format: { "suite": "scripts/x-tests.ts", "timeoutMs"?: number,
 *               "mutations": [{ "id", "file" (relative to ts/), "find" (must occur exactly once), "replace", "note"? }] }
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Mutation {
  id: string
  file: string
  find: string
  replace: string
  note?: string
}

interface MutationList {
  suite: string
  timeoutMs?: number
  mutations: Mutation[]
}

const TS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(TS_ROOT, '..')
const SKIP = new Set(['node_modules', '.git', 'dsh-runtime', 'gotry-state'])

function argValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}

function cloneTrees(scratch: string): string {
  const copy = (from: string, to: string): void => {
    cpSync(from, to, { recursive: true, filter: (source) => !SKIP.has(basename(source)) })
  }
  const tsClone = join(scratch, 'ts')
  copy(TS_ROOT, tsClone)
  for (const dir of ['schemas', 'data']) {
    if (existsSync(join(REPO_ROOT, dir))) copy(join(REPO_ROOT, dir), join(scratch, dir))
  }
  // Installed packages are shared, not copied: the suites only read them.
  symlinkSync(join(TS_ROOT, 'node_modules'), join(tsClone, 'node_modules'))
  if (existsSync(join(REPO_ROOT, 'node_modules'))) symlinkSync(join(REPO_ROOT, 'node_modules'), join(scratch, 'node_modules'))
  return tsClone
}

function runSuite(tsClone: string, suite: string, timeoutMs: number): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [join(tsClone, 'node_modules', 'tsx', 'dist', 'cli.mjs'), suite], {
    cwd: tsClone,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, GOTRY_SESSION_LIVE: '0', GOTRY_HBCLI_LIVE: '0', GOTRY_HOTELBYTE_SKILLS_LIVE: '0' },
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function lastLines(text: string, count: number): string {
  return text.trim().split('\n').slice(-count).join('\n')
}

const args = process.argv.slice(2)
const listPath = args.find((arg) => !arg.startsWith('--') && arg !== argValue(args, '--only') && arg !== argValue(args, '--scratch'))
if (!listPath) {
  console.error('usage: mutation-check.ts <mutation-list.json> [--only <id>] [--keep] [--scratch <dir>]')
  process.exit(2)
}
const list = JSON.parse(readFileSync(resolve(TS_ROOT, listPath), 'utf8')) as MutationList
const only = argValue(args, '--only')
const timeoutMs = list.timeoutMs ?? 180_000
const scratch = mkdtempSync(join(argValue(args, '--scratch') ?? tmpdir(), 'gotry-mutation-'))
const tsClone = cloneTrees(scratch)

let survivors = 0
let killed = 0
try {
  const baseline = runSuite(tsClone, list.suite, timeoutMs)
  if (baseline.status !== 0) {
    console.error(`baseline FAILED (exit ${baseline.status}) — mutation results would mean nothing\n${lastLines(baseline.output, 20)}`)
    process.exit(2)
  }
  console.log(`baseline ok: ${list.suite}`)
  for (const mutation of list.mutations) {
    if (only && mutation.id !== only) continue
    const path = join(tsClone, mutation.file)
    const original = readFileSync(path, 'utf8')
    const occurrences = original.split(mutation.find).length - 1
    if (occurrences !== 1) {
      console.error(`${mutation.id}: "find" occurs ${occurrences} times in ${mutation.file} (need exactly 1)`)
      process.exit(2)
    }
    writeFileSync(path, original.replace(mutation.find, () => mutation.replace))
    const outcome = runSuite(tsClone, list.suite, timeoutMs)
    writeFileSync(path, original)
    if (outcome.status === 0) {
      survivors += 1
      console.log(`SURVIVED ${mutation.id} ${mutation.file}${mutation.note ? ` — ${mutation.note}` : ''}`)
    } else {
      killed += 1
      const reason = outcome.output.split('\n').find((line) => /AssertionError|Error:|FAIL|not ok/.test(line)) ?? `exit ${outcome.status}`
      console.log(`killed   ${mutation.id} ${mutation.file}${mutation.note ? ` — ${mutation.note}` : ''}\n           ${reason.trim().slice(0, 160)}`)
    }
  }
} finally {
  if (args.includes('--keep')) console.log(`scratch kept: ${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
}
console.log(`${killed} killed, ${survivors} survived`)
process.exit(survivors === 0 ? 0 : 1)
