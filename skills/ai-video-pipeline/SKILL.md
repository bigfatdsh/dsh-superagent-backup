---
name: ai-video-pipeline
description: Blender 白模 → Seedance 2.5 写实视频的完整制片流程：一致性契约、白模、参考包、确定性提示词、生成、证据制 QA 与续写。把随机抽卡变成骨架可控、跨镜一致。
whenToUse: 用户要生成 AI 视频、真人/写实镜头、白模参考、首尾帧、Seedance 任务、镜头分镜、视频续写或视频编辑时。
---

# AI 视频管线：Blender 白模 → Seedance 2.5

> 核心原则：**Blender 负责确定性，Seedance 负责写实化，契约负责一致性。** 先锁定构图、走位、运镜、节奏和首尾帧，再让模型贴皮。不要在第一次生成后就“不满意，重抽整条”。
>
> 三条线：**白模锁运动 → `consistency.json` 锁身份/空间/道具/调色 → `must_show` 锁内容正确性**。缺一条，模型就会用“看起来差不多”的东西把画面填满；成片复盘见 `references/failure-modes.md`。

## 0. 开工前五道门

在写任何提示词之前，确认：

0. **用户已确认制片参数**：`produce.mjs intake --questions` 的 8 项（画质/时长/画幅/声音/镜头数/样片策略/调用上限/机位扫描）必须**问过用户**并 `--confirm`。没确认，`produce.mjs gate` 会拒绝一切付费提交。详见 `references/cost-control.md`。
1. **Blender 可用**：`node .dsh/skills/ai-video-pipeline/scripts/doctor.mjs`，`blender`/`ffmpeg`/`ffprobe` 三项必须 ok。
2. **Seedance Key 可用**：`seedance_doctor` 里 `api-key` 和 `ark-endpoint` 通过；没有 Key 时只能 `seedance_preview_request`，不能提交。
3. **本地参考视频有公网出口**：Ark 的 `video_url` 只接受公网 `http(s)` URL 或 `asset://`，**不接受 base64 视频**。本地白模 MP4 必须先 `seedance_stage_reference`，或配置 `stagePublicBaseUrl`/`cloudflaredPath`/`stageUploadProvider`。
4. **一致性契约就绪**：`projects/<p>/consistency.json` 存在且 `contract-init.mjs --check` 通过。
5. **机位扫描通过**：`shot-scan.mjs --test` 对每个要用白模的镜头给 `verdict=pass`。

缺失任何一项，先停下修门槛，不要用“模型应该能猜”来绕过。

## 1. 建项目

```bash
cd /Users/yangletian/Documents/deepseek-harness/ai-video-studio
node .dsh/skills/ai-video-pipeline/scripts/new-project.mjs \
  --name my-film --title "我的短片" --duration 5 --ratio 16:9 --resolution 1280x720
```

目录约定：

```
projects/<name>/
  brief.md                 # 一句话、角色、场景、镜头清单、硬约束、验收
  shotlist.json            # 全片分镜 + 素材映射
  shot_01.json             # 单个镜头的白模 spec（走位/相机关键帧）
  refs/character/          # AI 生成的虚拟人像参考（不要放未授权真人）
  refs/scene/  refs/props/
  blockout/                # 白模 .blend / GLB / 参考包
  renders/shot_01/         # frames/、shot_01.mp4、first.png、last.png、contact.png
  output/seedance/         # Seedance 下载的成片
  prompts/                 # 每镜最终提示词
  qa/                      # 渲染/成片 QA 报告
```

## 2. 把需求变成 shotlist

`shotlist.json` 最少包含：

```json
{
  "project": "my-film",
  "title": "我的短片",
  "format": { "ratio": "16:9", "resolution": [1280, 720], "fps": 24 },
  "global": {
    "style": "写实电影质感，自然光影，35mm 胶片颗粒，真实皮肤肌理",
    "character_description": "30 岁女性，黑色短发，浅灰针织衫，深色长裤，自然肤色",
    "scene_description": "傍晚旧公寓客厅，窗外冷蓝余晖，室内暖色台灯",
    "characters": [], "scenes": [], "props": [],
    "negative": "无字幕、无水印、无logo"
  },
  "shots": [
    {
      "id": "shot_01",
      "duration": 5,
      "shot_size": "MS",
      "camera": "镜头缓慢跟随人物向右移动，保持中景，轻微手持呼吸感",
      "action": "人物从左向右走过房间，停在窗边，转头看向窗外",
      "dialogue": "",
      "hand_policy": "out_of_frame",
      "fast_turn": false,
      "blockout": { "spec": "shot_01.json", "mp4": "renders/shot_01/shot_01.mp4" },
      "seedance": {
        "mode": "reference",
        "omni_reference_task_type": "reference",
        "ratio": "16:9",
        "duration": 5,
        "generate_audio": false,
        "whitemodel": true,
        "reference_images": [],
        "reference_videos": ["renders/shot_01/shot_01.mp4"]
      }
    }
  ]
}
```

