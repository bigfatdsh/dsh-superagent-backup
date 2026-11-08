#!/usr/bin/env node
// 超写实验收：1:1 裁切取证 + 可量化的"塑料感"指标。
//
//   node qa-realism.mjs --project projects/my-film
//   node qa-realism.mjs --project projects/my-film --video-dir ../../output/seedance
//
// 为什么：上一版 QA 是看 480p 缩略图得出"通过"的，而缩略图会把
// 无颗粒、无织纹、均匀高光这些 CG 特征全部抹平。这里强制 **1:1 裁切**，
// 并且给出三个能横向比较的数字：
//
//   detail  纹理能量   —— 相邻像素差的均值/255。均匀光滑表面趋近 0。
//   grain   高频残差   —— 去 3×3 均值后的标准差/255。真实摄影有颗粒/噪点，纯 CG 几乎没有。
//   range   局部动态范围 —— 亮度 p95-p5。平打光的 CG 常常挤在窄区间。
//
// 这三个指标不能"证明"照片级，但能可靠地指出"过于平滑/过于干净"——
// 也就是这一轮问题的两个直接特征。身份/材质是否符合预期仍然必须看 1:1 图。
//
// 退出码：0 无硬失败；1 有作物不达标或缺失。

import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, "../../../..");
const FFMPEG = join(STUDIO, "tools/bin/ffmpeg");
const FFPROBE = join(STUDIO, "tools/bin/ffprobe");

// 阈值来自实测校准（同尺寸 576×576 裁切）：
//   平涂白模 detail 0.0027   ← 完全无表面信息
//   本轮成片 盔壳 0.0083 / 手枪 0.0036 / 纸靶 0.0037 / 手套 0.0132
//   加颗粒后 0.0158
// 所以 0.010 是"有明显表面细节"的下限；纸这类本来就光滑的材质，
// 在契约里用单个 crop 的 minDetail 单独放宽，而不是全局放水。
// grain 在 H.264/HEVC 之后会被压平（实测 0.00003→0.00005），
// 所以它只作为"几乎无颗粒"的提示，不参与硬判定。
const DEFAULTS = { detail: 0.01, minDetail: 0.01, range: 0.12, grainWarn: 0.0005 };

function parseArgs(argv) {
  const args = { video: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      if (key === "video") args.video.push(next);
      else args[key] = next;
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

async function pickPath(root, value) {
  if (isAbsolute(value)) return value;
  const fromCwd = resolve(value);
  if (await exists(fromCwd)) return fromCwd;
  const fromRoot = resolve(root, value);
  if (await exists(fromRoot)) return fromRoot;
  return fromCwd;
}

function parseFps(value) {
  if (typeof value !== "string" || !value.includes("/")) return Number(value) || 24;
  const [num, den] = value.split("/").map(Number);
  return den ? num / den : 24;
}

async function probe(video) {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate",
    "-of", "json", video
  ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const stream = (data.streams ?? []).find((item) => item.codec_type === "video") ?? {};
  return {
    duration: Number(data.format?.duration ?? 0),
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    fps: parseFps(stream.r_frame_rate)
  };
}

async function cropAt(video, time, info, crop, out) {
  const size = Number(crop.size) || 0.3;
  const width = Math.max(16, Math.round(size * info.width) & ~1);
  const height = Math.max(16, Math.round((width * info.height) / info.width) & ~1);
  const x = Math.round(Math.min(Math.max((crop.at?.[0] ?? 0.5) * info.width - width / 2, 0), Math.max(0, info.width - width)) / 2) * 2;
  const y = Math.round(Math.min(Math.max((crop.at?.[1] ?? 0.5) * info.height - height / 2, 0), Math.max(0, info.height - height)) / 2) * 2;
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", String(time), "-i", video, "-frames:v", "1",
    "-vf", `crop=${width}:${height}:${x}:${y}`, out
  ], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  return { width, height, x, y };
}

async function decode(path) {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error", "-i", path, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"
  ], { timeout: 60000, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" });
  const { stdout: meta } = await execFileAsync(FFPROBE, [
    "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", path
  ]);
  const [width, height] = meta.trim().split(",").map(Number);
  return { data: stdout, width, height };
}

function metrics({ data, width, height }) {
  const luma = new Float32Array(width * height);
  let detailSum = 0;
  let detailCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      luma[y * width + x] = (0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) / 255;
    }
  }
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const value = luma[y * width + x];
      detailSum += Math.abs(value - luma[y * width + x + 1]) + Math.abs(value - luma[(y + 1) * width + x]);
      detailCount += 2;
    }
  }
  // 高频残差：减去 3×3 均值
  let residualSum = 0;
  let residualSq = 0;
  let residualCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) sum += luma[(y + dy) * width + (x + dx)];
      }
      const residual = luma[y * width + x] - sum / 9;
      residualSum += Math.abs(residual);
      residualSq += residual * residual;
      residualCount += 1;
    }
  }
  // 饱和度
  let saturation = 0;
  const pixels = width * height;
  for (let index = 0; index < pixels * 3; index += 3) {
    const r = data[index] / 255;
    const g = data[index + 1] / 255;
    const b = data[index + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    saturation += max > 0 ? (max - min) / max : 0;
  }
  // 动态范围
  const sorted = Float32Array.from(luma).sort();
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
  return {
    detail: Number((detailSum / Math.max(1, detailCount)).toFixed(5)),
    grain: Number((Math.sqrt(residualSq / Math.max(1, residualCount)) / 255).toFixed(5)),
    grainMean: Number((residualSum / Math.max(1, residualCount) / 255).toFixed(5)),
    saturation: Number((saturation / pixels).toFixed(4)),
    range: Number((p(0.95) - p(0.05)).toFixed(4)),
    lumaMean: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(4))
  };
}

