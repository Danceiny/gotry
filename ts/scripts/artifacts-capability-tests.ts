/**
 * 产物面(issue #285)能力层离线 proof:
 *  list/read 工具链的纯函数 + 隔离 fixture 路径护栏。
 *  与 smoke.ts §15 互相补——smoke 验注册 + dsh 卡片契约(在 plugin context),
 *  本文件验 capabilities/artifacts.ts 纯函数 + 隔离 stateRoot(无 dsh 上下文)。
 *
 *  1) 账本权威 list:种工单 + 交付 → list 找到 async-run
 *  2) cwd md list:工作目录顶层 md → list 找到 cwd-file
 *  3) 合并去重:账本 + cwd 同 path 不重复
 *  4) 裸工单 id read:从账本 deliverable 读出
 *  5) 行号窗口:offset/limit 行号正确
 *  6) 越界路径:ok:false + error 含「越界」
 *  7) symlink 越界:ok:false
 *  7b) 裸工单 id symlink/超大 deliverable:仍经过 canonical/root/size 护栏
 *  8) 不支持扩展名:.db → ok:false + error 含「不支持的文件类型」
 *  9) 不存在文件:ok:false
 *  10) 超大文件:>2MB → ok:false
 *  11) read 在 cwd/根边界外的相对路径:rejects
 *  12) list limit 截断:truncated=true, paths.length === limit
 *
 *  issue #441 追加(HTML 行程产物发现 + 安全源码预览):
 *  13) cwd 顶层 .html/.htm/大写扩展名同时可发现;标题去扩展名;dotfile 仍排除;md 不退化
 *  14) HTML read:lang=html、原始行号、全文 sha256 指纹、.htm 同 lang
 *  15) HTML 分页:offset/limit 行号 + windowed 语义与 md 一致
 *  16) 恶意 HTML fixture 只作字面文本返回:脚本/内联事件/fetch 不执行、不联网
 *  17) 安全回归:HTML 超大/越界/symlink 逃逸/隐藏文件/拒绝目录,与 md 同限制
 *  18) list→read 实际串联:消费 list 返回的 path 读回 HTML(state-root 与 cwd 两种来源)
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { listArtifacts, readArtifact } from '../capabilities/artifacts.ts'
import { ensureLedger } from '../src/state-ledger.ts'

const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-artifacts-cap-tests-'))
const cwd = mkdtempSync(join(tmpdir(), 'gotry-artifacts-cap-cwd-'))

// 1) 账本权威 list
{
  const ledger = ensureLedger(stateRoot)
  ledger.createWorkflowRun({ id: 'cap-probe-1', goal: '产物探针·账本', ticket: { objective: 'probe' }, state: {} })
  ledger.settleWorkflowRun('cap-probe-1', '# 交付·账本权威\nD1 大理\nD2 洱海')
  const r = await listArtifacts({ stateRoot, limit: 20 })
  const run = r.artifacts.find(a => a.id === 'cap-probe-1')
  assert.ok(run, '账本工单应被 list 找到')
  assert.equal(run?.source, 'async-run')
  assert.equal(run?.status, 'settled')
  assert.ok(run?.path.endsWith('cap-probe-1.deliverable.md'), `path 形态应为 deliverable.md,实际 ${run?.path}`)
  console.log('1) 账本权威 list OK')
}

// 2) cwd md list
{
  const lines = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行`)
  writeFileSync(join(cwd, 'trip-2027-cap.md'), `# 行程探针\n${lines.join('\n')}\n`)
  const r = await listArtifacts({ stateRoot, cwd, limit: 20 })
  const md = r.artifacts.find(a => a.id === 'trip-2027-cap.md')
  assert.ok(md, 'cwd 顶层 md 应被 list 找到')
  assert.equal(md?.source, 'cwd-file')
  console.log('2) cwd md list OK')
}

// 3) 合并去重:账本工单 cap-probe-1 的 path 与 cwd 任何文件 path 不冲突——验证 seenPath 去重逻辑
{
  // 制造一个 cwd 文件与账本 deliverable 同 basename 看似不同
  writeFileSync(join(cwd, 'cap-probe-1.deliverable.md'), 'unrelated')
  const r = await listArtifacts({ stateRoot, cwd, limit: 20 })
  const seen = new Map<string, number>()
  for (const a of r.artifacts) {
    if (a.id === 'cap-probe-1.deliverable.md' || a.id === 'cap-probe-1') {
      const k = resolve(a.path)
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
  }
  // 同一 path 出现 ≥2 次即去重失败
  for (const [k, n] of seen) {
    assert.ok(n <= 1, `path ${k} 出现 ${n} 次,应去重为 1`)
  }
  console.log('3) 合并去重 OK')
}

// 4) 裸工单 id read
{
  const r = await readArtifact({ stateRoot, cwd, path: 'cap-probe-1' })
  assert.equal(r.ok, true, '裸工单 id 应可读')
  if (r.ok) {
    assert.equal(r.lang, 'markdown')
    assert.equal(r.offset, 1)
    assert.equal(r.lines[0]?.number, 1)
    assert.ok(r.lines[0]?.text.includes('交付·账本权威'), '首行应含账本 deliverable 标题')
    assert.equal(r.totalLines, 3, `交付 3 行,实际 ${r.totalLines}`)
  }
  console.log('4) 裸工单 id read OK')
}

// 5) 行号窗口
{
  const r = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.md', offset: 3, limit: 3 })
  assert.equal(r.ok, true, 'cwd md 应可读')
  if (r.ok) {
    assert.equal(r.lines.length, 3, `offset=3 limit=3 应 3 行,实际 ${r.lines.length}`)
    assert.equal(r.lines[0]?.number, 3, `首行号应 3,实际 ${r.lines[0]?.number}`)
    assert.equal(r.lines[2]?.number, 5)
    assert.equal(r.totalLines, 10, `8 行 + 标题 1 + 末尾空行 1 = 10,实际 ${r.totalLines}`)
    assert.equal(r.windowed, true, `offset=3 limit=3 总 10 行 → windowed=true(可继续翻页)`)
  }
  const full = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.md' })
  assert.equal(full.ok, true, 'cwd md 默认 limit 应读完')
  if (full.ok) {
    assert.equal(full.windowed, false, `读完应 windowed=false`)
    assert.equal(full.lines.length, full.totalLines, `lines.length === totalLines,实际 ${full.lines.length}/${full.totalLines}`)
  }
  console.log('5) 行号窗口 OK')
}

// 6) 越界路径
{
  const r = await readArtifact({ stateRoot, cwd, path: '../../../../../etc/passwd' })
  assert.equal(r.ok, false, '越界路径必须被拒')
  if (!r.ok) {
    assert.ok(r.error.includes('越界'), `error 应含「越界」,实际 ${r.error}`)
  }
  console.log('6) 越界路径 OK')
}

// 7) symlink 越界
{
  const linkPath = join(cwd, 'symlink-out.md')
  try {
    symlinkSync('/etc/passwd', linkPath)
  } catch {
    // macOS 上 /etc/passwd 是符号链接到 /private/etc/passwd;symlink 自身仍 out-of-root
  }
  const r = await readArtifact({ stateRoot, cwd, path: 'symlink-out.md' })
  assert.equal(r.ok, false, '相对路径 symlink 解析后越出 cwd 必须被拒')
  if (!r.ok) assert.ok(r.error.includes('越界'), `symlink 越界错误应含「越界」,实际 ${r.error}`)

  // 绝对 symlink 指向目录也必须按 canonical target 做边界检查。
  const absLink = join(stateRoot, 'abs-link.md')
  try {
    symlinkSync('/etc', absLink)
    const r2 = await readArtifact({ stateRoot, cwd, path: absLink })
    assert.equal(r2.ok, false, '绝对 symlink 越界必须被拒')
    if (!r2.ok) {
      assert.ok(r2.error.includes('越界'), `error 应含「越界」,实际 ${r2.error}`)
    }
  } catch { /* 非 POSIX fs 跳过 */ }
  console.log('7) symlink 越界 OK')
}

