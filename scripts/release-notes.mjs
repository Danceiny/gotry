#!/usr/bin/env node
/**
 * scripts/release-notes.mjs — the GitHub Release body for a version, from the two release authorities:
 * the human-written block of docs/release-notes.md (the decision surface) on top, the generated CHANGELOG.md
 * section (the commit-derived record) below, separated by one rule. publish-npm.sh calls this, and any other
 * publishing path (a CI workflow) should too, so the body is the same whichever path published.
 *
 * Usage: node scripts/release-notes.mjs [--version <v>] [--out <file>] [--root <dir>]
 * Without --version it reads package.json. Exit: 0 written; 1 the CHANGELOG has no section for the version
 * (nothing to publish notes from — run the changelog gate first); 2 usage.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageError, isMain } from './release-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function parseArgs(argv) {
  const opts = { version: '', out: '', root: ROOT }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
      return v
    }
    if (a === '--version') opts.version = value()
    else if (a === '--out') opts.out = value()
    else if (a === '--root') opts.root = resolve(value())
    else if (a === '-h' || a === '--help') throw new UsageError('')
    else throw new UsageError(`unknown argument ${a}`)
  }
  return opts
}

/**
 * The body of the section whose heading line matches `headingRe`: from the line after it to the line before the next
 * line matching `endRe` (or the end of the file), with the blank lines and block separators around it trimmed.
 * Returns '' when there is no such section.
 */
function sectionBody(text, headingRe, endRe) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => headingRe.test(l))
  if (start === -1) return ''
  let end = lines.findIndex((l, i) => i > start && endRe.test(l))
  if (end === -1) end = lines.length
  const body = lines.slice(start + 1, end)
  const junk = (l) => l.trim() === '' || l.trim() === '---'
  while (body.length && junk(body[0])) body.shift()
  while (body.length && junk(body[body.length - 1])) body.pop()
  return body.join('\n')
}

/** The exact version, not a prefix: `## v0.2.0` must not pick up `## v0.2.0-rc.28`. */
export function changelogSection(text, version) {
  return sectionBody(text, new RegExp(`^## \\[${escapeRe(version)}\\](\\s|$)`), /^## \[/)
}

export function releaseNotesSection(text, version) {
  return sectionBody(text, new RegExp(`^## v${escapeRe(version)}(\\s|$)`), /^## /)
}

/** Null when the CHANGELOG has no section for the version. */
export function composeNotes({ changelog, releaseNotes, version }) {
  const generated = changelogSection(changelog, version)
  if (!generated) return null
  const written = releaseNotes ? releaseNotesSection(releaseNotes, version) : ''
  return `${written ? `${written}\n\n---\n\n` : ''}${generated}\n`
}

function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message ? `error: ${err.message}\n` : ''}usage: node scripts/release-notes.mjs [--version <v>] [--out <file>] [--root <dir>]`)
      return 2
    }
    throw err
  }
  const read = (p) => (existsSync(join(opts.root, p)) ? readFileSync(join(opts.root, p), 'utf8') : '')
  const version = opts.version || JSON.parse(read('package.json') || '{}').version
  if (!version) { console.error('error: no version — pass --version or run from a tree with a package.json'); return 2 }
  const notes = composeNotes({ changelog: read('CHANGELOG.md'), releaseNotes: read('docs/release-notes.md'), version })
  if (notes === null) {
    console.error(`error: CHANGELOG.md has no "## [${version}]" section — nothing to build the release notes from`)
    return 1
  }
  if (opts.out) writeFileSync(opts.out, notes)
  else process.stdout.write(notes)
  return 0
}

if (isMain(import.meta.url)) process.exit(main())
