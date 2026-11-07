#!/usr/bin/env node
// 从「已通过」的成片里截一帧，作为下一镜的衔接锚 / 新的场景锚。
//
//   node shot-anchor.mjs --video output/seedance/<taskId>.mp4 --at 4.4 \
//     --out blockout/anchors/shot_01_tail.jpg
//   node shot-anchor.mjs --video a.mp4 --at last --out blockout/anchors/scene.jpg
//
// 为什么：衔接锚（上一镜尾帧）是唯一能同时锁住空间、光位、调色和道具状态的
// 参考。用它 + 白模，接缝处才不会"换了个房间"。锚图只能来自已验收的成片或
// 白模渲染，不能拿未验收的生成帧当锚（会把错误固化成契约）。
//
// 退出码：0 成功；1 失败。

import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, "../../../..");
const FFMPEG = join(STUDIO, "tools/bin/ffmpeg");
const FFPROBE = join(STUDIO, "tools/bin/ffprobe");

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.video || !args.out) {
    throw new Error("用法：node shot-anchor.mjs --video <mp4> --at <秒|last> --out <jpg> [--width 1280]");
  }
  const video = resolve(args.video);
  const info = await stat(video).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`找不到视频：${video}`);
  const out = isAbsolute(args.out) ? args.out : resolve(args.out);
  await mkdir(dirname(out), { recursive: true });

  let at = args.at;
  if (at === undefined || at === true || at === "last") {
    const { stdout } = await execFileAsync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]);
    at = Math.max(0, Number(stdout.trim()) - 0.06);
  }
  const time = Number(at);
  if (!Number.isFinite(time) || time < 0) throw new Error(`--at 非法：${at}`);

  const width = Number(args.width ?? 1280);
  await execFileAsync(FFMPEG, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", time.toFixed(3), "-i", video,
    "-frames:v", "1",
    "-vf", `scale=${Math.round(width)}:-2`,
    "-q:v", "2",
    out
  ], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });

  const written = await stat(out);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    source: video,
    at: Number(time.toFixed(3)),
    out,
    bytes: written.size,
    next: "把这张图写进 consistency.json 的 shots.<id>.anchor_tail（或 subjects.*.anchor），再跑 prep-shot"
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