// 7b) 裸工单 id 的兼容文件视图也必须经过同一组 canonical/root/size 护栏。
{
  mkdirSync(join(stateRoot, 'gotry-state', 'async'), { recursive: true })
  const bareLink = join(stateRoot, 'gotry-state', 'async', 'evil.deliverable.md')
  let bareLinkCreated = false
  try {
    symlinkSync('/etc/hosts', bareLink)
    bareLinkCreated = true
  } catch { /* 非 POSIX fs 跳过 */ }
  if (bareLinkCreated) {
    const r = await readArtifact({ stateRoot, cwd, path: 'evil' })
    assert.equal(r.ok, false, '裸工单 id symlink 指向 root 外时必须被拒')
    if (!r.ok) assert.ok(r.error.includes('越界'), `裸工单 id symlink 越界错误应含「越界」,实际 ${r.error}`)
  }

  const bareBig = join(stateRoot, 'gotry-state', 'async', 'oversized.deliverable.md')
  writeFileSync(bareBig, 'x'.repeat(2 * 1024 * 1024 + 1))
  const oversized = await readArtifact({ stateRoot, cwd, path: 'oversized' })
  assert.equal(oversized.ok, false, '裸工单 id 超大文件必须被拒')
  if (!oversized.ok) assert.ok(oversized.error.includes('过大'), `裸工单 id 超大错误应含「过大」,实际 ${oversized.error}`)
  rmSync(bareLink, { force: true })
  rmSync(bareBig, { force: true })
  console.log('7b) 裸工单 id symlink/超大 deliverable 护栏 OK')
}

// 8) 不支持扩展名
{
  mkdirSync(join(stateRoot, 'gotry-state'), { recursive: true })
  writeFileSync(join(stateRoot, 'gotry-state', 'gotry-state.db'), 'fake db')
  const r = await readArtifact({ stateRoot, cwd, path: 'gotry-state/gotry-state.db' })
  assert.equal(r.ok, false, '.db 必须被拒')
  if (!r.ok) {
    assert.ok(r.error.includes('不支持的文件类型'), `error 应含「不支持的文件类型」,实际 ${r.error}`)
  }
  console.log('8) 不支持扩展名 OK')
}

// 9) 不存在文件
{
  const r = await readArtifact({ stateRoot, cwd, path: 'not-found.md' })
  assert.equal(r.ok, false, '不存在文件必须被拒')
  if (!r.ok) {
    assert.ok(r.error.includes('不存在'), `error 应含「不存在」,实际 ${r.error}`)
  }
  console.log('9) 不存在文件 OK')
}

// 10) 超大文件
{
  const big = join(cwd, 'big.md')
  // 2MB+ 一点点;read 默认上限 2MB
  const chunk = 'x'.repeat(64 * 1024)
  const handle = await import('node:fs/promises').then(m => m.open(big, 'w'))
  try {
    for (let i = 0; i < 33; i++) await handle.write(chunk) // 33 * 64KB = 2.11MB
  } finally { await handle.close() }
  const r = await readArtifact({ stateRoot, cwd, path: 'big.md' })
  assert.equal(r.ok, false, '>2MB 必须被拒')
  if (!r.ok) {
    assert.ok(r.error.includes('过大'), `error 应含「过大」,实际 ${r.error}`)
  }
  console.log('10) 超大文件 OK')
}

// 11) read 接受 path 三形态:id / cwd 文件名 / 绝对路径
{
  // 11a) 相对文件名仅在 cwd 顶层
  const r = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.md' })
  assert.equal(r.ok, true, '相对文件名应解析为 cwd 顶层')
  // 11b) path 为裸字符串无后缀 + 不在 cwd → 尝试 stateRoot 下的 gotry-state/async/
  const r2 = await readArtifact({ stateRoot, cwd, path: 'cap-probe-1' })
  assert.equal(r2.ok, true, '裸工单 id 应解析为账本')
  // 11c) 空 path
  const r3 = await readArtifact({ stateRoot, cwd, path: '' })
  assert.equal(r3.ok, false, '空 path 应被拒')
  console.log('11) path 三形态 OK')
}

