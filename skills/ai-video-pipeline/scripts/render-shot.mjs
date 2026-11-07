#!/usr/bin/env node
// Deterministic white-model shot renderer.
//
//   node render-shot.mjs --spec projects/demo/shot.json --out projects/demo/renders/shot_01
//
// Blender builds the blockout + camera path, renders PNG frames with Workbench
// (clean white model, no overlays), then this wrapper encodes H.264 MP4 with
// ffmpeg, exports first/last frames and a contact sheet, and probes the result.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, "../../../..");
const DEFAULT_BLENDER = join(STUDIO, "tools/bin/blender");
const DEFAULT_FFMPEG = join(STUDIO, "tools/bin/ffmpeg");
const DEFAULT_FFPROBE = join(STUDIO, "tools/bin/ffprobe");
const SHOT_BUILDER = join(HERE, "shot_builder.py");

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

function fail(message, details) {
  const error = new Error(message);
  if (details) error.details = details;
  throw error;
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object") fail("shot spec 必须是 JSON 对象");
  if (typeof spec.name !== "string" || !/^[a-zA-Z0-9._-]+$/.test(spec.name)) fail("spec.name 必须是字母/数字/._- 组成的文件名安全字符串");
  const fps = Number(spec.fps ?? 24);
  if (!Number.isFinite(fps) || fps < 12 || fps > 60) fail("spec.fps 必须在 12-60");
  const duration = Number(spec.duration_seconds ?? 5);
  if (!Number.isFinite(duration) || duration < 0.5 || duration > 30) fail("spec.duration_seconds 必须在 0.5-30");
  const resolution = spec.resolution ?? [1280, 720];
  if (!Array.isArray(resolution) || resolution.length !== 2 || resolution.some((value) => !Number.isFinite(Number(value)))) {
    fail("spec.resolution 必须是 [width, height]");
  }
  const width = Number(resolution[0]);
  const height = Number(resolution[1]);
  if (width < 256 || height < 256 || width > 1920 || height > 1920) fail("spec.resolution 每边必须在 256-1920");
  const keyframes = spec.camera?.keyframes;
  if (!Array.isArray(keyframes) || keyframes.length === 0) fail("spec.camera.keyframes 至少需要一个关键帧");
  for (const keyframe of keyframes) {
    if (!Number.isFinite(Number(keyframe.t))) fail("camera keyframe.t 必须是秒数");
    if (!Array.isArray(keyframe.from_mm) || keyframe.from_mm.length !== 3) fail("camera keyframe.from_mm 必须是 [x,y,z] mm");
    if (!Array.isArray(keyframe.look_at_mm) || keyframe.look_at_mm.length !== 3) fail("camera keyframe.look_at_mm 必须是 [x,y,z] mm");
  }
  return { fps, duration, width, height };
}

async function md5(path) {
  const hash = createHash("md5");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).slice(-4000) : "";
    const stdout = error?.stdout ? String(error.stdout).slice(-4000) : "";
    fail(`命令失败：${command} ${args.join(" ")}\n${stderr}\n${stdout}`.trim());
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.spec || !args.out) fail("用法：node render-shot.mjs --spec <shot.json> --out <dir> [--blender path] [--ffmpeg path] [--ffprobe path]");
  const specPath = resolve(args.spec);
  const spec = await loadJson(specPath);
  const { fps, duration, width, height } = validateSpec(spec);
  const outDir = resolve(args.out);
  const framesDir = join(outDir, "frames");
  await mkdir(framesDir, { recursive: true });
  await mkdir(join(outDir, "qa"), { recursive: true });

  const blender = realpathSync(resolve(args.blender ?? process.env.BLENDER ?? DEFAULT_BLENDER));
  const ffmpeg = resolve(args.ffmpeg ?? process.env.FFMPEG ?? DEFAULT_FFMPEG);
  const ffprobe = resolve(args.ffprobe ?? process.env.FFPROBE ?? DEFAULT_FFPROBE);
  for (const [label, path] of [["blender", blender], ["ffmpeg", ffmpeg], ["ffprobe", ffprobe]]) {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) fail(`找不到 ${label}：${path}`);
  }

  const started = Date.now();
  const blenderRun = spawnSync(blender, [
    "-b", "--factory-startup", "--python", SHOT_BUILDER,
    "--", "--spec", specPath, "--out", outDir
  ], { encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 128 * 1024 * 1024 });
  if (blenderRun.error) fail(`Blender 启动失败：${String(blenderRun.error.message ?? blenderRun.error)}`);
  if (blenderRun.status !== 0) {
    fail(`Blender 渲染失败（exit=${blenderRun.status}）`, {
      stdout: String(blenderRun.stdout ?? "").slice(-6000),
      stderr: String(blenderRun.stderr ?? "").slice(-6000)
    });
  }
  const resultLine = String(blenderRun.stdout ?? "").split(/\r?\n/).reverse().find((line) => line.startsWith("SHOT_BUILDER_RESULT "));
  let buildMeta;
  try {
    buildMeta = resultLine ? JSON.parse(resultLine.slice("SHOT_BUILDER_RESULT ".length)) : await loadJson(join(outDir, "shot_meta.json"));
  } catch (error) {
    fail(`无法读取 Blender 结果：${String(error?.message ?? error)}`);
  }
  if (!buildMeta?.ok) fail("Blender 没有产出帧", buildMeta);

  const frameFiles = (await readdir(framesDir))
    .filter((name) => /^frame_\d+\.png$/i.test(name))
    .sort()
    .map((name) => join(framesDir, name));
  if (frameFiles.length === 0) fail("frames 目录为空");

  const mp4 = join(outDir, `${spec.name}.mp4`);
  const encodeArgs = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", String(fps),
    "-i", join(framesDir, "frame_%04d.png"),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    mp4
  ];
  run(ffmpeg, encodeArgs);
  const mp4Info = await stat(mp4);
  if (!mp4Info.size) fail("MP4 输出为空");

  const firstFrame = join(outDir, "first.png");
  const lastFrame = join(outDir, "last.png");
  await copyFile(frameFiles[0], firstFrame);
  await copyFile(frameFiles[frameFiles.length - 1], lastFrame);

  const contact = join(outDir, "contact.png");
  try {
    // 2 fps catches a 1 s walk cycle; 1 fps would alias to the same pose.
    const sampled = Math.max(2, Math.round(duration * 2));
    const columns = Math.min(5, sampled);
    const rows = Math.ceil(sampled / columns);
    run(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", mp4,
      "-vf", `fps=2,scale=480:-2,tile=${columns}x${rows}:padding=8:margin=8`,
      "-frames:v", "1",
      contact
    ]);
  } catch {
    /* contact sheet is optional */
  }

  let probe;
  try {
    const output = run(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration,size:stream=codec_name,width,height,r_frame_rate,nb_frames",
      "-of", "json", mp4
    ]);
    probe = JSON.parse(output);
  } catch (error) {
    probe = { error: String(error?.message ?? error) };
  }

  const report = {
    ok: true,
    name: spec.name,
    spec: specPath,
    outDir,
    mp4,
    mp4Bytes: mp4Info.size,
    mp4Md5: await md5(mp4),
    durationSeconds: duration,
    fps,
    resolution: [width, height],
    frameCount: frameFiles.length,
    framesDir,
    firstFrame,
    lastFrame,
    contactSheet: contact,
    blend: join(outDir, `${spec.name}.blend`),
    meta: buildMeta,
    probe,
    elapsedMs: Date.now() - started
  };
  await writeFile(join(outDir, "qa", "render-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error), details: error?.details }, null, 2)}\n`);
  process.exit(1);
});