硬规则：

- **时长 4–30 秒或 -1**；没有 3 秒。`edit` 必须是 -1。
- **首帧/首尾帧、edit、extend 的 `ratio` 只能是 `adaptive`**。
- 白模参考必须显式 `omni_reference_task_type: "reference"`，并在提示词里避开“修改/替换/延长/续写”等会触发 edit/extend 的词。
- 参考素材按顺序编号：`@图片1` = `reference_images[0]`，`@视频1` = `reference_videos[0]`。先按人物首次出场顺序排图。
- `hand_policy` 用 `out_of_frame` 或 `occluded`；`fast_turn`/`multi_person_contact` 为 true 时先拆镜头。
- 真人脸：Seedance 会拦截直接上传的真人参考图/视频。只用 AI 生成的虚拟人像、预置数字人、或已授权 `asset://`。风格化/3D/插画角色不受限。

校验：

```bash
node .dsh/skills/ai-video-pipeline/scripts/validate-shotlist.mjs \
  --file projects/my-film/shotlist.json --root projects/my-film
```

## 2.5 一致性契约：生成前必须写死（v1.1）

`shotlist.json` 决定**怎么生成**，`consistency.json` 决定**什么不许变**。两者都要有。

```bash
node .dsh/skills/ai-video-pipeline/scripts/contract-init.mjs --project projects/my-film
# 填角色/场景/道具/调色 + 每镜 must_show / cues / logic
node .dsh/skills/ai-video-pipeline/scripts/contract-init.mjs --project projects/my-film --check
```

契约里必须写死的四类东西：

1. **锚图**：`character.jpg`、`scene.jpg`、每个道具一张特写；必要时加下一镜要用的
   上一镜尾帧 `<shot>_tail.jpg`（`shot-anchor.mjs` 从**已通过**的成片截）。
2. **锁定项**：每个主体 3-6 条"可对照像素"的特征，不写形容词。
3. **道具量化比例**：环外径/纸宽、环宽/外径、环心坐标这类比值。
4. **每镜内容正确性**：`must_show`（必须可见 + 归一化位置 + 占宽）、`cues`（秒级时间点）、
   `logic`（物理/因果）。

规则细节见 `references/consistency-contract.md`。三条最容易被忽略的：

- **锚图 > 文字**。文字与锚图冲突时，模型会二选一，你控制不了它选哪个。删文字。
- **锚图只能来自已验收素材**。拿未验收的生成帧当锚 = 把错误固化成契约。
- **参考图顺序固定**：`@图片1` 角色 → `@图片2` 场景 → `@图片3…` 道具 → 最后衔接尾帧；
  同一张图只占一个编号（`prep-shot.mjs` 自动去重）。

## 2.6 机位扫描 `--test`：付费前把构图定死

机位是**免费**的。Blender 单帧 640×360 只要 1–2 秒，而一条 1080p 5 秒 = 25 成本指数。
上一轮 9 次生成里 6 次返工，5 次是"构图/主体不对"——这一节就是专门消灭这类返工。

```bash
node .dsh/skills/ai-video-pipeline/scripts/shot-scan.mjs --test \
  --blend projects/my-film/blockout/scene.blend \
  --project projects/my-film --shot shot_01 \
  --base "from=-1500,-1500,1920;look=600,0,1560" \
  --lenses 50,65,85 --dolly 0.9,1.0 \
  --out projects/my-film/blockout/scan/shot_01
```

它做三件事：

1. 每个候选（焦段 × 推拉）渲一张样张，拼成带标签的 `contact.png`（按评分排序，最好的在左上）。
2. 用 Blender 把 `must_show[].object` 的**投影位置/占宽**算出来，与契约的 `at/size` 对账。
3. 给结论：`pass`（可以进 Seedance）/ `fail`（回白模或改契约）/ `unscored`（只出图）。

判定（可在契约里用 `scan.tolerance` 覆盖）：

| 项 | 默认容差 | 含义 |
| --- | --- | --- |
| `position` | 0.05 | 主体中心与契约坐标的距离，归一化画面宽 |
| `size` | 0.30 | 占宽相对偏差 |

`verdict=fail` 时退出码是 1，`produce.mjs gate` 也会拒绝——**扫描不过不许花钱**。

关键规则：

- **契约的 `at/size` 必须来自白模扫描的实测值**，不能从成片回填（那是把模型漂移写成标准）。
- `must_show` 要带 `object` 字段（白模里的物体名），否则只能出图不能对账。
- 扫描 contact 要人看一眼：位置对了但景别/遮挡不对，仍然要改。
- 白模里没有的主体（例如 shot_01 的纸靶不在过肩构图里），扫描会直接判"出画"——**先修白模，别指望提示词**。

