#!/usr/bin/env node
/**
 * 双语对同步校验(loopx 约定,2026-09-10 创始人拍板:双语不一致视为 bug)。
 *
 * 规则:
 *  1. 根目录 *.md(CHANGELOG.md 等机器生成文件豁免)与 docs/ 顶层 *.md 必须有同名 .zh-CN.md 镜像。
 *  2. 任何位置出现的 *.zh-CN.md 都必须有对应基座,且通过结构对等校验。
 *  3. 对等校验(跳过围栏代码块后统计):标题数、围栏数、markdown 链接数三者相等。
 *     —— 代码块正文允许因注释翻译而不同,故只比数量不比内容。
 *
 * 子目录文档(phase 2 前)不强制镜像;一旦某篇出现 .zh-CN.md 即纳入规则 2。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXEMPT_BASES = new Set(['CHANGELOG.md']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'assets']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (name.endsWith('.md')) yield p;
  }
}

function mirrorOf(basePath) {
  return basePath.replace(/\.md$/, '.zh-CN.md');
}
function baseOf(mirrorPath) {
  return mirrorPath.replace(/\.zh-CN\.md$/, '.md');
}

function stats(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  let inFence = false, headings = 0, fences = 0, links = 0;
  for (const line of lines) {
    if (/^```/.test(line)) { inFence = !inFence; fences++; continue; }
    if (inFence) continue;
    if (/^#{1,6} /.test(line)) headings++;
    links += (line.match(/\]\(/g) || []).length;
  }
  return { headings, fences, links };
}

const failures = [];
const checked = [];

// 规则 1:根目录与 docs/ 顶层的基座必须有镜像
const mandatoryBaseDirs = [ROOT, join(ROOT, 'docs')];
for (const dir of mandatoryBaseDirs) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name.endsWith('.zh-CN.md') || EXEMPT_BASES.has(name)) continue;
    const base = join(dir, name);
    if (!statSync(base).isFile()) continue;
    const mirror = mirrorOf(base);
    if (!existsSync(mirror)) failures.push(`缺少中文镜像: ${relative(ROOT, base)}`);
    else checked.push([base, mirror]);
  }
}

// 规则 2+3:任何已存在的镜像都必须有基座,且结构对等(去重)
const seen = new Set(checked.map(([b]) => b));
for (const p of walk(join(ROOT, 'docs'))) {
  if (!p.endsWith('.zh-CN.md')) continue;
  const base = baseOf(p);
  if (!existsSync(base)) { failures.push(`镜像无基座: ${relative(ROOT, p)}`); continue; }
  if (seen.has(base)) continue;
  seen.add(base);
  checked.push([base, p]);
}
// 根目录镜像同理(README.zh-CN.md 等)
for (const name of readdirSync(ROOT)) {
  if (!name.endsWith('.zh-CN.md')) continue;
  const base = join(ROOT, baseOf(name));
  if (!existsSync(base)) { failures.push(`镜像无基座: ${name}`); continue; }
  if (seen.has(base)) continue;
  seen.add(base);
  checked.push([base, join(ROOT, name)]);
}

for (const [base, mirror] of checked) {
  const a = stats(base), b = stats(mirror);
  const rel = relative(ROOT, base);
  for (const k of ['headings', 'fences', 'links']) {
    if (a[k] !== b[k]) failures.push(`结构不对等(${k}: ${a[k]} vs ${b[k]}): ${rel} ↔ ${relative(ROOT, mirror)}`);
  }
}

if (failures.length) {
  console.error('DOCS I18N SYNC FAILED(双语不一致视为 bug):');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`DOCS I18N SYNC OK: ${checked.length} 对双语文档结构对等`);
