# 一致性契约 `consistency.json`

> 一句话：**全片只允许有一份"什么不许变"的清单，并且它是文件，不是记忆。**
>
> 白模锁运动，契约锁身份/空间/道具/调色，`must_show` 锁内容正确性。
> 三者缺一，模型就会用"看起来差不多"的东西把镜头填满。

## 0. 为什么需要它

Seedance 每一镜都是独立采样。跨镜一致性不会自己出现，只能靠三件事：

1. **同一套锚图**（像素级真源）；
2. **同一段契约文字**（逐字复用，不"换个说法"）；
3. **同一套生成后校验**（把漂移量化出来）。

只靠"角色描述写详细点"，第 2 镜就会换一副护目镜；只靠"参考 @图片1"，第 3 镜的靶环粗细
就会变。`《靶场校准》`那轮就是这么翻车的（见 `failure-modes.md`）。

## 1. 位置与生命周期

```
projects/<name>/
  consistency.json      ← 本项目唯一真源，生成任何镜头前必须 --check 通过
  shotlist.json         ← 生产参数（mode/ratio/duration/refs）
  blockout/anchors/     ← 锚图（character.jpg / scene.jpg / 道具特写 / <shot>_tail.jpg）
  prompts/<shot>.txt    ← 由 prep-shot.mjs 生成，不要手写
  qa/consistency/       ← qa-consistency.mjs 产出的证据图
```

生成：

```bash
node .dsh/skills/ai-video-pipeline/scripts/contract-init.mjs --project projects/<name>
# 填完再校验
node .dsh/skills/ai-video-pipeline/scripts/contract-init.mjs --project projects/<name> --check
```

`--check` 是门禁：锚图不存在、`must_show` 为空、cue 超出时长、锁定项少于 3 条，全部报错。

## 2. 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schema` | ✅ | 固定 `1` |
| `project` / `title` | ✅ | 与 shotlist 对齐 |
| `format.ratio` / `resolution` / `fps` | ✅ | 全片统一画幅；生成后 QA 会逐镜比对 |
| `grade.look` | ✅ | 调色一句话。**不是形容词堆砌**，要能指向锚图 |
| `grade.tolerance` | ✅ | `luma`（默认 0.05）、`saturationRelative`（默认 0.25） |
| `subjects.character` | ✅ | 见 §3 |
| `subjects.scene` | ✅ | 见 §3 |
| `subjects.props[]` | ✅（可为空） | 见 §4 |
| `audio.mode` / `tolerance` | ✅ | `post`（后期配音）或 `model`（模型音频）；容差默认 0.2s |
| `global_avoid` | 建议 | 全片通用的本片特有排除项 |
| `shots{}` | ✅ | 见 §5 |

## 3. 角色与场景：锚图 + 锁死项 + 补充

```json
"character": {
  "anchor": "blockout/anchors/character.jpg",
  "text": "约 180cm 男性体型，只露护目镜与眼周，无可辨认真人脸",
  "locked": [
    "沙色战术头盔（侧面导轨 + 前置夜视底座 + 耳杯）",
    "灰蓝色大镜片护目镜与沙色镜框（尺寸以锚图为准）",
    "沙灰色覆面头套包裹到下眼睑，无面部特征",
    "沙色低可视度背心与胸前弹匣袋",
    "深灰作战服 + 沙色战术手套"
  ]
}
```

规则：

1. **锚图是唯一真源。** `text` 只补充锚图看不清的材质、佩戴方式、比例；任何与锚图冲突的
   描述都必须删掉——冲突时模型会二选一，你控制不了它选哪个。
2. **`locked` 至少 3 条，且必须是"可对照像素"的具体特征**，不写"帅气、专业、高级"。
3. 锚图来自**已通过**的成片帧或白模/材质图；**不许**拿未验收的生成帧当锚（会把错误固化）。
4. 每个主体只留一张锚图。新增第二张同类锚图 = 给模型两个矛盾答案。
5. 参考图顺序固定：`@图片1` 角色 → `@图片2` 场景 → `@图片3…` 道具 → 最后才是衔接尾帧。
   同一张图被多处引用时只占一个编号（`prep-shot.mjs` 自动去重）。

### 衔接锚（`anchor_tail`）

上一镜尾帧是唯一能同时锁住**空间、光位、调色、道具状态**的参考。用法：