// 12) list limit 截断
{
  for (let i = 0; i < 5; i++) writeFileSync(join(cwd, `extra-${i}.md`), `# 副产物 ${i}`)
  const r = await listArtifacts({ stateRoot, cwd, limit: 3 })
  assert.equal(r.artifacts.length, 3, `limit=3 应 3 条,实际 ${r.artifacts.length}`)
  assert.equal(r.truncated, true, `应有更多,truncated 应为 true`)
  // 自 #458 起 list 不再按源提前 limit,total 反映已过滤集合的全部条目。
  // 此时 ledger 1(cap-probe-1)+ cwd 顶层 8 个(trip-2027-cap.md +
  // cap-probe-1.deliverable.md + big.md + extra-0..4)= 9。test 13+ 才加 HTML/htm/
  // 隐藏文件,不影响本断言。
  assert.equal(r.total, 9, `total 应 9,实际 ${r.total}`)
  assert.ok(r.total > r.artifacts.length, `total 应 > artifacts.length 才能 truncated,实际 ${r.total} vs ${r.artifacts.length}`)
  assert.equal(r.nextOffset, 3, `limit=3 truncated 应 nextOffset=3,实际 ${r.nextOffset}`)
  // 放大 limit 后能看到全部
  const r2 = await listArtifacts({ stateRoot, cwd, limit: 20 })
  assert.equal(r2.truncated, false, `limit=20 应能装下,truncated=false`)
  assert.ok(r2.total >= 9, `放大 limit 后 total 应 ≥ 9,实际 ${r2.total}`)
  console.log('12) list limit 截断 OK')
}

// ============ issue #441:HTML 行程产物 ============

const HTML_TEXT = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>合成行程·大理</title></head>',
  '<body>',
  '<h1>合成行程 2027</h1>',
  '<p>D1 大理 · D2 洱海</p>',
  '</body></html>',
  '',
].join('\n')

// 13) cwd 顶层 html/htm 发现(大小写不敏感)+ 标题 + dotfile 排除 + md 不退化
{
  writeFileSync(join(cwd, 'trip-2027-cap.html'), HTML_TEXT)
  writeFileSync(join(cwd, 'trip-2027-cap.htm'), '<html><body><p>htm 变体</p></body></html>')
  writeFileSync(join(cwd, 'Trip-2027-CAPS.HTML'), '<html><body><p>大写扩展名</p></body></html>')
  writeFileSync(join(cwd, '.hidden-trip.html'), '<html><body><p>隐藏文件不得发现</p></body></html>')
  const r = await listArtifacts({ stateRoot, cwd, limit: 50 })
  const ids = r.artifacts.map(a => a.id)
  for (const name of ['trip-2027-cap.html', 'trip-2027-cap.htm', 'Trip-2027-CAPS.HTML']) {
    assert.ok(ids.includes(name), `顶层 ${name} 应被 list 发现,实际 ${ids.join(',')}`)
  }
  assert.ok(ids.includes('trip-2027-cap.md'), `md 发现不得退化,实际 ${ids.join(',')}`)
  assert.ok(!ids.includes('.hidden-trip.html'), `dotfile 仍应被排除,实际 ${ids.join(',')}`)
  const html = r.artifacts.find(a => a.id === 'trip-2027-cap.html')
  assert.equal(html?.source, 'cwd-file')
  assert.equal(html?.title, 'trip-2027-cap', `标题应去扩展名,实际 ${html?.title}`)
  assert.equal(html?.bytes, Buffer.byteLength(HTML_TEXT), `bytes 应为文件字节数,实际 ${html?.bytes}`)
  const caps = r.artifacts.find(a => a.id === 'Trip-2027-CAPS.HTML')
  assert.equal(caps?.title, 'Trip-2027-CAPS', `大写扩展名同样去扩展名,实际 ${caps?.title}`)
  // 排序仍是 mtime 倒序 + limit 截断(total 为各源保留数之和,与 md 语义一致)
  const limited = await listArtifacts({ stateRoot, cwd, limit: 2 })
  assert.equal(limited.artifacts.length, 2, `limit=2 应 2 条,实际 ${limited.artifacts.length}`)
  assert.equal(limited.truncated, true, 'limit=2 应截断')
  // 排序单调性:mtime 倒序(updated 字符串倒序)
  const all = await listArtifacts({ stateRoot, cwd, limit: 50 })
  for (let i = 1; i < all.artifacts.length; i++) {
    const prev = String(all.artifacts[i - 1]?.updated ?? '')
    const cur = String(all.artifacts[i]?.updated ?? '')
    assert.ok(prev.localeCompare(cur) >= 0, `排序应 mtime 倒序:${prev} < ${cur}`)
  }
  console.log('13) cwd html/htm 发现 + 标题/排序/截断 OK')
}

// 14) HTML read:lang=html + 原始行号 + 全文指纹(.htm 同 lang)
{
  const r = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.html' })
  assert.equal(r.ok, true, 'cwd html 应可读')
  if (r.ok) {
    assert.equal(r.lang, 'html', `lang 应 html,实际 ${r.lang}`)
    assert.equal(r.source, 'cwd', `source 应 cwd,实际 ${r.source}`)
    assert.equal(r.totalLines, 7, `HTML_TEXT 7 行,实际 ${r.totalLines}`)
    assert.equal(r.lines[0]?.number, 1, '首行号应 1')
    assert.equal(r.lines[3]?.text, '<h1>合成行程 2027</h1>', `第 4 行原文应保真,实际 ${r.lines[3]?.text}`)
    const expected = createHash('sha256').update(HTML_TEXT).digest('hex').slice(0, 12)
    assert.equal(r.version, expected, `版本应为全文 sha256 前 12 位,实际 ${r.version}`)
    assert.equal(r.windowed, false, '全文一次读完应 windowed=false')
  }
  const caps = await readArtifact({ stateRoot, cwd, path: 'Trip-2027-CAPS.HTML' })
  assert.equal(caps.ok, true, '大写 .HTML 应可读')
  if (caps.ok) assert.equal(caps.lang, 'html', `大写扩展名 lang 仍 html,实际 ${caps.lang}`)
  const htm = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.htm' })
  assert.equal(htm.ok, true, '.htm 应可读')
  if (htm.ok) {
    assert.equal(htm.lang, 'html', `.htm lang 应 html,实际 ${htm.lang}`)
    assert.ok(htm.content.includes('<p>htm 变体</p>'), '.htm 内容应原文返回')
  }
  console.log('14) HTML read lang/行号/指纹 OK')
}

