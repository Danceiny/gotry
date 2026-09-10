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
          return element('li', { key: path, style: { margin: '4px 0' } }, element('button', {
            type: 'button',
            'data-gotry-artifact-path': path,
            'aria-label': 'Open artifact ' + path,
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
          }, path))
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
      var children = [element('div', { style: { padding: '10px 14px 4px', fontWeight: 600 } }, statusLine(state, 'read'))]
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
      return element('section', shellProps('read', state), children)
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
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
