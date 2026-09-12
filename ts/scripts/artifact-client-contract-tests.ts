/**
 * Public Client contract: package export, lazy-CJS loader shape, keyed DSH
 * registrations, and defensive rendering from the runtime `block` payload.
 * Browser execution is covered separately by dsh-artifact-web-e2e.ts.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import vm from 'node:vm'

const ROOT = join(import.meta.dirname, '..', '..')
const source = readFileSync(join(ROOT, 'client/client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, any>
assert.equal(pkg.exports?.['./client'], './client/client.js')
assert.equal(pkg.dsh?.client?.platform, 'web')
assert.ok(pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-tool'))
assert.ok(pkg.files?.includes('client/'))
assert.ok(source.includes('window.__ModuleLoader__.load'))
assert.ok(source.includes("tool.call.toolview"))
assert.ok(source.includes("gotry_artifacts_list"))
assert.ok(source.includes("gotry_artifacts_read"))
assert.ok(!source.includes('@deepseek-ai/dsh-client-ui-tool/lib/'))

const registrations: Array<{ id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> }> = []
const context = vm.createContext({
  window: { __ModuleLoader__: { load: (registration: any) => registrations.push(registration) } },
  console,
})
new vm.Script(source, { filename: 'client/client.js' }).runInContext(context)
assert.equal(registrations.length, 1)
assert.equal(registrations[0].id, '@danceiny/gotry')

function createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
  return { type, props: props ?? {}, children }
}
const fakeReact = {
  createElement,
  useState<T>(initial: T) { return [initial, () => {}] as const },
}
const clientExports = registrations[0].factory(name => {
  assert.equal(name, 'react')
  return fakeReact
})
assert.deepEqual(Object.keys(clientExports), ['apply', 'inject'])

const slotRegistrations: Array<{ key?: string; view: unknown }> = []
const registrationContext = {
  inject(_deps: string[], callback: (scope: any) => void) { callback(registrationContext) },
  slots: {
    inject(_slot: string, callback: () => unknown) { callback() },
    register(definition: { key?: string }, view: unknown) {
      slotRegistrations.push({ key: definition.key, view })
      return () => {}
    },
  },
}
;(clientExports.apply as (ctx: typeof registrationContext) => void)(registrationContext)
assert.deepEqual(slotRegistrations.map(item => item.key), ['gotry_artifacts_list', 'gotry_artifacts_read'])
assert.equal(slotRegistrations[0].view, slotRegistrations[1].view)

const view = slotRegistrations[0].view as (props: Record<string, unknown>) => any
const listTree = view({
  toolName: 'gotry_artifacts_list',
  block: { kind: 'tool-result', isError: false, meta: { shape: 'paths', paths: ['/tmp/trip-2027.md'], total: 1, truncated: false }, content: [] },
})
assert.equal(listTree.props['data-gotry-artifact-card'], 'list')
assert.equal(listTree.props['data-gotry-artifact-state'], 'ok')
const malformedTree = view({ toolName: 'gotry_artifacts_read', block: { kind: 'tool-result', isError: false, meta: { shape: 'bad' }, content: [{ type: 'text', text: 'raw fallback' }] } })
assert.equal(malformedTree.props['data-gotry-artifact-card'], 'read')
assert.equal(malformedTree.props['data-gotry-artifact-state'], 'ok')

const requireRoot = createRequire(join(ROOT, 'package.json'))
assert.ok(requireRoot.resolve('./client/client.js'))

// issue #441: an HTML artifact is previewed as source text only. The client half
// must not gain a raw-HTML injection API or an embedded browsing context.
for (const banned of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc', 'iframe', 'document.write', 'eval(']) {
  assert.ok(!source.includes(banned), `client bundle must not use ${banned}`)
}

const textNodes: string[] = []
const elementTypes: unknown[] = []
const forbiddenProps: string[] = []
function walkTree(node: unknown): void {
  if (typeof node === 'string') { textNodes.push(node); return }
  if (Array.isArray(node)) { for (const child of node) walkTree(child); return }
  const item = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] } | null
  if (!item || typeof item !== 'object') return
  elementTypes.push(item.type)
  for (const key of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'srcdoc']) {
    if (key in (item.props ?? {})) forbiddenProps.push(key)
  }
  for (const child of item.children ?? []) walkTree(child)
}

const hostileLines = [
  '<script>globalThis.__gotry441Pwned = true</script>',
  '<img src=x onerror="globalThis.__gotry441Pwned = true">',
  '<iframe src="https://example.invalid/track"></iframe>',
  '<a href="javascript:globalThis.__gotry441Pwned=true">点击</a>',
]
const hostileTree = view({
  toolName: 'gotry_artifacts_read',
  block: {
    kind: 'tool-result',
    isError: false,
    meta: {
      path: '/tmp/trip-2027.html', offset: 1, totalLines: hostileLines.length, lang: 'html',
      source: 'cwd', version: 'a1b2c3d4e5f6',
      lines: hostileLines.map((text, index) => ({ number: index + 1, text })),
    },
    content: [],
  },
})
assert.equal(hostileTree.props['data-gotry-artifact-card'], 'read')
assert.equal(hostileTree.props['data-gotry-artifact-state'], 'ok')
walkTree(hostileTree)
assert.deepEqual(forbiddenProps, [], `预览树不得出现 raw HTML 注入 props,实际 ${forbiddenProps.join(',')}`)
assert.ok(!elementTypes.includes('iframe'), '预览树不得创建 iframe')
for (const line of hostileLines) {
  assert.ok(textNodes.includes(line), `HTML 源码行必须以文本节点原样呈现:${line}`)
}
function collect(node: unknown, out: Array<{ type?: unknown; props: Record<string, unknown>; children: unknown[] }> = []) {
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out }
  const item = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] } | null
  if (!item || typeof item !== 'object') return out
  out.push({ type: item.type, props: item.props ?? {}, children: item.children ?? [] })
  for (const child of item.children ?? []) collect(child, out)
  return out
}
function textsOf(node: { children: unknown[] }): string[] {
  const out: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { out.push(value); return }
    if (Array.isArray(value)) { for (const child of value) visit(child); return }
    const item = value as { children?: unknown[] } | null
    if (!item || typeof item !== 'object') return
    for (const child of item.children ?? []) visit(child)
  }
  visit(node.children)
  return out
}

// HTML list entries are opened through the host's native HTML preview, which is a
// different action from reading source text: it must be labelled and explained.
const mixedTree = view({
  toolName: 'gotry_artifacts_list',
  block: {
    kind: 'tool-result', isError: false,
    meta: { shape: 'paths', paths: ['/tmp/trip-2027.md', '/tmp/trip-2027.html', '/tmp/Trip-2027.HTM'], total: 3, truncated: false },
    content: [],
  },
})
const buttons = collect(mixedTree).filter(node => node.type === 'button')
assert.equal(buttons.length, 3, `3 条路径应有 3 个按钮,实际 ${buttons.length}`)
const mdButton = buttons.find(node => node.props['data-gotry-artifact-path'] === '/tmp/trip-2027.md')
const htmlButtons = buttons.filter(node => String(node.props['data-gotry-artifact-path']).toLowerCase().endsWith('.htm') ||
  String(node.props['data-gotry-artifact-path']).toLowerCase().endsWith('.html'))
assert.equal(htmlButtons.length, 2, `.html 与 .HTM 都应识别为 HTML 预览,实际 ${htmlButtons.length}`)
assert.equal(mdButton?.props['data-gotry-artifact-open'], 'artifact', 'markdown 打开动作保持原文')
assert.equal(mdButton?.props['aria-label'], 'Open artifact /tmp/trip-2027.md', 'markdown 可访问标签不变')
assert.equal(mdButton?.props.title, undefined, 'markdown 不新增提示(行为不变)')
assert.ok(!textsOf(mdButton!).includes('HTML 预览'), 'markdown 条目不显示 HTML 预览徽标')
for (const button of htmlButtons) {
  const path = String(button.props['data-gotry-artifact-path'])
  assert.equal(button.props['data-gotry-artifact-open'], 'html-preview', `HTML 条目应标记为原生预览动作:${path}`)
  assert.equal(button.props['aria-label'], `Open HTML preview ${path}`, `HTML 条目可访问标签应显式声明 HTML 预览:${path}`)
  const title = String(button.props.title ?? '')
  assert.ok(title.includes('脚本') && title.includes('可能'), `提示应说明脚本可能运行:${title}`)
  assert.ok(!/sandbox|renderer|iframe|宿主|DSH|dsh/i.test(title), `提示不得使用基础设施术语:${title}`)
  assert.ok(textsOf(button).includes('HTML 预览'), `HTML 条目应有可见的 HTML 预览指示:${path}`)
}

// Source read card: HTML is identified as source text, still plain text nodes.
const htmlSourceTree = view({
  toolName: 'gotry_artifacts_read',
  block: {
    kind: 'tool-result', isError: false,
    meta: {
      path: '/tmp/trip-2027.html', offset: 1, totalLines: hostileLines.length, lang: 'html',
      source: 'cwd', version: 'a1b2c3d4e5f6',
      lines: hostileLines.map((text, index) => ({ number: index + 1, text })),
    },
    content: [],
  },
})
assert.equal(htmlSourceTree.props['data-gotry-artifact-source'], 'html', 'HTML 读卡应显式标注源码来源')
assert.ok(textsOf(htmlSourceTree).includes('HTML 源码预览（只读文本）'), 'HTML 读卡标题应明确是源码文本')
const htmlSourceNodes = collect(htmlSourceTree)
assert.ok(!htmlSourceNodes.some(node => 'dangerouslySetInnerHTML' in node.props || 'innerHTML' in node.props), 'HTML 读卡不得注入原始 HTML')
assert.ok(htmlSourceNodes.every(node => node.type !== 'iframe'), 'HTML 读卡不得内嵌浏览上下文')
for (const line of hostileLines) {
  assert.ok(textsOf({ children: [htmlSourceTree] }).includes(line), `HTML 读卡仍以文本节点逐字呈现:${line}`)
}

const mdSourceTree = view({
  toolName: 'gotry_artifacts_read',
  block: {
    kind: 'tool-result', isError: false,
    meta: { path: '/tmp/trip-2027.md', offset: 1, totalLines: 1, lang: 'markdown', source: 'cwd', version: 'f6e5d4c3b2a1', lines: [{ number: 1, text: '# 行程' }] },
    content: [],
  },
})
assert.equal(mdSourceTree.props['data-gotry-artifact-source'], undefined, 'markdown 读卡不得被标注为 HTML 源码')
assert.ok(textsOf(mdSourceTree).includes('产物预览'), 'markdown 读卡标题保持原样')

console.log('ARTIFACT CLIENT CONTRACT: package export + web manifest + lazy loader + 2 keyed views + malformed fallback + HTML source-as-text + explicit HTML preview action OK')
