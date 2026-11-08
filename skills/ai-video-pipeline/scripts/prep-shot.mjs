#!/usr/bin/env node
// 由「一致性契约 + 分镜」确定性地生成单镜提示词与 Seedance payload。
//
//   node prep-shot.mjs --project projects/my-film --shot shot_01
//   node prep-shot.mjs --project projects/my-film --shot shot_01 --print
//
// 为什么要有这个脚本：手写提示词会让同一份契约在不同镜头里被"换个说法"，
// 一致性和声画时序就是这样漂掉的。这里把契约块原样嵌入、素材编号固定、
// 同一张锚图只占一个编号，并提前挡住会诱发镜内切镜 / 误判 edit 的措辞。
//
// 输出：<project>/prompts/<shot>.txt 和 <project>/prompts/<shot>.payload.json
// 退出码：0 通过（可有警告）；1 有阻塞问题。

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_GUARD = [
  "字幕", "水印", "文字", "logo", "多指", "少指", "畸形手", "扭曲肢体",
  "面部身份漂移", "过度磨皮", "磨皮", "蜡感皮肤", "蜡感", "塑料感", "白模材质",
  "轨迹线", "坐标轴", "网格线", "相机锥体"
];
// reference 模式下会诱导模型判成 edit/extend 的词（Ark TaskTypeMismatch 的来源）
const EDIT_WORDS = ["编辑视频", "修改", "替换", "改成", "延长", "续写", "延续"];
// "延长线"是几何描述，不是 edit 意图，扫描前先消掉
const FALSE_FRIENDS = [/延长线/g, /延长轴/g, /向前延伸/g];
// 会诱发"镜内切镜/尾段漂移"的措辞（只看镜头自身的文案，不看模板话术）
const DRIFT_WORDS = ["切到", "切镜", "切换到", "切至", "换个角度", "另一个机位", "另一个视角", "拉远露出", "镜头一切", "跳切", "尾段机位"];

