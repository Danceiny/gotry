import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseGoldenSource, type GoldenSource } from '../capabilities/session/static-flight-golden.ts'

export const SF_LIVE_HELP = `Usage: sf-live-benchmark.ts [--golden=manual|static|flyai] [--evidence-root PATH]

--evidence-root PATH  Write query records and the batch summary to this directory.
                     Also accepts --evidence-root=PATH; relative paths use the current directory.
                     Default: ~/.gotry/evidence/session. Automated tests must use an isolated root.
--golden=SOURCE      Comparator source (default: manual). Session searches still use live access.
--help, -h           Show this help without starting searches or writing evidence.

Rebuild a batch with: sf-summary.ts --evidence-root PATH
`

export function parseSfLiveOptions(args: string[]): { evidenceRoot: string; source: GoldenSource; help: boolean } {
  let evidenceRoot: string | undefined
  let goldenSeen = false
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--evidence-root' || arg.startsWith('--evidence-root=')) {
      if (evidenceRoot !== undefined) throw new Error('--evidence-root must be specified once')
      const value = arg === '--evidence-root' ? args[++index] : arg.slice('--evidence-root='.length)
      if (value === undefined || value.trim().length === 0 || value.startsWith('-')) {
        throw new Error('--evidence-root requires a path')
      }
      evidenceRoot = value
    } else if (arg.startsWith('--golden=')) {
      if (goldenSeen) throw new Error('--golden must be specified once')
      goldenSeen = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return {
    evidenceRoot: resolve(evidenceRoot ?? join(homedir(), '.gotry', 'evidence', 'session')),
    source: parseGoldenSource(args),
    help,
  }
}
