# shot builder spec 字段说明

`render-shot.mjs` 读取一个 JSON，交给 `shot_builder.py` 在 Blender 里搭白模、做走位/运镜、渲染 PNG 帧，再编码 MP4。

## 1. 坐标与单位

- 单位：**毫米（mm）**，写进 spec 的所有 `*_mm` 都是 mm。
- 坐标：+X 为角色前进方向，+Z 向上，+Y 为背景方向。
- 相机默认在 -Y 侧看向 +Y；所以 +X 在画面右侧，是侧跟/侧面视角。
- 3/4 视角：把相机 x 也移动，例如 `from_mm: [-2500, -3500, 1500]`。

## 2. 根字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `name` | 必填 | 文件名安全，如 `shot_01` |
| `fps` | 24 | 12–60 |
| `resolution` | `[1280,720]` | 每边 256–1920 |
| `duration_seconds` | 5 | 0.5–30（Seedance 提交时再按 4–30 校验） |
| `set` | `{}` | 地面/墙/道具 |
| `actor` | `{}` | 人偶 |
| `camera` | 必填 | 机位关键帧 |
| `render` | `{}` | 渲染设置 |

## 3. `set`

```json
{
  "floor": true,
  "walls": [
    { "id": "back", "size_mm": [8000, 100, 3000], "at_mm": [0, 3000, 1500] }
  ],
  "props": [
    { "id": "table", "prim": "box", "size_mm": [1200, 700, 750], "at_mm": [500, 0, 375] },
    { "id": "lamp", "prim": "cylinder", "radius_mm": 180, "depth_mm": 450, "at_mm": [900, -200, 1100] }
  ]
}
```

- `floor`：8m×8m×0.1m 的地面，顶部在 z=0。
- `walls`：可选；白底渲染下会和背景融合，主要提供转角/边界线。
- `props`：`box` / `cylinder` / `sphere`；`prim` 默认 box。
- 所有布景用浅灰材质（0.95），人偶用中灰（0.22），Workbench FLAT + cavity，干净可读。

## 4. `actor`

```json
{
  "enabled": true,
  "height_mm": 1750,
  "start_mm": [-1200, 0, 0],
  "end_mm": [1200, 0, 0],
  "facing_deg": 0,
  "walk": true,
  "walk_cycle_seconds": 1.0,
  "hands": true
}
```

- `height_mm`：总身高；比例按身高缩放。
- `start_mm` / `end_mm`：根节点从 start 线性走到 end；x/y 都会插值。
- `facing_deg`：整体绕 Z 旋转；0 = 面向 +X。
- `walk`：是否摆动四肢。`walk_cycle_seconds` 是一个完整步态周期的秒数；1.0 约等于每秒 2 步。
- `hands`：false 时不建手（用于手部必须不入画的镜头）。
- 人偶由方块/圆柱/球组成：头、颈、胸、骨盆、上臂/前臂/手、大腿/小腿/脚，关节处有球。
- 关节旋转轴是 Y（前后摆），不是 X；不要改成 X，否则腿会向画面内外劈。

## 5. `camera`

```json
{
  "lens_mm": 40,
  "keyframes": [
    { "t": 0, "from_mm": [-1500, -4000, 1450], "look_at_mm": [-1200, 0, 950] },
    { "t": 5, "from_mm": [2000, -4000, 1400], "look_at_mm": [1200, 0, 950] }
  ]
}
```

- `t` 单位秒；内部换算成帧。
- `from_mm` 相机位置；`look_at_mm` 看向点。
- 相机用 TRACK_TO 约束看向一个空物体；关键帧之间用 BEZIER/AUTO_CLAMPED。
- 焦距/距离参考（16:9，全身 1.75m）：
  - 40mm @ 4.0m：全身，留一点边。
  - 50mm @ 4.5–5.0m：更紧的全身/中景。
  - 85mm @ 3.0–3.5m：中近景/特写（头部）。
- 侧跟：相机 y 固定 -4m，x 从 -1.5m 到 +2m，look_at 跟角色。
- 推镜：`from_mm` 逐渐靠近，`look_at_mm` 保持主体。
- 环绕：多个关键帧改变相机 x/y，look_at 固定在主体。

## 6. `render`

```json
{ "engine": "workbench", "background": "white", "first_last": true }
```

- `engine`：目前只用 Workbench（白模最快、最干净）。
- `background`：white / gray / black（默认 white）。
- 渲染设置：FLAT + MATERIAL + cavity，白底，无网格/坐标轴/相机锥体/文字。
- 输出：`frames/frame_%04d.png`，24fps，PNG RGB。
- `first_last`：由 wrapper 复制 `first.png` / `last.png`；`contact.png` 2fps 拼图。

## 7. 已知问题

- **Blender 4.2 上插件的 turntable MP4 可能失败**：`ImageFormatSettings` 没有 `media_type`（4.4+ 才有），会回退 PNG 序列。用 `tools/bin/ffmpeg` 自己编码，或直接用 `render-shot.mjs`。
- **相机通过符号链接启动 Blender 会找不到 bundled Python**：`render-shot.mjs` 已用 `realpathSync` 解析；手动调用时请用真实路径 `/Users/.../Blender.app/Contents/MacOS/Blender`。
- **白模不是高模**：不要加材质、纹理、毛发、手指细节；白模只负责比例/走位/机位/节奏。
- **白模里有啥，模型才可能保留啥**：没有墙/窗/家具，模型会自己发明；要可控场景就在白模里搭出来，或给场景参考图。
- **景别要与白模一致**：白模全身就写全景/WS；写 MS 会诱导模型裁头。

## 8. 最小示例

```json
{
  "name": "shot_01",
  "fps": 24,
  "resolution": [1280, 720],
  "duration_seconds": 5,
  "set": { "floor": true, "walls": [], "props": [] },
  "actor": {
    "enabled": true,
    "height_mm": 1750,
    "start_mm": [-1200, 0, 0],
    "end_mm": [1200, 0, 0],
    "facing_deg": 0,
    "walk": true,
    "walk_cycle_seconds": 1.0,
    "hands": true
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
