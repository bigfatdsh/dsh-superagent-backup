# AI Video Studio preset bundle

这个 bundle 声明 **AI 视频导演** 预设，并把 `tool-seedance` 指到工作室的
`tools/bin/ffprobe`、零配置公网 staging 兜底。

版本 1.1.0 起，预设的主线从「白模 + 提示词」升级为 **一致性契约驱动的证据制生产**：
成因是 AIsp 工作区那轮《靶场校准》暴露的 9 类事故（镜内切镜、主体偏出、
道具比例漂移、声画落点偏移、跨镜调色漂移、状态不连续、场景自由发明、QA 自证失效）。

## 它声明了什么

- Agent 预设 `ai-video`：
  - persona：10 节硬协议 —— 第 0 原则 / 开工前三道门槛 + 契约 / 一致性七条铁律 /
    内容正确性先算再写 / API 与合规硬约束 / 每镜生成协议 / F1-F9 失败分类 /
    证据制验收 / 交付格式 / 沟通
  - `agent-instructions`（读工作区 `AGENTS.md`，没有也不影响，规则已内置在 persona）
  - `skill-filesystem` + `customSkillDirs` → studio `.dsh/skills`（含 `ai-video-pipeline`）
  - bash / fs / fs-search / jobs / web / todo / ask / present
  - subagent + workflow 委派、compaction + tool-result pruner
- `tool-seedance` 覆盖：
  - 模型 `doubao-seedance-2-5-260628`
  - Key 文件 `~/.dsh/secrets/ark-api-key`
  - `ffprobePath` → `tools/bin/ffprobe`
  - `stageUploadProvider: uguu`（非敏感白模 MP4 的临时公网口；生产换成
    `stagePublicBaseUrl`/TOS）

## 预设强制的工作流

```bash
cd /Users/yangletian/Documents/deepseek-harness/ai-video-studio

# 1. 建契约（骨架）→ 填角色/场景/道具/调色 + 每镜 must_show / cues / logic → 校验
node .dsh/skills/ai-video-pipeline/scripts/contract-init.mjs --project projects/<p>
node .dsh/skills/ai-video-pipeline/scripts/contract-init.mjs --project projects/<p> --check

# 2. 从已通过的成片截衔接锚（可选）
node .dsh/skills/ai-video-pipeline/scripts/shot-anchor.mjs \
  --video output/seedance/<taskId>.mp4 --at 4.4 --out projects/<p>/blockout/anchors/shot_01_tail.jpg

# 3. 确定性生成提示词 + payload（契约块原样嵌入、禁词校验、素材编号固定）
node .dsh/skills/ai-video-pipeline/scripts/prep-shot.mjs --project projects/<p> --shot shot_01

# 4. preview → generate → status（DSH 工具）
# 5. 证据制 QA
node .dsh/skills/ai-video-pipeline/scripts/qa-video.mjs --video <mp4> --strict
node .dsh/skills/ai-video-pipeline/scripts/qa-consistency.mjs --project projects/<p>
```

`qa-consistency.mjs` 的判定阈值：

| 检查 | 硬失败 | 警告 |
| --- | --- | --- |
| 技术参数 | 时长差 >0.6s / 分辨率或 fps 不一致 | — |
| 声画落点 | 声明 cue 与实际峰值偏差 >0.2s | 无声轨或未声明 cue |
| 镜内跳变 | 布局相关系数 <0.22（切镜/尾段换机位） | 0.22–0.45 |
| 跨镜调色 | — | 亮度偏离 >0.05 或饱和度相对偏差 >25% |
| 硬切亮度 | — | 相邻镜亮度差 >0.08 |

身份、手部、材质、场景结构机器判不了，报告明确标「未验证」，并给出
`qa/consistency/<shot>-msNN-*.png` 裁剪证据，逼你落到具体像素上看。

## 安装

通过 DSH Plugin Manager 作为 profile bundle 安装：

```
/Users/yangletian/Documents/deepseek-harness/ai-video-studio/engine/dsh-ai-video-preset
```

或 `plugin_manager` 工具 `action: install_bundle` + 该绝对路径。

**改完预设必须重装 bundle 或重启 app 才生效**（profile 在启动时组合）。

## 使用

1. 打开工作区 `/Users/yangletian/Documents/deepseek-harness/ai-video-studio`
   （或任何需要出片的工作区，例如 `AIsp/`；规则在 persona 里，不依赖工作区文件）。
2. 新建会话 → 选 **AI 视频导演**。
3. 直接说镜头需求。预设会先要契约，再白模，再生成。

## 改 staging

编辑 `cordis.patch.yml` 的 `tool-seedance` 行：

- 生产：`stagePublicBaseUrl: "https://your-tunnel.example"`，`stageUploadProvider: ""`。
- TOS/对象存储：staging 留空，直接把公网 URL 传给 `reference_videos`。
- 敏感素材：绝不用 `uguu`；用 TOS / 自建反代 / `asset://`。

改完要重装 bundle，否则 profile 层不会重新组合。

## 卸载

Plugin Manager 里移除本 bundle。Seedance 插件与 Blender 插件是独立 bundle，分别处理。
