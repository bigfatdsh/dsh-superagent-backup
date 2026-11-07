#!/usr/bin/env node
// Deterministically compose a Seedance 2.5 white-model prompt from a shotlist.
//
//   node build-prompt.mjs --file projects/demo/shotlist.json --shot shot_01
//
// This is a starting point: the agent should review the mapping and may add
// acting/lighting details. The script never invents references.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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

function list(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = resolve(args.file ?? "shotlist.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  const shotId = args.shot ?? data.shots?.[0]?.id;
  const shot = (data.shots ?? []).find((item) => item.id === shotId);
  if (!shot) throw new Error(`找不到镜头 ${shotId}（可用：${(data.shots ?? []).map((item) => item.id).join(", ")}）`);
  const global = data.global ?? {};
  const seedance = shot.seedance ?? {};
  const characters = list(global.characters);
  const scenes = list(global.scenes);
  const props = list(global.props);
  const imageRefs = [...list(seedance.reference_images)];
  const warnings = [];

  // The manifest is the source of truth for image numbering. If the shot has
  // explicit reference_images, use their order; otherwise use characters,
  // scenes, props in that order.
  const manifest = imageRefs.length > 0
    ? imageRefs.map((path) => ({ path, kind: "reference" }))
    : [
        ...characters.map((path) => ({ path, kind: "character" })),
        ...scenes.map((path) => ({ path, kind: "scene" })),
        ...props.map((path) => ({ path, kind: "prop" }))
      ];

  const mappings = [];
  const imageIndex = new Map();
  manifest.forEach((item, index) => {
    imageIndex.set(item.path, index + 1);
    mappings.push({ image: index + 1, path: item.path, kind: item.kind });
  });

  const lines = [];
  const videoCount = list(seedance.reference_videos).length;
  if (videoCount > 0) {
    lines.push("参考 @视频1 的运镜、动作路径、角色站位、景别变化、镜头顺序与节奏；白模只提供运动与机位骨架，不要参考它的灰色材质和几何外观。");
  }
  if (characters.length > 0) {
    const parts = characters.map((path) => {
      const index = imageIndex.get(path);
      return `@图片${index ?? "?"} 的${path.includes("face") ? "面部特征" : "角色外观"}`;
    });
    lines.push(`将 @视频1 中的白色人偶映射为 ${parts.join("；")}。保持同一角色的身份、发型、服装、体型和比例，不要生成双胞胎或分身。`);
  } else if (videoCount > 0) {
    const description = String(global.character_description ?? "").trim();
    if (description) {
      lines.push(`人物设定：${description}。全片保持同一身份、发型、服装、体型和气质。`);
    } else {
      lines.push("人物设定：请补充明确的年龄、性别、发型、服装和气质，并保持全片一致。");
      warnings.push("global.characters 为空且 global.character_description 为空：没有角色参考图/描述时，身份一致性会下降。");
    }
  }
  if (scenes.length > 0) {
    const parts = scenes.map((path) => `@图片${imageIndex.get(path) ?? "?"}`);
    lines.push(`场景使用 ${parts.join("、")} 的环境、光线、色温与空间材质；保持白模中的空间比例、站位和遮挡关系。`);
  } else if (global.scene_description) {
    lines.push(`场景设定：${global.scene_description}。`);
  }
  if (props.length > 0) {
    const parts = props.map((path) => `@图片${imageIndex.get(path) ?? "?"}`);
    lines.push(`道具外观参考 ${parts.join("、")}。`);
  }
  if (videoCount === 0) lines.push("这是文生视频/图生视频任务：不要声称参考了白模视频。");

  lines.push("");
  lines.push(`【镜头】${shot.shot_size ?? "MS"}；${shot.camera ?? "固定机位"}。`);
  lines.push(`【动作】${shot.action ?? ""}`);
  if (shot.dialogue) lines.push(`【台词】${shot.dialogue}（只生成这一句，口型同步；不要额外对白）`);
  lines.push(`【风格】${global.style ?? "写实电影质感"}。写实真人质感，皮肤保留原生肌理，避免过度磨皮、蜡感和塑料感。`);
  const constraints = [];
  if (shot.hand_policy === "out_of_frame") constraints.push("手部不入画");
  if (shot.hand_policy === "occluded") constraints.push("手部用遮挡物挡住");
  if (shot.fast_turn) warnings.push("fast_turn=true：Seedance 对快速转身不稳定，建议切镜或拆镜头。");
  if (shot.multi_person_contact) warnings.push("multi_person_contact=true：多人肢体接触极易崩手/穿模，建议拆成单人镜头。");
  if (seedance.whitemodel === true) constraints.push("不保留白模材质、轨迹线、坐标轴、网格线或相机锥体");
  if (global.negative) {
    constraints.push(global.negative);
    const missing = ["无字幕", "无水印", "无文字", "无logo"].filter((term) => !String(global.negative).includes(term));
    if (missing.length > 0) constraints.push(missing.join("、"));
  } else {
    constraints.push("无字幕、无水印、无文字、无logo");
  }
  const uniqueConstraints = [...new Set(constraints.map((item) => String(item).trim()).filter(Boolean))];
  lines.push(`【严格排除】${uniqueConstraints.join("；")}。`);

  const prompt = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const output = {
    ok: true,
    shot: shot.id,
    prompt,
    mapping: mappings,
    references: {
      videos: list(seedance.reference_videos),
      images: manifest.map((item) => item.path),
      audios: list(seedance.reference_audios)
    },
    warnings
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
