#!/usr/bin/env node
// 成片一致性 / 内容正确性 QA —— 只认证据，不认"看起来可以"。
//
//   node qa-consistency.mjs --project projects/my-film
//   node qa-consistency.mjs --project projects/my-film --video-dir ../../output/seedance
//   node qa-consistency.mjs --project projects/my-film --video shot_01=/abs/a.mp4 --strict
//
// 产出（写到 <project>/qa/）：
//   consistency-report.json / consistency-report.md   —— 结论表 + 证据路径
//   consistency/<shot>-strip.png                      —— 每镜 6 帧抽帧
//   consistency/<shot>-<item>.png                     —— must_show 裁剪证据（需目视）
//
// 能自动判的：技术参数、声画峰值时间、镜内跳变（切镜/机位漂移）、跨镜调色与硬切亮度差。
// 不能自动判的：身份、手部、材质、场景结构 —— 报告里明确标"未验证·需目视"，不冒充通过。
//
// 退出码：0 无硬失败；1 有硬失败（配合 --strict 即可做门禁）。

import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, "../../../..");
const FFPROBE = join(STUDIO, "tools/bin/ffprobe");
const FFMPEG = join(STUDIO, "tools/bin/ffmpeg");

const GRID_W = 16;
const GRID_H = 9;
const LUMA_W = 32;
const LUMA_H = 18;
const AUDIO_RATE = 16000;
const AUDIO_WINDOW = 0.05;

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

function parseFps(value) {
  if (typeof value !== "string" || !value.includes("/")) return Number(value) || 24;
  const [num, den] = value.split("/").map(Number);
  return den ? num / den : 24;
}

function median(values) {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function fmt(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "-";
}

async function probe(video) {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,channels",
    "-of", "json", video
  ], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const videoStream = (data.streams ?? []).find((item) => item.codec_type === "video") ?? {};
  const audioStream = (data.streams ?? []).find((item) => item.codec_type === "audio");
  return {
    duration: Number(data.format?.duration ?? 0),
    width: Number(videoStream.width ?? 0),
    height: Number(videoStream.height ?? 0),
    fps: parseFps(videoStream.r_frame_rate),
    codec: videoStream.codec_name,
    frames: videoStream.nb_frames ? Number(videoStream.nb_frames) : undefined,
    hasAudio: Boolean(audioStream),
    audioCodec: audioStream?.codec_name,
    audioChannels: audioStream?.channels
  };
}

async function decodeFrames(video) {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error", "-i", video, "-an",
    "-vf", `scale=${LUMA_W}:${LUMA_H},format=rgb24`,
    "-f", "rawvideo", "-"
  ], { timeout: 120000, maxBuffer: 1 << 30, encoding: "buffer" });
  const frameSize = LUMA_W * LUMA_H * 3;
  const frames = [];
  for (let offset = 0; offset + frameSize <= stdout.length; offset += frameSize) {
    frames.push(stdout.subarray(offset, offset + frameSize));
  }
  return frames;
}

function frameStats(frame) {
  const pixels = frame.length / 3;
  let luma = 0;
  let saturation = 0;
  const grid = new Float64Array(GRID_W * GRID_H);
  const scale = GRID_W / LUMA_W;
  for (let index = 0; index < pixels; index += 1) {
    const r = frame[index * 3] / 255;
    const g = frame[index * 3 + 1] / 255;
    const b = frame[index * 3 + 2] / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luma += y;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    saturation += max > 0 ? (max - min) / max : 0;
    const x = Math.floor((index % LUMA_W) * scale);
    const gy = Math.floor(Math.floor(index / LUMA_W) * scale);
    grid[gy * GRID_W + x] += y / (scale * scale);
  }
  return { luma: luma / pixels, saturation: saturation / pixels, grid };
}

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < n; index += 1) {
    meanA += a[index];
    meanB += b[index];
  }
  meanA /= n;
  meanB /= n;
  let varA = 0;
  let varB = 0;
  let cov = 0;
  for (let index = 0; index < n; index += 1) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    varA += da * da;
    varB += db * db;
    cov += da * db;
  }
  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : 1;
}

