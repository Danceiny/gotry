#!/usr/bin/env node
/**
 * Mechanical docs readability guard for the reader-facing state surfaces.
 *
 * Scope is deliberately narrow: the public README, architecture/roadmap
 * authorities, and frozen Stage 1 design pair. Budgets are calibrated from the
 * compacted 2026-09-13 files with modest headroom so the guard prevents ledger
 * re-growth without becoming a general prose linter.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SURFACES = [
  {
    key: 'readme',
    label: 'Reader README',
    files: ['README.md', 'README.zh-CN.md'],
    maxLines: 260, // observed 212/214 on 2026-09-13, plus compact-growth headroom
    maxH2SectionLines: 70,
    maxLogicalLineBytes: 900, // observed max 660/624 bytes
    maxTableRowBytes: 1200, // observed max 255/219 bytes
  },
  {
    key: 'roadmap',
    label: 'Roadmap authority',
    files: ['docs/roadmap.md', 'docs/roadmap.zh-CN.md'],
    maxLines: 115, // observed 92/92 on 2026-09-13
    maxH2SectionLines: 36,
    maxLogicalLineBytes: 900, // observed max table row 323/320 bytes
    maxTableRowBytes: 1200,
  },
  {
    key: 'architecture',
    label: 'Architecture authority',
    files: ['docs/architecture.md', 'docs/architecture.zh-CN.md'],
    preambleMaxLines: 32, // observed 26/26 on 2026-09-13 after compaction
    preambleMaxBytes: 2600, // observed 1940/1701 bytes
    requiredHeaderFields: {
      'docs/architecture.md': ['Position', 'Status'],
      'docs/architecture.zh-CN.md': ['定位', '状态'],
    },
    maxLogicalLineBytes: 900, // observed guarded max table row 657/576 bytes
    maxTableRowBytes: 1200,
    requireNumberedHeadingParity: true,
    issueLedgerMode: 'pointer-only',
    focusH2: {
      // Guard reader-facing authority sections; dense reference sections 3/8
      // intentionally stay outside this readability gate.
      '1': { maxLines: 85, maxBytes: 9000 }, // observed 69 lines, 7196/6418 bytes
      '9': { maxLines: 50, maxBytes: 5900 }, // observed 39 lines, 4693/4155 bytes
      '10': { maxLines: 30, maxBytes: 7300 }, // observed 22 lines, 6041/5390 bytes
      '11': { maxLines: 34, maxBytes: 2400 }, // observed 26 lines, 1788/1532 bytes
      '12': { maxLines: 22, maxBytes: 1300 }, // observed 15 lines, 860/827 bytes
    },
  },
  {
    key: 'stage1',
    label: 'Frozen Stage 1 design header',
    files: [
      'docs/design/stage1-top-down-design.md',
      'docs/design/stage1-top-down-design.zh-CN.md',
    ],
    maxLines: 120, // observed 96/96 on 2026-09-13
    maxH2SectionLines: 42,
    maxLogicalLineBytes: 900, // observed max table row 408/306 bytes
    maxTableRowBytes: 1200,
    frozenPreambleMaxLines: 16, // observed first H2 at line 15 on 2026-09-13
    requiredHeaderFields: {
      'docs/design/stage1-top-down-design.md': ['Role', 'Status'],
      'docs/design/stage1-top-down-design.zh-CN.md': ['定位', '状态'],
    },
  },
];

const PAIR_MAX_LINE_DELTA = 8;

const REVISION_HISTORY_HEADING = /^#{2,6}\s*(?:revision history|change log|changelog|version history|change history|updates?|更新记录|修订记录|变更记录|版本历史|版本记录|变更日志)\b/i;
const LEDGER_HEADING = /^#{2,6}\s*(?:.*(?:ledger|台账|流水|append-only|追加).*)$/i;
const DATED_ROW = /^\s*(?:[-*+]\s+|\d+\.\s+|\|)?(?:20\d{2}[-/.年](?:0?[1-9]|1[0-2])[-/.月](?:0?[1-9]|[12]\d|3[01])日?)\b/;
const ISSUE_ROW = /^\s*(?:[-*+]\s+|\d+\.\s+|\|).*?(?:#\d+|issues\/\d+)\b/i;
const POINTER_ISSUE_ROW = /^\s*(?:[-*+]\s+|\d+\.\s+|\|)\s*(?:\[?#\d+\]?|\[#\d+\]\([^)]+\)|https:\/\/github\.com\/[^)\s]+\/issues\/\d+)\s*(?:\||[-:：—–])?\s*(?:see|todo|open|closed|done|见|待办|已关)?\s*$/i;

function stripFenceState(lines) {
  let inFence = false;
  return lines.map((line) => {
    if (/^```/.test(line)) {
      inFence = !inFence;
      return { line, inFence: true };
    }
    return { line, inFence };
  });
}

function markdownStats(text) {
  const lines = text.split('\n');
  const visible = stripFenceState(lines);
  const headings = [];
  for (let i = 0; i < visible.length; i++) {
    if (visible[i].inFence) continue;
    const match = visible[i].line.match(/^(#{1,6})\s+(.+)$/);
    if (match) headings.push({ lineNo: i + 1, level: match[1].length, text: match[2] });
  }
  return { lines, visible, headings };
}

function h2SectionLengths(stats) {
  const h2s = stats.headings.filter((h) => h.level === 2);
  return h2s.map((heading, index) => {
    const next = h2s[index + 1]?.lineNo ?? (stats.lines.length + 1);
    return { heading, length: next - heading.lineNo };
  });
}

function h2SectionRanges(stats) {
  const h2s = stats.headings.filter((h) => h.level === 2);
  return h2s.map((heading, index) => {
    const next = h2s[index + 1]?.lineNo ?? (stats.lines.length + 1);
    const number = heading.text.match(/^(\d+)\.\s+/)?.[1];
    return { heading, number, startLine: heading.lineNo, endLine: next - 1 };
  });
}

function guardedRanges(stats, surface) {
  if (!surface.focusH2) return [{ startLine: 1, endLine: stats.lines.length }];
  const firstH2 = stats.headings.find((h) => h.level === 2);
  const ranges = [];
  if (firstH2) ranges.push({ startLine: 1, endLine: firstH2.lineNo - 1 });
  for (const range of h2SectionRanges(stats)) {
    if (range.number && surface.focusH2[range.number]) ranges.push(range);
  }
  return ranges.filter((range) => range.endLine >= range.startLine);
}

function visibleInRanges(stats, ranges) {
  const allowed = new Set();
  for (const range of ranges) {
    for (let lineNo = range.startLine; lineNo <= range.endLine; lineNo++) allowed.add(lineNo);
  }
  return stats.visible.map((entry, index) => ({ ...entry, lineNo: index + 1 })).filter((entry) => allowed.has(entry.lineNo));
}

function bytesForLines(lines) {
  return Buffer.byteLength(lines.join('\n'));
}

function numberedHeadingSignature(stats) {
  return stats.headings
    .map((heading) => {
      const match = heading.text.match(/^(\d+(?:\.\d+)*)\.?(?:\s|$)/);
      return match ? `${heading.level}:${match[1]}` : null;
    })
    .filter(Boolean);
}

function checkSurface(root, surface, failures) {
  const statsByFile = [];
  for (const relPath of surface.files) {
    const absPath = join(root, relPath);
    if (!existsSync(absPath)) {
      failures.push(`${relPath}: missing target file`);
      continue;
    }
    const stats = markdownStats(readFileSync(absPath, 'utf8'));
    statsByFile.push({ relPath, stats });

    if (stats.lines.length > surface.maxLines) {
      failures.push(`${relPath}: ${stats.lines.length} lines exceeds ${surface.maxLines} line budget`);
    }

    if (surface.maxH2SectionLines !== undefined) {
      for (const section of h2SectionLengths(stats)) {
        if (section.length > surface.maxH2SectionLines) {
          failures.push(`${relPath}:${section.heading.lineNo}: H2 section "${section.heading.text}" has ${section.length} lines, budget ${surface.maxH2SectionLines}`);
        }
      }
    }

    if (surface.preambleMaxLines !== undefined || surface.preambleMaxBytes !== undefined) {
      const firstH2 = stats.headings.find((h) => h.level === 2);
      if (!firstH2) {
        failures.push(`${relPath}: missing first H2 for preamble budget`);
      } else {
        const preambleLines = firstH2.lineNo - 1;
        const preambleBytes = bytesForLines(stats.lines.slice(0, preambleLines));
        if (surface.preambleMaxLines !== undefined && preambleLines > surface.preambleMaxLines) {
          failures.push(`${relPath}: preamble has ${preambleLines} lines, budget ${surface.preambleMaxLines}`);
        }
        if (surface.preambleMaxBytes !== undefined && preambleBytes > surface.preambleMaxBytes) {
          failures.push(`${relPath}: preamble has ${preambleBytes} bytes, budget ${surface.preambleMaxBytes}`);
        }
      }
    }

    if (surface.focusH2) {
      const rangesByNumber = new Map(h2SectionRanges(stats).filter((range) => range.number).map((range) => [range.number, range]));
      for (const [number, budget] of Object.entries(surface.focusH2)) {
        const range = rangesByNumber.get(number);
        if (!range) {
          failures.push(`${relPath}: missing guarded section ${number}`);
          continue;
        }
        const sectionLines = stats.lines.slice(range.startLine - 1, range.endLine);
        const sectionLineCount = sectionLines.length;
        const sectionBytes = bytesForLines(sectionLines);
        if (sectionLineCount > budget.maxLines) {
          failures.push(`${relPath}:${range.startLine}: section ${number} has ${sectionLineCount} lines, budget ${budget.maxLines}`);
        }
        if (sectionBytes > budget.maxBytes) {
          failures.push(`${relPath}:${range.startLine}: section ${number} has ${sectionBytes} bytes, budget ${budget.maxBytes}`);
        }
      }
    }

    const guardedVisible = visibleInRanges(stats, guardedRanges(stats, surface));
    checkLogicalLineBytes(relPath, guardedVisible, failures, surface);
    checkRequiredHeaderFields(relPath, stats, failures, surface);
    for (const { line, lineNo, inFence } of guardedVisible) {
      if (inFence) continue;
      if (REVISION_HISTORY_HEADING.test(line)) {
        failures.push(`${relPath}:${lineNo}: revision/change-history section belongs in git and release notes`);
      }
      if (LEDGER_HEADING.test(line)) {
        failures.push(`${relPath}:${lineNo}: ledger-style section is not allowed on this reader-facing surface`);
      }
    }

    checkLedgerRuns(relPath, guardedVisible, failures, surface.issueLedgerMode);

    if (surface.frozenPreambleMaxLines !== undefined) {
      const firstH2 = stats.headings.find((h) => h.level === 2);
      if (!firstH2) {
        failures.push(`${relPath}: frozen design must keep a bounded preamble before the first H2`);
      } else {
        const preambleLines = firstH2.lineNo - 1;
        if (preambleLines > surface.frozenPreambleMaxLines) {
          failures.push(`${relPath}: frozen design preamble has ${preambleLines} lines, budget ${surface.frozenPreambleMaxLines}`);
        }
      }
    }
  }

  if (statsByFile.length === 2) {
    const [base, mirror] = statsByFile;
    const lineDelta = Math.abs(base.stats.lines.length - mirror.stats.lines.length);
    if (lineDelta > PAIR_MAX_LINE_DELTA) {
      failures.push(`${base.relPath} <-> ${mirror.relPath}: bilingual pair line-count delta ${lineDelta} exceeds ${PAIR_MAX_LINE_DELTA}`);
    }
    const baseH2 = base.stats.headings.filter((h) => h.level === 2).length;
    const mirrorH2 = mirror.stats.headings.filter((h) => h.level === 2).length;
    if (baseH2 !== mirrorH2) {
      failures.push(`${base.relPath} <-> ${mirror.relPath}: bilingual pair H2 count differs (${baseH2} vs ${mirrorH2})`);
    }
    if (surface.requireNumberedHeadingParity) {
      const baseSignature = numberedHeadingSignature(base.stats);
      const mirrorSignature = numberedHeadingSignature(mirror.stats);
      if (baseSignature.join('\n') !== mirrorSignature.join('\n')) {
        failures.push(`${base.relPath} <-> ${mirror.relPath}: numbered heading structure differs`);
      }
    }
  }
}

function preambleLines(stats) {
  const firstH2 = stats.headings.find((h) => h.level === 2);
  if (!firstH2) return stats.lines;
  return stats.lines.slice(0, firstH2.lineNo - 1);
}

function checkRequiredHeaderFields(relPath, stats, failures, surface) {
  const required = surface.requiredHeaderFields?.[relPath];
  if (!required) return;
  const lines = preambleLines(stats);
  for (const field of required) {
    const fieldPattern = new RegExp(`^>\\s*${escapeRegExp(field)}\\s*[:：]`, 'i');
    if (!lines.some((line) => fieldPattern.test(line))) {
      failures.push(`${relPath}: bounded preamble missing required header field "${field}"`);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkLogicalLineBytes(relPath, visible, failures, surface) {
  if (surface.maxLogicalLineBytes === undefined) return;
  for (const { line, lineNo, inFence } of visible) {
    if (inFence || !line.trim()) continue;
    const isTableRow = /^\s*\|/.test(line);
    const budget = isTableRow ? (surface.maxTableRowBytes ?? surface.maxLogicalLineBytes) : surface.maxLogicalLineBytes;
    const bytes = Buffer.byteLength(line);
    if (bytes > budget) {
      const kind = isTableRow ? 'Markdown table row' : 'logical line';
      failures.push(`${relPath}:${lineNo}: ${kind} has ${bytes} bytes, budget ${budget}`);
    }
  }
}

function checkLedgerRuns(relPath, visible, failures, issueLedgerMode = 'any-issue') {
  const run = [];
  for (const { line, lineNo, inFence } of visible) {
    const issueMatches = issueLedgerMode === 'pointer-only' ? POINTER_ISSUE_ROW.test(line) : ISSUE_ROW.test(line);
    const matches = !inFence && (DATED_ROW.test(line) || issueMatches);
    if (matches) {
      run.push(lineNo);
      if (run.length >= 4) {
        failures.push(`${relPath}:${run[0]}-${run.at(-1)}: append-only date/issue ledger run detected`);
        return;
      }
    } else if (line.trim() !== '') {
      run.length = 0;
    }
  }
}

function runCheck(root = ROOT) {
  const failures = [];
  for (const surface of SURFACES) checkSurface(root, surface, failures);
  return failures;
}

function writeFixture(root, overrides = {}) {
  const good = {
    'README.md': '# GoTry\n\n## Summary\n\nCompact reader intro.\n',
    'README.zh-CN.md': '# GoTry\n\n## 速览\n\n紧凑读者入口。\n',
    'docs/roadmap.md': '# GoTry Roadmap\n\n## TL;DR\n\n- Current state.\n',
    'docs/roadmap.zh-CN.md': '# GoTry 路线图\n\n## 速览\n\n- 当前状态。\n',
    'docs/architecture.md': [
      '# Architecture',
      '',
      '> Position: authority.',
      '> Status: living.',
      '',
      '## 1. What the system is',
      '',
      'Compact body.',
      '',
      '## 9. Evolution',
      '',
      'Pointers stay compact.',
      '',
      '## 10. Debt Register',
      '',
      '| Debt | Status |',
      '|---|---|',
      '| D-1 | Explained with context. |',
      '',
      '## 11. Freshness Mechanism',
      '',
      'Compact body.',
      '',
      '## 12. Document Map',
      '',
      'Compact body.',
      '',
    ].join('\n'),
    'docs/architecture.zh-CN.md': [
      '# 架构',
      '',
      '> 定位：权威面。',
      '> 状态：living。',
      '',
      '## 1. 系统是什么',
      '',
      '紧凑正文。',
      '',
      '## 9. 演进',
      '',
      '指针保持紧凑。',
      '',
      '## 10. 债务清单',
      '',
      '| 债务 | 状态 |',
      '|---|---|',
      '| D-1 | 带上下文说明。 |',
      '',
      '## 11. 保鲜机制',
      '',
      '紧凑正文。',
      '',
      '## 12. 文档地图',
      '',
      '紧凑正文。',
      '',
    ].join('\n'),
    'docs/design/stage1-top-down-design.md': '# Stage 1\n\n> Role: frozen source.\n> Status: frozen\n\n## 1. Contract\n\nBody.\n',
    'docs/design/stage1-top-down-design.zh-CN.md': '# Stage 1\n\n> 定位：冻结来源。\n> 状态：frozen\n\n## 1. 契约\n\n正文。\n',
    ...overrides,
  };
  for (const [relPath, body] of Object.entries(good)) {
    const absPath = join(root, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, body);
  }
}

function runSelfTest() {
  const baselineDir = mkdtempSync(join(tmpdir(), 'gotry-doc-readability-baseline-'));
  try {
    writeFixture(baselineDir);
    const baselineFailures = runCheck(baselineDir);
    if (baselineFailures.length) {
      console.error('SELF-TEST FIXTURE INVALID: baseline must pass before negative mutations');
      console.error(baselineFailures.map((failure) => `  ${failure}`).join('\n'));
      process.exit(1);
    }
  } finally {
    rmSync(baselineDir, { recursive: true, force: true });
  }

  const cases = [
    {
      name: 'line budget',
      overrides: { 'README.md': `# GoTry\n\n## Summary\n\n${Array.from({ length: 270 }, (_, i) => `line ${i}`).join('\n')}\n` },
      want: /exceeds 260 line budget/,
    },
    {
      name: 'revision history heading',
      overrides: { 'docs/roadmap.md': '# GoTry Roadmap\n\n## Revision History\n\n- Old state.\n' },
      want: /revision\/change-history/,
    },
    {
      name: 'append-only issue/date ledger',
      overrides: { 'README.md': '# GoTry\n\n## Summary\n\n- 2026-09-10 #1 old note\n- 2026-09-11 #2 old note\n- 2026-09-12 #3 old note\n- 2026-09-13 #4 old note\n' },
      want: /append-only date\/issue ledger run/,
    },
    {
      name: 'frozen preamble bound',
      overrides: { 'docs/design/stage1-top-down-design.md': `# Stage 1\n\n${Array.from({ length: 18 }, (_, i) => `> preamble ${i}`).join('\n')}\n\n## 1. Contract\n\nBody.\n` },
      want: /frozen design preamble/,
    },
    {
      name: 'bilingual parity',
      overrides: { 'docs/roadmap.zh-CN.md': `# GoTry 路线图\n\n## 速览\n\n${Array.from({ length: 30 }, (_, i) => `- 第 ${i} 行`).join('\n')}\n` },
      want: /bilingual pair line-count delta/,
    },
    {
      name: 'architecture section regrowth',
      overrides: { 'docs/architecture.md': `# Architecture\n\n> Position: authority.\n> Status: living.\n\n## 1. What the system is\n\nCompact.\n\n## 9. Evolution\n\n${Array.from({ length: 55 }, (_, i) => `line ${i}`).join('\n')}\n\n## 10. Debt Register\n\nCompact.\n\n## 11. Freshness Mechanism\n\nCompact.\n\n## 12. Document Map\n\nCompact.\n` },
      want: /section 9 has .* lines/,
    },
    {
      name: 'architecture pointer ledger',
      overrides: { 'docs/architecture.md': '# Architecture\n\n> Position: authority.\n> Status: living.\n\n## 1. What the system is\n\nCompact.\n\n## 9. Evolution\n\n- #470\n- #471\n- #472\n- #473\n\n## 10. Debt Register\n\nCompact.\n\n## 11. Freshness Mechanism\n\nCompact.\n\n## 12. Document Map\n\nCompact.\n' },
      want: /append-only date\/issue ledger run/,
    },
    {
      name: 'oversized logical line under section budget',
      overrides: { 'docs/roadmap.md': `# GoTry Roadmap\n\n## TL;DR\n\n${'x'.repeat(950)}\n` },
      want: /logical line has 950 bytes, budget 900/,
    },
    {
      name: 'missing required status header',
      overrides: { 'docs/design/stage1-top-down-design.md': '# Stage 1\n\n> Role: frozen source.\n\n## 1. Contract\n\nBody.\n' },
      want: /missing required header field "Status"/,
    },
  ];

  for (const testCase of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'gotry-doc-readability-'));
    try {
      writeFixture(dir, testCase.overrides);
      const failures = runCheck(dir);
      if (!failures.some((failure) => testCase.want.test(failure))) {
        console.error(`SELF-TEST FAILED: ${testCase.name}`);
        console.error(failures.map((failure) => `  ${failure}`).join('\n'));
        process.exit(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`DOC READABILITY SELF-TEST OK: ${cases.length} negative fixtures failed as expected`);
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const failures = runCheck();
  if (failures.length) {
    console.error('DOC READABILITY CHECK FAILED:');
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }
  const files = SURFACES.flatMap((surface) => surface.files).map((file) => relative(ROOT, join(ROOT, file)));
  console.log(`DOC READABILITY CHECK OK: ${files.length} reader-facing files within calibrated budgets`);
}
