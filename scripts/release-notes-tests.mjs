#!/usr/bin/env node
/** Tests for scripts/release-notes.mjs. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changelogSection, composeNotes, parseArgs, releaseNotesSection } from './release-notes.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'release-notes.mjs')
let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++ }
const throws = (fn, re, msg) => { assert.throws(fn, re, msg); checks++ }

const CHANGELOG = [
  '# Changelog', '', '## [Unreleased]', '', '## [0.2.0] - 2026-11-01', '', '### Added', '', '- stable thing', '',
  '## [0.2.0-rc.28] - 2026-10-05', '', '### Fixed', '', '- the rc fix', '', '## [0.2.0-rc.27] - 2026-10-04', '', '- older', '',
].join('\n')
const NOTES = [
  '# Release notes', '', '---', '', '## Unreleased', '', 'Nothing queued.', '', '---', '',
  '## v0.2.0 · 2026-11-01', '', '### What\'s New', '', 'the stable block', '', '---', '',
  '## v0.2.0-rc.28 · 2026-10-05', '', '**Why this release.** Because.', '', '### Installation', '', 'Run it.', '', '### Published', '', 'Pulled back.', '', '---', '',
  '## v0.2.0-rc.27 · 2026-10-04', '', 'older block', '', '---', '',
].join('\n')

// arguments
eq(parseArgs([]).version, '')
eq(parseArgs(['--version', '1.2.3', '--out', 'x.md']).out, 'x.md')
throws(() => parseArgs(['--out']), /needs a value/)
throws(() => parseArgs(['--nope']), /unknown argument/)

// sections: exact version, never a prefix
eq(changelogSection(CHANGELOG, '0.2.0-rc.28'), '### Fixed\n\n- the rc fix', 'the CHANGELOG section stops at the next version heading')
eq(changelogSection(CHANGELOG, '0.2.0'), '### Added\n\n- stable thing', '0.2.0 does not pick up 0.2.0-rc.28')
eq(changelogSection(CHANGELOG, '0.2.0-rc.27'), '- older', 'the last section runs to the end of the file')
eq(changelogSection(CHANGELOG, '9.9.9'), '', 'an absent version has no section')
eq(changelogSection(CHANGELOG, '0.2'), '', 'a partial version has no section')
eq(releaseNotesSection(NOTES, '0.2.0'), '### What\'s New\n\nthe stable block', 'the notes section for 0.2.0 is not the rc block')
eq(releaseNotesSection(NOTES, '0.2.0-rc.28').split('\n')[0], '**Why this release.** Because.', 'leading blank lines are trimmed')
ok(releaseNotesSection(NOTES, '0.2.0-rc.28').endsWith('Pulled back.'), 'the trailing block separator is trimmed, subsections are kept')
eq(releaseNotesSection(NOTES.replace('## v0.2.0 · 2026-11-01', '## v0.3.0 · 2026-11-01'), '0.2.0'), '', 'an absent 0.2.0 block is not satisfied by the 0.2.0-rc.28 block')
eq(releaseNotesSection(NOTES, '9.9.9'), '')
eq(releaseNotesSection('## v1.0.0\n\nonly block', '1.0.0'), 'only block', 'a block at the end of the file without a separator')

// composition
eq(composeNotes({ changelog: CHANGELOG, releaseNotes: NOTES, version: '0.2.0-rc.28' }),
  `**Why this release.** Because.\n\n### Installation\n\nRun it.\n\n### Published\n\nPulled back.\n\n---\n\n### Fixed\n\n- the rc fix\n`,
  'written notes on top, one rule, the generated section below')
eq(composeNotes({ changelog: CHANGELOG, releaseNotes: '', version: '0.2.0-rc.28' }), '### Fixed\n\n- the rc fix\n', 'without release notes the CHANGELOG section stands alone')
eq(composeNotes({ changelog: CHANGELOG, releaseNotes: NOTES, version: '0.2.0-rc.99' }), null, 'a version absent from the CHANGELOG yields nothing')
eq(composeNotes({ changelog: CHANGELOG, releaseNotes: '## v0.2.0-rc.99\n\nonly notes', version: '0.2.0-rc.99' }), null, 'release notes alone are not enough')
const noBlock = composeNotes({ changelog: CHANGELOG, releaseNotes: NOTES, version: '0.2.0-rc.27' })
ok(noBlock.startsWith('older block\n\n---\n\n- older'), 'each version gets its own block')
ok(!composeNotes({ changelog: CHANGELOG, releaseNotes: NOTES, version: '0.2.0-rc.28' }).includes('\n---\n\n---\n'), 'no doubled separators')

// the CLI
const tmp = mkdtempSync(join(tmpdir(), 'gotry-relnotes-'))
mkdirSync(join(tmp, 'docs'))
writeFileSync(join(tmp, 'CHANGELOG.md'), CHANGELOG)
writeFileSync(join(tmp, 'docs/release-notes.md'), NOTES)
writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'x', version: '0.2.0-rc.28' }))
const run = (...args) => spawnSync(process.execPath, [SCRIPT, '--root', tmp, ...args], { encoding: 'utf8' })
{
  const r = run()
  ok(r.status === 0 && r.stdout.includes('the rc fix') && r.stdout.startsWith('**Why this release.**'), 'the version defaults to package.json and the body goes to stdout')
  const out = join(tmp, 'out.md')
  const w = run('--version', '0.2.0-rc.27', '--out', out)
  ok(w.status === 0 && w.stdout === '' && readFileSync(out, 'utf8').includes('- older'), '--out writes the file and prints nothing')
  const missing = run('--version', '9.9.9')
  ok(missing.status === 1 && /no "## \[9\.9\.9\]" section/.test(missing.stderr), 'a missing section exits 1 with the reason')
  const bad = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' })
  ok(bad.status === 2 && /usage: node scripts\/release-notes\.mjs/.test(bad.stderr), 'a bad flag prints usage and exits 2')
  rmSync(join(tmp, 'package.json'))
  const noVersion = run()
  ok(noVersion.status === 2 && /no version/.test(noVersion.stderr), 'no version anywhere exits 2')
}
rmSync(tmp, { recursive: true, force: true })

console.log(`RELEASE-NOTES TESTS: ${checks} checks OK`)