## 3. 白模：先定骨架

### 3.0 参考视频用「材质代理」，不要用平涂灰模

平涂白模（Workbench FLAT + 单一灰 + 白背景）只能锁骨架。实测它渲出来**没有任何明暗与材质信息**，
模型只能从剪影猜形体，于是把一切画成"光滑的简单体块"——这就是上一轮塑料感头盔、
融成一坨的手枪、无缝线手套的来源（见 `references/realism-playbook.md`）。

```bash
# 新镜头：直接出代理参考视频
node .dsh/skills/ai-video-pipeline/scripts/render-shot.mjs \
  --spec projects/my-film/shot_01.json --out projects/my-film/renders/shot_01 --proxy

# 已有 .blend：不改工程，渲代理（可同时渲 gray 做 A/B）
node .dsh/skills/ai-video-pipeline/scripts/proxy-render.mjs \
  --blend projects/my-film/blockout/scene.blend --camera shot_01_cam --frames 1-120 \
  --out projects/my-film/blockout/proxy/shot_01 --style proxy
```

代理做了什么：按物体名分材质区（皮肤/织物/装备/金属/纸/混凝土/黄铜）、平滑着色、
STUDIO 光照 + 阴影 + 空腔 + 高光、中性灰背景；枪口焰/粉尘默认隐藏（白模里那是个球）。

分类不对时用 `--map "hand=gear"` 覆盖。**代理颜色是材质约定**：它告诉模型"这块是织物、那块是金属"。

**先看几何预算。** `shot-scan` 会报评估后的多边形数。视频模型会把参考的**拓扑复杂度**一起继承：
5,883 面的山巅场景，成片只能是"低模 + 高级打光"（peak-photoreal 的实际结果）。
门槛：远景 ≥ 2 万、中景 ≥ 8 万、特写 ≥ 20 万。不达标先建模（细分/置换/布料/倒角），
**涂色和提示词都救不回来**。风格化项目写 `look.style: "stylized"` 关掉这个门。

代理解决的是**材质可读性**；**形体可读性**要另外保证：头盔是壳体不是球、枪要有套筒/握把/准星分件、
手套要有拇指与指槽。球+方块的白模，模型只会画成球+方块，代理也救不回来。

### 3.1 有走位/运镜的镜头：用 shot builder

编辑 `shot_01.json`：

```json
{
  "name": "shot_01",
  "fps": 24,
  "resolution": [1280, 720],
  "duration_seconds": 5,
  "set": { "floor": true, "walls": [], "props": [] },
  "actor": {
    "enabled": true, "height_mm": 1750,
    "start_mm": [-1200, 0, 0], "end_mm": [1200, 0, 0],
    "facing_deg": 0, "walk": true, "walk_cycle_seconds": 1.0, "hands": true
  },
  "camera": {
    "lens_mm": 40,
    "keyframes": [
      { "t": 0, "from_mm": [-1500, -4000, 1450], "look_at_mm": [-1200, 0, 950] },
      { "t": 5, "from_mm": [2000, -4000, 1400], "look_at_mm": [1200, 0, 950] }
    ]
  },
  "render": { "engine": "workbench", "background": "white", "first_last": true }
}
```

渲染：

```bash
node .dsh/skills/ai-video-pipeline/scripts/render-shot.mjs \
  --spec projects/my-film/shot_01.json --out projects/my-film/renders/shot_01
```

产物：`shot_01.mp4`（H.264，24fps）、`first.png`、`last.png`、`contact.png`、`frames/`、`shot_01.blend`、`qa/render-report.json`。

要点：

- 白模只解决空间比例、站位/走位、相机机位/运镜，不做精细建模。
- 摄影机用 `lens_mm` + `from_mm/look_at_mm` 关键帧；相机路径线性/贝塞尔平滑。
- 默认白底、浅灰布景、中灰人偶；无网格、无坐标轴、无轨迹线、无相机锥体。
- 走位沿 +X；相机在 -Y 侧看是侧跟。需要 3/4 视角就同时移动相机 x/y。
- 全身镜头 40mm / 4m 左右；中近景 50–85mm / 2–3m。先看 `contact.png`，再决定是否重渲。
- 手部要么用 `hands: false` 去掉，要么用构图切掉/遮挡；不要让 AI 去修手。

### 3.2 只做静物/场景/转台：用 Blender 插件的 blockout 参考包

```text
blender_rt_plan(op="blockout_refsheet", session="auto", args={
  name: "set_A", parts: [...], out_dir: ".../blockout/refsheet", turntable: true
})
```

或转台：

