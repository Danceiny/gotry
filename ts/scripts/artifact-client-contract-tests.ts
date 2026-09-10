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
console.log('ARTIFACT CLIENT CONTRACT: package export + web manifest + lazy loader + 2 keyed views + malformed fallback OK')
