/*
 * GoTry's public DSH Web client half.
 *
 * This is a lazy-CJS browser bundle. The host serves it through the exact
 * `./client` export and DSH materializes it with the platform React module.
 * The Client receives the frozen `block` from the runtime; Host
 * presentationMeta/presentResult values are not available here.
 */
window.__ModuleLoader__.load({
  id: '@danceiny/gotry',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var UI = require('@deepseek-ai/dsh-client-ui-primitives')

    var webLocale = {
      en: {
        title: 'GoTry', description: 'Travel data sources and saved itineraries', flyai: 'FlyAI',
        loading: 'Loading…', unavailable: 'Configuration is unavailable. Retry to read its current state.',
        readOnly: 'The current key comes from the launch environment, or this platform cannot safely store it here.',
        key: 'API Key', keyHint: 'Paste the key from the FlyAI console. It never enters the conversation.',
        configured: 'A key is configured', anonymous: 'Anonymous trial · shared quota', verified: 'Current configuration verified',
        unverified: 'Configured · verification required', debug: 'Debug endpoint', console: 'Open FlyAI console',
        save: 'Verify and save', saving: 'Verifying…', saveFailed: 'The new key was not saved; the previous configuration is retained.',
        saved: 'Verified and saved.', clear: 'Clear local key', cleared: 'Local key cleared. Anonymous trial is now active.',
        retry: 'Refresh status', source: 'Source', config: 'Local configuration', env: 'Environment variable',
        'env-debug': 'Debug environment variable', none: 'Shared trial',
        artifacts: 'GoTry artifacts', artifactsHint: 'Browse saved itineraries and planning deliveries',
        search: 'Search artifacts', searchPlaceholder: 'Title or filename', refresh: 'Refresh',
        empty: 'No saved artifacts in this workspace.', noMatches: 'No matching artifacts.', noSession: 'Open a conversation to browse its workspace.',
        previous: 'Previous', next: 'Next', html: 'Open HTML preview', open: 'Open preview',
        htmlHint: 'HTML previews may run the document’s scripts.', failed: 'Could not read the current state. Please retry.',
      },
      zh: {
        title: 'GoTry', description: '旅行数据源与已保存行程', flyai: 'FlyAI（飞猪）',
        loading: '正在读取…', unavailable: '配置暂时不可用，请重新读取当前状态。',
        readOnly: '当前 Key 来自启动环境变量，或此平台无法在这里安全保存。',
        key: 'API Key', keyHint: '粘贴飞猪控制台中的 Key，凭据不会进入对话。',
        configured: '已配置 Key', anonymous: '匿名试用 · 共享额度', verified: '当前配置已验证',
        unverified: '已配置 · 尚未验证通过', debug: '调试服务地址', console: '打开飞猪控制台',
        save: '验证并保存', saving: '正在验证…', saveFailed: '新 Key 未保存，旧配置已保留。',
        saved: '验证通过，已保存。', clear: '清除本机 Key', cleared: '本机 Key 已清除，已恢复匿名试用。',
        retry: '重新读取状态', source: '来源', config: '本机配置', env: '环境变量',
        'env-debug': '调试环境变量', none: '共享试用',
        artifacts: 'GoTry 产物', artifactsHint: '查看已保存行程和规划交付物',
        search: '搜索产物', searchPlaceholder: '标题或文件名', refresh: '刷新',
        empty: '这个工作区尚无已保存产物。', noMatches: '没有匹配的产物。', noSession: '打开一个对话后即可查看其工作区产物。',
        previous: '上一页', next: '下一页', html: '打开 HTML 预览', open: '打开预览',
        htmlHint: 'HTML 预览可能运行文档中的脚本。', failed: '无法读取当前状态，请重试。',
      },
    }

    async function webRequest(path, options) {
      var response = await fetch('api/gotry/' + path, Object.assign({ credentials: 'same-origin' }, options))
      var value = await response.json()
      if (!value || typeof value !== 'object') throw new Error('Invalid Web response')
      if (!response.ok || value.ok === false) throw new Error(value.error || 'Request failed')
      return value
    }

    function FlyaiSettings(props) {
      var t = props.t
      var state = React.useState(null), status = state[0], setStatus = state[1]
      var draft = React.useState(''), key = draft[0], setKey = draft[1]
      var noticeState = React.useState(''), notice = noticeState[0], setNotice = noticeState[1]
      var errorState = React.useState(''), error = errorState[0], setError = errorState[1]
      var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1]
      var reloadState = React.useState(0), reload = reloadState[0], setReload = reloadState[1]
      var lifetime = React.useRef(null), activeRequest = React.useRef(false)
      React.useEffect(function () {
        var controller = new AbortController()
        lifetime.current = controller
        setError('')
        webRequest('flyai', { signal: controller.signal }).then(function (value) {
          if (!controller.signal.aborted) setStatus(value)
        }).catch(function () { if (!controller.signal.aborted) setError(t('failed')) })
        return function () { controller.abort(); lifetime.current = null }
      }, [reload])
      async function write(action) {
        if (activeRequest.current || !lifetime.current || !status?.writable) return
        var controller = lifetime.current
        activeRequest.current = true
        setBusy(true); setError(''); setNotice('')
        var candidate = key
        setKey('')
        try {
          var value = await webRequest('flyai/write', { method: 'POST', signal: controller.signal,
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(action === 'save' ? { action: action, key: candidate } : { action: action }) })
          if (!controller.signal.aborted) { setStatus(value); setNotice(t(action === 'save' ? 'saved' : 'cleared')) }
        } catch (failure) {
          if (!controller.signal.aborted) setError(failure.message || t('saveFailed'))
        } finally {
          activeRequest.current = false
          if (!controller.signal.aborted) setBusy(false)
        }
      }
      if (props.view === 'summary') return t('description')
      var disabled = busy || !status?.writable
      var stateLabel = !status ? t('loading') : !status.configured ? t('anonymous') : status.verified ? t('verified') : t('unverified')
      return element('section', { 'data-gotry-flyai-settings': '', style: { display: 'grid', gap: '16px', maxWidth: '640px' } }, [
        element('h3', { key: 'heading', style: { margin: 0 } }, t('flyai')),
        element('div', { key: 'status', role: 'status', 'data-gotry-flyai-status': '', style: { display: 'grid', gap: '6px' } }, [
          element(UI.Tag, { key: 'badge', tone: status?.verified ? 'success' : 'neutral' }, stateLabel),
          status ? element('span', { key: 'source', style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('source') + '：' + t(status.source)) : null,
          status?.endpointDebug ? element('span', { key: 'debug' }, t('debug') + '：' + status.endpoint) : null,
        ]),
        element('a', { key: 'console', href: 'https://flyai.open.fliggy.com/console', target: '_blank', rel: 'noopener noreferrer' }, t('console')),
        element(UI.SettingsForm, { key: 'form', labels: { unavailable: t('loading'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') },
          state: { available: Boolean(status), writable: Boolean(status?.writable), dirty: key.trim().length > 0, invalid: false, saving: busy, failed: false },
          onSave: function () { void write('save') }, onDiscard: function () { setKey('') } }, [
          element(UI.SettingsSecretField, { key: 'key', id: 'gotry-flyai-key', label: t('key'), hint: t('keyHint'), text: key,
            configured: Boolean(status?.configured), stateLabel: t(status?.configured ? 'configured' : 'anonymous'), disabled: disabled,
            onEdit: function (value) { setKey(value); setError(''); setNotice('') } }),
        ]),
        error ? element('p', { key: 'error', role: 'alert', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        notice ? element('p', { key: 'notice', role: 'status', style: { margin: 0 } }, notice) : null,
        element('div', { key: 'actions', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
          element(UI.Button, { key: 'retry', type: 'button', variant: 'outline', disabled: busy,
            onClick: function () { setReload(function (value) { return value + 1 }) } }, t('retry')),
          status?.configured && status.writable ? element(UI.Button, { key: 'clear', type: 'button', disabled: busy,
            onClick: function () { void write('clear') } }, t('clear')) : null,
        ]),
      ])
    }

    function ArtifactBrowser(props) {
      var t = props.t, info = props.useTabInfo(), sessionId = props.sessionId
      var cwd = props.useSessions(function (sessions) { return sessions.byId[sessionId]?.cwd })
      var state = React.useState(null), result = state[0], setResult = state[1]
      var queryState = React.useState(''), search = queryState[0], setSearch = queryState[1]
      var pageState = React.useState(0), offset = pageState[0], setOffset = pageState[1]
      var refreshState = React.useState(0), refresh = refreshState[0], setRefresh = refreshState[1]
      var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1]
      var errorState = React.useState(''), error = errorState[0], setError = errorState[1]
      React.useEffect(function () {
        if (!sessionId || !info.tab.visible) return
        var controller = new AbortController()
        setBusy(true); setError('')
        var query = new URLSearchParams({ sessionId: sessionId, search: search, offset: String(offset), limit: '20' })
        webRequest('artifacts?' + query, { signal: controller.signal }).then(function (value) {
          if (!controller.signal.aborted) setResult(value)
        }).catch(function () { if (!controller.signal.aborted) setError(t('failed')) })
          .finally(function () { if (!controller.signal.aborted) setBusy(false) })
        return function () { controller.abort() }
      }, [sessionId, info.tab.visible, search, offset, refresh])
      function open(path) {
        var normalized = String(path).replace(/\\/g, '/')
        var root = String(cwd || '').replace(/\\/g, '/').replace(/\/$/, '')
        var relative = root && normalized.startsWith(root + '/') ? normalized.slice(root.length + 1) : normalized
        info.tab.actions.openResource('dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' + relative.split('/').map(encodeURIComponent).join('/'))
      }
      var entries = result?.artifacts || []
      return element('section', { 'data-gotry-artifacts-browser': '', style: { padding: '16px', display: 'grid', alignContent: 'start', gap: '12px', height: '100%', overflow: 'auto', boxSizing: 'border-box', minWidth: 0 } }, [
        element('div', { key: 'controls', style: { display: 'flex', gap: '8px', alignItems: 'center', minWidth: 0 } }, [
          element(UI.Input, { key: 'search', 'aria-label': t('search'), placeholder: t('searchPlaceholder'), value: search,
            style: { minWidth: 0, width: '100%' }, onChange: function (event) { setSearch(event.target.value); setOffset(0) } }),
          element(UI.Button, { key: 'refresh', size: 'sm', disabled: busy || !sessionId,
            onClick: function () { setRefresh(function (value) { return value + 1 }) } }, busy ? t('loading') : t('refresh')),
        ]),
        error ? element('p', { key: 'error', role: 'alert' }, error) : null,
        !sessionId ? element('p', { key: 'no-session' }, t('noSession')) : !busy && entries.length === 0 ? element('p', { key: 'empty' }, t(search ? 'noMatches' : 'empty')) : null,
        element('div', { key: 'list', 'aria-busy': busy, style: { display: 'grid', gap: '8px' } }, entries.map(function (entry) {
          var html = /\.html?$/i.test(entry.path)
          return element(UI.Button, { key: entry.path, variant: 'outline', 'data-gotry-artifact-entry': entry.path,
            title: html ? t('htmlHint') : entry.path, onClick: function () { open(entry.path) },
            style: { width: '100%', height: 'auto', padding: '12px', textAlign: 'left', justifyContent: 'flex-start', minWidth: 0 } }, [
            element(UI.FileTypeIcon, { key: 'icon', path: entry.path }),
            element('span', { key: 'body', style: { display: 'grid', gap: '4px', minWidth: 0, flex: 1 } }, [
              element('span', { key: 'title', style: { overflowWrap: 'anywhere' } }, entry.title),
              element('span', { key: 'meta', style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' } },
                [entry.status, entry.updated ? new Date(entry.updated).toLocaleString() : '', html ? t('html') : t('open')].filter(Boolean).join(' · ')),
            ]),
          ])
        })),
        result?.total > 0 ? element('div', { key: 'pagination', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } }, [
          element(UI.Button, { key: 'previous', size: 'sm', disabled: busy || offset === 0, onClick: function () { setOffset(Math.max(0, offset - 20)) } }, t('previous')),
          element('span', { key: 'count', role: 'status', style: { fontSize: '12px' } }, (entries.length ? offset + 1 : 0) + '–' + (offset + entries.length) + ' / ' + result.total),
          element(UI.Button, { key: 'next', size: 'sm', disabled: busy || !result.truncated, onClick: function () { setOffset(result.nextOffset) } }, t('next')),
        ]) : null,
      ])
    }

    function element(type, props, children) {
      return React.createElement(type, props, ...(Array.isArray(children) ? children : [children]))
    }

    function object(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
    }

    function isSettled(block) {
      return object(block)?.kind === 'tool-result'
    }

    function resultText(block) {
      var content = Array.isArray(block?.content) ? block.content : []
      var text = content.map(function (item) {
        return item && item.type === 'text' && typeof item.text === 'string' ? item.text : JSON.stringify(item)
      }).filter(Boolean).join('\n')
      var error = object(block?.error)
      if (!text && error) text = String(error.name || 'Tool error') + ': ' + String(error.code || 'unknown')
      return text
    }

    function stateOf(block) {
      if (!isSettled(block)) return 'running'
      return block.isError ? 'error' : 'ok'
    }

    function metaOf(block) {
      return object(block?.meta)
    }

    function shellProps(type, state) {
      return {
        'data-gotry-artifact-card': type,
        'data-gotry-artifact-state': state,
        role: 'region',
        'aria-label': type === 'list' ? 'GoTry artifacts' : 'GoTry artifact preview',
        style: {
          border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))',
          borderRadius: '12px',
          margin: '6px 0',
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.05))',
        },
      }
    }

    function statusLine(state, type) {
      if (state === 'running') return type === 'list' ? '正在查找产物…' : '正在读取产物…'
      if (state === 'error') return type === 'list' ? '产物列表读取失败' : '产物预览失败'
      return type === 'list' ? '可打开的 GoTry 产物' : '产物预览'
    }

    function isHtmlPath(path) {
      return typeof path === 'string' && /\.(html|htm)$/i.test(path)
    }

    function ArtifactListCard(props) {
      var block = props.block
      var state = stateOf(block)
      var meta = metaOf(block)
      var selectedState = React.useState(null)
      var selected = selectedState[0]
      var setSelected = selectedState[1]
      var valid = state === 'ok' && meta && meta.shape === 'paths' && Array.isArray(meta.paths) &&
        meta.paths.every(function (path) { return typeof path === 'string' && path.length > 0 }) &&
        typeof meta.total === 'number' && Number.isInteger(meta.total) && meta.total >= 0 &&
        typeof meta.truncated === 'boolean'
      var text = resultText(block)
      var children = [element('div', { style: { padding: '10px 14px 4px', fontWeight: 600 } }, statusLine(state, 'list'))]
      if (state === 'running') {
        children.push(element('p', { 'data-gotry-artifact-status': 'running', style: { padding: '0 14px 12px', margin: 0 } }, '等待运行时返回路径…'))
      } else if (state === 'error') {
        children.push(element('p', { 'data-gotry-artifact-status': 'error', style: { padding: '0 14px 12px', margin: 0, color: 'var(--dsw-alias-state-error-primary, #c44)' } }, text || '未知错误'))
      } else if (!valid) {
        children.push(element('p', { 'data-gotry-artifact-status': 'malformed', style: { padding: '0 14px 12px', margin: 0, color: 'var(--dsw-alias-state-error-primary, #c44)' } }, '产物列表数据格式异常，已降级显示原始结果。'))
        if (text) children.push(element('pre', { style: { whiteSpace: 'pre-wrap', padding: '0 14px 12px', margin: 0 } }, text))
      } else {
        var list = meta.paths.map(function (path) {
          var isSelected = selected === path
          var htmlPreview = isHtmlPath(path)
          var buttonProps = {
            type: 'button',
            'data-gotry-artifact-path': path,
            'aria-pressed': isSelected,
            onClick: function () {
              setSelected(path)
              if (typeof props.openFile === 'function') props.openFile(path)
            },
            style: {
              color: 'var(--dsw-alias-accent, #4f8cff)',
              background: 'none',
              border: 0,
              padding: 0,
              cursor: 'pointer',
              textAlign: 'left',
              textDecoration: isSelected ? 'underline' : 'none',
            },
          }
          var label = path
          if (htmlPreview) {
            buttonProps['data-gotry-artifact-open'] = 'html-preview'
            buttonProps['aria-label'] = 'Open HTML preview ' + path
            buttonProps.title = '打开 HTML 预览：这是可直接查看的网页文件，其中的脚本可能会运行；只想看源码请用读取结果里的文本视图。'
            label = [
              element('span', { key: 'path' }, path),
              element('span', {
                key: 'badge',
                'data-gotry-artifact-badge': 'html-preview',
                style: {
                  marginLeft: '6px', padding: '0 6px', borderRadius: '999px',
                  border: '1px solid currentColor', fontSize: '11px', opacity: .75,
                },
              }, 'HTML 预览'),
            ]
          } else {
            buttonProps['data-gotry-artifact-open'] = 'artifact'
            buttonProps['aria-label'] = 'Open artifact ' + path
          }
          return element('li', { key: path, style: { margin: '4px 0' } }, element('button', buttonProps, label))
        })
        children.push(element('div', { style: { padding: '0 14px 10px', color: 'var(--dsw-alias-label-secondary, #888)' } },
          '共 ' + String(meta.total) + ' 项' + (meta.truncated ? '（已截断）' : '')))
        children.push(element('ul', { 'data-gotry-artifact-paths': 'true', style: { margin: '0', padding: '0 14px 12px 34px' } }, list))
        if (selected) children.push(element('div', { 'data-gotry-artifact-selection': selected, style: { padding: '0 14px 12px', fontSize: '12px' } }, '已选择：' + selected))
      }
      return element('section', shellProps('list', state), children)
    }

    function ArtifactReadCard(props) {
      var block = props.block
      var state = stateOf(block)
      var meta = metaOf(block)
      var validLines = Array.isArray(meta?.lines) && meta.lines.every(function (line) {
        return object(line) && Number.isInteger(line.number) && typeof line.text === 'string'
      })
      var valid = state === 'ok' && typeof meta?.path === 'string' && meta.path !== '' &&
        Number.isInteger(meta?.offset) && meta.offset >= 1 && Number.isInteger(meta?.totalLines) &&
        meta.totalLines >= 0 && validLines
      var text = resultText(block)
      var htmlSource = valid && meta.lang === 'html'
      var header = htmlSource ? 'HTML 源码预览（只读文本）' : statusLine(state, 'read')
      var children = [element('div', { style: { padding: '10px 14px 4px', fontWeight: 600 } }, header)]
      if (state === 'running') {
        children.push(element('p', { 'data-gotry-artifact-status': 'running', style: { padding: '0 14px 12px', margin: 0 } }, '等待运行时返回文件内容…'))
      } else if (state === 'error') {
        children.push(element('p', { 'data-gotry-artifact-status': 'error', style: { padding: '0 14px 12px', margin: 0, color: 'var(--dsw-alias-state-error-primary, #c44)' } }, text || '未知错误'))
      } else if (!valid) {
        children.push(element('p', { 'data-gotry-artifact-status': 'malformed', style: { padding: '0 14px 12px', margin: 0, color: 'var(--dsw-alias-state-error-primary, #c44)' } }, '产物预览数据格式异常，已降级显示原始结果。'))
        if (text) children.push(element('pre', { style: { whiteSpace: 'pre-wrap', padding: '0 14px 12px', margin: 0 } }, text))
      } else {
        var version = typeof meta.version === 'string' && meta.version ? meta.version : 'content-refresh'
        children.push(element('div', { 'data-gotry-artifact-identity': 'true', style: { padding: '0 14px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #888)' } },
          '来源：' + String(meta.source || 'unknown') + ' · ' + meta.path + ' · ' + String(meta.totalLines) + ' 行 · 版本：' + version))
        children.push(element('div', { 'data-gotry-artifact-version': version, style: { padding: '0 14px 12px', fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: '13px', lineHeight: '21px', overflowX: 'auto' } },
          meta.lines.map(function (line) {
            return element('div', { key: String(line.number), 'data-gotry-artifact-line': String(line.number), style: { display: 'grid', gridTemplateColumns: '4em 1fr', whiteSpace: 'pre' } }, [
              element('span', { key: 'number', 'aria-hidden': 'true', style: { color: 'var(--dsw-alias-label-caption, #999)', userSelect: 'none', textAlign: 'right', paddingRight: '12px' } }, String(line.number)),
              element('span', { key: 'text' }, line.text || ' '),
            ])
          })))
      }
      var shell = shellProps('read', state)
      if (htmlSource) shell['data-gotry-artifact-source'] = 'html'
      return element('section', shell, children)
    }

    function ArtifactToolView(props) {
      if (props.toolName === 'gotry_artifacts_list') return ArtifactListCard(props)
      return ArtifactReadCard(props)
    }

    function apply(ctx) {
      ctx.inject(['slots'], function (scope) {
        scope.slots.inject('tool.call.toolview', function () {
          return scope.slots.register({ name: 'tool.call.toolview', key: 'gotry_artifacts_list' }, ArtifactToolView)
        })
        scope.slots.inject('tool.call.toolview', function () {
          return scope.slots.register({ name: 'tool.call.toolview', key: 'gotry_artifacts_read' }, ArtifactToolView)
        })
      })
      ctx.inject(['slots', 'locale'], function (scope) {
        var ns = 'gotry.web'
        var t = scope.locale.bind(ns)
        scope.effect(function () { return scope.locale.register(ns, webLocale) })
        scope.slots.inject('plugins.item', function () {
          return scope.slots.register({ name: 'plugins.item', id: 'gotry', order: 50, label: function () { return t('title') }, locale: ns }, FlyaiSettings)
        })
        scope.inject(['sidebarRightTabs'], function (sidebar) {
          sidebar.effect(function () { return sidebar.sidebarRightTabs.register({ id: '@danceiny/gotry:artifacts', kind: 'gotry-artifacts',
            title: function () { return t('artifacts') }, guide: [{ id: 'gotry-artifacts', order: 15, title: function () { return t('artifacts') }, description: function () { return t('artifactsHint') } }] }) })
          sidebar.slots.inject('sidebar.right.pane.tab', function () {
            return sidebar.slots.register({ name: 'sidebar.right.pane.tab', key: '@danceiny/gotry:artifacts', locale: ns }, ArtifactBrowser)
          })
        })
      })
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
