#!/usr/bin/env node
// Video QA: probe duration/resolution/fps, extract first/mid/last frames, hash.
//
//   node qa-video.mjs --video projects/demo/output/seedance/cgt-xxx.mp4 \
//     --expect-duration 5 --expect-resolution 1280x720 --strict
//
// Writes <video-dir>/qa/video-report.json and prints the report.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, "../../../..");
const FFPROBE = join(STUDIO, "tools/bin/ffprobe");
const FFMPEG = join(STUDIO, "tools/bin/ffmpeg");

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

function parseFps(value) {
  if (typeof value !== "string" || !value.includes("/")) return Number(value) || undefined;
  const [num, den] = value.split("/").map(Number);
  return den ? num / den : undefined;
}

async function md5(path) {
  const hash = createHash("md5");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function extract(path, time, out) {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  if (time > 0) args.push("-ss", String(time));
  args.push("-i", path, "-frames:v", "1", "-q:v", "2", out);
  await execFileAsync(FFMPEG, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.video) throw new Error("用法：node qa-video.mjs --video <mp4> [--expect-duration 5] [--expect-resolution 1280x720] [--expect-fps 24] [--strict]");
  const video = resolve(args.video);
  const info = await stat(video).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`找不到视频：${video}`);
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames",
    "-of", "json", video
  ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  const stream = (parsed.streams ?? []).find((item) => item.codec_type === "video") ?? {};
  const audio = (parsed.streams ?? []).find((item) => item.codec_type === "audio");
  const duration = Number(parsed.format?.duration ?? 0);
  const width = Number(stream.width ?? 0);
  const height = Number(stream.height ?? 0);
  const fps = parseFps(stream.r_frame_rate);
  const outDir = resolve(args.out ?? join(dirname(video), "qa"));
  await mkdir(outDir, { recursive: true });
  const stem = extname(video) ? video.slice(0, -extname(video).length) : video;
  const base = stem.split("/").pop();
  const frames = {
    first: await extract(video, 0, join(outDir, `${base}-first.jpg`)),
    middle: await extract(video, Math.max(0, duration / 2), join(outDir, `${base}-middle.jpg`)),
    last: await extract(video, Math.max(0, duration - 0.08), join(outDir, `${base}-last.jpg`))
  };

  const checks = [];
  if (args["expect-duration"] !== undefined) {
    const expected = Number(args["expect-duration"]);
    const delta = Math.abs(duration - expected);
    checks.push({ id: "duration", ok: delta <= 0.6, expected, actual: duration, delta });
  }
  if (args["expect-resolution"] !== undefined) {
    const [expectedWidth, expectedHeight] = String(args["expect-resolution"]).split("x").map(Number);
    checks.push({ id: "resolution", ok: width === expectedWidth && height === expectedHeight, expected: [expectedWidth, expectedHeight], actual: [width, height] });
  }
  if (args["expect-fps"] !== undefined) {
    const expected = Number(args["expect-fps"]);
    checks.push({ id: "fps", ok: Number.isFinite(fps) && Math.abs(fps - expected) <= 0.5, expected, actual: fps });
  }
  if (width > 0 && height > 0) {
    const ratio = width / height;
    checks.push({ id: "aspect", ok: ratio > 0.3 && ratio < 3, actual: Number(ratio.toFixed(4)) });
  }
  const report = {
    ok: checks.every((check) => check.ok),
    video,
    bytes: Number(parsed.format?.size ?? info.size),
    md5: await md5(video),
    durationSeconds: duration,
    width,
    height,
    fps,
    codec: stream.codec_name,
    frames: stream.nb_frames ? Number(stream.nb_frames) : undefined,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name,
    checks,
    extractedFrames: frames
  };
  const reportPath = join(outDir, "video-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  if (args.strict && !report.ok) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
