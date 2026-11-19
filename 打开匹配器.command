#!/bin/zsh
set -eu
cd -- "${0:A:h}"

# Reuse the live calculator and its confirmed local snapshots.
url='http://127.0.0.1:4181'
if /usr/bin/curl --silent --fail --max-time 2 "$url/" | /usr/bin/grep -Fq '<title>实时对冲计算 · VS × Hype</title>'; then
  exec /usr/bin/open "$url/"
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  print -u2 '请先安装 Node.js 22 或更高版本，再打开匹配器。'
  exit 1
fi
PORT=4181 exec node scripts/serve.js --hedge --open