```text
blender_rt_plan(op="blockout_turntable", session="auto", args={
  name: "set_A", out_dir: ".../blockout/turntable", frames: 96, fps: 24, fmt: "mp4"
})
```

注意：Blender 4.2 上插件的 turntable MP4 可能因 `ImageFormatSettings.media_type` 报错并回退 PNG 序列（已知兼容性问题）。这时用工作室的 ffmpeg 自己编码：

```bash
tools/bin/ffmpeg -y -framerate 24 -i <frames>/frame_%04d.png \
  -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart out.mp4
```

### 3.3 白模与提示词对齐（真实跑片复盘）

- **景别必须一致**：白模是全身/全景，`shot_size` 就写全景/WS；写 `MS` 会诱导模型裁头（首条真实任务就踩了这个坑）。
- **白模里没有的东西，模型会自己发明**：只有地板没有墙/窗，模型会补窗、暖气片。可控场景要在白模里搭出来，或给场景参考图。
- **全身镜头手会入画**：prompt 写“手部不入画”不够；要中近景/遮挡，或接受手部并逐帧检查。
- **首帧是最强的构图锁**：需要精确落版时，用 `first_frame` 把构图钉死，比只在 prompt 里写景别可靠。
- **主体位置也要一致**：白模里靶纸占画面多少、在哪个位置，输出就必须一样。文字写“画面正中”，白模给的却是偏左小靶——模型听白模的。把主体在白模里摆到契约位置，再用 `must_show.at/size` 落成可校验的坐标。
- **道具比例要有数字**：文字写“黑色环靶”，每镜可以画得完全不同。给一张道具特写锚图 + `ratios`（环外径/纸宽、环宽/外径）。
- **单镜单机位**：5 秒里塞两个动作单元，模型会在尾段自己“收尾”——通常就是切机位。5s 最多 2 个节拍。
- **参考里没有的，形容词补不上**：平涂灰块 → 模型照抄"光滑简单体块"。参考视频用材质代理，材质/磨损写进契约 `look` 段。

### 3.4 白模验收（硬门）

- 画面里没有轨迹线、坐标轴、网格线、相机锥体、文字/标签。
- 首帧和尾帧构图可读；`contact.png` 能看到走位/运镜变化。
- 人偶比例、脚接地、空间关系合理；没有明显穿模/浮空。
- `qa-video.mjs` 通过：时长、分辨率、fps 与 spec 一致。

```bash
node .dsh/skills/ai-video-pipeline/scripts/qa-video.mjs \
  --video projects/my-film/renders/shot_01/shot_01.mp4 \
  --expect-duration 5 --expect-resolution 1280x720 --expect-fps 24 --strict
```

## 4. 提示词：先映射，再描述，最后约束

**提示词不要手写。** 用 `prep-shot.mjs`：它把契约块原样嵌入、固定素材编号、顺带挡住
会触发 `TaskTypeMismatch` 的措辞和会诱发切镜的话术：

```bash
node .dsh/skills/ai-video-pipeline/scripts/prep-shot.mjs --project projects/my-film --shot shot_01
# 产出 prompts/shot_01.txt + prompts/shot_01.payload.json（payload 直接给 preview/generate）
```

`build-prompt.mjs` 只用于没有契约的快速草稿。

推荐结构（顺序不要乱）：

1. **继承声明**：`参考 @视频1 的运镜、动作路径、角色站位、景别变化、镜头顺序与节奏；白模只提供运动与机位骨架，不要参考它的灰色材质和几何外观。`
2. **素材分工**：`将 @视频1 中的白色人偶映射为 @图片1 的[角色描述]；场景使用 @图片2 的[环境/光线/色温/材质]；道具参考 @图片3。`
3. **镜头/动作**：景别、机位、运镜、主体动作、时间戳（0-2s / 2-5s）。
4. **摄影与材质**：机身/焦段/光圈/快门/ISO/色温 + 逐件装备的"材质 + 使用痕迹"。这一段由 `prep-shot.mjs` 从契约 `look` 段自动生成；没有 `look` 段它会告警。
5. **严格排除**：无字幕/水印/文字；不保留白模材质、轨迹线、坐标轴、网格线、相机锥体；手部不入画；不出现多指/少指/畸形手/身份漂移；避免过度磨皮/蜡感/塑料感。

完整模板见 `references/prompt-templates.md`。

注意：

- 官方 API 没有 `negative_prompt` 和 `motion_strength` 字段。工具会把你给的值并入正向提示词/运动描述，并在返回值里如实报告。
- 负向控制优先用正向描述；只有字幕、水印、音频这类明确项适合写“不要”。
- **负向词要省着用**：插件默认已带质量护栏（字幕/水印/多指/白模材质/轨迹线/相机锥体…），
  再写一遍只会分散注意力。`prep-shot.mjs` 会自动剔除基础护栏，只留"本片特有"的
  （例如"同一画面出现第二把枪"、"靶纸出现弹孔"）。