async function resolveVideo(root, shot, args, videoDir, taskIdOverride) {
  const override = args.video.find((entry) => entry.startsWith(`${shot}=`));
  if (override) {
    const path = override.slice(shot.length + 1);
    const absolute = await pickPath(root, path);
    return (await exists(absolute)) ? absolute : { missing: absolute };
  }
  const taskId = taskIdOverride ?? args.taskId ?? shot;
  for (const candidate of [
    join(videoDir, `${taskId}.mp4`),
    join(root, "output/seedance", `${taskId}.mp4`),
    join(root, "../output/seedance", `${taskId}.mp4`),
    join(root, "../../output/seedance", `${taskId}.mp4`)
  ]) {
    if (await exists(candidate)) return candidate;
  }
  return { missing: join(videoDir, `${taskId}.mp4`) };
}

function verdictOf(row, thresholds, crop) {
  const problems = [];
  const minDetail = Number(crop?.minDetail ?? thresholds.minDetail ?? thresholds.detail);
  if (row.detail < minDetail) problems.push(`纹理能量 ${row.detail} < ${minDetail}（过于平滑）`);
  if (row.range < thresholds.range) problems.push(`动态范围 ${row.range} < ${thresholds.range}（光太平）`);
  return problems;
}

function warningsOf(row, thresholds) {
  const messages = [];
  if (row.grain < thresholds.grainWarn) messages.push(`颗粒 ${row.grain} < ${thresholds.grainWarn}（几乎没有颗粒：可能是降噪/合成产物）`);
  return messages;
}

