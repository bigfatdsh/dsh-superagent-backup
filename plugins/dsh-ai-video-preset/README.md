# AI Video Studio preset bundle

这个 bundle 声明 **AI 视频导演** 预设，并把 `tool-seedance` 指到工作室的
`tools/bin/ffprobe`、零配置公网 staging 兜底。

版本 1.1.0 起，预设的主线从「白模 + 提示词」升级为 **一致性契约驱动的证据制生产**；1.2.0 加 **机位扫描 `--test`、强制 intake、成本门禁**；1.3.0 加 **材质代理参考视频 + `look` 材质契约 + 1:1 超写实验收**：
成因是 AIsp 工作区那轮《靶场校准》暴露的 9 类事故（镜内切镜、主体偏出、
道具比例漂移、声画落点偏移、跨镜调色漂移、状态不连续、场景自由发明、QA 自证失效）。

### 1.3.0：超写实修复

上一轮"没做出超写实"的根因不是提示词不够重，而是**白模参考里没有可写实化的信息**：
Workbench FLAT + 单一灰 + 白背景 → 模型只能从剪影猜形体 → 照抄"光滑简单体块"。

- `render-shot.mjs --proxy` / `proxy-render.mjs` + `proxy_style.py`：材质代理参考视频
  （材质分区 + STUDIO 光照 + 阴影/空腔/高光 + 中性灰背景，枪口焰等球体代理默认隐藏）
- 契约 `look` 段：机身/焦段/光圈/快门/ISO/色温 + 逐件装备"材质 + 使用痕迹" + 反 CG 排除项；
  `prep-shot.mjs` 自动拼成【摄影与材质】段
- `qa-realism.mjs`：**强制 1:1 裁切** + 纹理能量/颗粒/动态范围三指标
- 预设新增【超写实：参考里必须先有东西】与 F12；`references/realism-playbook.md` 记录复盘

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

# 0. 先问用户 8 项参数（画质/时长/画幅/声音/镜头数/样片策略/调用上限/机位扫描），再确认
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs intake --project projects/<p> --questions
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs intake --project projects/<p> \
  --set "deliveryResolution=720p,durationPerShot=5,shotCount=4,draftPolicy=all,maxPaidCalls=8,maxCallsPerShot=2,requireScan=true" \
  --confirm --note "用户在对话框确认"

# 1. 建契约（骨架）→ 填角色/场景/道具/调色 + 每镜 must_show(带 object) / cues / logic → 校验
node .dsh/skills/ai-video-pipeline/scripts/contract-init.mjs --project projects/<p>
node .dsh/skills/ai-video-pipeline/scripts/contract-init.mjs --project projects/<p> --check

# 2. 机位扫描 --test：候选机位/焦段样张 + 投影对账（免费，pass 之前不许花钱）
node .dsh/skills/ai-video-pipeline/scripts/shot-scan.mjs --test \
  --blend projects/<p>/blockout/scene.blend --project projects/<p> --shot shot_01 \
  --base "from=-1500,-1500,1920;look=600,0,1560" --lenses 50,65,85 --dolly 0.9,1.0

# 3. 从已通过的成片截衔接锚（可选）
node .dsh/skills/ai-video-pipeline/scripts/shot-anchor.mjs \
  --video output/seedance/<taskId>.mp4 --at 4.4 --out projects/<p>/blockout/anchors/shot_01_tail.jpg

# 4. 两级生成：draft（480p）→ 验收 → approve → final
node .dsh/skills/ai-video-pipeline/scripts/prep-shot.mjs --project projects/<p> --shot shot_01 --tier draft
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs gate --project projects/<p> --shot shot_01 --tier draft
# preview → generate → record → status（DSH 工具）
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs record --project projects/<p> \
  --shot shot_01 --tier draft --taskId cgt-xxx --resolution 480p --duration 5
# 看证据 → 合格则
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs approve --project projects/<p> --shot shot_01 --tier draft

# 5. final 同一套流程（--tier final），然后证据制 QA
node .dsh/skills/ai-video-pipeline/scripts/qa-video.mjs --video <mp4> --strict
node .dsh/skills/ai-video-pipeline/scripts/qa-consistency.mjs --project projects/<p>
```

`shot-scan.mjs --test` 的判定：

| 检查 | 阈值（可在契约 `scan.tolerance` 覆盖） |
| --- | --- |
| 主体中心与契约坐标的距离 | ≤ 0.05（画面宽归一化） |
| 主体占宽相对偏差 | ≤ 30% |
| 主体中心是否出画 | 出画即 fail |

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
