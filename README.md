# super-agent 本机部署备份

DeepSeek Harness（DSH）上的 **super-agent** 面板 + 专属插件 + 一键启动 app 的完整快照，
用于换机 / 重装后还原。来源：本机 `~/Documents/deepseek-harness/default-workspace/adapted/dsh-superagent`
与 `~/.dsh/profiles/superagent`，2026-11-07 打包。

上游原型：`deepseek-ai/dsh-superagent-prototype` @ `8c32a9dc`（2026-10-31），本机只有
`src/infra/environment.ts` 一处改动 + 新增 `bridge/`、`DEPLOYMENT-zh.md`。

## 里面有什么

| 目录 | 内容 |
| --- | --- |
| `superagent/` | 插件源码 + **构建产物 `lib/`**（含 `lib/client.js`，即面板前端）+ 文档 + 桥接脚本 |
| `profile/` | superagent 独立 profile 的配置（cordis.yml / cordis.patch.yml / package.json / lock），不含 node_modules |
| `launcher/Super Agent.app` | 桌面一键启动 app：服务没跑就拉起 → 取最新 token → 开浏览器 |
| `launchd/` | LaunchAgent plist，开机自启 + 崩溃重启 |
| `restore.sh` | 还原脚本（见下） |

`lib/` 是构建好的，直接可用，不需要重新编译（重编译需要 Tuanjie Cowork 的 node，见 `superagent/DEPLOYMENT-zh.md`）。

## 还原

```sh
git clone <本仓库> superagent-backup && cd superagent-backup
./restore.sh
```

脚本会：把 app 放到桌面 → 装 profile → 装 LaunchAgent → 装依赖 → 启动服务。
**需要先装好 DeepSeek Harness.app**（本备份对应 0.2.2-rc.1），并且把 `superagent/` 放到
脚本默认期望的位置（或改 `restore.sh` 顶部的路径变量）。

## 注意

- 运行态不在这里：`~/.dsh/state/superagent`（sqlite 历史、worker 垫片、GitHub 桥裸仓）
  和日志（含面板 token）都没备份，首次启动会重新生成。
- 本机 `github.com` 不通、只有 `api.github.com` 通，所以插件里带了
  `superagent/bridge/github-bridge.mjs`（本地裸仓 post-receive → Git Data API 推送）。
  换到网络正常的环境可以不启用。
- `gh` 需要从 macOS 钥匙串取 token（`security find-internet-password -s github.com`），
  备份里不含任何凭据。
