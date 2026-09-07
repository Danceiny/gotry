/**
 * dsh-map-tools browser half: the 设置 → 插件 configuration card.
 *
 * Hand-written lazy-CJS bundle (window.__ModuleLoader__.load), zero build
 * step, zero imports from dsh client packages beyond react + ui-primitives —
 * the same stance as the modlens client half. Data flows through the host
 * loopback route /dsh-map-tools/config, never through the DSH settings
 * document: keys are stored in ~/.dsh-map-tools/config.json and never echoed
 * back to the card (only hasAmapKey boolean).
 */
window.__ModuleLoader__.load({
  id: 'dsh-map-tools',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Whether the host route is mounted (a 404 or network failure = absent). */
    function hostRoutePresent() {
      return fetch('/dsh-map-tools/config').then((response) => {
        if (response.status === 404) return false
        return response.ok || response.status === 405 || response.status === 200
      }).catch(() => false)
    }

    function registerCard(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], (scope) => {
        hostRoutePresent().then((present) => {
          if (!present) return
          try {
            mountCard(scope)
          } catch (error) {
            console.error(`[dsh-map-tools] settings card skipped: ${error}`)
          }
        })
      })
    }

    function mountCard(ctx) {
      var react
      try {
        react = require('react')
      } catch (error) {
        console.error(`[dsh-map-tools] settings card skipped: ${error}`)
        return
      }
      var ui = require('@deepseek-ai/dsh-client-ui-primitives')
      var Card = ConfigCard(react, ui)
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({ name: 'settings.plugin.item', id: 'map-tools', key: 'dsh-map-tools', order: 25 }, Card)
      })
    }

    function ConfigCard(react, ui) {
      var h = react.createElement
      var Input = ui.Input
      var AMAP_URL = 'https://console.amap.com/dev/key/app'
      var PROVIDERS = [
        { id: 'amap', label: '高德地图（推荐）' },
        { id: 'osm', label: '免费 OSM（无需 key，能力有限）' },
      ]

      function maskProps() {
        // Hidden characters without being a password field: keeps the key out
        // of Safari's keychain offer (same trade the modlens card makes).
        var p = { autoComplete: 'off' }
        if (typeof CSS !== 'undefined' && 'textSecurity' in document.documentElement.style) {
          p.style = { textSecurity: 'disc', WebkitTextSecurity: 'disc' }
        } else {
          p.type = 'password'
        }
        return p
      }

      function Chevron(open) {
        return h('svg', {
          width: 16, height: 16, viewBox: '0 0 16 16',
          style: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', flex: 'none', transition: 'transform .16s', transform: open ? 'rotate(180deg)' : 'none' },
        }, h('path', { d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
      }

      function ApplyLink(url, text) {
        return h('a', { href: url, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-accent, #4f8cff)', fontSize: '12px', textDecoration: 'none' } }, text)
      }

      return function MapToolsCard() {
        var openState = react.useState(false)
        var summaryState = react.useState(null)
        var draftState = react.useState(null)
        var noteState = react.useState('')
        var savingState = react.useState(false)
        var open = openState[0]
        var summary = summaryState[0]
        var draft = draftState[0]
        var note = noteState[0]
        var saving = savingState[0]

        var load = react.useCallback(() => {
          fetch('/dsh-map-tools/config').then((r) => r.json()).then((data) => {
            summaryState[1](data)
            draftState[1]({
              provider: data.provider || 'amap',
              amapKey: '',
              timeoutMs: data.timeoutMs || 15000,
            })
          }).catch(() => {})
        }, [])

        react.useEffect(() => {
          // Load the summary on mount (not only on expand) so the collapsed
          // header shows the provider status immediately instead of "加载中…".
          if (summary === null) load()
        }, [summary, load])

        var save = function () {
          if (!draft) return
          savingState[1](true)
          var payload = {}
          if (draft.provider !== summary.provider) payload.provider = draft.provider
          if (draft.amapKey !== '') payload.amapKey = draft.amapKey
          if (draft.timeoutMs && draft.timeoutMs !== summary.timeoutMs) payload.timeoutMs = draft.timeoutMs
          fetch('/dsh-map-tools/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).then((r) => r.json()).then((data) => {
            summaryState[1](data)
            noteState[1]('已保存 — 工具已重建，直接可用')
            savingState[1](false)
          }).catch((error) => {
            noteState[1](`保存失败：${String(error?.message ?? error)}`)
            savingState[1](false)
          })
        }

        var discard = function () {
          draftState[1](null)
          noteState[1]('')
          summaryState[1](null)
        }

        var cardStyle = {
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          borderRadius: '12px',
          marginBottom: '8px', overflow: 'hidden',
          transition: 'border-color .16s, background .16s',
        }
        var rowStyle = { padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '12px' }
        var fieldStyle = { display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px 14px 10px' }
        var labelStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' }

        return h('div', { style: Object.assign({}, cardStyle, {
          background: open ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))' : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
        }) },
          h('button', {
            type: 'button',
            'aria-expanded': open,
            style: { ...rowStyle, width: '100%', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', textAlign: 'left' },
            onClick: function () { openState[1](!open) },
          },
            h('div', { style: { flex: '1', minWidth: '0' } },
              h('div', { style: { fontSize: '14px', fontWeight: 600 } }, '地图引擎 (dsh-map-tools)'),
              h('div', { style: { fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } }, '地图定位与路径规划：驾车/公交/步行/骑行路线、地理编码、POI 搜索'),
            ),
            h('span', { style: { flex: 'none', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } },
              summary ? (summary.provider ? (summary.provider === 'amap' ? '高德' : 'OSM') : '未配置') + (summary.hasAmapKey ? ' ✓' : '') : ''),
            Chevron(open),
          ),
          open && h('div', {},
            h('div', { style: { padding: '0 14px 10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' } },
              '地图定位与路径规划：驾车/公交/步行/骑行路线、地理编码、POI 搜索。配置数据存于 ~/.dsh-map-tools/config.json。'),
            h('div', { style: fieldStyle },
              h('span', { style: labelStyle }, '数据源'),
              h('select', {
                value: draft ? draft.provider : 'amap',
                onChange: function (e) { draftState[1]({ ...(draft || {}), provider: e.target.value }) },
                style: { padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.25))', background: 'var(--dsw-alias-bg-elevated, #262626)', color: 'inherit' },
              }, PROVIDERS.map(function (p) { return h('option', { key: p.id, value: p.id }, p.label) })),
            ),
            h('div', { style: fieldStyle },
              h('span', { style: labelStyle }, '高德 key（Web 服务） — ', ApplyLink(AMAP_URL, '如何获取高德 Key？')),
              h(Input, {
                ...maskProps(),
                placeholder: summary && summary.hasAmapKey ? '已配置（留空保持不变）' : 'amapKey',
                value: draft ? draft.amapKey : '',
                onChange: function (e) { draftState[1]({ ...(draft || {}), amapKey: e.target.value }) },
              }),
            ),
            h('div', { style: fieldStyle },
              h('span', { style: labelStyle }, '超时（毫秒）'),
              h(Input, {
                inputMode: 'numeric',
                value: draft ? String(draft.timeoutMs) : '15000',
                onChange: function (e) { draftState[1]({ ...(draft || {}), timeoutMs: Number(e.target.value) || 15000 }) },
              }),
            ),
            note && h('div', { style: { padding: '0 14px 8px', fontSize: '12px', color: note.indexOf('失败') >= 0 ? '#e05c5c' : 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' } }, note),
            h('div', { style: { ...rowStyle, justifyContent: 'flex-end', borderTop: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.2))' } },
              h('button', { type: 'button', onClick: discard, disabled: saving, style: { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))', fontSize: '13px' } }, '放弃'),
              h('button', { type: 'button', onClick: save, disabled: saving || !draft, style: { background: 'var(--dsw-alias-accent, #4f8cff)', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 14px', cursor: 'pointer', fontSize: '13px' } }, saving ? '保存中…' : '保存'),
            ),
          ),
        )
      }
    }

    function apply(ctx) {
      registerCard(ctx)
    }

    exports.apply = apply
    exports.inject = []
    exports.__card = { ConfigCard: ConfigCard }
    return module.exports
  },
})