```bash
node .dsh/skills/ai-video-pipeline/scripts/shot-anchor.mjs \
  --video output/seedance/<taskId>.mp4 --at 4.4 \
  --out projects/<name>/blockout/anchors/shot_01_tail.jpg
```

然后写进下一镜：

```json
"shot_02": { "anchor_tail": "blockout/anchors/shot_01_tail.jpg", ... }
```

适用：同空间相邻硬切、同一主体连续动作。不适用：机位类型完全改变（过肩 → 枪 POV），
此时尾帧里的构图会误导模型，只在需要"同一个房间/同一套光"时才用。

## 4. 道具：锚图 + 量化比例

道具是最容易被"差不多"糊弄过去的东西。文字写"黑色环靶"，模型每镜可以画得完全不同。
必须给**比例数字**：

```json
{
  "id": "paper_target",
  "anchor": "blockout/anchors/paper_target.jpg",
  "text": "米白方纸 + 粗黑圆环，细金属框从两侧夹住",
  "ratios": {
    "ring_outer_diameter_over_width": 0.62,
    "ring_thickness_over_diameter": 0.12,
    "center_x": 0.5,
    "center_y": 0.5
  }
}
```

`prep-shot.mjs` 会把比例翻译成 "环外径/纸宽 62%，环宽/外径 12%" 写进契约块。
`ratios` 的键可以自己定，脚本会原样带上；建议都用"比值"而不是绝对像素。

**最好给每个道具单独一张特写锚图。** 如果道具只出现在场景全景里（比如手枪只在
`scene.jpg` 里），可以复用场景锚图当道具锚，但要在 `text` 里补足识别特征
（"方缺口后照门两侧白点、无红点镜"）。

## 5. 每镜：`must_show` / `cues` / `logic`

```json
"shot_02": {
  "anchor_tail": "",
  "logic": "准星中心与靶心共线；枪口轴线沿画面纵深指向纸靶；不出现可见弹孔",
  "must_show": [
    { "what": "纸靶", "prop": "paper_target", "at": [0.5, 0.34], "size": 0.14 },
    { "what": "枪身前准星", "prop": "pistol", "at": [0.5, 0.78], "size": 0.3 }
  ],
  "cues": [
    { "t": 1.1, "event": "第一次击发" },
    { "t": 2.5, "event": "第二次击发" }
  ],
  "avoid": ["远端靶纸上出现弹孔/黑点/白斑", "纸靶变形或位移"]
}
```

- `must_show[].at` 是**归一化坐标**（0-1），`size` 是**占画面宽度比例**。
  它表达的是"契约要求它在这里"，不是"它现在在这里"。QA 会按这个坐标裁证据图：
  裁出来是墙，就说明主体没到位。
- `must_show[].prop` 指向 `subjects.props[].id`，用来把道具锚图自动带进这一镜。
- `cues[].t` 是秒级时间点，必须落在镜头时长内、升序。`"audio": false` 表示这个节拍
  不参与声画校验（例如纯视觉的枪口焰）。
- `logic` 写**物理/因果**：枪口延长线、视线、运动方向、命中点。这一句是"内容正确性"
  的核心，模型画反方向就是没写清。
- `avoid` 是本镜特有的排除项，会进入 `negative_prompt`。基础护栏（字幕/水印/多指/
  白模材质…）由插件的 `quality_guard` 负责，**不要重复写**，`prep-shot.mjs` 会自动剔除。

## 6. 音频策略

| mode | 含义 | QA 行为 |
| --- | --- | --- |
| `post`（推荐） | 生成时 `generate_audio=false`，后期按帧配音 | 本镜无音轨 → 标记"未验证"，终剪后单独验 |
| `model` | 用模型音频 | 用峰值检测比对 `cues`，偏差 > `tolerance` 硬失败 |

时间敏感的动作（枪声、命中、关门、脚步）一律用 `post`。模型音频的落点由它自己决定，
《靶场校准》实测偏差 0.28–1.27s，剪起来比重新配音贵得多。

## 7. 填空顺序（10 分钟版）

1. `contract-init.mjs` 生成骨架。
2. 从已通过的成片截 3 张锚图：角色、场景、每个道具一张。
3. 每个主体写 3-6 条 `locked`（可对照像素的特征）。
4. 道具补 `ratios`。
5. 每镜写 1-3 条 `must_show`、按分镜写 `cues`、写一句 `logic`。
6. `--check` 通过后，才开始 `prep-shot.mjs`。
