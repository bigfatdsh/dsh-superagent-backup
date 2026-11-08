# 成本与调用纪律

> **每一次 `seedance_generate_video` 都是钱。** 这条管线里唯一"免费且无限"的资源是
> Blender 和白模：构图、机位、景别、主体占比、走位、节奏、锚图、契约、调色、配音——
> 全都可以在付费之前做到位。
>
> 上一轮《靶场校准》：4 个镜头花了 **9 次**生成（2.25×），其中 **6 次是返工**，
> 而且返工里有 5 次是"构图/主体不对"——这类问题 `shot-scan --test` 在付费前 100% 能发现。

## 1. 成本指数（非货币）

```
成本指数 = (宽 × 高) / (854 × 480) × 秒数
```

以 480p 为 1.0：

| 画质 | 像素比 | 5 秒一条 | 说明 |
| --- | --- | --- | --- |
| 480p | 1.00 | **5.0** | 样片档；Seedance 原生 `draft` 模式 |
| 720p | 2.25 | **11.25** | 折中档 |
| 1080p | 5.06 | **25.3** | 交付档 |

> 这只是**相对成本**，方便你设上限和比较方案；换算成钱请填 `unitPriceYuan`
> （去方舟控制台查单价），`produce.mjs plan` 会附估算。不要拿这个指数当账单。

## 2. 三种样片策略，先算再选

4 镜 × 5 秒、交付 1080p：

| 策略 | 调用数 | 成本指数 | 适用 |
| --- | --- | --- | --- |
| `none`（直接交付） | 4 | **101** | 镜头简单、机位固定、之前跑过同款 |
| `risky`（只给高风险出样片） | 5 | **106** | 4 镜里有 1 镜是新机位/新人设 |
| `all`（每镜先 480p 样片） | 8 | **121** | 默认推荐：≤6 镜的新片 |

**关键账**：一条 1080p 5 秒返工 = 25.3 指数 ≈ **5 条 480p 样片**。
也就是说，只要样片帮你避开**一次**整镜返工，`all` 就和 `none` 打平；避开两次就赚。

作为对比，上一轮实际是 **228 指数**（9 次 × 1080p 5 秒）。同样的片子，
按"契约 + 扫描 + 全样片"走，目标区间是 **121（零返工）～146（1 次返工）**。

## 3. 强制流程（少一步都会被 gate 拒绝）

```
intake（问用户）→ contract（契约）→ shot-scan --test（机位扫描）
   → prep-shot --tier draft → gate draft → preview → generate → record
   → qa-consistency（看骨架/构图/一致性）→ approve draft
   → prep-shot --tier final → gate final → preview → generate → record
   → qa-consistency + qa-video --strict → 后期（调色/配音/剪辑）
```

### 3.1 intake：先问用户，不替用户决定

```bash
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs intake --project projects/<p> --questions
# 把这 8 项用 ask_user_question 问完，然后：
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs intake --project projects/<p> \
  --set "deliveryResolution=1080p,durationPerShot=5,ratio=16:9,generateAudio=false,shotCount=4,draftPolicy=all,maxPaidCalls=6,maxCallsPerShot=2,requireScan=true" \
  --confirm --note "用户在对话框确认（2026-11-08）"
```

8 项：交付画质 / 单镜时长 / 画幅 / 声音方案 / 镜头数 / 样片策略 / 付费调用上限 / 是否要求机位扫描。

`run.json` 里 `confirmed.byUser=true` 是后面所有付费动作的前置条件。

### 3.2 gate：每次提交前的硬门

```bash
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs gate --project projects/<p> --shot shot_01 --tier draft
```

会检查（全部满足才 `allowed:true`）：