function jumpReport(frames, fps, step = 3) {
  if (frames.length < step * 2 + 2) return { min: 1, at: 0, warnAt: 0 };
  const scores = [];
  for (let index = step; index < frames.length - step; index += 1) {
    scores.push({ frame: index, t: index / fps, corr: correlation(frames[index - step].grid, frames[index + step].grid) });
  }
  const sorted = [...scores].sort((a, b) => a.corr - b.corr);
  return { min: sorted[0]?.corr ?? 1, at: sorted[0]?.t ?? 0, scores };
}

async function decodeAudio(video) {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error", "-i", video, "-vn",
    "-f", "f32le", "-ac", "1", "-ar", String(AUDIO_RATE), "-"
  ], { timeout: 120000, maxBuffer: 1 << 30, encoding: "buffer" });
  const copy = new Uint8Array(stdout);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

function audioPeaks(samples) {
  const window = Math.floor(AUDIO_WINDOW * AUDIO_RATE);
  if (samples.length < window) return { peaks: [], max: -Infinity, duration: 0 };
  const windows = [];
  for (let offset = 0; offset + window <= samples.length; offset += window) {
    let sum = 0;
    for (let index = offset; index < offset + window; index += 1) sum += samples[index] * samples[index];
    windows.push({ t: offset / AUDIO_RATE, db: 10 * Math.log10(sum / window + 1e-12) });
  }
  const max = Math.max(...windows.map((item) => item.db));
  const peaks = [];
  for (let index = 0; index < windows.length; index += 1) {
    const item = windows[index];
    if (item.db < max - 6) continue;
    const previous = windows[index - 1];
    const next = windows[index + 1];
    if ((previous && previous.db > item.db) || (next && next.db > item.db)) continue;
    const last = peaks.at(-1);
    if (last && item.t - last.t <= 0.12) {
      if (item.db > last.db) Object.assign(last, { t: item.t, db: item.db });
      continue;
    }
    peaks.push({ t: item.t, db: item.db });
  }
  return { peaks: peaks.slice(0, 12), max, duration: samples.length / AUDIO_RATE };
}

async function extractFrames(video, times, fps, filter, out) {
  const frames = [...new Set(times.map((time) => Math.max(0, Math.round(time * fps))))];
  if (frames.length === 0) return undefined;
  const select = frames.map((frame) => `eq(n\\,${frame})`).join("+");
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", video,
    "-vf", `select='${select}',${filter},tile=${frames.length}x1`,
    "-frames:v", "1", out
  ], { timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  return out;
}

async function cropEvidence(video, times, fps, item, info, out) {
  const size = clamp(Number(item.size) || 0.2, 0.05, 1);
  const width = Math.max(32, Math.round(size * info.width) & ~1);
  const height = Math.max(32, Math.round((width * info.height) / info.width) & ~1);
  const [ax, ay] = item.at ?? [0.5, 0.5];
  const x = Math.round(clamp(ax * info.width - width / 2, 0, Math.max(0, info.width - width)) / 2) * 2;
  const y = Math.round(clamp(ay * info.height - height / 2, 0, Math.max(0, info.height - height)) / 2) * 2;
  return extractFrames(video, times, fps, `crop=${width}:${height}:${x}:${y},scale=360:-2`, out)
    .then(() => out, () => undefined);
}

async function resolveVideo(root, shot, args, videoDir) {
  const override = args.video.find((entry) => entry.startsWith(`${shot.id}=`));
  if (override) {
    const path = override.slice(shot.id.length + 1);
    const absolute = isAbsolute(path) ? path : resolve(path);
    return (await exists(absolute)) ? absolute : { missing: absolute };
  }
  const taskId = shot.result?.taskId;
  if (!taskId) return undefined;
  for (const candidate of [
    join(videoDir, `${taskId}.mp4`),
    join(root, "output/seedance", `${taskId}.mp4`),
    join(root, "output", `${taskId}.mp4`)
  ]) {
    if (await exists(candidate)) return candidate;
  }
  return { missing: join(videoDir, `${taskId}.mp4`) };
}

