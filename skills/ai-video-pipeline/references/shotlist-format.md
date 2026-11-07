# shotlist 格式与参数矩阵

## 1. 根字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `project` | 是 | 项目 slug，和目录名一致 |
| `title` | 否 | 显示标题 |
| `format.ratio` | 否 | `16:9` / `9:16` / `1:1` / `4:3` / `3:4` / `21:9` / `adaptive` |
| `format.resolution` | 否 | `[width, height]`，建议 1280×720 或 1920×1080 |
| `format.fps` | 否 | 12–60，默认 24 |
| `global.style` | 否 | 全片风格/质感 |
| `global.character_description` | 否 | 没有角色参考图时的外观描述 |
| `global.scene_description` | 否 | 没有场景参考图时的环境描述 |
| `global.characters` | 否 | 角色参考图路径数组，按出场顺序 |
| `global.scenes` | 否 | 场景参考图路径数组 |
| `global.props` | 否 | 道具参考图路径数组 |
| `global.negative` | 否 | 额外排除项 |
| `shots` | 是 | 1–8 个镜头；单次建议 ≤8 |

## 2. 镜头字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 唯一，如 `shot_01` |
| `duration` | 是 | 4–30 秒 |
| `shot_size` | 否 | 景别，如 `MS` / `MCU` / `CU` / `WS` |
| `camera` | 否 | 运镜/机位描述 |
| `action` | 否 | 主体动作、走位、时间戳 |
| `dialogue` | 否 | 台词（不要加字幕） |
| `hand_policy` | 否 | `out_of_frame` / `occluded` / `not_applicable` |
| `fast_turn` | 否 | true 表示有快速转身；建议拆镜 |
| `multi_person_contact` | 否 | true 表示多人肢体接触；建议拆单人 |
| `blockout.spec` | 否 | 白模 shot spec 路径 |
| `blockout.mp4` | 否 | 白模 MP4 路径 |
| `seedance` | 是 | 生成参数，见下 |

## 3. `seedance` 字段

| 字段 | 说明 |
|---|---|
| `mode` | `auto` / `text` / `reference` / `first_last_frame` / `edit` / `extend` |
| `omni_reference_task_type` | `auto` / `reference` / `edit` / `extend`；白模参考用 `reference` |
| `ratio` | 画幅；首尾帧/edit/extend 必须 `adaptive` |
| `duration` | 4–30 或 -1；edit 必须 -1 |
| `generate_audio` | 是否生成同步音频 |
| `watermark` | 默认 false |
| `output_format` | `mp4` / `mov`；edit/extend 建议 mov |
| `whitemodel` | 白模参考时 true，自动加“不保留白模材质/轨迹线…”约束 |
| `quality_guard` | 默认 true，追加默认质量负面词 |
| `reference_images` | 0–30 张；URL/data URI/`asset://`/本地路径 |
| `reference_videos` | 0–10 个；公网 URL/`asset://`；本地 MP4 必须先 staging |
| `reference_audios` | 0–10 段；URL/data URI/`asset://`/本地路径 |
| `first_frame` | 首帧模式；与 reference_* 互斥 |
| `last_frame` | 尾帧模式；必须同时有 first_frame |
| `reference_video_url` | 可选，直接给公网 URL（等价于 reference_videos[0]） |

## 4. 参数矩阵

| mode | 必需素材 | ratio | duration | omni | 备注 |
|---|---|---|---|---|---|
| `text` | 无 | 任意 | 4–30/-1 | 无 | 纯文生视频 |
| `reference` | ≥1 个 reference_* | 任意/adaptive | 4–30/-1 | `reference`（推荐）或 `auto` | 白模参考用 `reference` |
| `first_last_frame` | first_frame（+last_frame） | **adaptive** | 4–30/-1 | 无 | 与 reference_* 互斥 |
| `edit` | ≥1 个 reference_video | **adaptive** | **-1** | `edit` | 源视频 4–30s；建议 mov |
| `extend` | ≥1 个 reference_video | **adaptive** | 4–30 | `extend` | 建议 mov |

## 5. 素材数量

| 类型 | Seedance 2.5 上限 | 建议 |
|---|---|---|
| 图片 | 30 张 | 1–5 个主体最稳；多视角拆成多张 |
| 视频 | 10 个，总时长 ≤30s | 白模 1 个足够；总时长越短越稳 |
| 音频 | 10 段，总时长 ≤30s | 人声/音乐分开传 |
| 总计 | 50 个 | 超过 8–10 个主体稳定性下降 |

## 6. 真人合规

- 禁止直接上传含真人脸的参考图/视频。
- 用 AI 生成的写实虚拟人像、平台预置数字人、或授权 `asset://`。
- 3D/插画/风格化角色不受限。
- 不要在提示词里写“某个明星/某个真人”的姓名或可识别特征。

## 7. 参考编号

`@图片1` = `seedance.reference_images[0]`；`@视频1` = `seedance.reference_videos[0]`；`@音频1` = `seedance.reference_audios[0]`。

按人物首次出场顺序排图；先主角，再配角，再场景/道具。映射写在提示词里，不要只在图片上画字。

## 8. 最小示例

```json
{
  "project": "demo",
  "title": "窗边五分钟",
  "format": { "ratio": "16:9", "resolution": [1280, 720], "fps": 24 },
  "global": {
    "style": "写实电影质感，自然光影，35mm 胶片颗粒，真实皮肤肌理",
    "character_description": "30 岁女性，黑色短发，浅灰针织衫，深色长裤，自然肤色",
    "scene_description": "傍晚旧公寓客厅，窗外冷蓝余晖，室内暖色台灯",
    "characters": [],
    "scenes": [],
    "props": [],
    "negative": "无字幕、无水印、无logo"
  },
  "shots": [
    {
      "id": "shot_01",
      "duration": 5,
      "shot_size": "MS",
      "camera": "镜头缓慢跟随人物向右移动，保持中景，轻微手持呼吸感",
      "action": "人物从左向右走过房间，停在窗边，转头看向窗外",
      "hand_policy": "out_of_frame",
      "blockout": { "spec": "shot_01.json", "mp4": "renders/shot_01/shot_01.mp4" },
      "seedance": {
        "mode": "reference",
        "omni_reference_task_type": "reference",
        "ratio": "16:9",
        "duration": 5,
        "generate_audio": false,
        "whitemodel": true,
        "reference_videos": ["renders/shot_01/shot_01.mp4"]
      }
    }
  ]
}
```