| # | 检查 | 不满足的含义 |
| --- | --- | --- |
| 1 | `run.json` 已确认 | 你没问用户就开跑 |
| 2 | 契约存在且这一镜 `must_show` 非空 | 没定义"必须看见什么" |
| 3 | `prompts/<shot>.payload.json` 存在，且 `contractHash` 与当前契约一致 | 改了契约还在用旧提示词 |
| 4 | `blockout/scan/<shot>/scan.json` 的 verdict 是 `pass` | 机位没验证 |
| 5 | 这一镜调用次数 < `maxCallsPerShot` | 在盲抽 |
| 6 | 全片调用次数 < `maxPaidCalls` | 超预算 |
| 7 | 成本指数不超 `maxUnits`（若设置） | 超预算 |
| 8 | `tier=final` 时该镜 draft 已 `approve` | 没验样片就出交付 |

### 3.3 record / approve：账本

```bash
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs record --project projects/<p> \
  --shot shot_01 --tier draft --taskId cgt-xxxx --resolution 480p --duration 5
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs approve --project projects/<p> \
  --shot shot_01 --tier draft --note "骨架/构图/一致性通过"
node .dsh/skills/ai-video-pipeline/scripts/produce.mjs status --project projects/<p>
```

`record` 必须在**真拿到 taskId 之后**立刻跑；忘记记账，gate 的预算判断就会失真。

## 4. 一次通过的检查清单

付费前，这 6 条必须同时成立：

- [ ] 用户确认了画质/时长/预算（`run.json.confirmed.byUser`）
- [ ] 契约 `--check` 通过，`at/size` 来自白模扫描的实测值
- [ ] `shot-scan --test` 该镜 `pass`（位置 ≤0.05、占宽 ≤30%）
- [ ] 白模 `contact.png` 与扫描 contact 都看过：景别、主体位置、遮挡关系对
- [ ] `prep-shot` 退出码 0（无禁词/无参数错/素材成组）
- [ ] `gate` 放行

## 5. 常见误用

| 误用 | 后果 | 正确做法 |
| --- | --- | --- |
| 跳过 intake 直接生成 | 用户事后才发现画质/时长/预算不对 | `gate` 会拒绝；先问 |
| 用 `final` 直接试 | 一次 25 指数打水漂 | 先 `draft`（5 指数） |
| 样片不合格却"再抽一次" | 同一结构错误再花一次钱 | 改白模/锚图/契约 |
| 拿 480p 样片评画质 | 误判成"模型不行" | 样片只看骨架/构图/一致性 |
| 忘记 `record` | 预算判断失真，超支 | 提交后立刻记 |
| 一次并行跑 4 镜 | 错了 4 次一起错 | 一镜一镜推进 |
| 用 `maxCallsPerShot=3` | 纵容盲抽 | 保持 2；第 3 次必须重新确认预算 |

## 6. 极致降本方向（按杠杆排序）

> 成本指数基准：480p·5s = 5 / 720p·5s = 11.25 / 1080p·5s = 25.3。
> 下面按"能省多少"排序，前三条是数量级差异，后面是百分比差异。

### 6.1 先把钱花在建模上（最高杠杆，零成本）

参考视频是**几何真源**：视频模型会把参考的拓扑复杂度一起继承。
`peak-photoreal` 那轮的参考只有 **5,883 个面**，于是成片是"低模 + 好打光"——
6 次生成（3 样片 + 3 交付）= **90.9 指数，全部买到了错误的东西**。

| 景别 | 参考模型评估后多边形数下限 |
| --- | --- |
| 远景 / 全景 | 20,000 |
| 中景 / 中近景 | 80,000 |
| 特写 / 大特写 | 200,000 |

Blender 里补细分/置换/布料/倒角是**免费**的；一次 1080p 生成是 25.3 指数。
**任何"低模 + 提示词补救"的方案，期望值都是负的。**

### 6.2 720p 生成 + 本地超分到 1080p（省 ~55%/条）

```bash
# 生成 720p（11.25 指数）→ 本地 2× 超分 + 轻颗粒 → 交付 1080p
ffmpeg -i in720.mp4 -vf "scale=1920:1080:flags=lanczos,unsharp=3:3:0.4,noise=alls=4:allf=t" \
  -c:v libx264 -crf 16 -pix_fmt yuv420p out1080.mp4
```

