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
| `plugins/dsh-plugin-seedance/` | 视频生成插件（Seedance，AI 视频导演用的那个），含 `lib/` |
| `plugins/dsh-ai-video-preset/` | AI 视频预设 bundle **v1.1.0**（声明「AI 视频导演」预设：一致性契约 → 白模 → 生成 → 证据制 QA；把 seedance 指向 ffprobe / ARK） |
| `skills/ai-video-pipeline/` | 管线 skill：`contract-init` / `prep-shot` / `qa-consistency` / `shot-anchor` / `selftest` 脚本 + 契约与失败模式手册 |
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

脚本会：装插件（含视频生成）→ 装管线 skill 到 `$STUDIO_DIR/.dsh/skills` → 装 profile → 把 app 放到桌面 → 装 LaunchAgent → 装依赖 → 启动服务。

`STUDIO_DIR` 默认 `~/Documents/deepseek-harness/ai-video-studio`，可用环境变量覆盖；
**如果改了它，要同步改 `plugins/dsh-ai-video-preset/cordis.patch.yml` 里
`skill-filesystem.customSkillDirs` 和 `tool-seedance.ffprobePath` 的绝对路径。**
**需要先装好 DeepSeek Harness.app**（本备份对应 0.2.2-rc.1），并且把 `superagent/` 放到
脚本默认期望的位置（或改 `restore.sh` 顶部的路径变量）。

想先演练（不动真实目录、不碰 launchd）：

```sh
SRC_DIR=/tmp/t/src PROFILE_DIR=/tmp/t/profile APP_DST="/tmp/t/Super Agent.app" \
SKIP_LAUNCHD=1 ./restore.sh
```

路径变量都能用环境变量覆盖：`DSH_APP` `SRC_DIR` `BUNDLED_DIR` `STUDIO_DIR` `PROFILE_DIR` `PLIST_DST` `APP_DST` `LABEL` `REGISTRY`。

## v1.1 变更（2026-11-07 晚）

预设从「白模 + 提示词」升级为 **一致性契约驱动的证据制生产**，因为 AIsp 工作区《靶场校准》
那轮成片暴露了 9 类事故（镜内尾段切机位、POV 主体偏出、靶环比例漂移、声画偏差到 1.27s、
跨镜调色漂移、弹孔跳动、场景自由发明、QA 自证失效）。

- 预设 persona 重写为 10 节硬协议：第 0 原则 / 开工前三道门槛 + 契约 / 一致性七条铁律 /
  内容正确性先算再写 / API 与合规硬约束 / 每镜生成协议 / F1–F9 失败分类 / 证据制验收 /
  交付格式 / 沟通。
- 新增管线脚本：`contract-init`（契约生成校验）、`prep-shot`（确定性提示词 + 禁词拦截 +
  负向词去重）、`qa-consistency`（技术/声画/调色/镜内跳变/must_show 证据）、
  `shot-anchor`（衔接锚）、`selftest`（工具链自测）。
- `verify-all.sh` 增加自测门；`new-project.mjs` 现在会顺手生成 `consistency.json` 骨架。
- 用真实成片复盘：`qa-consistency` 在《靶场校准》v3 上抓出 **6 处硬失败 + 5 处警告**，
  与人工判读一致（镜内跳变 0.212@4.54s、声画最大偏差 1.27s、shot_03 亮度 Δ-0.072 等）。

**注意**：这套脚本依赖 `$STUDIO_DIR/tools/bin/{ffmpeg,ffprobe}` 和 Python/ffmpeg 环境；
换机后如果 studio 没装，`qa-consistency` 与 `prep-shot` 会报找不到 ffmpeg。

## 更新这份备份

```sh
git add -A && git commit -m "update: ..."
./tools/push.sh
```

`push.sh` 走 GitHub Data API（本机 `git push` 不通），token 从钥匙串取
（`security find-internet-password -s github.com`），也能用 `GITHUB_TOKEN=...` 覆盖。

## 注意

- **视频生成要自己配 key**：Seedance 读 `~/.dsh/secrets/ark-api-key`（或环境变量
  `ARK_API_KEY`），备份里不含任何密钥。没有 key 时插件仍会加载，只是生成任务会报错。
- `plugins/dsh-ai-video-preset/cordis.patch.yml` 里的 `ffprobePath`、`skill-filesystem.customSkillDirs`
  都是写死的本机路径（`~/Documents/deepseek-harness/ai-video-studio/...`），换机要改成自己的，
  否则「参考视频探测」和 skill 加载会失败。
- **改完预设必须重装 bundle 或重启 app**：profile 在启动时组合，改源文件不会热更新。
- 还原时 `restore.sh` 把附带插件装到 `~/Documents/deepseek-harness/superagent-plugins/`，
  并把 profile 里对应的 `link:` 依赖改指向那里；本机原路径还在的话优先用原路径。
- 运行态不在这里：`~/.dsh/state/superagent`（sqlite 历史、worker 垫片、GitHub 桥裸仓）
  和日志（含面板 token）都没备份，首次启动会重新生成。
- 本机 `github.com` 不通、只有 `api.github.com` 通，所以插件里带了
  `superagent/bridge/github-bridge.mjs`（本地裸仓 post-receive → Git Data API 推送）。
  换到网络正常的环境可以不启用。
- `gh` 需要从 macOS 钥匙串取 token（`security find-internet-password -s github.com`），
  备份里不含任何凭据。
