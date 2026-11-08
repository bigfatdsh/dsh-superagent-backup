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