// 15) HTML 分页与 md 同语义
{
  const r = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.html', offset: 3, limit: 2 })
  assert.equal(r.ok, true, 'HTML 分页应可读')
  if (r.ok) {
    assert.equal(r.lines.length, 2, `offset=3 limit=2 应 2 行,实际 ${r.lines.length}`)
    assert.equal(r.lines[0]?.number, 3, `首行号应 3,实际 ${r.lines[0]?.number}`)
    assert.equal(r.lines[1]?.number, 4)
    assert.equal(r.offset, 3)
    assert.equal(r.windowed, true, '总 7 行读 3-4 行应 windowed=true')
  }
  console.log('15) HTML 分页 OK')
}

// 16) 恶意 HTML fixture:只作字面文本返回,不执行脚本/内联事件,不发网络请求
{
  const evil = [
    '<!doctype html><html><body>',
    '<script>globalThis.__gotry441Pwned = true</script>',
    '<img src=x onerror="globalThis.__gotry441Pwned = true">',
    '<iframe src="https://example.invalid/track"></iframe>',
    '<a href="javascript:globalThis.__gotry441Pwned=true">点击</a>',
    '<script>fetch("http://127.0.0.1:1/collect")</script>',
    '</body></html>',
    '',
  ].join('\n')
  writeFileSync(join(cwd, 'evil-itinerary.html'), evil)
  const r = await readArtifact({ stateRoot, cwd, path: 'evil-itinerary.html', limit: 400 })
  assert.equal(r.ok, true, '恶意 HTML 仍应作为文本可读')
  if (r.ok) {
    const content = r.lines.map(l => l.text).join('\n')
    assert.ok(content.includes('<script>globalThis.__gotry441Pwned = true</script>'), '脚本应原样作为文本返回')
    assert.ok(content.includes('onerror="globalThis.__gotry441Pwned = true"'), '内联事件属性应原样作为文本返回')
    assert.ok(content.includes('javascript:globalThis.__gotry441Pwned=true'), 'javascript: 链接应原样作为文本返回')
    assert.ok(content.includes('fetch("http://127.0.0.1:1/collect")'), 'fetch 调用应原样作为文本返回')
    assert.ok(r.lines.every(l => typeof l.text === 'string'), '所有行必须是纯字符串文本')
    assert.equal(r.lang, 'html', 'lang 仍是 html(源码预览,非渲染)')
    assert.equal(r.version, createHash('sha256').update(evil).digest('hex').slice(0, 12), '指纹基于原文文本')
  }
  assert.equal((globalThis as unknown as Record<string, unknown>).__gotry441Pwned, undefined, '读取过程不得执行 HTML 内脚本')
  console.log('16) 恶意 HTML 字面文本 + 零执行 OK')
}

