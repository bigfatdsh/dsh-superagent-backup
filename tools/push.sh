#!/bin/bash
# 把当前提交推到 GitHub（Git Data API，因为 git push 不通）
set -eu
cd "$(dirname "$0")/.."
NODE="${NODE:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"

export GITHUB_BRIDGE_REPO="${GITHUB_BRIDGE_REPO:-bigfatdsh/dsh-superagent-backup}"
if [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then
  GITHUB_TOKEN="$(security find-internet-password -s github.com -w 2>/dev/null || true)"
  export GITHUB_TOKEN
fi
[ -n "${GITHUB_TOKEN:-}" ] || { echo "没有 token（钥匙串里没找到 github.com，或设 GITHUB_TOKEN）" >&2; exit 1; }

exec "$NODE" tools/push.mjs "${1:-refs/heads/main}"