- 白模参考时，**提示词里不要出现“修改/替换/延长/续写”**，否则模型可能把任务判成 edit/extend，和 `reference` 冲突。
- 参考图按出场顺序编号；先放主角，再放场景/道具。1–5 个主体最稳。

## 5. 提交 Seedance

### 5.0 制片门禁与成本分级（先读）

```bash
# 每次提交前
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs gate --project projects/my-film --shot shot_01 --tier draft
# 提交后立刻记账
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs record --project projects/my-film \
  --shot shot_01 --tier draft --taskId cgt-xxxx --resolution 480p --duration 5
# 样片通过
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs approve --project projects/my-film \
  --shot shot_01 --tier draft --note "骨架/构图/一致性通过"
```

- `draft`（480p）→ `final`（交付画质）。没有 draft 通过记录，`gate` 不放行 `final`。
- 每镜最多 2 次（含 draft）；第 3 次必须改结构并让用户重新确认预算。
- `gate` 拒绝时就停，不许"先跑了再说"。
- 完整成本模型、三种样片策略的账、8 项检查表见 `references/cost-control.md`。

### 5.1 把本地白模 MP4 变成公网 URL

```text
seedance_stage_reference({ path: "projects/my-film/renders/shot_01/shot_01.mp4", kind: "video" })
```

返回 `{ url, expiresAt, via }`。把 `url` 放进 `reference_videos`。

- 也可以用 `stagePublicBaseUrl`（你自己的反代/隧道）或 `cloudflaredPath`。
- `stageUploadProvider: "uguu"` 是零配置兜底（临时公开托管约 3 小时）；只对**非敏感白模 MP4**使用，不要上传角色/客户素材。
- 生产环境优先 TOS/对象存储或 `asset://`。

### 5.2 先预览，不花额度

payload 由 `prep-shot.mjs --tier draft|final` 产出；`--tier draft` 会把 `resolution` 设成 480p 并带 `draft: true`。

```text
seedance_preview_request({
  prompt: "...",
  mode: "reference",
  omni_reference_task_type: "reference",
  reference_videos: ["<staged url>"],
  reference_images: ["refs/character/hero.png", "refs/scene/livingroom.png"],
  whitemodel: true,
  ratio: "16:9",
  duration: 5,
  generate_audio: false
})
```

逐项检查返回：

- `payload.content` 的角色顺序：text → first/last frame → reference_image → reference_video → reference_audio。
- `payload.omni_reference_task_type` 是 `reference`（白模参考）。
- `payload.ratio` 是 `16:9`（参考模式）或 `adaptive`（首尾帧/edit/extend）。
- `payload.duration` 是 4–30 或 -1；不是 3。
- `requestBytes` 没接近 64MB。
- `warnings`：真人脸、白模关键词、duration/ratio 调整都要如实转述。

### 5.3 提交

```text
seedance_generate_video({ /* 与 preview 相同参数 */ })
```

返回 `taskId`、`status`、`finalPrompt`、`warnings`。把 `taskId` 告诉用户，不要编造完成状态。

```text
seedance_video_status({ taskId: "<id>", wait: true })
```

成功后会下载到 `output/seedance/<taskId>.mp4`，并返回 `localPath`、`video`（ffprobe 元数据）。

## 6. 成片验收：先骨架，再身份，再细节

按顺序，不要跳：

1. **运动骨架**：镜头顺序、机位变化、主体走位、景别、节奏是否与白模一致？不一致 → 回 Blender 改白模，不要反复抽卡。
2. **身份**：脸、发型、服装、体型、年龄是否稳定？漂移 → 减少参考主体、按出场顺序排图、加“同一角色、不要双胞胎/分身”。
3. **手部**：有没有多指/少指/畸形/穿模？有 → 下一镜改构图（手不入画/遮挡/中近景），不要指望模型修。
4. **皮肤/材质**：是否过度磨皮、蜡感、塑料感、CG 感？加“真实皮肤肌理、毛孔、细纹、自然高光”。
5. **动态**：有没有果冻、脚滑、肢体融合、背景扭曲、快速转身崩坏？
6. **干净度**：有没有白模材质、轨迹线、坐标轴、相机锥体、字幕/水印泄漏？
7. **技术**：时长、分辨率、fps、编码、音轨。

QA 命令：

```bash
node .dsh/skills/ai-video-pipeline/scripts/qa-video.mjs \
  --video projects/my-film/output/seedance/<taskId>.mp4 \
  --expect-duration 5 --expect-resolution 1280x720 --expect-fps 24 --strict
```

### 6.1 证据制验收（v1.1）：机器判能量化的，人判只能目视的