// 17) 安全回归:HTML 与 md 同限制(超大/越界/symlink 逃逸/隐藏/拒绝目录)
{
  // 17a) 超大 HTML(>2MB)
  const bigHtml = join(cwd, 'big-itinerary.html')
  const chunk = '<p>xxxx</p>'.repeat(64 * 1024)
  const handle = await import('node:fs/promises').then(m => m.open(bigHtml, 'w'))
  try {
    for (let i = 0; i < 4; i++) await handle.write(chunk) // 4 * 640KB = 2.6MB > 2MB
  } finally { await handle.close() }
  const big = await readArtifact({ stateRoot, cwd, path: 'big-itinerary.html' })
  assert.equal(big.ok, false, '>2MB HTML 必须被拒')
  if (!big.ok) assert.ok(big.error.includes('过大'), `超大 HTML 错误应含「过大」,实际 ${big.error}`)

  // 17b) 越界相对路径(html 扩展名不豁免边界)
  const out = await readArtifact({ stateRoot, cwd, path: '../../../../etc/passwd.html' })
  assert.equal(out.ok, false, '越界 html 必须被拒')
  if (!out.ok) assert.ok(out.error.includes('越界'), `越界错误应含「越界」,实际 ${out.error}`)

  // 17c) symlink 逃逸:指向 root 外的 .html 既不可 list 也不可 read
  const linkHtml = join(cwd, 'symlink-evil.html')
  try {
    symlinkSync('/etc/passwd', linkHtml)
    const listed = await listArtifacts({ stateRoot, cwd, limit: 50 })
    assert.ok(!listed.artifacts.some(a => a.id === 'symlink-evil.html'), 'symlink 文件不得进入 list')
    const read = await readArtifact({ stateRoot, cwd, path: 'symlink-evil.html' })
    assert.equal(read.ok, false, 'symlink 逃逸的 html 必须被拒')
    if (!read.ok) assert.ok(read.error.includes('越界'), `symlink 逃逸错误应含「越界」,实际 ${read.error}`)
  } catch { /* 非 POSIX fs 跳过 */ }

  // 17d) 隐藏文件:list 排除(同 md);显式 path 读取行为与 md 一致(不新增限制)
  writeFileSync(join(cwd, '.hidden-parity.md'), 'md 隐藏')
  const hiddenHtml = await readArtifact({ stateRoot, cwd, path: '.hidden-trip.html' })
  const hiddenMd = await readArtifact({ stateRoot, cwd, path: '.hidden-parity.md' })
  assert.equal(hiddenHtml.ok, hiddenMd.ok, '.html 与 .md 隐藏文件的显式读取行为必须一致')
  const listed2 = await listArtifacts({ stateRoot, cwd, limit: 50 })
  assert.ok(!listed2.artifacts.some(a => a.id === '.hidden-parity.md'), 'md dotfile 同样不得进入 list')

  // 17e) 拒绝目录:node_modules 内 html 既不可读也不可发现
  mkdirSync(join(cwd, 'node_modules'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules', 'vendored.html'), '<html><body>vendored</body></html>')
  const denied = await readArtifact({ stateRoot, cwd, path: 'node_modules/vendored.html' })
  assert.equal(denied.ok, false, 'node_modules 内 html 必须被拒')
  if (!denied.ok) assert.ok(denied.error.includes('越界'), `拒绝目录错误应含「越界」,实际 ${denied.error}`)
  const listed3 = await listArtifacts({ stateRoot, cwd, limit: 50 })
  assert.ok(!listed3.artifacts.some(a => a.id === 'vendored.html'), 'node_modules 内文件不得进入 list(非递归)')
  rmSync(join(cwd, 'node_modules'), { recursive: true, force: true })
  console.log('17) HTML 安全回归(超大/越界/symlink/隐藏/拒绝目录)OK')
}

// 18) list→read 实际串联:消费 list 返回的 path(绝对路径形态)读回 HTML
{
  const rootHtml = join(stateRoot, 'gotry-state', 'trip-in-root.html')
  mkdirSync(join(stateRoot, 'gotry-state'), { recursive: true })
  writeFileSync(rootHtml, '<html><body><p>state-root 内 HTML</p></body></html>')
  const listed = await listArtifacts({ stateRoot, cwd, limit: 50 })
  const cwdEntry = listed.artifacts.find(a => a.id === 'trip-2027-cap.html')
  assert.ok(cwdEntry, 'list 应返回 cwd html 条目')
  const viaList = await readArtifact({ stateRoot, cwd, path: String(cwdEntry?.path) })
  assert.equal(viaList.ok, true, 'list 返回的 cwd 绝对路径应可读')
  if (viaList.ok) {
    assert.equal(viaList.lang, 'html')
    assert.equal(viaList.source, 'cwd', `cwd 来源标签,实际 ${viaList.source}`)
  }
  const viaRoot = await readArtifact({ stateRoot, cwd, path: rootHtml })
  assert.equal(viaRoot.ok, true, 'stateRoot 内 HTML 应可读')
  if (viaRoot.ok) {
    assert.equal(viaRoot.lang, 'html')
    assert.equal(viaRoot.source, 'state-root', `state-root 来源标签,实际 ${viaRoot.source}`)
    assert.ok(viaRoot.content.includes('state-root 内 HTML'), '内容应为原文')
  }
  // 读回内容与磁盘原文逐字一致(不做任何 HTML 解析/改写)
  const onDisk = readFileSync(join(cwd, 'trip-2027-cap.html'), 'utf8')
  const roundTrip = await readArtifact({ stateRoot, cwd, path: 'trip-2027-cap.html' })
  if (roundTrip.ok) assert.equal(roundTrip.content, onDisk, '读回内容必须与磁盘原文逐字一致')
  console.log('18) list→read 串联(state-root/cwd)OK')
}

// ============ issue #458:list paging + literal metadata search ============

// 19) >50 cwd entries: enumerated across pages with no omission/duplicate
{
  const bigRoot = mkdtempSync(join(tmpdir(), 'gotry-458-big-root-'))
  const bigCwd = mkdtempSync(join(tmpdir(), 'gotry-458-big-'))
  try {
    const ids: string[] = []
    // 60 timestamped md files, oldest mtime first so updated ASC == alphabetical.
    for (let i = 0; i < 60; i++) {
      const name = `itinerary-${String(i).padStart(3, '0')}.md`
      const p = join(bigCwd, name)
      writeFileSync(p, `# itinerary ${i}\n`)
      // Older = smaller i; mtime strictly increasing ⇒ updated ASC mirrors id ASC.
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i))
      const { utimesSync } = await import('node:fs')
      utimesSync(p, ts, ts)
      ids.push(name)
    }

    const r1 = await listArtifacts({ stateRoot: bigRoot, cwd: bigCwd, limit: 20 })
    assert.equal(r1.artifacts.length, 20, `default page 应 20 条,实际 ${r1.artifacts.length}`)
    assert.equal(r1.total, 60, `total 应 60(全部 cwd 顶层),实际 ${r1.total}`)
    assert.equal(r1.truncated, true, `truncated 应 true`)
    assert.equal(r1.nextOffset, 20, `nextOffset 应 20,实际 ${r1.nextOffset}`)
    assert.equal(r1.limit, 20, `limit echo 应 20,实际 ${r1.limit}`)
    assert.equal(r1.offset, 0, `offset echo 应 0`)

    const r2 = await listArtifacts({ stateRoot: bigRoot, cwd: bigCwd, limit: 9999 })
    assert.equal(r2.artifacts.length, 50, `limit 9999 应被夹到 50,实际 ${r2.artifacts.length}`)
    assert.equal(r2.total, 60, `cap=50 时 total 仍应 60(不被截断到 50),实际 ${r2.total}`)
    assert.equal(r2.truncated, true, `50<60 时 truncated 应 true`)
    assert.equal(r2.limit, 50, `limit echo 应 50`)
    assert.equal(r2.nextOffset, 50, `nextOffset 应 50`)

    // 全 60 条刚好分两页半:page1+page2 完整覆盖,最后 10 条从 page2 起
    const page1 = await listArtifacts({ stateRoot: bigRoot, cwd: bigCwd, limit: 30, offset: 0 })
    const page2 = await listArtifacts({ stateRoot: bigRoot, cwd: bigCwd, limit: 30, offset: 30 })
    const page3 = await listArtifacts({ stateRoot: bigRoot, cwd: bigCwd, limit: 30, offset: 60 })
    const collected = new Set<string>()
    for (const p of [page1, page2, page3]) {
      assert.equal(p.total, 60, `各页 total 都应 60,实际 ${p.total}`)
      for (const a of p.artifacts) {
        assert.equal(collected.has(a.path), false, `path ${a.path} 在分页中出现多次`)
        collected.add(a.path)
      }
    }
    assert.equal(collected.size, 60, `三页拼起来必须唯一覆盖 60 条,实际 ${collected.size}`)
    for (const id of ids) {
      assert.ok([...collected].some(p => p.endsWith(join(bigCwd, id))), `应能找到 ${id}`)
    }
    assert.equal(page1.nextOffset, 30, `page1 nextOffset 应 30`)
    assert.equal(page2.nextOffset, undefined, `page2 已是最后一页,无 nextOffset`)
    assert.equal(page2.truncated, false, `page2 truncated 应 false`)
    assert.equal(page3.artifacts.length, 0, `越界页应空,实际 ${page3.artifacts.length}`)
    assert.equal(page3.nextOffset, undefined, `越界页无 nextOffset,实际 ${page3.nextOffset}`)
    assert.equal(page3.truncated, false, `越界页 truncated 应 false`)
    assert.equal(page3.offset, 60, `越界页 offset echo 应回填请求值 60`)

    // 第 1 页首条应是 mtime 最新(序号最大)
    assert.ok(page1.artifacts[0]?.path.endsWith('itinerary-059.md'), `首条应是 mtime 最新者,实际 ${page1.artifacts[0]?.path}`)
    // 第 3 页(越界页)首条之后无内容,但 known total 仍准确
    console.log('19) >50 cwd 跨页枚举 OK')
  } finally {
    rmSync(bigCwd, { recursive: true, force: true })
    rmSync(bigRoot, { recursive: true, force: true })
  }
}

