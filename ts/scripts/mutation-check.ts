/**
 * Mutation check runner (AaaS A2, docs/rfc/aaas-rfc.md §8.3: "falsification tests that must fail against a
 * deliberately broken guard").
 *
 * A mutation list names a suite and a set of source edits. For each edit the runner clones the source trees into a
 * scratch directory, breaks exactly one guard there, runs the suite, and requires it to fail. A suite that stays
 * green under a broken guard proves nothing about that guard, so a surviving mutation fails the run. The list's
 * unmutated baseline must pass first, otherwise "red" would only mean the harness is broken.
 *
 * The working tree is never edited: mutations happen in the clone, so a run can sit beside other work. A mutation file must
 * name a path inside the clone (no absolute path, no `..`, nothing under node_modules, which is shared with the real tree).
 *
 * A mutation is "killed" only when the suite fails for a reason about behaviour. A suite that times out, and an edit that
 * does not even load (syntax or module errors), prove nothing about the guard, so both fail the run as well.
 *
 *   cd ts && npx tsx scripts/mutation-check.ts scripts/tenant-seam-mutations.json [--only <id>] [--keep] [--scratch <dir>]
 *
 * List format: { "suite": "scripts/x-tests.ts", "timeoutMs"?: number,
 *               "mutations": [{ "id", "file" (relative to ts/), "find" (must occur exactly once), "replace", "note"? }] }
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
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

/** An edit that does not load says nothing about a guard: `tsx` reports these, not an assertion. */
const BROKEN_EDIT = /SyntaxError|TransformError|Transform failed|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|Unexpected token/

class ListError extends Error {}

/** The file a mutation edits, which must be inside the scratch clone and never in the shared node_modules. */
function mutationTarget(tsClone: string, file: string): string {
  const parts = file.split(/[\\/]/)
  if (isAbsolute(file) || parts.includes('..') || parts.includes('node_modules')) throw new ListError(`mutation file "${file}" must be a relative path inside ts/ and not under node_modules`)
  const path = resolve(tsClone, file)
  if (!path.startsWith(tsClone + sep)) throw new ListError(`mutation file "${file}" leaves the clone`)
  if (!existsSync(path)) throw new ListError(`mutation file "${file}" does not exist`)
  return path
}

function runSuite(tsClone: string, suite: string, timeoutMs: number): { status: number | null; output: string; timedOut: boolean } {
  const result = spawnSync(process.execPath, [join(tsClone, 'node_modules', 'tsx', 'dist', 'cli.mjs'), suite], {
    cwd: tsClone,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, GOTRY_SESSION_LIVE: '0', GOTRY_HBCLI_LIVE: '0', GOTRY_HOTELBYTE_SKILLS_LIVE: '0' },
    maxBuffer: 64 * 1024 * 1024,
  })
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, timedOut }
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

function run(): number {
  const scratch = mkdtempSync(join(argValue(args, '--scratch') ?? tmpdir(), 'gotry-mutation-'))
  try {
    const tsClone = cloneTrees(scratch)
    // Every target is checked before anything runs, so a bad list fails at once and leaves no half-run behind.
    const targets = list.mutations.map((mutation) => ({ mutation, path: mutationTarget(tsClone, mutation.file) }))
    const baseline = runSuite(tsClone, list.suite, timeoutMs)
    if (baseline.status !== 0) {
      console.error(`baseline FAILED (exit ${baseline.status}${baseline.timedOut ? ', timed out' : ''}) — mutation results would mean nothing\n${lastLines(baseline.output, 20)}`)
      return 2
    }
    console.log(`baseline ok: ${list.suite}`)
    let killed = 0
    let failed = 0
    for (const { mutation, path } of targets) {
      if (only && mutation.id !== only) continue
      const original = readFileSync(path, 'utf8')
      const occurrences = original.split(mutation.find).length - 1
      if (occurrences !== 1) throw new ListError(`${mutation.id}: "find" occurs ${occurrences} times in ${mutation.file} (need exactly 1)`)
      writeFileSync(path, original.replace(mutation.find, () => mutation.replace))
      let outcome: ReturnType<typeof runSuite>
      try {
        outcome = runSuite(tsClone, list.suite, timeoutMs)
      } finally {
        writeFileSync(path, original)
      }
      const label = `${mutation.id} ${mutation.file}${mutation.note ? ` — ${mutation.note}` : ''}`
      if (outcome.status === 0) {
        failed += 1
        console.log(`SURVIVED ${label}`)
      } else if (outcome.timedOut) {
        failed += 1
        console.log(`TIMEOUT  ${label}\n           the suite hung under this edit (${timeoutMs} ms): that is not a kill`)
      } else if (BROKEN_EDIT.test(outcome.output)) {
        failed += 1
        console.log(`BROKEN   ${label}\n           the edited file does not load: ${(outcome.output.split('\n').find((line) => BROKEN_EDIT.test(line)) ?? '').trim().slice(0, 140)}`)
      } else {
        killed += 1
        const reason = outcome.output.split('\n').find((line) => /AssertionError|Error:|FAIL|not ok/.test(line)) ?? `exit ${outcome.status}`
        console.log(`killed   ${label}\n           ${reason.trim().slice(0, 160)}`)
      }
    }
    console.log(`${killed} killed, ${failed} not killed (survived, hung or did not load)`)
    return failed === 0 ? 0 : 1
  } catch (error) {
    if (error instanceof ListError) { console.error(error.message); return 2 }
    throw error
  } finally {
    if (args.includes('--keep')) console.log(`scratch kept: ${scratch}`)
    else rmSync(scratch, { recursive: true, force: true })
  }
}

process.exit(run())