技术 QA 通过 ≠ 片子可用。再跑一致性 QA：

```bash
node .dsh/skills/ai-video-pipeline/scripts/qa-consistency.mjs \
  --project projects/my-film \
  --video-dir ../../output/seedance        # 成片不在 project 内时指定
# 可单镜覆盖：--video shot_01=/abs/path.mp4
```

它输出 `qa/consistency-report.md` + `qa/consistency-report.json` + 证据图：

| 检查 | 判定 | 证据 |
| --- | --- | --- |
| 技术参数 | 时长差 >0.6s、分辨率或 fps 不符 = 硬失败 | 表 1 |
| 声画/动作落点 | 声明 `cue` 与实际音频峰值偏差 >0.2s = 硬失败 | 表 2 |
| 跨镜调色 | 亮度偏离 >0.05 或饱和度相对偏差 >25% = 警告 | 表 3 |
| 硬切亮度 | 相邻镜亮度差 >0.08 = 警告 | 表 3 |
| 镜内跳变 | 布局相关系数 <0.22 = 切镜/尾段换机位（硬失败）；0.22–0.45 = 需确认 | 表 4 |
| must_show | 按契约坐标裁图；裁空 = 主体没到位 | `qa/consistency/<shot>-msNN-*.png` |
| 每镜抽帧 | 6 帧条带，逐帧看身份/手部/材质 | `qa/consistency/<shot>-strip.png` |

**身份、手部、材质、场景结构机器判不了。** 报告里它们固定出现在「未验证项」，
你必须看过证据图后再下结论；没看就写“未验证”，不许写“通过”。

声画那一条尤其重要：模型音频的落点由模型自己决定，实测偏差可达 1.27s。
**时间敏感的动作一律 `generate_audio=false`，后期按帧配音。**

### 6.2 超写实验收：只认 1:1

```bash
node .dsh/skills/ai-video-pipeline/scripts/qa-realism.mjs --project projects/my-film
```

- 强制 **1:1 裁切**（不缩放）出证据图：`qa/realism/<shot>-<crop>.png`。
- 三个数字：`detail`（纹理能量）、`grain`（高频残差）、`range`（动态范围）。
- 阈值按**单个作物**设 `minDetail`（纸/墙面这类本来就光滑的单独放宽），不要全局放水。
- `grain` 压缩后会失真，只作提示不参与硬判定。
- 这些指标只能指出"过于平滑/过于干净/光太平"，**不能证明照片级**——身份与材质必须看 1:1 图。

实测基准（576×576）：平涂白模 detail 0.0027；上一轮成片盔壳 0.0083 / 手枪 0.0036；
同一帧加颗粒后 0.0158。低于 0.010 基本就是"光滑塑料"。

## 7. 局部精修与续写

### 7.1 只改局部，不重抽整条

Seedance 2.5 支持基于时间戳的编辑。把原片变成公网 URL/`asset://`，然后：

```text
seedance_generate_video({
  prompt: "仅编辑 @视频1 中 2-4 秒的角色外套，从灰色改为深蓝色；其余人物、动作、机位、光线、背景保持不变。",
  mode: "edit",
  omni_reference_task_type: "edit",
  reference_videos: ["<原片公网 URL>"],
  ratio: "adaptive",
  duration: -1,
  output_format: "mov",
  generate_audio: false
})
```

- `edit` 必须：`ratio=adaptive`、`duration=-1`、至少一个 `reference_video`、源视频 4–30s。
- 提示词要含“编辑视频/增加/删除/修改/替换/改成”之一。
- 建议 `output_format: "mov"`。

### 7.2 续写

```text
seedance_generate_video({
  prompt: "向后延长 @视频1 5 秒：人物转身走向门口，镜头继续跟随，光线和服装保持一致。",
  mode: "extend",
  omni_reference_task_type: "extend",
  reference_videos: ["<原片公网 URL>"],
  ratio: "adaptive",
  duration: 10,
  output_format: "mov"
})
```

- `extend` 必须 `ratio=adaptive`，至少一个 `reference_video`；提示词含“延长/续写/延续/向前/向后”。
- 多镜头拼接优先用上一镜的尾帧做下一镜首帧，或保留同一角色参考图 + 同一风格描述。

### 7.3 首尾帧锁定落版

```text
seedance_generate_video({
  prompt: "从首帧自然过渡到尾帧，镜头缓慢推近，人物保持同一身份。",
  mode: "first_last_frame",
  first_frame: "renders/shot_01/first.png",
  last_frame: "renders/shot_01/last.png",
  ratio: "adaptive",
  duration: 5
})
```

- 首尾帧模式与 `reference_*` 互斥，不能混用。
- 首尾帧画幅尽量一致；不一致时以首帧为主，尾帧会被裁剪/拉伸。
- `ratio` 只能 `adaptive`。