// 20) equal timestamps:lexical (source,id,path) tie-break 让 page 边界稳定
{
  const tieRoot = mkdtempSync(join(tmpdir(), 'gotry-458-tie-root-'))
  const sameCwd = mkdtempSync(join(tmpdir(), 'gotry-458-tie-'))
  try {
    const ts = new Date('2026-01-01T00:00:00.000Z')
    const { utimesSync } = await import('node:fs')
    for (const name of ['zeta.md', 'alpha.md', 'Beta.md', 'Gamma.md']) {
      const p = join(sameCwd, name)
      writeFileSync(p, '# tie\n')
      utimesSync(p, ts, ts)
    }
    const r = await listArtifacts({ stateRoot: tieRoot, cwd: sameCwd, limit: 2 })
    assert.equal(r.total, 4, `total 应 4,实际 ${r.total}`)
    assert.equal(r.artifacts.length, 2)
    // 标题去扩展名后 codepoint 词典序(ASCII):'B'(0x42) < 'G'(0x47) < 'a'(0x61) < 'z'(0x7A)
    const titles = r.artifacts.map(a => a.title)
    assert.deepEqual(titles, ['Beta', 'Gamma'], `updated 相同时按 title codepoint 词典序,实际 ${titles.join(',')}`)
    // 同样输入两次必须返回完全相同的顺序
    const r2 = await listArtifacts({ stateRoot: tieRoot, cwd: sameCwd, limit: 2 })
    assert.deepEqual(r2.artifacts.map(a => a.path), r.artifacts.map(a => a.path), '等 mtime 下分页顺序必须可复现')
    console.log('20) equal-timestamp tie-break OK')
  } finally {
    rmSync(sameCwd, { recursive: true, force: true })
    rmSync(tieRoot, { recursive: true, force: true })
  }
}

// 21) mixed ledger/legacy/cwd:authority + dedupe 跨分页保留
{
  const mixRoot = mkdtempSync(join(tmpdir(), 'gotry-458-mix-root-'))
  const mixCwd = mkdtempSync(join(tmpdir(), 'gotry-458-mix-cwd-'))
  try {
    const ledger = ensureLedger(mixRoot)
    ledger.createWorkflowRun({ id: 'cap-mix-a', goal: '账本权威 a', ticket: { objective: 'mix' }, state: {} })
    ledger.settleWorkflowRun('cap-mix-a', '# a\n')
    ledger.createWorkflowRun({ id: 'cap-mix-b', goal: '账本权威 b', ticket: { objective: 'mix' }, state: {} })
    ledger.settleWorkflowRun('cap-mix-b', '# b\n')
    mkdirSync(join(mixRoot, 'gotry-state', 'async'), { recursive: true })
    writeFileSync(join(mixRoot, 'gotry-state', 'async', 'legacy-1.deliverable.md'), '# legacy\n')
    writeFileSync(join(mixRoot, 'gotry-state', 'async', 'legacy-2.deliverable.md'), '# legacy\n')
    writeFileSync(join(mixCwd, 'trip-plan-a.md'), '# cwd a\n')
    writeFileSync(join(mixCwd, 'trip-plan-b.md'), '# cwd b\n')
    const r = await listArtifacts({ stateRoot: mixRoot, cwd: mixCwd, limit: 10 })
    assert.equal(r.total, 6, `total 应 6(2 账本 + 2 legacy + 2 cwd),实际 ${r.total}`)
    const sources = new Set(r.artifacts.map(a => a.source))
    assert.ok(sources.has('async-run') && sources.has('cwd-file'), `应同时覆盖账本/legacy 与 cwd 两源,实际 ${[...sources].join(',')}`)
    // 写入与账本同 path 的文件视图,验证 dedupe 后总数不变
    writeFileSync(join(mixRoot, 'gotry-state', 'async', 'cap-mix-a.deliverable.md'), '# file view a\n')
    writeFileSync(join(mixRoot, 'gotry-state', 'async', 'cap-mix-b.deliverable.md'), '# file view b\n')
    const r2 = await listArtifacts({ stateRoot: mixRoot, cwd: mixCwd, limit: 10 })
    assert.equal(r2.total, 6, `账本权威 + 文件视图 dedupe 后 total 应仍 6,实际 ${r2.total}`)
    const seen = new Map<string, number>()
    for (const a of r2.artifacts) {
      seen.set(resolve(a.path), (seen.get(resolve(a.path)) ?? 0) + 1)
    }
    for (const [k, n] of seen) {
      assert.ok(n <= 1, `path ${k} 出现 ${n} 次(账本/legacy/cwd 跨源去重失败)`)
    }
    // 再次确认源覆盖:每个 cap-mix-{a,b} 应来自账本(async-run),不是 cwd
    for (const id of ['cap-mix-a', 'cap-mix-b']) {
      const entry = r2.artifacts.find(a => a.id === id)
      assert.equal(entry?.source, 'async-run', `${id} 应来自账本权威,实际 ${entry?.source}`)
    }
    console.log('21) mixed ledger/legacy/cwd dedupe OK')
  } finally {
    rmSync(mixRoot, { recursive: true, force: true })
    rmSync(mixCwd, { recursive: true, force: true })
  }
}

