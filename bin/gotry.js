#!/bin/sh
# bin/gotry.js: npm bin entry(sh wrapper,找 node 路径,exec 真正代码 bin/gotry-inner.js)
# 解决 nvm 没 source 时 `env: node: not found`。
# 优先:$PATH → nvm 常见路径 → 系统路径 → 找不到给一次性提示。
# 零新依赖;不改 npm bin 名(强制 .js 后缀),实际 node 代码在 bin/gotry-inner.js。

conf="$(command -v node 2>/dev/null)"
if [ -z "$conf" ] || [ ! -x "$conf" ]; then
  for cand in \
    "$HOME/.nvm/versions/node/v24.16.0/bin/node" \
    "$HOME/.nvm/versions/node/v22.16.0/bin/node" \
    /usr/local/bin/node \
    /opt/homebrew/bin/node
  do
    if [ -x "$cand" ]; then conf="$cand"; break; fi
  done
fi
if [ -z "$conf" ] || [ ! -x "$conf" ]; then
  cat >&2 <<'EOF'
gotry: node not found in PATH. Install Node 22.15+:
  macOS:  brew install node@22  (or use nvm)
  Linux:  https://nodejs.org/

Then re-run: gotry web
EOF
  exit 1
fi
exec "$conf" "$(dirname "$0")/gotry-inner.js" "$@"
