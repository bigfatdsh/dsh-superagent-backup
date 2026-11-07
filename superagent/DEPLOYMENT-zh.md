# dsh-superagent 本机部署说明（2026-11-03）

官方仓库 `deepseek-ai/dsh-superagent-prototype` 的本地部署，包含针对这台机器的改动。
代码本体在 `adapted/dsh-superagent`（可重建），运行态在 `~/.dsh/state/superagent`。

## 一、装在哪

| 东西 | 位置 |
| --- | --- |
| 源码 + 构建产物 | `adapted/dsh-superagent`（`lib/` 为构建输出） |
| 独立 profile | `~/.dsh/profiles/superagent`（从 web 模板复制，端口 3082） |
| 运行状态 | `~/.dsh/state/superagent`（sqlite、worker 垫片、GitHub 桥） |
| 面板 | http://127.0.0.1:3082/ ，token 见 `~/.dsh/state/superagent/logs/launchd.out.log` |
| 自启/守护 | `~/Library/LaunchAgents/com.bigfatdsh.superagent.plist` |

profile 里两个插件：`dsh-superagent`（编排器）与 `dsh-superagent-github`（GitHub 源）。

## 二、网络适配：github.com 不通，只有 api.github.com 通

实测本机 `github.com:22/443` 全部被拒（`ssh.github.com:443` 也拒绝握手），
`api.github.com`、`raw.githubusercontent.com`、`codeload.github.com` 正常。
所以官方那套「git clone / git push 直连 GitHub」在本机必然失败。做了三层适配：

1. **gh 走原样**：GitHub 的 REST API 和 `gh pr`/`gh issue` 全部可用，`gh` 用
   `~/.dsh/state/superagent/bin/gh-agent` 包装，token 从钥匙串取（`bigfatdsh`，repo 权限）。
2. **git 重定向到本地裸仓**：worker 的隔离 gitconfig（每次启动由插件重写）里加了
   `url.file://…/github-bridge/.insteadOf = https://github.com/bigfatdsh/`。
   worker 看到的 URL 仍是 `https://github.com/...`，实际读写本地
   `~/.dsh/state/superagent/github-bridge/superagent-sandbox.git`。
3. **本地裸仓 push 后同步到 GitHub**：`hooks/post-receive` 调
   `bridge/github-bridge.mjs export <ref>`，用 Git Data API（blobs → trees → commits → refs）
   把提交送上去。本地 sha 与 GitHub sha 的对应关系记在 `bridge-map.json`，所以后续提交
   仍挂在同一条历史上，`gh pr create` 能正常开 PR。

已验证：worker 式 clone（URL 仍是 https）、push 分支、GitHub 上出现分支、`gh pr create`
开出 PR（probe 用的 PR #1 已关闭、分支已删）。

注意：桥只做了「本地 → GitHub」的推送。GitHub 上合并 PR 后本地裸仓不会自动跟进，
需要手工 `github-bridge.mjs import refs/heads/main`（或在面板里重开一个分支从 main 起）。

`bridge/github-bridge.mjs` 需要的两个环境变量由 LaunchAgent 注入：
`SUPERAGENT_GIT_BRIDGE_DIR`、`SUPERAGENT_GIT_BRIDGE_PREFIX`。

## 三、启动 / 状态 / 重启

```sh
# 状态（launchd）
launchctl print gui/$(id -u)/com.bigfatdsh.superagent | grep -E "state|pid"
# 面板健康
curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/state | jq .health
# 重启
launchctl kickstart -k gui/$(id -u)/com.bigfatdsh.superagent
# 停
launchctl bootout gui/$(id -u)/com.bigfatdsh.superagent
# 日志
tail -f ~/.dsh/state/superagent/logs/launchd.out.log
```

官方 `scripts/dsh-superagent start|stop|status` 依赖 tmux，本机没有 tmux，改用 launchd：
开机自启、崩溃 15 秒后重启。

## 四、已调的参数

| 设置 | 值 | 原因 |
| --- | --- | --- |
| `executor.maxWorkers` | 2 | 8GB 内存，官方默认 3 |
| `executor.model` | 空（跟 profile 默认） | 本机只有 `deepseek-flash` |
| `agent-default-model` | `deepseek-account` / `deepseek-flash` / high | 用账号登录态，不需要 DEEPSEEK_API_KEY |
| 源仓库 | `bigfatdsh/superagent-sandbox`（私有） | 专用沙箱，不碰现有插件仓 |
| 允许的人 | `bigfatdsh` | 只有他能下单 |
| 观察开关 | 新 Issue / 新 PR / 评论 开，CI 关 | 仓库里的动静都收 |
| eval 模式 | `observe` | 主动发现的工作只记录不动手（官方默认） |

## 五、还差一步：第二个 GitHub 账号（这是设计前提，不是 bug）

`src/sources/github.ts` 里有一句 `if (sameName(item.user.login, login)) continue`：
**agent 自己账号发的东西一律不算请求**。现在 agent 和操作者是同一个号（`bigfatdsh`），
所以你开的 issue / 评论会被直接跳过，永远不会有工单 —— 实测 issue #2 确实没进队列。

要用起来，需要一个「提需求的人」不等于「干活的号」：

1. 再注册一个 GitHub 账号（比如 `xxx-requester`），或用你已有的小号；
2. 把它加为 `bigfatdsh/superagent-sandbox` 的 collaborator（Write 权限）；
3. 面板 → Settings → Policy → GitHub 允许名单里加上这个号；
4. 用这个号开 issue，正文写 `@bigfatdsh 要做的事`。

不想再注册号的话，另一个方向是让 agent 用专用账号（官方原意）：建 `xxx-agent`，
把它设成仓库 collaborator，`gh-agent` 换它的 token，允许名单留 `bigfatdsh`。
两种都行，关键是**下单的人和干活的号不能是同一个**。

## 六、改代码后怎么重建

```sh
cd adapted/dsh-superagent
# 注意：必须用 Tuanjie Cowork 的 node 跑 tsdown，DSH 自带 node 有 Team ID 校验，
# 加载 rolldown 原生模块会 ERR_DLOPEN_FAILED
PATH="/Users/yangletian/Library/Application Support/Tuanjie Cowork/bin:$PATH" ./node_modules/.bin/tsdown
launchctl kickstart -k gui/$(id -u)/com.bigfatdsh.superagent
```

依赖安装（pnpm 在 DSH 运行时里）：
```sh
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
PNPM=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs
"$NODE" "$PNPM" install --registry=https://registry.npmmirror.com
```

本仓库相对上游只改了两处：
- `src/infra/environment.ts`：`gitBridge()` 及那行 `...gitBridge()`（本地裸仓重定向）；
- 新增 `bridge/github-bridge.mjs`。

上游更新后重新 patch 这两处即可。

## 七、升级

```sh
cd adapted/dsh-superagent && git pull   # 本机 github.com 不通时用 codeload 下载覆盖
"$NODE" "$PNPM" install --registry=https://registry.npmmirror.com
PATH="/Users/yangletian/Library/Application Support/Tuanjie Cowork/bin:$PATH" ./node_modules/.bin/tsdown
launchctl kickstart -k gui/$(id -u)/com.bigfatdsh.superagent
```
升级前备份 `~/.dsh/state/superagent/orchestrator.sqlite`。