// 22) literal search:finds old entries before paging;total reflects filtered set
{
  const searchRoot = mkdtempSync(join(tmpdir(), 'gotry-458-search-root-'))
  const searchCwd = mkdtempSync(join(tmpdir(), 'gotry-458-search-'))
  try {
    for (const name of ['trip-paris-2025.md', 'trip-tokyo-2024.md', 'report-budget.md', 'random.md']) {
      writeFileSync(join(searchCwd, name), `# ${name}\n`)
    }
    const exact = await listArtifacts({ stateRoot: searchRoot, cwd: searchCwd, search: 'paris' })
    assert.equal(exact.total, 1, `search='paris' 应命中 1 条,实际 ${exact.total}`)
    assert.equal(exact.artifacts[0]?.id, 'trip-paris-2025.md')
    const none = await listArtifacts({ stateRoot: searchRoot, cwd: searchCwd, search: '   ' })
    assert.equal(none.total, 4, `空白 search 应等同未过滤,total=4,实际 ${none.total}`)
    const ci = await listArtifacts({ stateRoot: searchRoot, cwd: searchCwd, search: 'PARIS' })
    assert.equal(ci.total, 1, `search 大小写不敏感,实际 ${ci.total}`)
    const literal = await listArtifacts({ stateRoot: searchRoot, cwd: searchCwd, search: '.*' })
    assert.equal(literal.total, 0, `.* 应作字面匹配,不命中任何 id/title/filename,实际 ${literal.total}`)
    const bodyOnly = await listArtifacts({ stateRoot: searchRoot, cwd: searchCwd, search: 'budget-detail' })
    assert.equal(bodyOnly.total, 0, `search 仅匹配元数据,不搜文件内容,实际 ${bodyOnly.total}`)
    // search 后分页 + 越界
    const filtered = await listArtifacts({ stateRoot: searchRoot, cwd: searchCwd, search: 'trip', limit: 2 })
    assert.equal(filtered.total, 2, `search='trip' 应命中 trip-* 两条,实际 ${filtered.total}`)
    assert.equal(filtered.nextOffset, undefined, `2 条全在一页时无 nextOffset`)
    // 元数据命中 via title(去扩展名)
    const viaTitle = await listArtifacts({ stateRoot: searchRoot, cwd: searchCwd, search: 'report-budget' })
    assert.equal(viaTitle.total, 1, `命中 id,实际 ${viaTitle.total}`)
    // 标记 search echo
    assert.equal(filtered.search, 'trip', `应回填 trim 后的 search,实际 ${filtered.search}`)
    console.log('22) literal search OK')
  } finally {
    rmSync(searchCwd, { recursive: true, force: true })
    rmSync(searchRoot, { recursive: true, force: true })
  }
}

// 23) invalid offset/limit/search types:拒绝可预测,不静默圆整
{
  await assert.rejects(
    () => listArtifacts({ stateRoot, cwd, offset: -1 }),
    /offset must be a nonnegative integer/,
    '负 offset 必须被拒',
  )
  await assert.rejects(
    () => listArtifacts({ stateRoot, cwd, offset: 1.5 }),
    /offset must be a nonnegative integer/,
    '非整数 offset 必须被拒',
  )
  await assert.rejects(
    () => listArtifacts({ stateRoot, cwd, offset: NaN }),
    /offset must be a nonnegative integer/,
    'NaN offset 必须被拒',
  )
  await assert.rejects(
    () => listArtifacts({ stateRoot, cwd, offset: '5' as unknown as number }),
    /offset must be a nonnegative integer/,
    '字符串 offset 必须被拒(不静默转数字)',
  )
  await assert.rejects(
    () => listArtifacts({ stateRoot, cwd, offset: null as unknown as number }),
    /offset must be a nonnegative integer/,
    'null offset 必须被拒',
  )
  await assert.rejects(
    () => listArtifacts({ stateRoot, cwd, offset: Number.MAX_SAFE_INTEGER + 1 }),
    /offset must be a safe integer/,
    'unsafe 整数 offset(>MAX_SAFE_INTEGER)必须被拒,避免数组切片失真',
  )
  await assert.rejects(
    () => listArtifacts({ stateRoot, cwd, offset: -Number.MAX_SAFE_INTEGER - 1 }),
    /offset must be/,
    'unsafe 负整数 offset(<-MAX_SAFE_INTEGER)必须被拒(由负数分支先拒)',
  )
  await assert.rejects(
    () => listArtifacts({ stateRoot, cwd, limit: '20' as unknown as number }),
    /limit must be a positive integer/,
    '字符串 limit 必须被拒',
  )
  await assert.rejects(
    () => listArtifacts({ stateRoot, cwd, limit: Infinity }),
    /limit must be a positive integer/,
    'Infinity limit 必须被拒',
  )
  await assert.rejects(
    () => listArtifacts({ stateRoot, cwd, limit: 1.5 }),
    /limit must be a positive integer/,
    '非整数 limit 必须被拒',
  )
  await assert.rejects(
    () => listArtifacts({ stateRoot, cwd, search: 5 as unknown as string }),
    /search must be a string/,
    '非字符串 search 必须被拒(不静默 "no filter")',
  )
  // 兼容路径:零/负 INTEGER limit 静默夹到 1(保留 pre-#458 clamp-on-1 行为)
  const zero = await listArtifacts({ stateRoot, cwd, limit: 0 })
  assert.equal(zero.limit, 1, `limit=0 应夹到 1,实际 ${zero.limit}`)
  assert.equal(zero.artifacts.length <= 1, true, `limit 夹到 1 时最多 1 条`)
  const neg = await listArtifacts({ stateRoot, cwd, limit: -3 })
  assert.equal(neg.limit, 1, `limit=-3 应夹到 1,实际 ${neg.limit}`)
  // 大值夹到 50
  const big = await listArtifacts({ stateRoot, cwd, limit: 9999 })
  assert.equal(big.limit, 50, `limit=9999 应夹到 50,实际 ${big.limit}`)
  // 友好情况:undefined 走默认
  const ok = await listArtifacts({ stateRoot, cwd })
  assert.equal(ok.offset, 0, `undefined offset 应回填 0`)
  assert.equal(ok.limit, 20, `undefined limit 应回填默认 20`)
  console.log('23) invalid offset/limit/search OK')
}

