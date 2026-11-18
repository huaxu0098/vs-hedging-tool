#!/bin/zsh
set -eu
cd -- "${0:A:h}"

# Reuse the same browser origin so all instruments keep the same local ledger.
url='http://127.0.0.1:4178'
if /usr/bin/curl --silent --fail --max-time 2 "$url/" | /usr/bin/grep -Fq '<title>VS × Hype 多品种动态对冲匹配器</title>'; then
  exec /usr/bin/open "$url/"
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  print -u2 '请先安装 Node.js 22 或更高版本，再打开匹配器。'
  exit 1
fi
PORT=4178 exec node scripts/serve.js --open