const SHOT_SIZE = {
  EWS: "大远景", WS: "全景", LS: "全景", FS: "全身", MWS: "中全景", MS: "中景",
  MCU: "中近景", CU: "特写", ECU: "大特写", BCU: "大特写", INSERT: "插入特写",
  "INSERT-CU": "插入特写", POV: "第一人称主观视角", OTS: "过肩",
  "OTS-CU": "过肩特写", "OTS-MS": "过肩中景", "TWO-SHOT": "双人镜头", "CLOSE-UP": "特写"
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function exists(path) {
  return Boolean(await stat(path).then((info) => info.isFile(), () => false));
}

function pct(value) {
  return `${Math.round(Number(value) * 100)}%`;
}

function shotSizeLabel(raw) {
  const key = String(raw ?? "").trim().toUpperCase();
  return SHOT_SIZE[key] ?? raw ?? "中景";
}

function isGuardItem(item) {
  if (DEFAULT_GUARD.some((term) => item.includes(term))) {
    // "非同款塑料感"这类反向描述也属于基础护栏，统一交给 quality_guard
    return true;
  }
  // 白模相关的基础护栏（whitemodel 子句与 quality_guard 已经覆盖）
  return /白模|纯白背景|方块人偶|灰色材质/.test(item);
}

function stripGuard(text) {
  const kept = [];
  const dropped = [];
  for (const raw of String(text ?? "").split(/[、；;，,\n]/)) {
    const item = raw.trim();
    if (!item) continue;
    if (isGuardItem(item)) dropped.push(item);
    else if (!kept.includes(item)) kept.push(item);
  }
  // "本片特有：X" 与 "X" 这类重复项只留一条
  const pruned = kept.filter((item, index) => !kept.some((other, otherIndex) => otherIndex !== index && other.includes(item) && other.length > item.length));
  return { kept: pruned, dropped };
}

function ratioLines(prop) {
  const ratios = prop?.ratios ?? {};
  const entries = Object.entries(ratios).filter(([, value]) => Number.isFinite(Number(value)));
  if (entries.length === 0) return "";
  const labels = {
    ring_outer_diameter_over_width: "环外径/纸宽",
    ring_thickness_over_diameter: "环宽/外径",
    width_over_height: "宽/高",
    center_x: "环心 x",
    center_y: "环心 y"
  };
  return entries.map(([key, value]) => `${labels[key] ?? key} ${pct(value)}`).join("，");
}

function fmtTime(value) {
  return `${Number(value).toFixed(1)}s`;
}

function stripFalseFriends(text) {
  return FALSE_FRIENDS.reduce((carry, pattern) => carry.replace(pattern, ""), text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) throw new Error("用法：node prep-shot.mjs --project projects/<name> --shot <shot_id> [--print]");
  const root = resolve(args.project);
  const shotlist = await readJson(join(root, "shotlist.json"));
  const contractPath = join(root, "consistency.json");
  if (!(await exists(contractPath))) {
    throw new Error(`缺少 ${contractPath}：先跑 contract-init.mjs 建契约并填完，再生成提示词`);
  }
  const contract = await readJson(contractPath);
  const shotId = args.shot ?? shotlist.shots?.[0]?.id;
  const shot = (shotlist.shots ?? []).find((item) => item.id === shotId);
  if (!shot) throw new Error(`找不到镜头 ${shotId}（可用：${(shotlist.shots ?? []).map((item) => item.id).join(", ")}）`);

  const errors = [];
  const warnings = [];
  const seedance = shot.seedance ?? {};
  const mode = seedance.mode ?? "reference";
  const omni = seedance.omni_reference_task_type ?? (mode === "reference" ? "reference" : mode);
  const ratio = seedance.ratio ?? contract.format?.ratio ?? shotlist.format?.ratio ?? "16:9";
  const duration = Number(seedance.duration ?? shot.duration ?? 5);
  const formatResolution = contract.format?.resolution ?? shotlist.format?.resolution ?? [1280, 720];
  const tier = args.tier === "draft" ? "draft" : "final";
  const payloadResolution = tier === "draft" ? "480p" : (seedance.resolution ?? "720p");
  const fps = contract.format?.fps ?? shotlist.format?.fps ?? 24;
  const entry = contract.shots?.[shotId] ?? {};

  // ---------- 硬参数校验 ----------
  if (!Number.isInteger(duration) || (duration !== -1 && (duration < 4 || duration > 30))) {
    errors.push(`duration=${duration} 非法：Seedance 2.5 只接受 4-30 或 -1`);
  }
  if (["first_last_frame", "edit", "extend"].includes(mode) && ratio !== "adaptive") {
    errors.push(`${mode} 的 ratio 必须是 adaptive，当前 ${ratio}`);
  }
  if (mode === "edit" && duration !== -1) errors.push("edit 的 duration 必须是 -1");
  if (mode === "reference" && !(seedance.reference_videos ?? []).length) {
    errors.push("reference 模式没有参考视频：白模镜头必须给 @视频1");
  }

  // ---------- 内容正确性门 ----------
  const mustShow = Array.isArray(entry.must_show) ? entry.must_show : [];
  if (mustShow.length === 0) {
    errors.push(`shots.${shotId}.must_show 为空：不写清"必须看得见什么"，这一镜不能提交`);
  }
  const cues = Array.isArray(entry.cues) ? entry.cues : [];
  for (const [index, cue] of cues.entries()) {
    const t = Number(cue?.t);
    if (!Number.isFinite(t) || t < 0 || (duration > 0 && t > duration)) {
      errors.push(`cues[${index}].t=${cue?.t} 超出镜头时长 ${duration}s`);
    }
  }
  if (tier === "draft") warnings.push("draft 样片只验骨架/构图/一致性，不要用样片判断画质；通过后要 approve draft 才允许出 final");
  if (!entry.logic) warnings.push(`shots.${shotId}.logic 为空：物理/因果逻辑没写（准星是否对准靶心、运动方向），模型容易画反`);

  // ---------- 素材清单（编号固定；同一张锚图只占一个编号） ----------
  const subjects = contract.subjects ?? {};
  const imagePlan = [];
  const used = new Set();
  const pushImage = (path, role, label) => {
    if (!path || used.has(path)) return false;
    used.add(path);
    imagePlan.push({ path, role, label });
    return true;
  };
  pushImage(subjects.character?.anchor, "character", "角色定妆");
  pushImage(subjects.scene?.anchor, "scene", "场景定妆");
  const usedProps = [];
  for (const item of mustShow) {
    const prop = (subjects.props ?? []).find((candidate) => candidate.id === item.prop)
      ?? (subjects.props ?? []).find((candidate) => `${item.what}`.includes(candidate.id));
    if (!prop) {
      if (item.prop) warnings.push(`must_show「${item.what}」的 prop=${item.prop} 在 subjects.props 里不存在：道具没有锚图`);
      continue;
    }
    if (!usedProps.includes(prop)) usedProps.push(prop);
  }
  for (const prop of usedProps) pushImage(prop.anchor, `prop:${prop.id}`, `道具·${prop.id}`);
  pushImage(entry.anchor_tail, "tail", "上一镜尾帧（衔接锚）");
  // shotlist 里额外指定的参考图排在契约锚图之后，编号不打断前四张
  for (const extra of seedance.reference_images ?? []) {
    if (pushImage(extra, "extra", "补充参考（shotlist 指定）")) {
      warnings.push(`shotlist 额外参考图 ${extra}：契约锚图优先，它排在其后`);
    }
  }

  const missingAnchors = [];
  for (const [index, item] of imagePlan.entries()) {
    const absolute = isAbsolute(item.path) ? item.path : join(root, item.path);
    if (!(await exists(absolute))) missingAnchors.push(`@图片${index + 1}（${item.label}）锚图不存在：${absolute}`);
  }
  errors.push(...missingAnchors);
  if (imagePlan.length > 5) warnings.push(`参考图 ${imagePlan.length} 张：1-5 个主体最稳，超过会稀释注意力`);
  if (imagePlan.length === 0) errors.push("没有任何锚图：一致性无从谈起");

  const refOf = (path) => {
    const index = imagePlan.findIndex((item) => item.path === path);
    return index >= 0 ? `@图片${index + 1}` : "";
  };

  // ---------- 组契约块 ----------
  const lines = [];
  lines.push("【一致性契约 · 逐字复用 · 不得改写】");
  lines.push(`画幅：${contract.format?.ratio ?? ratio} / ${(formatResolution ?? []).join("×")} / ${fps}fps，全片一致。`);
  if (subjects.character) {
    const locked = (subjects.character.locked ?? []).join("；");
    lines.push(`角色（以 ${refOf(subjects.character.anchor) || "（无锚图）"} 为准，不得与锚图冲突）：${locked || "见锚图"}。${subjects.character.text ? `补充：${subjects.character.text}` : ""}`);
  }
  if (subjects.scene) {
    const locked = (subjects.scene.locked ?? []).join("；");
    lines.push(`场景（以 ${refOf(subjects.scene.anchor) || "（无锚图）"} 为准，不得与锚图冲突）：${locked || "见锚图"}。${subjects.scene.text ? `补充：${subjects.scene.text}` : ""}`);
  }
  for (const prop of usedProps) {
    const ratios = ratioLines(prop);
    lines.push(`道具（${refOf(prop.anchor)}）：${prop.id}${ratios ? `——${ratios}` : ""}${prop.text ? `；${prop.text}` : ""}`);
  }
  lines.push(`调色：${contract.grade?.look ?? "全片统一"}；全片同一套光位与调色，任何一镜不得单独调色。`);

  // ---------- 素材分工 ----------
  lines.push("");
  lines.push("【素材分工】");
  const hasVideo = (seedance.reference_videos ?? []).length > 0;
  if (hasVideo) {
    lines.push("@视频1：白模。只继承运镜、机位、景别、主体走位、动作路径与节奏；不继承灰色材质、纯白背景、几何块面、方块人偶。");
  }
  const roles = imagePlan.map((item, index) => `@图片${index + 1}：${item.label}`);
  if (roles.length > 0) lines.push(`${roles.join("；")}。`);
  if (hasVideo && subjects.character) {
    lines.push(`映射：@视频1 中的白色人偶 = ${refOf(subjects.character.anchor)} 的角色；@视频1 中的白色方块/几何体 = 对应道具。`);
  }
  if (imagePlan.some((item) => item.role === "tail")) {
    lines.push("衔接锚只用于统一空间、光线和调色，不复制它的构图与机位。");
  }

  // ---------- 镜头 + 节奏 ----------
  lines.push("");
  lines.push(`【镜头】${shotSizeLabel(shot.shot_size)}${shot.shot_size ? `（${shot.shot_size}）` : ""}；${shot.camera ?? "固定机位"}。`);
  if (cues.length > 0) {
    lines.push(`【动作/节奏 · 严格按时间点】${cues.map((cue) => `${fmtTime(cue.t)} ${cue.event}`).join("；")}。`);
  } else if (shot.action) {
    lines.push(`【动作】${shot.action}。`);
  }
  if (shot.dialogue) lines.push(`【台词】${shot.dialogue}（只生成这一句，口型同步，不加字幕）`);

  // ---------- 内容正确性 ----------
  lines.push("");
  const mustLines = mustShow.map((item) => {
    const [x, y] = item.at ?? [0.5, 0.5];
    const extra = item.prop && item.prop !== item.what ? `（${item.prop}）` : "";
    return `${item.what}${extra} 在画面 ${pct(x)},${pct(y)} 附近、占宽约 ${pct(item.size ?? 0.2)}`;
  });
  lines.push(`【内容正确性】必须同时看得见：${mustLines.join("；")}。`);
  if (entry.logic) lines.push(`物理逻辑：${entry.logic}`);

  // ---------- 摄影与材质（超写实的可执行部分） ----------
  const look = contract.look ?? {};
  const cameraSpec = String(look.camera ?? "").trim();
  const materials = [...(look.character_materials ?? []), ...(look.scene_materials ?? [])]
    .map((item) => String(item).trim())
    .filter(Boolean);
  lines.push("");
  if (cameraSpec || materials.length > 0) {
    lines.push("【摄影与材质 · 超写实的可执行部分】");
    if (cameraSpec) lines.push(`摄影：${cameraSpec}。`);
    if (materials.length > 0) lines.push(`材质：${materials.join("；")}。`);
    lines.push("所有表面都要有真实微观纹理、边缘磨损与使用痕迹（指纹、油光、掉漆、织纹、积灰）；不允许均匀光滑的理想表面、不允许画上去的假反射。");
  } else {
    warnings.push("契约没有 look 段（摄影机/材质清单）：超写实只剩形容词，成片会滑向 CG 感（见 realism-playbook）");
  }

  // ---------- 画面纪律 ----------
  lines.push("");
  lines.push("【画面纪律】全片一个机位、一个景别：不切镜、不换角度、不插入特写、结尾不拉远换构图；主体位置与景别以 @视频1 为准。不要要求跨帧维持弹孔、烟雾、水渍等累计状态，只表现单次事件。");

  const prompt = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // ---------- 自检：只扫镜头自己的文案，不扫模板话术 ----------
  const shotText = stripFalseFriends([
    shot.camera ?? "",
    shot.action ?? "",
    entry.logic ?? "",
    ...cues.map((cue) => `${cue.event ?? ""}`)
  ].join(" "));
  if (mode === "reference") {
    const hits = EDIT_WORDS.filter((word) => stripFalseFriends(shotText).includes(word));
    if (hits.length > 0) errors.push(`reference 模式镜头文案里出现会误判成 edit/extend 的词：${hits.join("、")}（换成"映射为/表现为"）`);
  }
  const drift = DRIFT_WORDS.filter((word) => shotText.includes(word));
  if (drift.length > 0) warnings.push(`镜头文案出现诱发镜内切镜的措辞：${drift.join("、")}（F1 尾段漂移的常见根因）`);
  if (/最后.{0,8}(看向|推到|拉远|拉开)/.test(shotText)) warnings.push("镜头文案含「最后…看向/拉远」类结尾动作：容易诱发尾段换机位，建议删掉");

  // ---------- 排除项：只留项目特有的，基础护栏交给 quality_guard ----------
  const rawNegative = [
    shotlist.global?.negative ?? "",
    ...(entry.avoid ?? []),
    ...(contract.global_avoid ?? []),
    ...(look.negative ?? [])
  ].join("；");
  const { kept, dropped } = stripGuard(rawNegative);
  const negative = kept.join("；");

  const payload = {
    mode,
    omni_reference_task_type: omni,
    whitemodel: seedance.whitemodel ?? (mode === "reference" && hasVideo),
    ratio,
    duration,
    resolution: payloadResolution,
    ...(tier === "draft" ? { draft: true } : {}),
    generate_audio: seedance.generate_audio ?? false,
    output_format: seedance.output_format ?? "mp4",
    reference_videos: seedance.reference_videos ?? [],
    reference_images: imagePlan.map((item) => item.path),
    negative_prompt: negative,
    tier,
    contractHash: createHash("sha256").update(await readFile(contractPath)).digest("hex").slice(0, 16),
    prompt
  };

  const outDir = resolve(args.out ?? join(root, "prompts"));
  const txtPath = join(outDir, `${shotId}${tier === "draft" ? ".draft" : ""}.txt`);
  const jsonPath = join(outDir, `${shotId}.payload.json`);
  if (!args.print) {
    await mkdir(outDir, { recursive: true });
    await writeFile(txtPath, `${prompt}\n`, "utf8");
    await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  const report = {
    ok: errors.length === 0,
    shot: shotId,
    mode,
    tier,
    ratio,
    duration,
    resolution: payloadResolution,
    promptChars: prompt.length,
    look: { camera: Boolean(cameraSpec), materials: materials.length },
    images: imagePlan.map((item, index) => ({ ref: `@图片${index + 1}`, role: item.role, path: item.path })),
    videos: payload.reference_videos,
    negativePrompt: negative,
    strippedGuard: dropped,
    errors,
    warnings,
    ...(args.print ? { prompt } : { files: [txtPath, jsonPath] }),
    next: "seedance_preview_request 用 payload 校验；本地参考视频先 seedance_stage_reference 换成公网 URL"
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
