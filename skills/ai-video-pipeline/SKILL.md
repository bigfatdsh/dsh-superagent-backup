---
name: ai-video-pipeline
description: Blender 白模 → Seedance 2.5 写实视频的完整制片流程：一致性契约、白模、参考包、确定性提示词、生成、证据制 QA 与续写。把随机抽卡变成骨架可控、跨镜一致。
whenToUse: 用户要生成 AI 视频、真人/写实镜头、白模参考、首尾帧、Seedance 任务、镜头分镜、视频续写或视频编辑时。
---

# AI 视频管线：Blender 白模 → Seedance 2.5

> 核心原则：**Blender 负责确定性，Seedance 负责写实化，契约负责一致性。** 先锁定构图、走位、运镜、节奏和首尾帧，再让模型贴皮。不要在第一次生成后就“不满意，重抽整条”。
>
> 三条线：**白模锁运动 → `consistency.json` 锁身份/空间/道具/调色 → `must_show` 锁内容正确性**。缺一条，模型就会用“看起来差不多”的东西把画面填满；成片复盘见 `references/failure-modes.md`。

## 0. 先跑三道门槛

在写任何提示词之前，确认：

1. **Blender 可用**：`node .dsh/skills/ai-video-pipeline/scripts/doctor.mjs`，`blender`/`ffmpeg`/`ffprobe` 三项必须 ok。
2. **Seedance Key 可用**：`seedance_doctor` 里 `api-key` 和 `ark-endpoint` 通过；没有 Key 时只能 `seedance_preview_request`，不能提交。
3. **本地参考视频有公网出口**：Ark 的 `video_url` 只接受公网 `http(s)` URL 或 `asset://`，**不接受 base64 视频**。本地白模 MP4 必须先 `seedance_stage_reference`，或配置 `stagePublicBaseUrl`/`cloudflaredPath`/`stageUploadProvider`。
4. **一致性契约就绪**：`projects/<p>/consistency.json` 存在且 `contract-init.mjs --check` 通过。没有契约不许生成——这一条是 v1.1 新增的硬门。

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

## 3. 白模：先定骨架

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
4. **风格/质感**：写实电影质感、镜头焦段、光线、调色、皮肤肌理。
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

### 5.1 把本地白模 MP4 变成公网 URL

```text
seedance_stage_reference({ path: "projects/my-film/renders/shot_01/shot_01.mp4", kind: "video" })
```

返回 `{ url, expiresAt, via }`。把 `url` 放进 `reference_videos`。

- 也可以用 `stagePublicBaseUrl`（你自己的反代/隧道）或 `cloudflaredPath`。
- `stageUploadProvider: "uguu"` 是零配置兜底（临时公开托管约 3 小时）；只对**非敏感白模 MP4**使用，不要上传角色/客户素材。
- 生产环境优先 TOS/对象存储或 `asset://`。

### 5.2 先预览，不花额度

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

- `brief.md` / `shotlist.json` / **`consistency.json`**（意图、参数、不变量）
- `blockout/anchors/`（角色/场景/道具/衔接锚）
- `renders/<shot>/<shot>.mp4` + `first.png` + `last.png` + `contact.png`（白模证据）
- `prompts/<shot>.txt` + `payload.json`（`prep-shot.mjs` 产出，不手写）
- `output/seedance/<taskId>.mp4` + `qa/video-report.json`
- **`qa/consistency-report.md`** + `qa/consistency/`（证据图：抽帧、must_show 裁剪）
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

## 11. 相关文件

- `references/consistency-contract.md`：`consistency.json` 字段、锚图规则、量化道具、衔接锚
- `references/failure-modes.md`：F1–F9 症状 → 根因 → 修哪一层 → 怎么验证（含实测数据）
- `references/prompt-templates.md`：白模/首尾帧/编辑/延长/对白模板
- `references/qa-checklist.md`：逐项验收清单
- `references/shotlist-format.md`：shotlist 字段说明
- `references/blender-shot-spec.md`：shot builder spec 字段说明
- `scripts/doctor.mjs` / `new-project.mjs` / `render-shot.mjs` / `validate-shotlist.mjs` / `set-ark-key.mjs`
- `scripts/contract-init.mjs`（契约生成/校验）/ `prep-shot.mjs`（确定性提示词）/ `qa-consistency.mjs`（证据制 QA）/ `shot-anchor.mjs`（衔接锚截帧）/ `selftest.mjs`（工具链自测）/ `build-prompt.mjs` / `qa-video.mjs`
