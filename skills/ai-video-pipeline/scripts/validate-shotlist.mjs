#!/usr/bin/env node
// Validate a shotlist before spending render/API time.
//
//   node validate-shotlist.mjs --file projects/demo/shotlist.json
//
// Exits 1 on blocking errors, 0 otherwise. Warnings do not block.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const RATIOS = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
const MODES = ["auto", "text", "reference", "first_last_frame", "edit", "extend"];

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

function isUrl(value) {
  return typeof value === "string" && (/^https?:\/\//i.test(value) || /^asset:\/\//i.test(value));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = resolve(args.file ?? "shotlist.json");
  const root = resolve(args.root ?? process.cwd());
  const errors = [];
  const warnings = [];
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, errors: [`无法读取 ${file}: ${String(error?.message ?? error)}`], warnings: [] }, null, 2)}\n`);
    process.exit(1);
  }
  if (!data.project || typeof data.project !== "string") errors.push("project 必须是非空字符串");
  if (!Array.isArray(data.shots) || data.shots.length === 0) errors.push("shots 必须是非空数组");
  if (Array.isArray(data.shots) && data.shots.length > 8) warnings.push(`shots=${data.shots.length}，单次建议不超过 8 个镜头，否则上下文和一致性都会变差。`);

  const format = data.format ?? {};
  if (!RATIOS.includes(format.ratio ?? "16:9")) errors.push(`format.ratio 非法：${format.ratio}`);
  if (!Array.isArray(format.resolution) || format.resolution.length !== 2) errors.push("format.resolution 必须是 [width, height]");
  if (!Number.isFinite(Number(format.fps ?? 24))) errors.push("format.fps 必须是数字");

  const ids = new Set();
  const seen = [];
  for (const [index, shot] of (data.shots ?? []).entries()) {
    const where = `shots[${index}]`;
    if (!shot.id || typeof shot.id !== "string") errors.push(`${where}.id 必须是非空字符串`);
    else if (ids.has(shot.id)) errors.push(`${where}.id 重复：${shot.id}`);
    else ids.add(shot.id);
    const duration = Number(shot.duration ?? 5);
    if (!Number.isFinite(duration) || duration < 4 || duration > 30) errors.push(`${where}.duration 必须是 4-30 秒（Seedance 2.5；不是 3 秒）`);
    if (!shot.camera || typeof shot.camera !== "string") warnings.push(`${where}.camera 为空，建议写清运镜`);
    if (!shot.action || typeof shot.action !== "string") warnings.push(`${where}.action 为空，建议写清主体动作`);
    if (shot.hand_policy && !["out_of_frame", "occluded", "not_applicable"].includes(shot.hand_policy)) {
      warnings.push(`${where}.hand_policy=${shot.hand_policy} 不常见；建议 out_of_frame/occluded/not_applicable。`);
    }
    if (shot.fast_turn === true) warnings.push(`${where}.fast_turn=true：Seedance 对快速转身不稳定，建议切镜或拆镜头。`);
    if (shot.multi_person_contact === true) warnings.push(`${where}.multi_person_contact=true：多人肢体接触极易崩手/穿模，建议拆成单人镜头。`);

    const seedance = shot.seedance ?? {};
    const mode = seedance.mode ?? "reference";
    if (!MODES.includes(mode)) errors.push(`${where}.seedance.mode 非法：${mode}`);
    const ratio = seedance.ratio ?? format.ratio ?? "16:9";
    if (!RATIOS.includes(ratio)) errors.push(`${where}.seedance.ratio 非法：${ratio}`);
    const requestedDuration = seedance.duration ?? duration;
    if (requestedDuration !== -1 && (!Number.isInteger(Number(requestedDuration)) || Number(requestedDuration) < 4 || Number(requestedDuration) > 30)) {
      errors.push(`${where}.seedance.duration 必须是 -1 或 4-30 的整数`);
    }
    const images = seedance.reference_images ?? [];
    const videos = seedance.reference_videos ?? [];
    const audios = seedance.reference_audios ?? [];
    if (!Array.isArray(images) || !Array.isArray(videos) || !Array.isArray(audios)) errors.push(`${where}.seedance.reference_* 必须是数组`);
    if (images.length > 30) errors.push(`${where}: 参考图超过 30 张`);
    if (videos.length > 10) errors.push(`${where}: 参考视频超过 10 个`);
    if (audios.length > 10) errors.push(`${where}: 参考音频超过 10 段`);
    if (images.length + videos.length + audios.length > 50) errors.push(`${where}: 参考素材超过 50 个`);
    if (mode === "reference" && images.length + videos.length + audios.length === 0) {
      errors.push(`${where}: reference 模式没有任何参考素材；至少放白模 MP4 或角色/场景图`);
    }
    if ((mode === "edit" || mode === "extend") && videos.length === 0) errors.push(`${where}: ${mode} 模式需要 reference_videos`);
    if (mode === "first_last_frame") {
      if (!seedance.first_frame) errors.push(`${where}: first_last_frame 需要 first_frame`);
      if (ratio !== "adaptive") errors.push(`${where}: 首帧/首尾帧的 ratio 必须是 adaptive`);
    }
    if ((mode === "edit" || mode === "extend") && ratio !== "adaptive") errors.push(`${where}: ${mode} 的 ratio 必须是 adaptive`);
    if (mode === "edit" && requestedDuration !== -1) errors.push(`${where}: edit 的 duration 必须是 -1`);
    if (mode === "reference" && /编辑视频|增加|删除|修改|替换|改成|延长|续写|延续/i.test(`${shot.action ?? ""} ${shot.camera ?? ""}`)) {
      warnings.push(`${where}: 参考镜头文案含编辑/延长关键词；已建议显式 omni_reference_task_type=reference，仍要确认模型不会误判。`);
    }
    if (seedance.whitemodel !== true && mode === "reference" && videos.some((video) => /blockout|shot|white|白模/i.test(String(video)))) {
      warnings.push(`${where}: 看起来用了白模参考视频，但 seedance.whitemodel 不是 true；建议打开以加入“不保留白模材质/轨迹线”的强约束。`);
    }
    for (const video of videos) {
      if (isUrl(video)) continue;
      const absolute = isAbsolute(video) ? video : join(root, video);
      const info = await stat(absolute).catch(() => undefined);
      if (!info?.isFile()) errors.push(`${where}: 本地参考视频不存在：${absolute}`);
      else warnings.push(`${where}: 本地参考视频 ${video} 需要在提交前 staging 成公网 URL（seedance_stage_reference 或 stageUploadProvider）。`);
    }
    for (const image of images) {
      if (isUrl(image)) continue;
      const absolute = isAbsolute(image) ? image : join(root, image);
      const info = await stat(absolute).catch(() => undefined);
      if (!info?.isFile()) errors.push(`${where}: 本地参考图不存在：${absolute}`);
    }
    const blockout = shot.blockout ?? {};
    if (blockout.spec) {
      const specPath = isAbsolute(blockout.spec) ? blockout.spec : join(root, blockout.spec);
      const info = await stat(specPath).catch(() => undefined);
      if (!info?.isFile()) warnings.push(`${where}: blockout.spec 不存在：${specPath}`);
    }
    if (blockout.mp4) {
      const mp4Path = isAbsolute(blockout.mp4) ? blockout.mp4 : join(root, blockout.mp4);
      const info = await stat(mp4Path).catch(() => undefined);
      if (!info?.isFile()) warnings.push(`${where}: blockout.mp4 还没有渲染：${mp4Path}`);
    }
    seen.push({ id: shot.id, mode, ratio, duration: requestedDuration, images: images.length, videos: videos.length, audios: audios.length });
  }

  const report = { ok: errors.length === 0, file, root, errors, warnings, shots: seen };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
