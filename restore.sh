#!/bin/bash
# super-agent 一键还原（macOS）
# 用法：./restore.sh   （先装好 DeepSeek Harness.app）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"

# ---- 可改的路径（也都能用环境变量覆盖，便于先演练）----
DSH_APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
SRC_DIR="${SRC_DIR:-$HOME/Documents/deepseek-harness/default-workspace/adapted/dsh-superagent}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/.dsh/profiles/superagent}"
LABEL="${LABEL:-com.bigfatdsh.superagent}"
PLIST_DST="${PLIST_DST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
APP_DST="${APP_DST:-$HOME/Desktop/Super Agent.app}"
REGISTRY="${REGISTRY:-https://registry.npmmirror.com}"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31m失败: %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$DSH_APP" ] || die "没找到 $DSH_APP，先装 DeepSeek Harness"

# ---- node / pnpm：优先 DSH 运行时的 ----
RT="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies"
NODE="${NODE:-$RT/node/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "找不到 node（可用 NODE=/path/to/node ./restore.sh 指定）"

PNPM_RUN=()
if [ -n "${PNPM:-}" ]; then PNPM_RUN=("$NODE" "$PNPM")
elif [ -f "$RT/pnpm/bin/pnpm.mjs" ]; then PNPM_RUN=("$NODE" "$RT/pnpm/bin/pnpm.mjs")
elif command -v pnpm >/dev/null 2>&1; then PNPM_RUN=(pnpm); fi

# ---- 1. 插件源码 + 构建产物 ----
say "安装插件到 $SRC_DIR"
mkdir -p "$(dirname "$SRC_DIR")"
mkdir -p "$SRC_DIR"
rsync -a --exclude node_modules --exclude .git "$HERE/superagent/" "$SRC_DIR/"

# 附带插件（视频生成 seedance + AI 视频预设）
BUNDLED_DIR="${BUNDLED_DIR:-$HOME/Documents/deepseek-harness/superagent-plugins}"
if [ -d "$HERE/plugins" ]; then
  say "安装附带插件到 $BUNDLED_DIR"
  mkdir -p "$BUNDLED_DIR"
  for d in "$HERE"/plugins/*/; do
    name="$(basename "$d")"
    mkdir -p "$BUNDLED_DIR/$name"
    rsync -a --exclude node_modules --exclude .git "$d" "$BUNDLED_DIR/$name/"
  done
fi

# 管线 skill（ai-video-pipeline：一致性契约 / 确定性提示词 / 证据制 QA 脚本）
# 预设里的 skill-filesystem 指向 $STUDIO_DIR/.dsh/skills，这里装到同一位置。
STUDIO_DIR="${STUDIO_DIR:-$HOME/Documents/deepseek-harness/ai-video-studio}"
if [ -d "$HERE/skills" ]; then
  say "安装管线 skill 到 $STUDIO_DIR/.dsh/skills"
  mkdir -p "$STUDIO_DIR/.dsh/skills"
  for d in "$HERE"/skills/*/; do
    name="$(basename "$d")"
    mkdir -p "$STUDIO_DIR/.dsh/skills/$name"
    rsync -a --exclude node_modules --exclude __pycache__ "$d" "$STUDIO_DIR/.dsh/skills/$name/"
  done
fi

# ---- 2. profile ----
say "写入 profile $PROFILE_DIR"
mkdir -p "$PROFILE_DIR"
cp "$HERE/profile/cordis.yml" "$HERE/profile/cordis.patch.yml" "$PROFILE_DIR/"
cp "$HERE/profile/pnpm-lock.yaml" "$HERE/profile/pnpm-workspace.yaml" "$PROFILE_DIR/" 2>/dev/null

# link: 依赖改指向本机实际位置：本机有的原样保留，没有的用 plugins/ 里带的，再没有就丢掉
SRC_PKG="$HERE/profile/package.json" DST_PKG="$PROFILE_DIR/package.json" \
SRC_DIR_V="$SRC_DIR" BUNDLED_DIR_V="$BUNDLED_DIR" "$NODE" <<'NODE'
const fs = require('fs')
const path = require('path')
const { SRC_PKG, DST_PKG, SRC_DIR_V, BUNDLED_DIR_V } = process.env
const pkg = JSON.parse(fs.readFileSync(SRC_PKG, 'utf8'))
const drop = []
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (!spec.startsWith('link:')) continue
  const original = spec.slice(5)
  let target
  if (name === 'dsh-superagent') target = SRC_DIR_V
  else if (fs.existsSync(original)) target = original
  else {
    for (const candidate of [path.basename(original), name.split('/').pop()]) {
      const p = path.join(BUNDLED_DIR_V, candidate)
      if (fs.existsSync(path.join(p, 'package.json'))) { target = p; break }
    }
  }
  if (!target) { drop.push(name); delete pkg.dependencies[name]; continue }
  pkg.dependencies[name] = `link:${target}`
  if (target !== original) console.log(`${name}: link -> ${target}`)
}
if (drop.length) {
  pkg.dsh.profile.bundles = (pkg.dsh.profile.bundles ?? []).filter(b => !drop.includes(b))
  console.log('跳过本机没有的插件:', drop.join(', '))
}
fs.writeFileSync(DST_PKG, JSON.stringify(pkg, null, 2) + '\n')
NODE

# ---- 3. 装依赖 ----
if [ ! -d "$PROFILE_DIR/node_modules" ]; then
  if [ ${#PNPM_RUN[@]} -gt 0 ]; then
    say "安装 profile 依赖"
    ( cd "$PROFILE_DIR" && "${PNPM_RUN[@]}" install --registry="$REGISTRY" ) || say "依赖安装有问题，可稍后手动重试"
  else
    say "没有 pnpm，跳过依赖安装"
  fi
fi

# ---- 4. 桌面启动器 ----
say "安装启动器到 $APP_DST"
rm -rf "$APP_DST"
cp -R "$HERE/launcher/Super Agent.app" "$APP_DST"
chmod +x "$APP_DST/Contents/MacOS/launcher"
xattr -dr com.apple.quarantine "$APP_DST" 2>/dev/null
codesign --force --deep --sign - "$APP_DST" >/dev/null 2>&1

# ---- 5. 开机自启 ----
if [ -n "${SKIP_LAUNCHD:-}" ]; then
  say "跳过 LaunchAgent（SKIP_LAUNCHD 已设置）"
  exit 0
fi

say "安装 LaunchAgent"
mkdir -p "$(dirname "$PLIST_DST")"
cp "$HERE/launchd/$LABEL.plist" "$PLIST_DST"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" || die "LaunchAgent 加载失败，看 $PLIST_DST"

# ---- 6. 启动 + 打开 ----
say "启动服务"
launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1
for _ in $(seq 1 120); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3082/)" != "000" ] && break
  sleep 0.5
done

say "完成。以后双击桌面 Super Agent.app 即可打开面板。"