async function resolveVideoDir(root, explicit) {
  // 显式指定：必须存在，否则报清楚（不要静默落到 CWD）
  if (explicit) {
    const resolved = await pickPath(root, explicit);
    if (!(await stat(resolved).then((info) => info.isDirectory(), () => false))) {
      throw new Error(`--video-dir 不存在：${resolved}（相对路径会先按 CWD、再按项目根解析）`);
    }
    return resolved;
  }
  // 未指定：从项目根往上找 output/seedance（兼容 <ws>/projects/<p> 布局）
  const candidates = [
    join(root, "output/seedance"),
    join(root, "../output/seedance"),
    join(root, "../../output/seedance")
  ];
  for (const candidate of candidates) {
    if (await stat(candidate).then((info) => info.isDirectory(), () => false)) return candidate;
  }
  return candidates[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) throw new Error("用法：node qa-realism.mjs --project projects/<name> [--video-dir dir] [--video shot=path] [--strict]");
  const root = resolve(args.project);
  const contract = await readJson(join(root, "consistency.json"));
  const shotlist = await readJson(join(root, "shotlist.json"));
  const realism = contract.realism ?? {};
  const crops = realism.crops ?? [];
  if (crops.length === 0) throw new Error("契约没有 realism.crops：先写清楚要检查哪些 1:1 区域");
  const thresholds = { ...DEFAULTS, ...(realism.thresholds ?? {}) };
  const videoDir = await resolveVideoDir(root, args["video-dir"]);
  const outDir = resolve(args.out ?? join(root, "qa"));
  const cropDir = join(outDir, "realism");
  await mkdir(cropDir, { recursive: true });

  const taskByShot = new Map((shotlist.shots ?? []).map((shot) => [shot.id, shot.result?.taskId]));
  // run.json 账本里的最后一次调用优先（可能是 480p 样片轮）
  try {
    const runPath = join(root, "run.json");
    if (await exists(runPath)) {
      const run = JSON.parse(await readFile(runPath, "utf8"));
      for (const entry of run.ledger ?? []) {
        if (entry.shot && entry.taskId) taskByShot.set(entry.shot, entry.taskId);
      }
    }
  } catch {}
  const rows = [];
  const failures = [];
  const warnings = [];

  for (const crop of crops) {
    const shotId = crop.shot;
    const taskId = taskByShot.get(shotId) ?? shotId;
    const video = await resolveVideo(root, shotId, { ...args, taskId }, videoDir, taskId);
    if (!video || typeof video === "object") {
      failures.push(`${shotId}: 缺少成片（${video?.missing ?? ""}）`);
      continue;
    }
    const info = await probe(video);
    const time = Math.min(Number(crop.t ?? 0), Math.max(0, info.duration - 0.1));
    const out = join(cropDir, `${shotId}-${crop.id}.png`);
    const box = await cropAt(video, time, info, crop, out);
    const values = metrics(await decode(out));
    const problems = verdictOf(values, thresholds, crop);
    const notices = warningsOf(values, thresholds);
    if (problems.length > 0) failures.push(`${shotId}/${crop.id}: ${problems.join("；")}`);
    if (notices.length > 0) warnings.push(`${shotId}/${crop.id}: ${notices.join("；")}`);
    rows.push({
      shot: shotId,
      id: crop.id,
      t: Number(time.toFixed(2)),
      box: `${box.width}×${box.height} @ ${box.x},${box.y}`,
      file: out.replace(`${root}/`, ""),
      ...values,
      minDetail: Number(crop.minDetail ?? thresholds.minDetail ?? thresholds.detail),
      verdict: problems.length === 0 ? "通过（仍需 1:1 目视）" : problems.join("；"),
      notices
    });
  }

  const report = {
    ok: failures.length === 0,
    project: contract.project ?? shotlist.project,
    thresholds,
    crops: rows,
    failures,
    warnings,
    note: "detail/grain/range 只能指出「过于平滑/过于干净/光太平」，不能证明照片级；身份与材质必须看 1:1 裁切图。"
  };
  const md = [];
  md.push(`# 超写实 QA — ${report.project}`);
  md.push("");
  md.push(`- 结论：**${report.ok ? "PASS" : "FAIL"}**（不达标 ${failures.length} 项）`);
  md.push(`- 阈值：detail ≥ 各 crop 的 minDetail（全局默认 ${thresholds.minDetail}），range ≥ ${thresholds.range}；grain 仅作提示（压缩后会失真）`);
  md.push("");
  md.push("| 镜头/区域 | 时间 | 1:1 尺寸 | 纹理能量 | 下限 | 颗粒 | 动态范围 | 结论 |");
  md.push("|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    md.push(`| ${row.shot}/${row.id} | ${row.t}s | ${row.box} | ${row.detail} | ${row.minDetail} | ${row.grain} | ${row.range} | ${row.verdict} |`);
  }
  if (warnings.length > 0) {
    md.push("");
    md.push("## 提示");
    md.push("");
    for (const item of warnings) md.push(`- ${item}`);
  }
  md.push("");
  md.push("## 1:1 裁切（必须逐张看）");
  md.push("");
  for (const row of rows) md.push(`- ${row.shot}/${row.id}：\`${row.file}\``);
  md.push("");
  md.push(report.note);
  md.push("");
  await writeFile(join(outDir, "realism-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(outDir, "realism-report.md"), `${md.join("\n")}\n`, "utf8");

  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    failures,
    warnings: report.warnings,
    report: `qa/realism-report.md`,
    crops: rows.map((row) => ({ id: `${row.shot}/${row.id}`, detail: row.detail, grain: row.grain, range: row.range, verdict: row.verdict }))
  }, null, 2)}\n`);
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