// 24) search + paging:在 >50 条里用 search 找到"旧"的精确产物
{
  const bigRoot = mkdtempSync(join(tmpdir(), 'gotry-458-bigsearch-root-'))
  const bigCwd = mkdtempSync(join(tmpdir(), 'gotry-458-bigsearch-'))
  try {
    const { utimesSync } = await import('node:fs')
    for (let i = 0; i < 60; i++) {
      const name = `note-${String(i).padStart(3, '0')}.md`
      const p = join(bigCwd, name)
      writeFileSync(p, `# ${name}\n`)
      utimesSync(p, new Date(Date.UTC(2026, 0, 1, 0, 0, i)), new Date(Date.UTC(2026, 0, 1, 0, 0, i)))
    }
    // 极小 mtime 的目标条目(模拟"老产物")
    const targetPath = join(bigCwd, 'special-deliverable.md')
    writeFileSync(targetPath, '# special\n')
    utimesSync(targetPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))

    // 不带 search:即便用 limit=50 也找不到极老的产物(默认按 mtime DESC 排序)
    const noSearch = await listArtifacts({ stateRoot: bigRoot, cwd: bigCwd, limit: 50 })
    assert.equal(noSearch.total, 61, `61 条总数,实际 ${noSearch.total}`)
    assert.ok(!noSearch.artifacts.some(a => a.id === 'special-deliverable.md'), '无 search 时老产物应在 50 之外')
    assert.equal(noSearch.truncated, true, '60 条之外还有老产物时 truncated 应 true')

    // 带 search:即使 limit=1 也能直接定位
    const direct = await listArtifacts({ stateRoot: bigRoot, cwd: bigCwd, search: 'special-deliverable', limit: 1 })
    assert.equal(direct.total, 1, `search 命中 1,实际 ${direct.total}`)
    assert.equal(direct.artifacts[0]?.id, 'special-deliverable.md')
    assert.equal(direct.truncated, false, `1 条命中无下一页`)

    // search + 翻页:filter 后 total 反映 filtered 集
    const pageFilter = await listArtifacts({ stateRoot: bigRoot, cwd: bigCwd, search: 'note', limit: 20 })
    assert.equal(pageFilter.total, 60, `search='note' 应命中 60 条 note-*,实际 ${pageFilter.total}`)
    assert.equal(pageFilter.artifacts.length, 20)
    assert.equal(pageFilter.nextOffset, 20, `filter 后 60 条 / limit 20 → nextOffset 20`)
    const page2 = await listArtifacts({ stateRoot, cwd: bigCwd, search: 'note', limit: 20, offset: 20 })
    assert.equal(page2.total, 60)
    assert.equal(page2.artifacts.length, 20)
    assert.equal(page2.nextOffset, 40, `page2 nextOffset 应 40`)
    // 两页拼起来应不重复
    const seen = new Set<string>()
    for (const a of [...pageFilter.artifacts, ...page2.artifacts]) seen.add(a.path)
    assert.equal(seen.size, 40, `两页拼起来 40 个唯一 path,实际 ${seen.size}`)
    console.log('24) search + paging across >50 OK')
  } finally {
    rmSync(bigCwd, { recursive: true, force: true })
    rmSync(bigRoot, { recursive: true, force: true })
  }
}

// 25) existing read-by-id/path 边界在新分页表面下不回归
{
  // a) 已存在的裸 id 直接读
  const r = await readArtifact({ stateRoot, cwd, path: 'cap-probe-1' })
  assert.equal(r.ok, true, '裸工单 id 仍可读')
  if (r.ok) assert.equal(r.lang, 'markdown')

  // b) 分页结果里某条 path 仍可直接用 readArtifact 读回 — 必须用已知小
  //    fixture(trip-2027-cap.md),不能选首条 cwd 项:先前测试(10/17a/24)可能
  //    在 cwd 留下 big.md(>2MB)被 reader 拒,需要隔离 / 显式选择。
  writeFileSync(join(cwd, 'paging-target.md'), '# paging target\nbody\n')
  const list = await listArtifacts({ stateRoot, cwd, limit: 50 })
  const target = list.artifacts.find(a => a.id === 'paging-target.md')
  assert.ok(target, '列表里应有 paging-target.md 已知小 fixture')
  const read = await readArtifact({ stateRoot, cwd, path: target!.path })
  assert.equal(read.ok, true, 'list 返回的 path 应可读回')
  if (read.ok) assert.equal(read.lang, 'markdown')
  rmSync(join(cwd, 'paging-target.md'))

  // c) 越界路径仍被拒
  const out = await readArtifact({ stateRoot, cwd, path: '../../../../../etc/passwd' })
  assert.equal(out.ok, false, '越界仍必须被拒')

  // d) symlink 越界仍被拒
  const linkPath = join(cwd, 'symlink-page-out.md')
  try {
    symlinkSync('/etc/passwd', linkPath)
    const r2 = await readArtifact({ stateRoot, cwd, path: 'symlink-page-out.md' })
    assert.equal(r2.ok, false, 'symlink 逃逸仍被拒')
  } catch { /* 非 POSIX fs 跳过 */ }

  // e) node_modules 内既不可发现也不可读
  mkdirSync(join(cwd, 'node_modules'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules', 'page-evil.md'), '# evil')
  const denied = await readArtifact({ stateRoot, cwd, path: 'node_modules/page-evil.md' })
  assert.equal(denied.ok, false, 'node_modules 内文件仍被拒')
  const list2 = await listArtifacts({ stateRoot, cwd, limit: 50 })
  assert.ok(!list2.artifacts.some(a => a.id === 'page-evil.md'), 'node_modules 内文件不进入列表')
  rmSync(join(cwd, 'node_modules'), { recursive: true, force: true })

  // f) 不支持的扩展名仍被拒
  writeFileSync(join(cwd, 'binary.db'), 'fake')
  const bad = await readArtifact({ stateRoot, cwd, path: 'binary.db' })
  assert.equal(bad.ok, false, '.db 仍被拒')
  rmSync(join(cwd, 'binary.db'))
  console.log('25) read boundary 与分页表面兼容 OK')
}

rmSync(stateRoot, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log('all artifacts capability tests OK')