## 8. 交付格式

每个镜头至少交付：

- `brief.md` / `shotlist.json` / **`consistency.json`** / **`run.json`**（意图、参数、不变量、预算与账本）
- `blockout/scan/<shot>/`（机位扫描：contact.png / scan.json / scan.md）
- `blockout/anchors/`（角色/场景/道具/衔接锚）
- `renders/<shot>/<shot>.mp4` + `first.png` + `last.png` + `contact.png`（白模证据）
- `prompts/<shot>.txt` + `payload.json`（`prep-shot.mjs` 产出，不手写）
- `output/seedance/<taskId>.mp4` + `qa/video-report.json`
- **`qa/consistency-report.md`** + `qa/consistency/`（证据图：抽帧、must_show 裁剪）
- `run.json` 的 `ledger`：每次调用的 taskId / tier / 分辨率 / 时长 / 成本指数
- 一句话结论：骨架/一致性/内容正确性/技术各自是否通过，还有哪些「未验证」。

最终回答不要只报“生成了”。要报：**taskId、localPath、实际 duration/ratio/resolution、
QA verdict、warnings、证据路径**，以及失败项对应的 F 编号和修复动作。

## 9. 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| `API key is required` / 找不到 Key | 环境变量/Key 文件缺失 | `printf '%s' "$ARK_API_KEY" \| node scripts/set-ark-key.mjs --stdin`，或 `seedance_doctor` |
| `TaskTypeConstraint` | 首尾帧/edit/extend 的 ratio/duration 不合法 | 首尾帧/edit/extend 一律 `adaptive`；edit `duration=-1` |
| `TaskTypeMismatch` | 提示词意图与 `omni_reference_task_type` 冲突 | 白模参考用 `reference` 且删掉“修改/延长”词；真 edit/extend 就显式设对应类型 |
| `InvalidParameter` / model not found | 用了不存在的 `...-pro-250906` | 用 `doubao-seedance-2-5-260628`（INTL：`dreamina-seedance-2-5-260628`）或控制台 `ep-...` |
| `video_url` 不合法 | 传了本地路径/base64 视频 | `seedance_stage_reference` 或公网 URL/`asset://` |
| 真人脸被拒 | 参考素材含真人脸 | 换 AI 虚拟人像/预置数字人/授权 `asset://` |
| 白模轨迹线/坐标轴泄漏 | 渲染时开了 overlays | 用 `render-shot.mjs`（无 overlays）或 `blockout_refsheet`；检查 `contact.png` |
| Blender turntable MP4 失败 | 4.2 缺 `ImageFormatSettings.media_type` | 用 PNG 序列 + `tools/bin/ffmpeg` 编码 |
| 角色漂移/换脸 | 参考图太多/顺序乱/描述弱 | 按出场顺序排图，1–5 个主体，明确“同一角色、不要分身” |
| 手部畸形 | 手入画/复杂交互 | 手不入画、遮挡、拆单人镜头；不要靠重抽修手 |
| 皮肤蜡感/塑料感 | 过度磨皮/负面词不足 | 加“真实皮肤肌理、毛孔、细纹、自然高光”，避免“磨皮/美颜” |
| 快速转身崩坏 | 模型对快速转身不稳定 | 切镜、拆分、用首尾帧锁定 |
| 尾段自己切到别的机位 | 单镜塞太多动作 / 文案有“最后…” / 无单机位约束 | 删结尾动作、5s 最多 2 拍、加“全片一个机位”；`prep-shot` 会警告切镜措辞 |
| POV 里主体不在准星前 | 白模里主体位置不对，模型只听白模 | 改白模把主体摆到契约位置，写 `must_show.at`，按裁剪图核对 |
| 靶环/靶架每镜不同 | 道具没有锚图和量化比例 | 单一道具锚图 + `ratios`，每镜必带 |
| 枪声比画面晚 0.8s 以上 | 依赖模型音频对齐 | `generate_audio=false` + 后期配音；`qa-consistency` 声画表 |
| 某镜明显更暗/更灰 | 无统一调色 | 全片统一调色，卡亮度/饱和度阈值 |
| 弹孔跳动、纸边变形 | 要求模型跨帧维持状态 | 只写单次事件，累计效果后期合成 |
| QA 说通过但画面有硬伤 | 验收无证据、无阈值 | `qa-consistency` + 每条结论附证据路径；机器判不了的写“未验证” |
| `gate` 拒绝 | 没确认 / 没契约 / 没机位扫描 / 提示词过期 / 超预算 | 看 `reasons` 逐条修；不要绕过 |
| `shot-scan` verdict=fail | 主体位置/占宽与契约不符，或主体出画 | 改白模机位或改契约 `at/size`（改后重扫） |
| 扫描 `probe` 未测到 | `object` 名写错/被隐藏/在相机背后 | 用 Blender 里真实的物体名；确认在白模里可见 |
| 预算快超 | 返工多、或没用 draft | `produce.mjs status` 看账；停手改结构 |
| 成片像 CG / 塑料感 | 参考视频是平涂灰模；prompt 只有形容词 | 换材质代理参考 + 补 `look` 段；`qa-realism` 1:1 复核 |
| 金属边缘糊成一团 | 白模里就是几个方块；契约没写机加工细节 | 代理分类确认是 metal；`look.character_materials` 写"磷化钢、棱边磨损" |
| 镜片反光是画上去的白条 | prompt 没指定真实光源关系 | 写清"反射画面里的条形灯"，并把 `look.negative` 加上"画上去的假反射" |
| 手套/织物没有缝线织纹 | 参考里没有，prompt 也没写 | `look` 段写 Cordura/针织/猪皮 + 缝线；1:1 复核 |

