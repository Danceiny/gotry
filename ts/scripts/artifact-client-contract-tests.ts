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
console.log('ARTIFACT CLIENT CONTRACT: package export + web manifest + lazy loader + 2 keyed views + malformed fallback + HTML source-as-text OK')