function markdown(report) {
  const lines = [];
  lines.push(`# 一致性 QA 报告 — ${report.project}`);
  lines.push("");
  lines.push(`- 结论：**${report.verdict}**（硬失败 ${report.hardFailures.length}，警告 ${report.warnings.length}）`);
  lines.push(`- 契约：\`${report.contract}\``);
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push("");
  lines.push("## 1. 技术参数");
  lines.push("");
  lines.push("| 镜头 | 时长 | 分辨率 | fps | 编码 | 音轨 | 结论 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const shot of report.shots) {
    const tech = shot.tech;
    lines.push(`| ${shot.id} | ${fmt(tech.duration, 2)}s | ${tech.width}×${tech.height} | ${fmt(tech.fps, 0)} | ${tech.codec ?? "-"} | ${tech.hasAudio ? tech.audioCodec : "无"} | ${shot.techVerdict} |`);
  }
  lines.push("");
  lines.push("## 2. 声画 / 动作落点");
  lines.push("");
  if (report.audioRows.length === 0) {
    lines.push("无音轨或未声明音频 cue：声画由后期配音保证 —— **未验证**（终剪后需单独验）。");
  } else {
    lines.push("| 镜头 | 声明时间 | 实际落点 | 偏差 | 容差 | 结论 |");
    lines.push("|---|---|---|---|---|---|");
    for (const row of report.audioRows) {
      lines.push(`| ${row.shot} | ${fmt(row.cue, 2)}s | ${fmt(row.peak, 2)}s | ${fmt(row.delta, 2)}s | ${fmt(row.tolerance, 2)}s | ${row.ok ? "通过" : "**失败**"} |`);
    }
  }
  lines.push("");
  lines.push("## 3. 跨镜调色 / 硬切亮度");
  lines.push("");
  lines.push("| 镜头 | 平均亮度 | 饱和度 | 亮度偏差 | 与前镜亮度差 | 结论 |");
  lines.push("|---|---|---|---|---|---|");
  for (const shot of report.shots) {
    const grade = shot.grade;
    lines.push(`| ${shot.id} | ${fmt(grade.luma, 3)} | ${fmt(grade.saturation, 3)} | ${grade.lumaDelta >= 0 ? "+" : ""}${fmt(grade.lumaDelta, 3)} | ${shot.cutDelta === undefined ? "-" : `${shot.cutDelta >= 0 ? "+" : ""}${fmt(shot.cutDelta, 3)}`} | ${grade.verdict} |`);
  }
  lines.push("");
  lines.push(`基准：亮度中位数 ${fmt(report.baseline.luma, 3)}，饱和度中位数 ${fmt(report.baseline.saturation, 3)}；容差 ±${fmt(report.tolerance.luma, 2)} 亮度、±${Math.round(report.tolerance.saturationRelative * 100)}% 饱和度。`);
  lines.push("");
  lines.push("## 4. 镜内跳变（切镜 / 机位漂移）");
  lines.push("");
  lines.push("| 镜头 | 最小布局相关系数 | 发生时间 | 结论 |");
  lines.push("|---|---|---|---|");
  for (const shot of report.shots) {
    lines.push(`| ${shot.id} | ${fmt(shot.jump.min, 3)} | ${fmt(shot.jump.at, 2)}s | ${shot.jump.verdict} |`);
  }
  lines.push("");
  lines.push("判定：相关系数 < 0.22 视为镜内切镜/机位漂移（硬失败）；< 0.45 提示构图内部变化较大（需确认）。");
  lines.push("");
  lines.push("## 5. 内容正确性证据（需目视）");
  lines.push("");
  if (report.mustShow.length === 0) {
    lines.push("契约里没有 must_show 条目 —— **未验证**。");
  } else {
    lines.push("| 镜头 | 必须可见 | 位置 | 证据 |");
    lines.push("|---|---|---|---|");
    for (const row of report.mustShow) {
      lines.push(`| ${row.shot} | ${row.what} | ${row.at} | ${row.evidence ? `\`${row.evidence}\`` : "未生成"} |`);
    }
  }
  lines.push("");
  lines.push("## 6. 未验证项（必须目视，不许默认通过）");
  lines.push("");
  for (const item of report.unverified) lines.push(`- ${item}`);
  lines.push("");
  if (report.hardFailures.length > 0) {
    lines.push("## 硬失败");
    lines.push("");
    for (const item of report.hardFailures) lines.push(`- ${item}`);
    lines.push("");
  }
  if (report.warnings.length > 0) {
    lines.push("## 警告");
    lines.push("");
    for (const item of report.warnings) lines.push(`- ${item}`);
    lines.push("");
  }
  lines.push("## 证据文件");
  lines.push("");
  for (const shot of report.shots) {
    if (shot.strip) lines.push(`- ${shot.id} 抽帧：\`${shot.strip}\``);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) throw new Error("用法：node qa-consistency.mjs --project projects/<name> [--video-dir dir] [--video shot_01=path] [--strict]");
  const root = resolve(args.project);
  const shotlist = await readJson(join(root, "shotlist.json"));
  const contractPath = join(root, "consistency.json");
  if (!(await exists(contractPath))) throw new Error(`缺少 ${contractPath}：先建契约，否则无法判定一致性`);
  const contract = await readJson(contractPath);
  const videoDir = resolve(args["video-dir"] ?? join(root, "output/seedance"));
  const outDir = resolve(args.out ?? join(root, "qa"));
  const evidenceDir = join(outDir, "consistency");
  await mkdir(evidenceDir, { recursive: true });

  const tolerance = {
    luma: Number(contract.grade?.tolerance?.luma ?? 0.05),
    saturationRelative: Number(contract.grade?.tolerance?.saturationRelative ?? 0.25),
    audio: Number(contract.audio?.tolerance ?? 0.2)
  };
  const target = {
    width: Number(contract.format?.resolution?.[0] ?? shotlist.format?.resolution?.[0] ?? 0),
    height: Number(contract.format?.resolution?.[1] ?? shotlist.format?.resolution?.[1] ?? 0),
    fps: Number(contract.format?.fps ?? shotlist.format?.fps ?? 24)
  };

  const shots = [];
  const hardFailures = [];
  const warnings = [];
  const audioRows = [];
  const mustShow = [];

  for (const shot of shotlist.shots ?? []) {
    const resolved = await resolveVideo(root, shot, args, videoDir);
    const entry = contract.shots?.[shot.id] ?? {};
    if (!resolved || typeof resolved === "object") {
      hardFailures.push(`${shot.id}: 缺少成片${resolved?.missing ? `（${resolved.missing}）` : ""}`);
      shots.push({ id: shot.id, tech: { duration: 0, width: 0, height: 0, fps: 0, hasAudio: false }, techVerdict: "缺少成片", grade: { luma: NaN, saturation: NaN, lumaDelta: NaN, verdict: "无法判定" }, jump: { min: 1, at: 0, verdict: "无法判定" } });
      continue;
    }

    const tech = await probe(resolved);
    const techProblems = [];
    const expectedDuration = Number(shot.duration ?? contract.format?.duration ?? 5);
    if (Math.abs(tech.duration - expectedDuration) > 0.6) techProblems.push(`时长 ${fmt(tech.duration, 2)}s ≠ ${expectedDuration}s`);
    if (target.width && (tech.width !== target.width || tech.height !== target.height)) techProblems.push(`分辨率 ${tech.width}×${tech.height} ≠ ${target.width}×${target.height}`);
    if (target.fps && Math.abs(tech.fps - target.fps) > 0.5) techProblems.push(`fps ${fmt(tech.fps, 1)} ≠ ${target.fps}`);
    if (techProblems.length > 0) hardFailures.push(`${shot.id}: ${techProblems.join("；")}`);

    const frames = await decodeFrames(resolved);
    const stats = frames.map(frameStats);
    const gridFrames = stats.map((item) => ({ grid: item.grid }));
    const luma = median(stats.map((item) => item.luma)) ?? 0;
    const saturation = median(stats.map((item) => item.saturation)) ?? 0;
    const jump = jumpReport(gridFrames, tech.fps);
    let jumpVerdict = "通过";
    if (jump.min < 0.22) {
      jumpVerdict = `**镜内切镜/机位漂移**（t=${fmt(jump.at, 2)}s）`;
      hardFailures.push(`${shot.id}: 镜内跳变 ${fmt(jump.min, 3)} < 0.22（t=${fmt(jump.at, 2)}s），疑似切镜或尾段换机位`);
    } else if (jump.min < 0.45) {
      jumpVerdict = "构图变化较大，需确认";
      warnings.push(`${shot.id}: 镜内布局相关系数 ${fmt(jump.min, 3)}（t=${fmt(jump.at, 2)}s），确认不是切镜`);
    }

    // 声画峰值
    if (tech.hasAudio) {
      const samples = await decodeAudio(resolved);
      const peaks = audioPeaks(samples);
      const cues = (entry.cues ?? []).filter((cue) => cue.audio !== false);
      if (cues.length === 0) {
        warnings.push(`${shot.id}: 有音轨但没有声明音频 cue，无法校验声画同步`);
      }
      for (const cue of cues) {
        let nearest = { t: NaN, db: -Infinity };
        for (const peak of peaks.peaks) {
          if (!Number.isFinite(nearest.t) || Math.abs(peak.t - cue.t) < Math.abs(nearest.t - cue.t)) nearest = peak;
        }
        const delta = Number.isFinite(nearest.t) ? nearest.t - Number(cue.t) : NaN;
        const ok = Number.isFinite(delta) && Math.abs(delta) <= tolerance.audio + 1e-6;
        audioRows.push({ shot: shot.id, cue: Number(cue.t), peak: nearest.t, delta, tolerance: tolerance.audio, ok });
        if (!ok) hardFailures.push(`${shot.id}: 声画不同步 —— 声明 ${fmt(cue.t, 2)}s「${cue.event}」，实际峰值 ${fmt(nearest.t, 2)}s（偏差 ${fmt(delta, 2)}s > ${tolerance.audio}s）`);
      }
    } else if ((entry.cues ?? []).some((cue) => cue.audio !== false)) {
      warnings.push(`${shot.id}: 本镜无音轨，声画只能在终剪或后期配音后校验（未验证）`);
    }

    // 证据：抽帧 + must_show 裁剪
    const strip = join(evidenceDir, `${shot.id}-strip.png`);
    const stripOk = await extractFrames(
      resolved,
      Array.from({ length: 6 }, (_, index) => (Math.max(0, tech.duration - 0.08) * index) / 6),
      tech.fps,
      "scale=480:-2",
      strip
    ).then(() => strip, () => undefined);
    if (!stripOk) warnings.push(`${shot.id}: 抽帧图生成失败`);

    for (const [itemIndex, item] of (entry.must_show ?? []).entries()) {
      const times = (entry.cues ?? []).length > 0
        ? pickThree((entry.cues ?? []).map((cue) => Number(cue.t)))
        : [tech.duration * 0.25, tech.duration * 0.5, tech.duration * 0.75];
      const ascii = String(item.prop ?? "").replace(/[^a-zA-Z0-9.-]+/g, "").slice(0, 24);
      const out = join(evidenceDir, `${shot.id}-ms${String(itemIndex + 1).padStart(2, "0")}${ascii ? `-${ascii}` : ""}.png`);
      const evidence = await cropEvidence(resolved, times, tech.fps, item, tech, out);
      mustShow.push({
        shot: shot.id,
        what: item.what,
        at: `${Math.round((item.at?.[0] ?? 0.5) * 100)}%,${Math.round((item.at?.[1] ?? 0.5) * 100)}%`,
        evidence: evidence ? evidence.replace(`${root}/`, "") : undefined
      });
      if (!evidence) warnings.push(`${shot.id}: ${item.what} 的证据裁剪失败`);
    }

    shots.push({
      id: shot.id,
      video: resolved.replace(`${root}/`, ""),
      tech,
      techVerdict: techProblems.length === 0 ? "通过" : techProblems.join("；"),
      grade: { luma, saturation, lumaDelta: NaN, verdict: "待比较" },
      jump: { min: jump.min, at: jump.at, verdict: jumpVerdict },
      strip: stripOk ? strip.replace(`${root}/`, "") : undefined
    });
    shots.at(-1).frames = stats.length;
  }

  // 跨镜调色
  const measured = shots.filter((shot) => Number.isFinite(shot.grade.luma));
  const baseline = {
    luma: measured.length ? median(measured.map((shot) => shot.grade.luma)) : undefined,
    saturation: measured.length ? median(measured.map((shot) => shot.grade.saturation)) : undefined
  };
  let previousLuma;
  for (const shot of shots) {
    if (!Number.isFinite(shot.grade.luma)) continue;
    shot.grade.lumaDelta = shot.grade.luma - baseline.luma;
    if (previousLuma !== undefined) shot.cutDelta = shot.grade.luma - previousLuma;
    previousLuma = shot.grade.luma;
    const lumaOff = Math.abs(shot.grade.lumaDelta) > tolerance.luma;
    const relSat = baseline.saturation > 0 ? Math.abs(shot.grade.saturation - baseline.saturation) / baseline.saturation : 0;
    const satOff = relSat > tolerance.saturationRelative;
    if (lumaOff || satOff) {
      shot.grade.verdict = "偏离全片基准（需确认）";
      warnings.push(`${shot.id}: 调色漂移 —— 亮度 ${fmt(shot.grade.luma, 3)}（Δ${shot.grade.lumaDelta >= 0 ? "+" : ""}${fmt(shot.grade.lumaDelta, 3)}），饱和度 ${fmt(shot.grade.saturation, 3)}（相对偏差 ${Math.round(relSat * 100)}%）`);
    } else {
      shot.grade.verdict = "通过";
    }
    if (shot.cutDelta !== undefined && Math.abs(shot.cutDelta) > 0.08) {
      warnings.push(`${shot.id}: 与前镜硬切亮度差 ${fmt(shot.cutDelta, 3)}，剪辑点可能有亮度跳变`);
    }
  }

  const unverified = [
    "角色身份/装备细节（护目镜尺寸、面罩颜色、挂件）—— 看每镜抽帧与 must_show 裁剪",
    "手部与肢体（多指、穿模、手指特写）—— 抽帧逐帧看",
    "材质与皮肤（蜡感、塑料感、磨皮）—— 目视",
    "场景结构是否与场景锚图一致（灯位、隔板、靶架）—— 目视",
    "镜头运动与白模骨架的一致性（方向、幅度、节奏）—— 与 contact.png 并排看"
  ];

  const verdict = hardFailures.length > 0 ? "FAIL" : warnings.length > 0 ? "PARTIAL" : "PASS";
  const report = {
    ok: hardFailures.length === 0,
    verdict,
    project: contract.project ?? shotlist.project,
    contract: contractPath.replace(`${root}/`, ""),
    generatedAt: new Date().toISOString(),
    tolerance,
    target,
    baseline,
    shots,
    audioRows,
    mustShow,
    hardFailures,
    warnings,
    unverified
  };
  const jsonPath = join(outDir, "consistency-report.json");
  const mdPath = join(outDir, "consistency-report.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, markdown(report), "utf8");

  process.stdout.write(`${JSON.stringify({ ok: report.ok, verdict, hardFailures, warnings: warnings.length, report: mdPath.replace(`${root}/`, ""), json: jsonPath.replace(`${root}/`, "") }, null, 2)}\n`);
  if (report.ok) return;
  process.exit(1);
}

function pickThree(values) {
  const unique = [...new Set(values.filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
  if (unique.length <= 3) return unique;
  return [unique[0], unique[Math.floor(unique.length / 2)], unique.at(-1)];
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