## 10. 反模式

- ❌ 不看白模 `contact.png` 就直接提交。
- ❌ 第一次不满意就重抽整条。
- ❌ 把 `negative_prompt`、`motion_strength` 当 API 字段直接传给 Ark。
- ❌ 首尾帧/ edit / extend 传 `ratio: "16:9"`。
- ❌ 传 3 秒时长。
- ❌ 用真人照片做参考图。
- ❌ 把轨迹线、坐标轴、相机锥体渲进白模。
- ❌ 让 AI 生成多人肢体接触、快速转身、手部特写。
- ❌ 把本地 MP4 直接塞进 `reference_videos`（工具会报错，这是保护）。
- ❌ 编造任务 ID、视频 URL、完成状态。
- ❌ 没有 `consistency.json` 就开始生成（没有“什么不许变”的清单）。
- ❌ 拿未验收的生成帧当锚图（把错误固化成契约）。
- ❌ 手写提示词、把契约“换个说法”再写一遍。
- ❌ 一镜塞两个以上动作单元，或在文案里写“最后…拉远/切到”。
- ❌ 要求模型跨帧维持弹孔/烟雾/水渍等累计状态。
- ❌ 时间敏感镜头开模型音频，然后手动对轨。
- ❌ 用“看一眼缩略图”代替带坐标的裁剪证据。
- ❌ 把机器判不了的项（身份/手部/材质）直接写成“通过”。
- ❌ 没问用户就开跑（画质/时长/预算都是用户的钱）。
- ❌ 用 `final` 直接试镜，而不是先出 480p 样片。
- ❌ 把成片里"模型碰巧画对"的位置抄进契约的 `at/size`。
- ❌ 绕过 `produce.mjs gate`，或提交后忘记 `record`。
- ❌ 一次并行盲抽多条镜头。
- ❌ 拿 480p 样片判断画质。
- ❌ 用平涂灰模当参考视频（只能锁骨架，不能写实化）。
- ❌ 只用"超写实/8K/电影感"这类形容词，不写机身/材质/磨损。
- ❌ 拿成片帧当定妆锚（把 CG 感固化成身份标准）。
- ❌ 看缩略图验收超写实。

## 11. 相关文件

- `references/consistency-contract.md`：`consistency.json` 字段、锚图规则、量化道具、衔接锚
- `references/failure-modes.md`：F1–F9 症状 → 根因 → 修哪一层 → 怎么验证（含实测数据）
- `references/prompt-templates.md`：白模/首尾帧/编辑/延长/对白模板
- `references/qa-checklist.md`：逐项验收清单
- `references/shotlist-format.md`：shotlist 字段说明
- `references/blender-shot-spec.md`：shot builder spec 字段说明
- `scripts/doctor.mjs` / `new-project.mjs` / `render-shot.mjs` / `validate-shotlist.mjs` / `set-ark-key.mjs`
- `references/realism-playbook.md`：超写实复盘、材质代理、1:1 验收、反模式
- `references/cost-control.md`：成本指数、三级样片策略的账、8 项门禁、一次通过清单
- `scripts/contract-init.mjs`（契约生成/校验）/ `prep-shot.mjs`（确定性提示词 + tier）/ `qa-consistency.mjs`（证据制 QA）/ `shot-anchor.mjs`（衔接锚截帧）
- `scripts/shot-scan.mjs` + `scan_cameras.py`（机位扫描 `--test`，投影对账）/ `produce.mjs`（intake/plan/gate/record/approve/status）
- `scripts/proxy-render.mjs` + `proxy_render.py` + `proxy_style.py`（材质代理参考视频）/ `qa-realism.mjs`（1:1 超写实验收）
- `scripts/selftest.mjs`（18 项工具链自测）/ `build-prompt.mjs` / `qa-video.mjs`
