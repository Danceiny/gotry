/** Native Web entry registration, without a model invocation or additional UI shell. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const registrations: any[] = [], slots: any[] = [], tabs: any[] = []
const source = readFileSync(join(import.meta.dirname, '../../client/client.js'), 'utf8')
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (r: unknown) => registrations.push(r) } }, console, fetch, AbortController })
const react = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  useState: (value: unknown) => [value, () => {}], useRef: (value: unknown) => ({ current: value }), useEffect: () => {} }
const primitives = { SettingsForm: () => {}, SettingsSecretField: () => {}, Button: () => {}, Input: () => {}, Tag: () => {}, FileTypeIcon: () => {} }
const plugin = registrations[0].factory((name: string) => name === 'react' ? react : primitives)
const context: any = {
  locale: { bind: () => (key: string) => key, register: () => () => {} },
  slots: { inject: (_name: string, f: () => void) => f(), register: (definition: unknown, component: unknown) => { slots.push({ definition, component }); return () => {} } },
  sidebarRightTabs: { register: (definition: unknown) => { tabs.push(definition); return () => {} } },
  effect: (f: () => unknown) => f(),
  inject: (names: string[], f: (ctx: unknown) => void) => { if (names.every(name => name in context)) f(context) },
}
plugin.apply(context)
assert.ok(slots.some(s => s.definition.name === 'plugins.item' && s.definition.id === 'gotry'), 'Plugins must contain a directly visible GoTry configuration entry')
const settings = slots.find(s => s.definition.name === 'plugins.item' && s.definition.id === 'gotry')
const nodes: any[] = []
function visit(node: any): void {
  if (!node || typeof node !== 'object') return
  nodes.push(node)
  if (typeof node.type === 'function') visit(node.type(node.props))
  for (const child of node.children ?? []) visit(child)
}
visit(settings.component({ t: (key: string) => key }))
assert.ok(nodes.some(n => n.props?.['data-gotry-flyai-settings'] === ''), 'existing FlyAI configuration remains available')
assert.ok(nodes.some(n => n.props?.['data-gotry-hbcli-settings'] === ''), 'HotelByte configuration must be visible in the same page')
for (const id of ['gotry-flyai-key', 'gotry-hbcli-key', 'gotry-hbcli-secret']) {
  assert.ok(nodes.some(n => n.type === primitives.SettingsSecretField && n.props?.id === id && n.props?.text === ''), `${id} must use an empty confidential field`)
}
assert.ok(nodes.some(n => n.type === 'a' && n.props?.href === 'https://hotelbyte.com/zh/guides/sandbox-verification'))
assert.ok(tabs.some(t => t.kind === 'gotry-artifacts' && t.guide?.length), 'right Sidebar must contain an always discoverable GoTry artifacts page')
assert.ok(slots.some(s => s.definition.name === 'sidebar.right.pane.tab' && s.definition.key === '@danceiny/gotry:artifacts'))
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'))
for (const dependency of ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-plugin-manager', '@deepseek-ai/dsh-client-ui-sidebar-right']) {
  assert.ok(pkg.dsh.client.inject.includes(dependency), `the shipped client graph must include ${dependency}`)
}
console.log('GoTry native Plugins and artifact Sidebar entries PASS')
