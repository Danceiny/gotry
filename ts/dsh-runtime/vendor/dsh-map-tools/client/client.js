/**
 * dsh-map-tools browser half: the bundle's own configuration card.
 *
 * Hand-written lazy-CJS bundle (`window.__ModuleLoader__.load`), no build step,
 * and no imports beyond React. Requiring a `@deepseek-ai/dsh-*` client package
 * would couple this card to a signature that may be absent from the running
 * harness's module table — the sibling dsh-jev-tools card takes the same stance,
 * and a `require` that throws at mount time takes the whole card down with it.
 *
 * **Where it renders.** `plugins.bundle.config`, the seat the sidebar 插件 page
 * declares for a bundle's own configuration. That page keys the seat by the
 * bundle's **package name**, draws the title, the package name, the description,
 * the crumb and the uninstall/switch controls itself, and asks the card only for
 * `view: 'page'` (verified against the running 0.1.6-alpha.2 harness:
 * `ui-plugin-manager` renders
 * `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`).
 * Harnesses older than 0.1.6-alpha.2 declare no such seat and dispatch the
 * settings page's `settings.plugin.item` list seat instead (`summary`, then
 * `page`); that is why the component still answers `summary`, and why both seats
 * are registered. `slots.inject` runs its factory only for a slot the running
 * host declares, so this is a capability probe, not a version check.
 *
 * **Where the data lives.** The host loopback route `/dsh-map-tools/config`,
 * never the DSH settings document. The key lives in
 * `~/.dsh-map-tools/config.json` (0600) and is never echoed back — the route
 * answers `hasAmapKey: boolean` and nothing else — so the input starts blank on
 * every load and a blank left untouched is never written.
 *
 * **How it saves.** Staged edits, one explicit save. Leaving the page discards
 * the draft (the component's state dies with it), so there is no 取消 control;
 * an invalid draft blocks the save instead of being silently repaired; only
 * changed fields ride the request; and after a save the form re-seeds from what
 * the host accepted, because the host is the only authority on whether a write
 * landed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-map-tools',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** The bundle's package name: the key the Plugins page dispatches this seat by. */
    var BUNDLE = 'dsh-map-tools'
    /** The Plugins page's seat for a bundle's own configuration (keyed by package name). */
    var BUNDLE_SEAT = 'plugins.bundle.config'
    /** Pre-0.1.6 seat: the settings page's plugin list (list kind, `key` = settings namespace). */
    var LEGACY_SEAT = 'settings.plugin.item'
    /** The host loopback route this card reads and writes. */
    var CONFIG_URL = '/dsh-map-tools/config'
    /** Where a user creates an Amap (高德) Web service key — mirrors src/config.ts. */
    var AMAP_URL = 'https://console.amap.com/dev/key/app'
    /** The composition schema's default timeout; the route omits the field while unset. */
    var DEFAULT_TIMEOUT_MS = 15000
    /** Accepted timeout range (ms): below it every upstream call aborts, above it a typo hides. */
    var TIMEOUT_MIN_MS = 100
    var TIMEOUT_MAX_MS = 600000
    var PROVIDERS = [
      { id: 'amap', label: '高德地图（推荐，公交/POI/中文地址都靠它）' },
      { id: 'osm', label: '免费 OSM（无需 key，能力有限）' },
    ]

    /**
     * The staged timeout as a number, or null while it is not a usable value.
     *
     * Nothing here coerces a bad draft into a default: silently rewriting `abc`
     * to 15000 would save a value the user never typed.
     *
     * @param text - the staged input text.
     * @returns milliseconds, or null when the text is not a value a save may write.
     */
    function parseTimeout(text) {
      var value = String(text === null || text === undefined ? '' : text).trim()
      if (!/^\d+$/.test(value)) return null
      var parsed = Number(value)
      if (parsed < TIMEOUT_MIN_MS || parsed > TIMEOUT_MAX_MS) return null
      return parsed
    }

    /**
     * The effective config as the form works with it: provider and timeout always
     * resolve, because the route omits a field the config file does not hold and
     * the schema default applies then.
     *
     * @param summary - the route's non-secret summary, or null while loading.
     * @returns the values the controls compare a draft against.
     */
    function effectiveConfig(summary) {
      var s = summary === null || summary === undefined ? {} : summary
      var timeout = parseTimeout(s.timeoutMs)
      return {
        provider: s.provider === 'osm' ? 'osm' : 'amap',
        hasAmapKey: s.hasAmapKey === true,
        timeoutMs: timeout === null ? DEFAULT_TIMEOUT_MS : timeout,
        configPath: typeof s.configPath === 'string' ? s.configPath : '',
      }
    }

    /**
     * The draft a freshly accepted config seeds. The key field is always blank —
     * the route cannot echo it, and a blank left alone is never written.
     *
     * @param summary - the summary the host just accepted.
     * @returns the staged draft.
     */
    function draftFrom(summary) {
      var config = effectiveConfig(summary)
      return { provider: config.provider, amapKey: '', timeoutMs: String(config.timeoutMs) }
    }

    /**
     * Whether the staged draft holds only values a save may write.
     *
     * @param draft - the staged draft.
     * @returns true when every field is usable.
     */
    function draftValid(draft) {
      if (draft === null || draft === undefined) return false
      if (draft.provider !== 'amap' && draft.provider !== 'osm') return false
      return parseTimeout(draft.timeoutMs) !== null
    }

    /**
     * The patch a save would send: only fields the user actually changed, never
     * an unusable one. An empty result means the save is a no-op, which keeps
     * saving idempotent — clicking twice writes once.
     *
     * @param draft - the staged draft.
     * @param summary - the config the host currently holds.
     * @returns the JSON body a save would post.
     */
    function configPatch(draft, summary) {
      var patch = {}
      if (draft === null || draft === undefined) return patch
      var config = effectiveConfig(summary)
      if (draft.provider !== config.provider) patch.provider = draft.provider
      if (draft.amapKey !== '') patch.amapKey = draft.amapKey
      var timeout = parseTimeout(draft.timeoutMs)
      if (timeout !== null && timeout !== config.timeoutMs) patch.timeoutMs = timeout
      return patch
    }

    /**
     * Whether the draft carries an edit the host does not already hold.
     *
     * @param draft - the staged draft.
     * @param summary - the config the host currently holds.
     * @returns true when a save would write something.
     */
    function isDirty(draft, summary) {
      return Object.keys(configPatch(draft, summary)).length > 0
    }

    /**
     * One line describing the current state: the page's status row, and the whole
     * one-liner the legacy list seat asks a card for.
     *
     * @param summary - the route's summary, or null while loading.
     * @returns the status text.
     */
    function statusLine(summary) {
      if (summary === null || summary === undefined) return '读取中…'
      var config = effectiveConfig(summary)
      if (config.provider === 'osm') return '免费 OSM · 无需 key（公交/POI/中文地址不可用）'
      return config.hasAmapKey ? '高德 · 已配置 key' : '高德 · 未配置 key（公交/POI/中文地址需先填 key）'
    }

    /**
     * Register the card into every configuration seat the running host declares.
     *
     * @param ctx - the client plugin context.
     */
    function registerCard(ctx) {
      if (!ctx || typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], function (scope) {
        if (!scope.slots || typeof scope.slots.inject !== 'function') return
        var react
        try {
          react = require('react')
        } catch (error) {
          console.error(`[dsh-map-tools] config card skipped: ${error}`)
          return
        }
        var Card = ConfigCard(react)
        registerOne(scope, Card, {
          // 0.1.6-alpha.2+: the bundle's page in the sidebar 插件 page, keyed by package name.
          seat: BUNDLE_SEAT,
          options: { name: BUNDLE_SEAT, key: BUNDLE },
        })
        registerOne(scope, Card, {
          // Older hosts: the settings page's plugin list. `id` is required there and
          // `key` is the settings namespace the host serves for this card.
          seat: LEGACY_SEAT,
          options: { name: LEGACY_SEAT, id: 'map-tools', key: BUNDLE, order: 25, label: '地图引擎 (dsh-map-tools)' },
        })
      })
    }

    /**
     * Register one seat, never letting a failure escape into the host.
     *
     * The guard sits **inside** the factory: `slots.inject` only stores the
     * factory and calls it later (synchronously when the slot is already declared,
     * otherwise once the declaration arrives), so a throw from the registration
     * would surface outside any try/catch wrapped around the `inject` call — the
     * failures this plugin's turn-tail registration already hit.
     *
     * @param scope - the client context carrying `slots`.
     * @param Card - the component to register.
     * @param seat - the slot name and its registration options.
     */
    function registerOne(scope, Card, seat) {
      try {
        scope.slots.inject(seat.seat, function () {
          try {
            return scope.slots.register(seat.options, Card)
          } catch (error) {
            console.error(`[dsh-map-tools] config card skipped on ${seat.seat}: ${error}`)
            return function () {}
          }
        })
      } catch (error) {
        console.error(`[dsh-map-tools] config card skipped on ${seat.seat}: ${error}`)
      }
    }

    /**
     * The bundle's configuration card.
     *
     * The owner draws the page's title, breadcrumb and uninstall control, so this
     * component draws only the configuration itself — in the vocabulary the
     * shipped settings surfaces use (label / control / hint and capsule buttons),
     * so a third-party page reads as the same product.
     *
     * @param react - the browser module table's React.
     * @returns the card component.
     */
    function ConfigCard(react) {
      var h = react.createElement

      // Every name below is defined by the running theme (`ui-theme`'s
      // design-platform.css, cross-checked against the live theme token table).
      // A name the theme does not define falls back silently and stops following
      // light/dark — which is exactly what `--dsw-alias-accent`,
      // `--dsw-alias-border` and `--dsw-alias-bg-elevated` did in this card's
      // previous version. Fallbacks stay as a last resort, not as the plan.
      var TEXT = 'var(--dsw-alias-label-primary, inherit)'
      var MUTED = 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))'
      var HINT = 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))'
      var BORDER = 'var(--dsw-alias-border-l4, rgba(127,127,127,0.3))'
      var SEPARATOR = '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))'
      var LINK = 'var(--dsw-alias-link, #4f8cff)'
      var ERROR = 'var(--dsw-alias-state-error-primary, #e05c5c)'
      var OK = 'var(--dsw-alias-state-success-primary, #22a06b)'
      var FIELD_BG = 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.08))'
      var PRIMARY_FILL = 'var(--dsw-alias-button-primary-fill, #4f8cff)'
      var PRIMARY_TEXT = 'var(--dsw-alias-label-primary-foreground, #fff)'

      var FIELD = { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0', borderTop: SEPARATOR }
      var FIRST_FIELD = { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' }
      var LABEL = { fontSize: '13px', fontWeight: 500, lineHeight: 1.5, color: TEXT }
      var CONTROL = { width: '100%', boxSizing: 'border-box', height: '34px', padding: '0 12px', border: '0.5px solid ' + BORDER, borderRadius: '8px', background: FIELD_BG, font: 'inherit', fontSize: '13px', lineHeight: 1.5, color: TEXT }
      var HINT_STYLE = { margin: 0, fontSize: '12px', lineHeight: 1.5, color: HINT }
      var CAPTION_STYLE = { margin: 0, fontSize: '12px', lineHeight: 1.5, color: MUTED }
      /** The Amap application link sits on its own line: a key is the one thing a
       *  first-time user must go elsewhere to get, so it may not hide in a label row. */
      var LINK_LINE = { margin: 0, fontSize: '13px', lineHeight: 1.5 }
      var BUTTON = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '28px', padding: '0 12px', borderRadius: '14px', border: '0.5px solid ' + BORDER, background: 'transparent', font: 'inherit', fontSize: '12px', lineHeight: '18px', color: TEXT, cursor: 'pointer' }
      var PRIMARY_BUTTON = Object.assign({}, BUTTON, { border: 'none', background: PRIMARY_FILL, color: PRIMARY_TEXT })
      var DISABLED = { opacity: 0.4, cursor: 'not-allowed' }

      /** A label/value line (the status row, in the shape the shipped cards use). */
      function row(label, value, valueStyle) {
        return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '12px', lineHeight: '18px' } },
          h('span', { style: { flex: 'none', minWidth: '56px', color: MUTED } }, label),
          h('span', { style: Object.assign({ minWidth: 0, color: TEXT }, valueStyle || {}) }, value))
      }

      /**
       * A link in the theme's link color.
       *
       * `--dsw-alias-link` (`deepseek-500` light / `deepseek-400` dark) is the token
       * the design system keeps for clickable text, and the one Markdown links use
       * in the shipped UI. The previous version reached for
       * `--dsw-alias-brand-primary`, which is a *neutral* near-black (light) /
       * near-white (dark) — i.e. the same color as body text, which is why the
       * Amap application link was invisible on the card.
       */
      function link(href, text) {
        return h('a', { href: href, target: '_blank', rel: 'noreferrer', style: { color: LINK, fontSize: '13px', lineHeight: 1.5, textDecoration: 'none' } }, text)
      }

      /** A capsule button; `primary` fills it, `disabled` dims it. */
      function button(label, onClick, options) {
        var opts = options || {}
        return h('button', {
          type: 'button',
          onClick: onClick,
          disabled: opts.disabled === true,
          style: Object.assign({}, opts.primary === true ? PRIMARY_BUTTON : BUTTON, opts.disabled === true ? DISABLED : {}),
        }, label)
      }

      /**
       * Hide characters without turning the field into a password field, so the
       * browser's password manager does not offer to store the key as a
       * credential. `type="password"` is the fallback where `text-security` is
       * unsupported; `autoComplete: 'off'` applies either way.
       *
       * @returns the extra style, or null when the standard password type must be used.
       */
      function maskStyle() {
        if (typeof CSS !== 'undefined' && 'textSecurity' in document.documentElement.style) {
          // Both spellings: browsers expose the property as `textSecurity` or
          // `WebkitTextSecurity` depending on the engine.
          return { textSecurity: 'disc', WebkitTextSecurity: 'disc' }
        }
        return null
      }

      /** A thrown value as note text. */
      function describe(error) {
        var message = error !== null && error !== undefined && error.message !== undefined ? error.message : error
        return String(message)
      }

      /**
       * The card.
       *
       * @param props - the owner's props: `view: 'summary'` asks for the one-liner
       *   alone (the legacy list seat does), `view: 'page'` for the form with its
       *   own save control (the bundle seat only ever asks for this one).
       * @returns the card.
       */
      return function MapToolsBundleCard(props) {
        var view = props !== null && props !== undefined && props.view === 'summary' ? 'summary' : 'page'
        var stateHook = react.useState({ status: 'loading', config: null, draft: null, note: '', tone: 'plain', saving: false })
        var state = stateHook[0]
        var setState = stateHook[1]
        var merge = react.useCallback(function (next) {
          setState(function (previous) { return Object.assign({}, previous, next) })
        }, [])

        /** Read the summary again; every load re-seeds the draft from the host. */
        var load = react.useCallback(function () {
          return fetch(CONFIG_URL, { headers: { accept: 'application/json' } })
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              return response.json()
            })
            .then(function (data) {
              setState({ status: 'ready', config: data, draft: draftFrom(data), note: '', tone: 'plain', saving: false })
            })
            .catch(function (error) {
              // The route is the only way in. With it missing, controls would take
              // input nothing could accept, so the form is replaced by a line that
              // says why rather than by fields that cannot save.
              setState({ status: 'unavailable', config: null, draft: null, note: describe(error), tone: 'error', saving: false })
            })
        }, [])

        react.useEffect(function () { void load() }, [load])

        /** Write the staged patch, then re-seed from what the host accepted. */
        var save = function () {
          if (state.config === null || !draftValid(state.draft)) return
          var body = configPatch(state.draft, state.config)
          if (Object.keys(body).length === 0) {
            // Nothing changed: saving stays idempotent instead of writing again.
            merge({ note: '没有需要保存的改动', tone: 'plain' })
            return
          }
          merge({ saving: true, note: '', tone: 'plain' })
          fetch(CONFIG_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
            .then(function (response) {
              return response.json().catch(function () { return {} }).then(function (data) {
                if (!response.ok) throw new Error(data && data.error ? String(data.error) : 'HTTP ' + response.status)
                return data
              })
            })
            .then(function (accepted) {
              // The host is the only authority on whether a write landed, so the
              // form re-seeds from its answer instead of promoting the draft; the
              // key input returns to blank because the key now lives in the file.
              var merged = Object.assign({}, state.config, accepted)
              setState({ status: 'ready', config: merged, draft: draftFrom(merged), note: '已保存 — 工具已重建，直接可用', tone: 'ok', saving: false })
            })
            .catch(function (error) {
              // Keep **every** staged edit: a failed save is fixed in place rather
              // than retyped, even the fields that may already have landed.
              merge({ saving: false, note: '保存失败：' + describe(error), tone: 'error' })
            })
        }

        /** Open the config file in the OS editor (the route's `?open=true`). */
        var openFile = function () {
          fetch(CONFIG_URL + '?open=true', { headers: { accept: 'application/json' } })
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              return response.json()
            })
            .then(function (data) {
              merge({ config: Object.assign({}, state.config, data), note: '已在系统默认编辑器中打开配置文件', tone: 'plain' })
            })
            .catch(function (error) {
              merge({ note: '打开配置文件失败：' + describe(error), tone: 'error' })
            })
        }

        // The bundle seat's page never asks for `summary`; the legacy list seat
        // does, and renders this line as the card's one-liner under its title.
        if (view === 'summary') return h('span', { style: HINT_STYLE }, statusLine(state.config))

        if (state.status === 'loading') return h('p', { style: HINT_STYLE, role: 'status' }, '读取配置中…')

        if (state.status === 'unavailable') {
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('p', { style: Object.assign({}, HINT_STYLE, { color: ERROR }), role: 'status' },
              '宿主路由 ' + CONFIG_URL + ' 当前不可用，无法在这里保存配置'
              + (state.note === '' ? '' : '（' + state.note + '）') + '。'),
            h('p', { style: CAPTION_STYLE }, '插件宿主半未加载时会这样；可直接编辑 ~/.dsh-map-tools/config.json（0600）。'))
        }

        var config = state.config
        var draft = state.draft
        var invalid = !draftValid(draft)
        // 无改动可存、有非法值不可存、正在存不可重复提交——按钮状态就是这三条。
        var blocked = !isDirty(draft, config) || invalid || state.saving
        var noteColor = state.tone === 'error' ? ERROR : state.tone === 'ok' ? OK : HINT
        var timeoutHint = invalid
          ? '超时要是 ' + TIMEOUT_MIN_MS + '–' + TIMEOUT_MAX_MS + ' 之间的整数毫秒值；不合法时保存会被阻止，不会替你改写'
          : '单次上游请求的超时，默认 ' + DEFAULT_TIMEOUT_MS + ' 毫秒'
        var mask = maskStyle()
        var keyStyle = mask === null ? CONTROL : Object.assign({}, CONTROL, mask)

        return h('div', { style: { display: 'flex', flexDirection: 'column', paddingTop: '4px' } },
          h('div', { style: FIRST_FIELD },
            row('状态', statusLine(config), { color: config.provider === 'amap' && config.hasAmapKey ? OK : HINT }),
          ),
          h('div', { style: FIELD },
            h('label', { style: LABEL, htmlFor: 'dsh-map-tools-provider' }, '数据源'),
            h('select', {
              id: 'dsh-map-tools-provider',
              value: draft.provider,
              disabled: state.saving,
              onChange: function (event) { merge({ draft: Object.assign({}, draft, { provider: event.target.value }) }) },
              style: CONTROL,
            }, PROVIDERS.map(function (provider) { return h('option', { key: provider.id, value: provider.id }, provider.label) })),
            h('p', { style: CAPTION_STYLE }, '高德提供公交/POI/中文地址（需 key）；免费 OSM 只兜底驾车/步行/骑行路线，中文地址解析不可靠。'),
          ),
          h('div', { style: FIELD },
            h('label', { style: LABEL, htmlFor: 'dsh-map-tools-key' }, '高德 key（Web 服务）'),
            // 还没有 key 的人必须一眼看到"去哪拿"：一句引导 + 独立成行的链接。
            config.hasAmapKey ? null : h('p', { style: CAPTION_STYLE }, '还没有 key。到高德控制台创建一个「Web 服务」类型的 key（免费），再粘贴到下面。'),
            h('p', { style: LINK_LINE }, link(AMAP_URL, config.hasAmapKey ? '获取 / 更换高德 Key →' : '获取高德 Key →')),
            h('input', {
              id: 'dsh-map-tools-key',
              type: mask === null ? 'password' : 'text',
              autoComplete: 'off',
              value: draft.amapKey,
              placeholder: config.hasAmapKey ? '已配置（留空即保持不变）' : '粘贴高德 Web 服务 key',
              disabled: state.saving,
              onChange: function (event) { merge({ draft: Object.assign({}, draft, { amapKey: event.target.value }) }) },
              style: keyStyle,
            }),
            h('p', { style: CAPTION_STYLE }, 'key 只写进本机的 ' + (config.configPath || '~/.dsh-map-tools/config.json') + '，不回显、不进日志、不下发到页面。'),
          ),
          h('div', { style: FIELD },
            h('label', { style: LABEL, htmlFor: 'dsh-map-tools-timeout' }, '超时（毫秒）'),
            h('input', {
              id: 'dsh-map-tools-timeout',
              inputMode: 'numeric',
              value: draft.timeoutMs,
              disabled: state.saving,
              'aria-invalid': invalid ? 'true' : 'false',
              onChange: function (event) { merge({ draft: Object.assign({}, draft, { timeoutMs: event.target.value }) }) },
              style: invalid ? Object.assign({}, CONTROL, { borderColor: ERROR }) : CONTROL,
            }),
            h('p', { style: invalid ? Object.assign({}, HINT_STYLE, { color: ERROR }) : CAPTION_STYLE }, timeoutHint),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', paddingTop: '12px', borderTop: SEPARATOR } },
            button('打开配置文件', openFile, { disabled: state.saving }),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } },
              state.note === '' ? null : h('span', { role: 'status', style: { fontSize: '12px', lineHeight: 1.5, color: noteColor } }, state.note),
              button(state.saving ? '保存中…' : '保存', save, { primary: true, disabled: blocked }),
            ),
          ),
        )
      }
    }

    // ---- 路线卡片（方向 A / 第二档：自绘示意图，无底图、无外部网络） --------
    //
    // 数据来源：工具侧 output.presentationMeta 投影出的 tool/result.data.meta，
    // 客户端通过 block.meta 读到（内置 Web 客户端不消费 presentResult）。
    // 渲染入口：官方 keyed 槽位 tool.call.toolview，按线级工具名分派。
    // 认领 key 即接管该工具卡片的全部形态，所以运行中/成功/失败/无几何
    // 四种情况都在这里兜住。

    var ROUTE_TOOLS = {
      map_driving_route: { mode: 'car', label: '驾车' },
      map_transit_route: { mode: 'bus', label: '公交' },
      map_walking_route: { mode: 'walk', label: '步行' },
      map_bicycling_route: { mode: 'ride', label: '骑行' },
    }

    // 这一区的主题名同样必须**真实存在**：卡片底色 / 描边 / 链接色一度用的是
    // 宿主里根本没有的别名，于是三者全部静默落到硬编码 fallback，深浅色不跟随。
    // 配置卡那一份在 0.7.0 修过，这里是同一批名字的漏网。下面每个名字都对运行中的
    // ui-theme 令牌表逐个复核过（DeepSeek Harness Desktop 0.1.7-rc.2）。
    var TEXT = 'var(--dsw-alias-label-primary, inherit)'
    var CARD_BG = 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))'
    var CARD_BORDER = 'var(--dsw-alias-border-l2, rgba(127,127,127,0.2))'
    var MUTED = 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))'
    var ACCENT = 'var(--dsw-alias-link, #4f8cff)'
    var START_COLOR = '#22a06b'
    var END_COLOR = '#e05c5c'
    var MAP_BG = 'rgba(127,127,127,0.10)'
    /** 画布 viewBox 的单位宽度（只给自绘示意图用）。 */
    var MAP_W = 100
    /** viewBox 高度的宽松上下限（只挡病态输入，不做审美钳制）。 */
    var MAP_H_MIN = 8
    var MAP_H_MAX = 400
    /**
     * 真地图画框的显示比例（高 / 宽）区间。
     *
     * 真地图与自绘示意图的取舍不同：示意图的留白是"白框"，所以画框要贴着
     * 路线；真地图的留白是**真实地图内容**，画框给大一点，路线反而更清楚。
     * 所以这里把路线比例钳到 [0.42, 0.68]，画框宽度吃满卡片（用 CSS
     * aspectRatio），整条路线由高德按请求尺寸自适应装进来。
     *
     * 下限 0.42 是特意抬高的：真实路线常常又长又扁（20 公里城市路线的高/宽
     * 只有 0.3 左右），若按真实比例出图就是一条又矮又长的窄条，卡片里几乎
     * 看不出是张地图。抬高下限会让画框变高——**路线本身的像素尺寸不变**
     * （它受宽度限制），多出来的是上下两边的地图上下文。
     */
    var MAP_ASPECT_MIN = 0.42
    var MAP_ASPECT_MAX = 0.68
    /** 请求给高德的图片宽度（2x 出图，缩小显示更清晰）；高度按显示比例换算。 */
    var MAP_REQUEST_W = 1024
    var MAP_PAD = 7
    /** 底纹网格间距（px）——只有自绘兜底图用得到。 */
    var MAP_GRID_PX = 26
    /**
     * 静态地图 URL 的版本号：宿主给图片回的是 `max-age=86400`，浏览器会缓存
     * 一整天。修掉"有底图、没路线"那个 bug 后必须换一次 URL，否则用户看到的
     * 还是缓存里那张坏图。改动出图逻辑时把它 +1。
     */
    var MAP_URL_VERSION = 2
    /**
     * 回合尾部最多逐条渲染几条路线。模型一轮里可能发多条路线调用（主路线 +
     * 用于核对/备选的探测），每条都要有自己的地图才不会"张冠李戴"；但也不能
     * 无限堆，超过这个数就只显示前几条并注明总数。
     */
    var MAX_TURN_ROUTES = 3

    /** 运行中的调用没有 `kind` 字段；已结算的结果节点有。 */
    function isRunning(block) {
      return !(block && typeof block === 'object' && 'kind' in block)
    }

    /** 解析调用参数（原始 JSON 串），失败返回 null。 */
    function parseArgsRaw(raw) {
      if (typeof raw !== 'string' || raw === '') return null
      try {
        var parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
      } catch (error) {
        return null
      }
    }

    /** 解析调用参数（从 block 里取原始 JSON 串）。 */
    function parseArgs(block) {
      if (!block || typeof block !== 'object') return null
      return parseArgsRaw(isRunning(block) ? block.argsRaw : (block.call && block.call.argsRaw))
    }

    /** 参数派的摘要文本："北京南站 → 首都机场"。 */
    function summaryOf(fromText, toText) {
      var from = typeof fromText === 'string' ? fromText : ''
      var to = typeof toText === 'string' ? toText : ''
      var text = from && to ? from + ' → ' + to : from || to
      return text.length > 60 ? text.slice(0, 59) + '…' : text
    }

    /** 参数派的摘要文本（从 block 里取，未做地名反查时的兜底）。 */
    function callSummary(block) {
      var args = parseArgs(block)
      if (!args) return ''
      return summaryOf(args.origin, args.destination)
    }

    /** 已结算结果的文本内容（兜底卡片与错误态显示用）。 */
    function flattenContent(block) {
      if (!block || !Array.isArray(block.content)) return ''
      var parts = []
      for (var i = 0; i < block.content.length; i += 1) {
        var part = block.content[i]
        if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      }
      return parts.join('\n')
    }

    /** 失败原因的短文本。 */
    function errorText(block) {
      var text = flattenContent(block)
      if (text) return text
      if (block && block.error && typeof block.error === 'object') {
        var name = typeof block.error.name === 'string' ? block.error.name : ''
        var code = typeof block.error.code === 'string' ? block.error.code : ''
        if (name || code) return (name + (code ? ': ' + code : '')) || '调用失败'
      }
      return '调用失败'
    }

    /**
     * 窄化持久化的卡片元数据。历史日志、手工改过的日志都会到这里，
     * 任何不符预期都返回 null（由调用方退回文本卡片），不抛错。
     */
    function routeMeta(meta) {
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
      if (meta.kind !== 'route' || meta.v !== 1) return null
      var line = []
      if (Array.isArray(meta.line)) {
        for (var i = 0; i < meta.line.length; i += 1) {
          var point = meta.line[i]
          if (!Array.isArray(point) || point.length < 2) continue
          var lng = Number(point[0])
          var lat = Number(point[1])
          if (!isFinite(lng) || !isFinite(lat)) continue
          line.push([lng, lat])
        }
      }
      return {
        provider: meta.provider === 'osrm' ? 'OSRM' : '高德',
        distanceM: typeof meta.distanceM === 'number' && isFinite(meta.distanceM) ? meta.distanceM : 0,
        durationS: typeof meta.durationS === 'number' && isFinite(meta.durationS) ? meta.durationS : 0,
        stepCount: typeof meta.stepCount === 'number' && isFinite(meta.stepCount) ? meta.stepCount : 0,
        alternatives: typeof meta.alternatives === 'number' && isFinite(meta.alternatives) ? meta.alternatives : 0,
        // 起点/终点的可读名称（坐标入参时由宿主反查得到）。
        fromName: typeof meta.fromName === 'string' ? meta.fromName : '',
        toName: typeof meta.toName === 'string' ? meta.toName : '',
        line: line,
      }
    }

    /** 一维取整到 0.1（压缩 SVG 里的数字串）。 */
    function round1(value) {
      return Math.round(value * 10) / 10
    }

    /**
     * 端点标签的摆放：靠近右边缘就放到点的左侧，靠近下边缘就放到点的上方，
     * 免得标签被画布裁掉。纯函数，可单测。
     * @param point - 端点屏幕坐标。
     * @param width - 画布宽。
     * @param height - 画布高。
     * @param fontSize - 字号。
     * @returns 标签的 x / y 与 textAnchor。
     */
    function labelPlacement(point, width, height, fontSize) {
      var flipX = point[0] > width * 0.72
      var flipY = point[1] > height - fontSize * 1.2
      return {
        x: round1(flipX ? point[0] - 3 : point[0] + 3),
        y: round1(flipY ? point[1] - 2.5 : point[1] + fontSize * 0.95),
        anchor: flipX ? 'end' : 'start',
      }
    }

    /**
     * 把经纬度路线投到 SVG 画布上。
     *
     * 等距近似（x 按纬度 cos 收缩）→ 等比缩放居中，保证路线不变形。
     * **画布高度按路线长宽比推算**（钳制在 MAP_H_MIN..MAP_H_MAX），返回的
     * `viewBox` 因此与路线形状同比例：组件只要设 `width:100%; height:auto`，
     * 地图就不会是一大片空白里的一条细线。
     *
     * 纯函数，可单测。
     */
    function projectLine(line) {
      var n = line.length
      if (n === 0) return null
      var latSum = 0
      for (var i = 0; i < n; i += 1) latSum += line[i][1]
      var scaleX = Math.cos(((latSum / n) * Math.PI) / 180)
      if (!(scaleX > 0.01)) scaleX = 0.01
      var xs = []
      var ys = []
      for (var j = 0; j < n; j += 1) {
        xs.push(line[j][0] * scaleX)
        ys.push(-line[j][1])
      }
      var minX = Math.min.apply(null, xs)
      var maxX = Math.max.apply(null, xs)
      var minY = Math.min.apply(null, ys)
      var maxY = Math.max.apply(null, ys)
      var dx = maxX - minX
      var dy = maxY - minY
      if (dx < 1e-12 && dy < 1e-12) {
        // 所有点重合：给一个最小画布，中心一个点，避免除零。
        var mid = [MAP_W / 2, MAP_H_MIN / 2]
        return {
          viewBox: '0 0 ' + MAP_W + ' ' + MAP_H_MIN,
          width: MAP_W,
          height: MAP_H_MIN,
          points: mid[0] + ',' + mid[1],
          start: mid,
          end: mid,
        }
      }
      // viewBox 比例 = 路线外包框比例（不做审美钳制，否则路线会在框内
      // 再被 letterbox 一次，画出来就是"大空框里一条线"）。
      var height = dx < 1e-12 ? MAP_H_MAX : MAP_W * (dy / dx)
      if (!isFinite(height) || height < MAP_H_MIN) height = MAP_H_MIN
      if (height > MAP_H_MAX) height = MAP_H_MAX
      var innerW = Math.max(1, MAP_W - 2 * MAP_PAD)
      var innerH = Math.max(1, height - 2 * MAP_PAD)
      var scale = Math.min(
        dx < 1e-12 ? Infinity : innerW / dx,
        dy < 1e-12 ? Infinity : innerH / dy,
      )
      if (!isFinite(scale)) scale = 1
      var offsetX = (MAP_W - dx * scale) / 2
      var offsetY = (height - dy * scale) / 2
      var projected = []
      for (var k = 0; k < n; k += 1) {
        projected.push([
          round1((xs[k] - minX) * scale + offsetX),
          round1((ys[k] - minY) * scale + offsetY),
        ])
      }
      var text = []
      for (var m = 0; m < projected.length; m += 1) text.push(projected[m][0] + ',' + projected[m][1])
      return {
        viewBox: '0 0 ' + MAP_W + ' ' + height,
        width: MAP_W,
        height: height,
        aspect: height / MAP_W,
        points: text.join(' '),
        start: projected[0],
        end: projected[projected.length - 1],
      }
    }

    /**
     * 真地图画框：把路线比例钳到 MAP_ASPECT_MIN..MAP_ASPECT_MAX（**高 / 宽**）
     * 后，换算出 CSS `aspect-ratio`（**宽 / 高**）与要请求的图片尺寸。
     *
     * 宽度交给 CSS（100%），高度由 aspect-ratio 推出来，所以不需要知道卡片
     * 实际宽度；图片与画框比例天然一致（既不裁掉两端，也不留黑边）。
     * 真地图的留白是**真实地图内容**，所以画框给大一点、路线反而更清楚。
     *
     * @param routeAspect - 路线外包框的高 / 宽（`projectLine().aspect`）。
     * @returns `cssAspect` 是 CSS 用的宽高比，`requestW/H` 是要高德出图的像素。
     */
    function mapFrame(routeAspect) {
      var aspect = Number(routeAspect)
      if (!isFinite(aspect) || aspect <= 0) aspect = MAP_ASPECT_MIN
      if (aspect < MAP_ASPECT_MIN) aspect = MAP_ASPECT_MIN
      if (aspect > MAP_ASPECT_MAX) aspect = MAP_ASPECT_MAX
      var requestW = MAP_REQUEST_W
      var requestH = Math.max(64, Math.min(1024, Math.round(requestW * aspect)))
      return { cssAspect: requestW / requestH, requestW: requestW, requestH: requestH }
    }

    /** 等间隔抽稀（客户端侧），用于把折线塞进静态地图的 URL。 */
    function decimateLine(line, maxPoints) {
      if (!Array.isArray(line) || line.length <= maxPoints) return Array.isArray(line) ? line : []
      var out = []
      var step = (line.length - 1) / (maxPoints - 1)
      for (var i = 0; i < maxPoints; i += 1) out.push(line[Math.round(i * step)])
      return out
    }

    /**
     * 向宿主回环路由要静态地图的 URL。
     *
     * 真地图（含高德绘制的路线与起终点标注）由**宿主**去取——key 不出服务端，
     * 浏览器只加载一张本地图片。宿主没配 key、配额超限、或老版本没有这个
     * 路由时，图片加载失败 → 卡片自动退回自绘示意图（见 RouteBody）。
     */
    function staticMapUrl(line, frame) {
      var compact = decimateLine(line, 120).map(function (p) { return p[0] + ',' + p[1] }).join(';')
      return '/dsh-map-tools/staticmap?w=' + frame.requestW + '&h=' + frame.requestH
        + '&v=' + MAP_URL_VERSION
        + '&line=' + encodeURIComponent(compact)
    }

    /** 距离文案：>=1 公里用公里，否则用米。 */
    function formatDistance(meters) {
      if (!(meters > 0)) return ''
      return meters >= 1000 ? (meters / 1000).toFixed(1) + ' 公里' : Math.round(meters) + ' 米'
    }

    /** 耗时文案；为 0 时返回空串（高德公交不返回耗时）。 */
    function formatDuration(seconds) {
      if (!(seconds > 0)) return ''
      var mins = Math.round(seconds / 60)
      if (mins < 60) return '约 ' + mins + ' 分钟'
      return '约 ' + Math.floor(mins / 60) + ' 小时 ' + (mins % 60) + ' 分钟'
    }

    /**
     * 高德 URI 深链（官方 uri.amap.com 协议）。
     * callnative=0 让它走网页版，避免在浏览器里尝试唤起客户端。
     * ⚠️ 未经实机验证——首版测试时请人工点一次确认。
     */
    function amapUri(mode, line, fromText, toText) {
      if (!Array.isArray(line) || line.length < 2) return null
      var from = line[0]
      var to = line[line.length - 1]
      var params = [
        'from=' + from[0] + ',' + from[1] + ',' + encodeURIComponent(fromText || '起点'),
        'to=' + to[0] + ',' + to[1] + ',' + encodeURIComponent(toText || '终点'),
        'mode=' + (mode || 'car'),
        'coordinate=gaode',
        'callnative=0',
        'src=dsh-map-tools',
      ]
      return 'https://uri.amap.com/navigation?' + params.join('&')
    }

    function routeCardModel(block, toolName) {
      var tool = ROUTE_TOOLS[toolName] || { mode: 'car', label: '路线' }
      var args = parseArgs(block)
      var running = isRunning(block)
      var failed = !running && block.isError === true
      var meta = running ? null : routeMeta(block && block.meta)
      var line = meta && meta.line && meta.line.length >= 2 ? meta.line : null
      // 名称优先用 meta 里的（坐标入参时宿主反查出来的地名），其次才用参数原文。
      var fromText = (meta && meta.fromName) || (args && typeof args.origin === 'string' ? args.origin : '')
      var toText = (meta && meta.toName) || (args && typeof args.destination === 'string' ? args.destination : '')
      return {
        label: tool.label,
        mode: tool.mode,
        summary: summaryOf(fromText, toText),
        fromText: fromText,
        toText: toText,
        running: running,
        failed: failed,
        meta: meta,
        line: line,
        // 模型可见的结果文本：画了图之后仍然显示（可滚动），
        // 这样卡片不会把"分段指引"这份信息藏起来。
        resultText: running || failed ? '' : flattenContent(block),
        errorText: failed ? errorText(block) : '',
      }
    }

    /**
     * 用"回合尾部"折叠出来的数据构造同一套卡片模型。
     *
     * 回合尾部只有（工具名 / 调用参数 / 持久化 meta），没有 ToolCallBlock；
     * 这里把它归一成与 routeCardModel 相同的形状，好让 RouteBody 复用。
     * @param entry - 折叠定义里记录的一条路线调用。
     * @returns 卡片模型；meta 不可用时返回 null。
     */
    function turnRouteModel(entry) {
      if (!entry) return null
      var meta = routeMeta(entry.meta)
      if (!meta) return null
      var tool = ROUTE_TOOLS[entry.toolName] || { mode: 'car', label: '路线' }
      var args = parseArgsRaw(entry.argsRaw)
      var fromText = meta.fromName || (args && typeof args.origin === 'string' ? args.origin : '')
      var toText = meta.toName || (args && typeof args.destination === 'string' ? args.destination : '')
      return {
        label: tool.label,
        mode: tool.mode,
        summary: summaryOf(fromText, toText),
        fromText: fromText,
        toText: toText,
        running: false,
        failed: false,
        meta: meta,
        line: meta.line && meta.line.length >= 2 ? meta.line : null,
        // 回合尾部拿不到模型可见文本（那是工具结果的 content）；这里不重复显示。
        resultText: '',
        errorText: '',
      }
    }

    /**
     * 自绘示意图（无底图）：静态地图拿不到时的兜底，也是"没有 key"的用户
     * 唯一能看到的图形。纯 SVG，不请求任何外部资源。
     */
    function sketchSvg(h, projected) {
      var startLabel = labelPlacement(projected.start, projected.width, projected.height, 7)
      var endLabel = labelPlacement(projected.end, projected.width, projected.height, 7)
      // 先画一条更粗的半透明底线当"光晕"，路线在浅色/深色主题下都清晰。
      var shapes = [
        h('polyline', {
          key: 'halo',
          points: projected.points,
          fill: 'none',
          stroke: ACCENT,
          strokeOpacity: 0.22,
          strokeWidth: 3.2,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
        h('polyline', {
          key: 'line',
          points: projected.points,
          fill: 'none',
          stroke: ACCENT,
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
        h('circle', { key: 'start', cx: projected.start[0], cy: projected.start[1], r: 2, fill: START_COLOR }),
        h('circle', { key: 'end', cx: projected.end[0], cy: projected.end[1], r: 2, fill: END_COLOR }),
        h('text', {
          key: 'startLabel',
          x: startLabel.x,
          y: startLabel.y,
          textAnchor: startLabel.anchor,
          fontSize: 7,
          fill: START_COLOR,
        }, '起'),
        h('text', {
          key: 'endLabel',
          x: endLabel.x,
          y: endLabel.y,
          textAnchor: endLabel.anchor,
          fontSize: 7,
          fill: END_COLOR,
        }, '终'),
      ]
      return h('svg', {
        viewBox: projected.viewBox,
        preserveAspectRatio: 'xMidYMid meet',
        style: { display: 'block', width: '100%', height: '100%' },
        role: 'img',
        'aria-label': '路线示意图（非真实底图，仅示意走向）',
      }, shapes)
    }

    /**
     * 卡片主体：地图/示意图 + 数据行 + 折叠的路书 + 深链。
     *
     * @param h - createElement。
     * @param model - 卡片模型。
     * @param opts.withMap - 是否渲染地图。过程区（"思考"块）传 false：
     *   工具卡片会随过程反复重绘，在那里再拉一张大图既没必要、也和
     *   回合尾部的卡片重复；地图只在"最终结果"处出现。
     */
    function RouteBody(h, model, opts) {
      var withMap = !opts || opts.withMap !== false
      var rows = []
      var distance = formatDistance(model.meta.distanceM)
      var duration = formatDuration(model.meta.durationS)
      var stats = [distance, duration, model.meta.provider].filter(Boolean).join(' · ')
      if (model.meta.stepCount > 0) stats += ' · 共 ' + model.meta.stepCount + ' 步'
      if (model.meta.alternatives > 0) stats += ' · 另有 ' + model.meta.alternatives + ' 条备选'

      if (withMap && model.line) {
        var projected = projectLine(model.line)
        if (projected) {
          // 真地图画框：宽度吃满卡片（CSS aspectRatio 推高度），整条路线由
          // 高德按请求尺寸自适应装进来——比"按路线比例做小缩略图"大得多。
          var frame = mapFrame(projected.aspect)
          var content = model.imageFailed
            ? sketchSvg(h, projected)
            : h('img', {
              src: staticMapUrl(model.line, frame),
              alt: '路线地图',
              onError: model.onImageError,
              style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' },
            })
          rows.push(h('div', {
            key: 'map',
            style: {
              margin: '0 0 8px',
              borderRadius: '6px',
              overflow: 'hidden',
              border: '1px solid ' + CARD_BORDER,
              // 真地图自带底图；自绘兜底图铺细网格，免得像"空框"。
              background: model.imageFailed
                ? 'repeating-linear-gradient(0deg, rgba(127,127,127,0.13) 0 1px, transparent 1px '
                  + MAP_GRID_PX + 'px), repeating-linear-gradient(90deg, rgba(127,127,127,0.13) 0 1px, transparent 1px '
                  + MAP_GRID_PX + 'px), ' + MAP_BG
                : MAP_BG,
              width: '100%',
              // 与请求给高德的图片同比例 ⇒ 既不裁掉两端，也不留黑边。
              aspectRatio: String(frame.cssAspect),
            },
          }, content))
        }
      }

      if (stats) rows.push(h('div', { key: 'stats', style: { color: MUTED, fontSize: '12px' } }, stats))

      if (model.resultText) {
        // 路书默认折叠：以前它是个占半屏、带独立滚动条的大框，
        // 把卡片主体（图）挤成了配角。
        var lines = model.resultText.split('\n')
        var expanded = model.expanded === true
        var preview = expanded ? model.resultText : lines.slice(0, 3).join('\n')
        var hiddenCount = Math.max(0, lines.length - 3)
        rows.push(h('pre', {
          key: 'text',
          style: {
            margin: '6px 0 0',
            padding: '6px 8px',
            maxHeight: expanded ? '320px' : 'none',
            overflow: expanded ? 'auto' : 'hidden',
            whiteSpace: 'pre-wrap',
            borderRadius: '6px',
            background: 'rgba(127,127,127,0.08)',
            fontSize: '12px',
            lineHeight: '1.5',
            color: MUTED,
          },
        }, preview))
        if (hiddenCount > 0 || expanded) {
          rows.push(h('button', {
            key: 'toggle',
            type: 'button',
            onClick: model.onToggle,
            style: {
              marginTop: '4px',
              padding: '2px 8px',
              border: '1px solid ' + CARD_BORDER,
              borderRadius: '5px',
              background: 'none',
              color: MUTED,
              fontSize: '12px',
              cursor: 'pointer',
            },
          }, expanded ? '收起分段指引' : '展开分段指引（还有 ' + hiddenCount + ' 行）'))
        }
      }

      // 署名与「在高德打开 ↗」**同一行**：它接在深链后面，而不是另起一行压在卡片
      // 底部，所以两者共用一个 flex 行、按基线对齐（窄卡片上再换行）。
      var uri = amapUri(model.mode, model.line, model.fromText, model.toText)
      var withCredit = !!(opts && opts.credit === true)
      if (uri || withCredit) {
        var linkRow = []
        if (uri) {
          // 字号不在这里定：整行统一 12px（与上面的统计行同号），深链只负责颜色，
          // 否则深链 12px、署名继承外层更大的字号，同一行会明显不等大。
          linkRow.push(h('a', {
            key: 'amap',
            href: uri,
            target: '_blank',
            rel: 'noreferrer',
            style: { color: ACCENT, textDecoration: 'none' },
          }, '在高德打开 ↗'))
        }
        // 没有几何（老日志 / 高德公交无折线）时深链是空的，署名照样在。
        if (withCredit) linkRow = linkRow.concat(creditNodes(h))
        rows.push(h('div', {
          key: 'link',
          style: {
            marginTop: '8px',
            display: 'flex',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            gap: '8px',
            // 这一行的唯一字号来源：深链与署名同号，差别只在颜色 / 字重。
            fontSize: '12px',
            lineHeight: '18px',
            color: MUTED,
          },
        }, linkRow))
      }
      return rows
    }

    /** 卡片组件：认领 key 后要覆盖运行中/成功/失败/无几何全部形态。 */
    function RouteCard(props) {
      var react = require('react')
      var h = react.createElement
      var state = useCardState(react)
      var model = applyCardState(routeCardModel(props.block, props.toolName), state)
      var head = [model.label]
      if (model.summary) head.push(model.summary)
      var children = [
        h('div', {
          key: 'head',
          style: { fontSize: '12px', color: MUTED, marginBottom: '6px' },
        }, head.join(' · ')),
      ]
      if (model.running) {
        children.push(h('div', { key: 'running', style: { fontSize: '12px', color: MUTED } }, '规划中…'))
      } else if (model.failed) {
        children.push(h('pre', {
          key: 'error',
          style: { margin: 0, whiteSpace: 'pre-wrap', fontSize: '12px', color: '#e05c5c' },
        }, model.errorText))
      } else if (model.line || model.meta) {
        // 过程区（工具卡片）**不渲染地图**：这里会随过程反复重绘，而且地图
        // 已经在回合尾部（最终结果处）给过了。过程区只做紧凑摘要 + 路书。
        children.push(h('div', { key: 'body' }, RouteBody(h, model, { withMap: false })))
      } else {
        children.push(h('pre', {
          key: 'plain',
          style: { margin: 0, whiteSpace: 'pre-wrap', fontSize: '12px', color: MUTED },
        }, model.resultText || '（无卡片数据）'))
      }
      return h('div', {
        style: {
          padding: '8px 10px',
          borderRadius: '8px',
          border: '1px solid ' + CARD_BORDER,
          background: CARD_BG,
        },
      }, children)
    }

    /** 注册四个路线工具的卡片；槽位声明未就绪时 inject 会排队等待。 */
    function registerRouteCards(scope) {
      if (!scope || !scope.slots || typeof scope.slots.inject !== 'function') return
      scope.slots.inject('tool.call.toolview', function* () {
        var names = Object.keys(ROUTE_TOOLS)
        for (var i = 0; i < names.length; i += 1) {
          yield scope.slots.register({ name: 'tool.call.toolview', key: names[i] }, RouteCard)
        }
      })
    }

    // ---- 回合尾部（"最终结果"处）的路线卡片 ------------------------------
    //
    // 工具卡片渲染在回合的**过程区**（"思考"块里，随时可能被折叠），所以只看
    // 最终答案的人看不到地图。这里按 ui-deliverables 的做法自己折叠本轮的
    // 路线结果（注册一个 conversation node definition），再注册到回合尾部的
    // 槽位 conversation.chat.turnTail —— 地图就会出现在收尾正文之后。
    //
    // 该槽位的**类型随宿主版本变过**（见 docs/dsh-map-tools-0.1.6兼容性说明.md）：
    //   · ≤ 0.1.6-alpha.1：kind 'chain' —— 必填 `select`，组件从 props.matched 取数；
    //   · ≥ 0.1.6-alpha.2：kind 'list'  —— 必填 `id`，不注入 matched，组件自推导。
    // 所以下面读槽位声明决定注册形状，一份 bundle 同时吃两种宿主。

    /** 本轮路线的 Turn 级数据键（Definition 与选择器共用）。 */
    var ROUTE_TURN_KEY = 'map-routes'

    /** 回合尾部槽位名（0.1.6-alpha.2 起由链式改为列表式）。 */
    var TURN_TAIL_SLOT = 'conversation.chat.turnTail'

    /** 列表式槽位必填的注册 id：稳定、全局唯一；链式宿主上被忽略。 */
    var TURN_TAIL_ID = 'dsh-map-tools-turn-routes'

    /** 线级工具名是否是我们的路线工具。 */
    function isRouteTool(name) {
      return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ROUTE_TOOLS, name)
    }

    /**
     * 折叠"本轮成功的路线调用"：tool/call 记名字与参数，tool/result 里带
     * `meta.kind === 'route'` 且不是失败结果时落一条。
     * 只发布数据、不产生视图节点（没有 target），与 ui-deliverables 同构。
     */
    function routeTurnDefinition() {
      return {
        kind: ROUTE_TURN_KEY,
        match: function (event) {
          if (!event || typeof event !== 'object') return null
          if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
          if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
          if (event.type === 'tool/result') return { id: String(event.data.turn), role: 'update' }
          // 只累加"带 turn 的事件"：user/message 没有 turn 字段（官方定义用
          // message id 另起一个节点），所以回合级累加器拿不到用户原话——这也是
          // 放弃"猜哪条是主路线"、改为把本轮所有路线都画出来的原因。
          return null
        },
        start: function (context, match) {
          return { turn: match.event.data.turn, calls: new Map(), routes: [] }
        },
        update: function (context, match) {
          var event = match.event
          var state = context.state
          if (event.type === 'tool/call') {
            var calls = new Map(state.calls)
            calls.set(String(event.data.callId), { name: event.data.name, argsRaw: event.data.arguments })
            return { turn: state.turn, calls: calls, routes: state.routes }
          }
          if (event.type !== 'tool/result') return state
          var message = event.data && event.data.message
          if (!message || message.isError === true) return state
          var meta = event.data.meta
          if (!meta || meta.kind !== 'route' || meta.v !== 1) return state
          var callId = String(message.source && message.source.callId)
          var call = state.calls.get(callId)
          if (!call || !isRouteTool(call.name)) return state
          var routes = state.routes.concat([{
            callId: callId,
            toolName: call.name,
            argsRaw: call.argsRaw,
            meta: meta,
            seq: event.seq,
          }])
          return { turn: state.turn, calls: state.calls, routes: routes }
        },
        buildLocationData: function (context, scope, previous) {
          if (scope !== 'turn' || !context.state) return null
          var state = context.state
          if (previous && previous.kind === 'turn' && previous.turn === state.turn
            && previous.key === ROUTE_TURN_KEY && previous.value.routes === state.routes) return previous
          return { kind: 'turn', turn: state.turn, key: ROUTE_TURN_KEY, value: { routes: state.routes } }
        },
      }
    }

    /**
     * 本轮"产出的文件"数量（ui-deliverables 的 Turn 数据，与本插件无关的那个 key）。
     *
     * 回合尾部是**单选**席位：我们用了更低的 `priority`（先试），所以只要本轮有
     * 路线就由我们占用这一行，"本轮产出文件"那行本轮就不会渲染。把数量带进卡片，
     * 免得那份信息彻底消失（文件本身在过程区的工具卡里仍然看得到）。
     */
    function producedFileCount(owner, seq) {
      try {
        var data = owner && owner.turn && owner.turn.data && typeof owner.turn.data.get === 'function'
          ? owner.turn.data.get('deliverables')
          : undefined
        var list = data && Array.isArray(data.produced) ? data.produced : []
        var count = 0
        for (var i = 0; i < list.length; i += 1) {
          if (typeof list[i].seq === 'number' && list[i].seq >= seq) continue
          count += 1
        }
        return count
      } catch (error) {
        // 别的插件的 Turn 数据可能是任何形状：读不到就当 0，绝不影响地图卡。
        return 0
      }
    }

    /** 本轮在收尾正文之前落定的路线（选择器：没有就放弃这个槽位）。 */
    function selectTurnRoutes(owner) {
      var data = owner && owner.turn && owner.turn.data && typeof owner.turn.data.get === 'function'
        ? owner.turn.data.get(ROUTE_TURN_KEY)
        : undefined
      var all = data && Array.isArray(data.routes) ? data.routes : []
      var seq = typeof owner.seq === 'number' ? owner.seq : Number.POSITIVE_INFINITY
      var routes = []
      for (var i = 0; i < all.length; i += 1) {
        if (typeof all[i].seq === 'number' && all[i].seq > seq) continue
        routes.push(all[i])
      }
      if (routes.length === 0) return null
      // **不再挑"最后一条"**：模型常在同一轮里发多条路线调用（主路线 + 若干用于
      // 核对/备选的探测，有些直接传坐标、反查出来的地名与用户问的毫不相干）。
      // 实测踩坑：正文讲南艳湖→蜀山，地图却画了中间那条"望江西路欣塘家园→蜀山"。
      // 任何"猜哪条是主路线"的启发式都试过并否掉了（收尾正文会引用探测路线的
      // 坐标，最长公共子串反而给探测更高分）。现在按时间顺序全部交给卡片，
      // 由卡片逐条渲染 —— 用户问的那条一定在里面。
      return { routes: routes, produced: producedFileCount(owner, seq) }
    }

    /**
     * 卡片模型（纯函数、不碰 react）：收出本轮要渲染的路线数、产出文件数与
     * "是否挤掉了官方产出文件行"。
     *
     * 这里就是两种槽位语义的**唯一适配点**：
     *   · chain（≤ 0.1.6-alpha.1）：框架把选择器结果当 `props.matched` 送进来；
     *     那是单选举席，我们当选就挤掉了官方"本轮产出文件"行 → displaced。
     *   · list（≥ 0.1.6-alpha.2）：没有 `matched`，从 ownerProps（turn / seq）
     *     自己推导（每次渲染都会跑一次，选择器保持纯函数）；官方产出文件卡
     *     与我们同时出现，没有挤掉谁 → 不 displaced。
     *
     * @returns 模型对象；本轮没有可画的路线时返回 null（卡片整块不渲染）。
     */
    function turnRouteCardModel(props) {
      var owner = props || {}
      var chainMatched = owner.matched && Array.isArray(owner.matched.routes) ? owner.matched : null
      var selected = chainMatched || selectTurnRoutes(owner)
      if (!selected) return null
      var routes = Array.isArray(selected.routes) ? selected.routes : []
      if (routes.length === 0) return null
      // 一轮里可能有多条路线（主路线 + 模型用于核对/备选的探测），**逐条渲染**，
      // 每条都有自己的地图。之前只画最后一条，导致"正文讲 A→B、地图画 C→B"。
      var models = []
      for (var i = 0; i < routes.length && models.length < MAX_TURN_ROUTES; i += 1) {
        var model = turnRouteModel(routes[i])
        if (model) models.push(model)
      }
      if (models.length === 0) return null
      return {
        models: models,
        total: routes.length,
        produced: typeof selected.produced === 'number' ? selected.produced : 0,
        displaced: chainMatched !== null,
      }
    }

    /** 插件仓库：署名行给截图读者的唯一去处。 */
    var REPO_URL = 'https://github.com/HorusJiang/dsh-map-tools'

    /**
     * 署名内容（包名 + GitHub 链接）：接在「在高德打开 ↗」**同一行的后面**。
     *
     * 存在的理由只有**截图传播**：地图卡会被截图、转发到聊天和朋友圈里，而那一张
     * 图里没有 README、没有 npm 页——只有这行字能说明"这张地图卡是 dsh-map-tools
     * 画的、它是个 DSH 插件"。所以包名用正文色 + 中等字重（缩略图里也认得出），
     * 其余收敛成次要色——**字号由所在行统一给**（与「在高德打开 ↗」同号 12px），
     * 这里绝不自带 fontSize，否则同一行里两截会不等大。
     *
     * 纯客户端渲染，宿主半边没有一行改动：不进 `presentationMeta`、不进模型上下文、
     * 不占 token，也不参与回合尾部席位的单选语义。
     *
     * @param h - createElement。
     * @returns 该行的内容节点数组（调用方把它接在深链后面）。
     */
    function creditNodes(h) {
      return [
        h('span', { key: 'credit' },
          '本卡片由 DeepSeek Harness 插件 ',
          h('span', { key: 'name', style: { color: TEXT, fontWeight: 500 } }, BUNDLE),
          ' 生成'),
        h('a', {
          key: 'repo',
          href: REPO_URL,
          target: '_blank',
          rel: 'noreferrer',
          style: { color: ACCENT, textDecoration: 'none' },
        }, 'GitHub ↗'),
      ]
    }

    /**
     * 回合尾部的路线卡片：本轮算了几条就逐条画（每条一张地图），
     * 与工具卡片复用同一套 body 与降级逻辑。
     */
    function TurnRouteCard(props) {
      var react = require('react')
      var h = react.createElement
      var state = useCardState(react)
      var card = turnRouteCardModel(props)
      if (!card) return null
      var models = card.models
      // 局部状态（折叠/图片失败）挂在第一条上：其余条目的地图仍按各自 URL 加载，
      // 加载失败时各自退回自绘示意图由 RouteBody 内部处理。
      applyCardState(models[0], state)
      var children = []
      for (var k = 0; k < models.length; k += 1) {
        var head = []
        if (models.length > 1) head.push('第 ' + (k + 1) + '/' + models.length + ' 条')
        head.push(models[k].label)
        if (models[k].summary) head.push(models[k].summary)
        if (k > 0) {
          children.push(h('div', {
            key: 'sep' + k,
            style: { margin: '10px 0 6px', borderTop: '1px solid ' + CARD_BORDER },
          }))
        }
        children.push(h('div', {
          key: 'head' + k,
          style: { fontSize: '12px', color: MUTED, marginBottom: '6px' },
        }, head.join(' · ')))
        // 署名只接在**最后一条路线**的「在高德打开 ↗」后面（整张卡出现一次，
        // 不是每条路线一次）：它是给截图读者的落款，重复 N 遍只会变成噪音。
        children.push(h('div', { key: 'body' + k }, RouteBody(h, models[k], { credit: k === models.length - 1 })))
      }
      if (card.total > MAX_TURN_ROUTES) {
        children.push(h('div', {
          key: 'more',
          style: { marginTop: '6px', fontSize: '12px', color: MUTED },
        }, '本轮共 ' + card.total + ' 条路线，这里显示前 ' + MAX_TURN_ROUTES + ' 条'))
      }
      if (card.displaced && card.produced > 0) {
        // 只在链式槽位下说这句：那是单选举席，我们把"本轮产出文件"那行挤掉了
        // （代价），至少把数量交代清楚。列表式槽位下官方那行照常渲染，无需多言。
        children.push(h('div', {
          key: 'produced',
          style: { marginTop: '6px', fontSize: '12px', color: MUTED },
        }, '本轮另有 ' + card.produced + ' 个产出文件（地图卡占用此行，文件见过程区）'))
      }
      return h('div', {
        style: {
          marginTop: '8px',
          padding: '8px 10px',
          borderRadius: '8px',
          border: '1px solid ' + CARD_BORDER,
          background: CARD_BG,
        },
      }, children)
    }

    /** 卡片的两处局部状态（折叠路书 / 静态地图是否加载失败）。 */
    function useCardState(react) {
      return { expanded: react.useState(false), imageFailed: react.useState(false) }
    }

    /** 把局部状态接到模型上（组件体里无条件调用，遵守 hooks 规则）。 */
    function applyCardState(model, state) {
      model.expanded = state.expanded[0]
      model.onToggle = function () { state.expanded[1](!state.expanded[0]) }
      model.imageFailed = state.imageFailed[0]
      // 静态地图加载失败（没 key / 配额超限 / 宿主无此路由）→ 退回自绘示意图。
      model.onImageError = function () { state.imageFailed[1](true) }
      return model
    }

    /**
     * 读槽位当前的声明类型（`chain` / `list` / `single` / `keyed`）。
     *
     * 这是"插件跟着宿主版本走"的关键：0.1.6-alpha.2 把 turnTail 从 chain 改成了
     * list，两者要求的注册字段互斥（chain 要 `select`、list 要 `id`，缺了就抛），
     * 而**读声明**比猜版本号可靠——宿主小版本号无法枚举，同一份 bundle 却能靠它
     * 在两个宿主上都注册成功。
     *
     * @returns 类型字符串；读不到（老宿主无 spec()、槽位未声明、服务形状变了）返回 undefined。
     */
    function slotKind(scope, name) {
      try {
        var slots = scope && scope.slots
        if (!slots || typeof slots.spec !== 'function') return undefined
        var spec = slots.spec(name)
        return spec && typeof spec.kind === 'string' ? spec.kind : undefined
      } catch (error) {
        return undefined
      }
    }

    /** 列表式注册：`id` 必填、同 id 同 priority 唯一；组件自己推导数据。 */
    function registerTurnTailAsList(scope) {
      // priority -1：列表式按 priority 升序渲染，排到官方"本轮文件改动"卡
      // （默认 0）前面，地图卡仍然紧贴正文。
      return scope.slots.register({
        name: TURN_TAIL_SLOT,
        id: TURN_TAIL_ID,
        priority: -1,
      }, TurnRouteCard)
    }

    /** 链式注册：`select` 必填；框架把选择器结果作为 props.matched 送进组件。 */
    function registerTurnTailAsChain(scope) {
      // 回合尾部是**单选**链式槽位（第一个非空 select 当选；同优先级按注册
      // 顺序）。ui-deliverables 在 web 组合里先注册，所以用默认优先级时，
      // 只要本轮产出了文件它就当选，地图卡永远轮不到（实测：我的回合几乎
      // 必然写文件，于是地图一直不显示）。用更低的 priority 让我们**先试**：
      //   · 本轮有路线 → 我们当选，并在卡里注明"另有 N 个产出文件"；
      //   · 本轮没路线 → 我们返回 null 弃权，官方的产出文件行照常渲染。
      return scope.slots.register({
        name: TURN_TAIL_SLOT,
        priority: -1,
        select: selectTurnRoutes,
      }, TurnRouteCard)
    }

    /**
     * 按宿主**实际**的槽位类型注册回合尾部卡片。
     *
     * 类型未知时按 list → chain 依次试：list 槽位缺 `id` 会抛、chain 槽位缺
     * `select` 也会抛，而两者的校验都发生在写入账本之前（ui-slots register 的
     * 类型检查在最前），所以失败的尝试不留副作用。
     */
    function registerTurnTail(scope) {
      var kind = slotKind(scope, TURN_TAIL_SLOT)
      if (kind === 'chain') return registerTurnTailAsChain(scope)
      if (kind === 'list') return registerTurnTailAsList(scope)
      try {
        return registerTurnTailAsList(scope)
      } catch (listError) {
        try {
          return registerTurnTailAsChain(scope)
        } catch (chainError) {
          // 两条路都堵上时把两个原因都带出来，别让回退把 list 的真实错误吞掉
          // （例如同 id 同 priority 的重复注册，HMR 重载时最容易撞）。
          throw new Error('neither list nor chain registration worked — list: '
            + listError + '; chain: ' + chainError)
        }
      }
    }

    /**
     * 注册回合尾部的路线卡片。
     *
     * 两处注册相互独立、各自兜错：回合折叠定义失败不该影响工具卡片，
     * 反之亦然（同一个 bundle 还挂着 bundle 配置卡，不能一起崩）。
     */
    function registerTurnRouteCard(ctx) {
      if (!ctx || typeof ctx.inject !== 'function') return
      ctx.inject(['uiConversation', 'slots'], function (scope) {
        try {
          var events = scope.uiConversation && scope.uiConversation.events
          if (events && typeof events.register === 'function') events.register(routeTurnDefinition())
        } catch (error) {
          console.error('[dsh-map-tools] route turn definition skipped: ' + error)
        }
        try {
          scope.slots.inject(TURN_TAIL_SLOT, function () {
            // 兜错**必须写在工厂体里**：`slots.inject()` 只登记这个工厂，它由框架
            // 在槽位声明之后调用（声明已存在时同步、否则异步），抛错发生在包住
            // inject 的那个 try/catch 之外——早先版本正是因此在控制台留下 page error。
            try {
              return registerTurnTail(scope)
            } catch (error) {
              console.error('[dsh-map-tools] route turn tail skipped: ' + error)
              return function () {}
            }
          })
        } catch (error) {
          console.error('[dsh-map-tools] route turn tail skipped: ' + error)
        }
      })
    }

    function apply(ctx) {
      registerCard(ctx)
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], function (scope) {
        try {
          registerRouteCards(scope)
        } catch (error) {
          console.error('[dsh-map-tools] route card skipped: ' + error)
        }
      })
      try {
        registerTurnRouteCard(ctx)
      } catch (error) {
        console.error('[dsh-map-tools] route turn tail skipped: ' + error)
      }
    }

    exports.apply = apply
    exports.inject = []
    // 纯函数出口：供单元测试直接验证随包发布的这段代码（无构建步骤，
    // 所以测试跑的就是浏览器加载的同一份字节）。
    exports.__card = {
      ConfigCard: ConfigCard,
      registerCard: registerCard,
      registerOne: registerOne,
      BUNDLE_SEAT: BUNDLE_SEAT,
      LEGACY_SEAT: LEGACY_SEAT,
      BUNDLE: BUNDLE,
      CONFIG_URL: CONFIG_URL,
      PROVIDERS: PROVIDERS,
      DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
      TIMEOUT_MIN_MS: TIMEOUT_MIN_MS,
      TIMEOUT_MAX_MS: TIMEOUT_MAX_MS,
      parseTimeout: parseTimeout,
      effectiveConfig: effectiveConfig,
      draftFrom: draftFrom,
      draftValid: draftValid,
      configPatch: configPatch,
      isDirty: isDirty,
      statusLine: statusLine,
    }
    exports.__route = {
      ROUTE_TOOLS: ROUTE_TOOLS,
      parseArgs: parseArgs,
      callSummary: callSummary,
      flattenContent: flattenContent,
      routeMeta: routeMeta,
      projectLine: projectLine,
      mapFrame: mapFrame,
      labelPlacement: labelPlacement,
      decimateLine: decimateLine,
      staticMapUrl: staticMapUrl,
      sketchSvg: sketchSvg,
      turnRouteModel: turnRouteModel,
      turnRouteCardModel: turnRouteCardModel,
      routeTurnDefinition: routeTurnDefinition,
      selectTurnRoutes: selectTurnRoutes,
      slotKind: slotKind,
      registerTurnTail: registerTurnTail,
      registerTurnTailAsList: registerTurnTailAsList,
      registerTurnTailAsChain: registerTurnTailAsChain,
      TURN_TAIL_SLOT: TURN_TAIL_SLOT,
      TURN_TAIL_ID: TURN_TAIL_ID,
      formatDistance: formatDistance,
      formatDuration: formatDuration,
      amapUri: amapUri,
      routeCardModel: routeCardModel,
      registerRouteCards: registerRouteCards,
      registerTurnRouteCard: registerTurnRouteCard,
      producedFileCount: producedFileCount,
      MAX_TURN_ROUTES: MAX_TURN_ROUTES,
      creditNodes: creditNodes,
      REPO_URL: REPO_URL,
      TurnRouteCard: TurnRouteCard,
      RouteCard: RouteCard,
    }
    return module.exports
  },
})