- 一条 1080p 镜头：25.3 → 11.25，**省 55.5%**。
- 适合：慢推/慢摇/远景/剪影镜头。不适合：特写、快速动作、需要极致边缘的镜头。
- 用 `qa-realism.mjs` 对比 720p→超分 与 1080p 直出的 `detail`，差 15% 以内就接受。

### 6.3 混合渲染：Blender 出环境，Seedance 出角色（本片可省 70%）

静态/半静态元素（岩石、山体、月亮、天空、云海、建筑）用 Cycles/EEVEE 渲染，
只有角色、布料、VFX 交给 Seedance，最后合成：

- 环境部分：**0 指数**，而且是真照片级（置换岩石、真实光照）。
- 角色部分：1 条生成。
- `peak-photoreal` 里约 70% 的画面是环境——这部分本来就不该花钱。

代价是渲染/合成工时增加，但这是影视行业的标准做法（matte painting + CG 角色）。

### 6.4 一镜多吃：长镜头剪成多条（省 25.3/条）

一条 10s 连续机位生成后剪成 2 条 5s 镜头；或用已通过镜头的 `extend` 派生下一镜。
适用：同机位连续动作、对话正反打以外的连续场景。不适用：需要严格切镜的场景。

### 6.5 按景别分配画质（省 20–55%/条）

| 景别 | 建议档位 |
| --- | --- |
| 远景 / 全景 / 剪影 | 480p 或 720p + 超分 |
| 中景 | 720p + 超分 |
| 特写 / 大特写 | 1080p 直出 |

一个 6 镜片子里，通常只有 1–2 个特写需要 1080p 直出。

### 6.6 关掉模型音频（省一次"为声音重试"）

`peak-photoreal` 实测声画 10/13 偏差 0.30–3.70s，`range-test` 6/8 超差。
模型音频的落点不可控，而后期拟音是免费的。
**时间敏感镜头一律 `generate_audio=false`**。

### 6.7 首帧锁风格（换一种省钱路径）

用 Cycles 渲一张照片级首帧 → `first_frame` 模式生成运动。
风格由真渲染锁定，模型只负责动；适合固定机位、慢动作。
代价：放弃 reference 模式的运动控制，收益：首帧即定稿，几乎不会因"风格不对"重抽。

### 6.8 Agent 侧也是成本（token）

`peak-photoreal` 会话里 `read_image` 调了 **77 次**，`bash` 111 次。
逐帧看图既慢又费 token：

- 一律先出 **contact sheet**（6–12 帧一张）整体看，只在可疑帧放大 1:1。
- 多个检查合并成一次脚本调用（`qa-video` + `qa-consistency` + `qa-realism` 一次跑完）。
- 不要反复 `read` 同一份文档；把结论写进 `qa/*.md` 复用。

### 6.9 失败预算（止损）

每镜 **1 次 draft + 1 次 final**；第 3 次必须先改结构（模型/契约/参考视频）并重新确认预算。
整片重抽是最贵的错误：4 镜重抽 = 101 指数起。

## 7. 组合示例：一条 3 镜超写实片的省钱方案

| 项 | 常规做法 | 优化后 |
| --- | --- | --- |
| 参考模型 | 低模（5,883 面） | 高模（≥ 8 万面）+ 材质代理 |
| 环境 | 全交给 Seedance | Cycles 渲染 + 合成（0 指数） |
| 角色镜头 | 3 × 1080p = 75.9 | 3 × 720p = 33.75（+ 本地超分） |
| 样片 | 无 | 3 × 480p = 15（拦掉结构性错误） |
| 音频 | 模型音频 | 后期拟音（0） |
| **合计** | **75.9（且大概率返工）** | **48.75（含样片，通过率高）** |
