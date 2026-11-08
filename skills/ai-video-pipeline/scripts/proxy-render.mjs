#!/usr/bin/env node
// 把已有的 .blend 渲成「材质代理」参考视频（或对照用的平灰白模）。
//
//   node proxy-render.mjs --blend projects/p/blockout/scene.blend \
//     --camera shot_03_cam --frames 1-120 --out projects/p/blockout/proxy/shot_03
//   node proxy-render.mjs … --style gray --out …/gray/shot_03      # 对照
//
// 产物：proxy/<shot>/proxy.mp4 + first.png + last.png + contact.png + proxy.json
//
// 为什么：Seedance 拿到的参考视频如果是"平涂灰块"，它只能照抄"光滑简单体块"的语言，
// 成片就是塑料感 CG。材质代理给它材质分区 + 明暗 + 高光，模型才有东西可"写实化"。

import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, "../../../..");
const DEFAULT_BLENDER = join(STUDIO, "tools/bin/blender");
const DEFAULT_FFMPEG = join(STUDIO, "tools/bin/ffmpeg");
const PY = join(HERE, "proxy_render.py");

function parseArgs(argv) {
  const args = { map: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      if (key === "map") args.map.push(next);
      else args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function exists(path) {
  return Boolean(await stat(path).then((info) => info.isFile(), () => false));
}

function parseFrames(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "number") return [value, value];
  const text = String(value ?? "");
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(text);
  if (!match) throw new Error(`--frames 需要 "起-止"，例如 1-120（收到 ${text}）`);
  return [Number(match[1]), Number(match[2])];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.blend || !args.out) {
    throw new Error("用法：node proxy-render.mjs --blend <scene.blend> --out <dir> [--camera name] [--frames 1-120] [--style proxy|gray] [--resolution 1280x720] [--map hand*=gear]");
  }
  const blend = realpathSync(resolve(args.blend));
  if (!(await exists(blend))) throw new Error(`找不到 .blend：${blend}`);
  const outDir = resolve(args.out);
  await mkdir(outDir, { recursive: true });

  const mapping = {};
  for (const entry of args.map) {
    const [pattern, key] = String(entry).split("=");
    if (!pattern || !key) throw new Error(`--map 需要 模式=材质，例如 hand*=gear（收到 ${entry}）`);
    mapping[pattern] = key;
  }
  const plan = {
    out_dir: outDir,
    mapping,
    style: args.style === "gray" ? "gray" : "proxy",
    camera: args.camera ? String(args.camera) : undefined,
    frames: parseFrames(args.frames ?? "1-120"),
    hide_fx: !args["keep-fx"],
    fps: Number(args.fps ?? 24),
    resolution: String(args.resolution ?? "1280x720").split("x").map(Number)
  };
  const planPath = join(outDir, "proxy-plan.json");
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  const blender = realpathSync(resolve(args.blender_bin ?? process.env.BLENDER ?? DEFAULT_BLENDER));
  const ffmpeg = resolve(args.ffmpeg ?? process.env.FFMPEG ?? DEFAULT_FFMPEG);
  const run = spawnSync(blender, ["-b", blend, "--python", PY, "--", planPath], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 30 * 60 * 1000
  });
  if (run.error) throw new Error(`Blender 启动失败：${run.error.message}`);
  if (run.status !== 0) {
    throw new Error(`Blender 渲染失败（exit=${run.status}）\n${String(run.stdout ?? "").slice(-3000)}\n${String(run.stderr ?? "").slice(-3000)}`);
  }
  const resultPath = join(outDir, "proxy-result.json");
  if (!(await exists(resultPath))) throw new Error("Blender 没有产出 proxy-result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8"));

  const framesDir = join(outDir, "frames");
  const video = join(outDir, plan.style === "gray" ? "gray.mp4" : "proxy.mp4");
  const encode = spawnSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", String(plan.fps), "-i", join(framesDir, "frame_%04d.png"),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", video
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (encode.status !== 0) throw new Error(`ffmpeg 编码失败：${String(encode.stderr ?? "").slice(-1500)}`);

  const first = join(outDir, "first.png");
  const last = join(outDir, "last.png");
  const contact = join(outDir, "contact.png");
  execFileSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", video, "-frames:v", "1", first]);
  execFileSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-sseof", "-0.1", "-i", video, "-frames:v", "1", last]);
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", video,
    "-vf", "select='eq(n\\,6)+eq(n\\,30)+eq(n\\,60)+eq(n\\,90)',scale=480:-2,tile=4x1",
    "-frames:v", "1", contact
  ]);

  const report = {
    ok: true,
    blend,
    outDir,
    style: plan.style,
    camera: result.camera,
    frames: result.frames,
    resolution: result.resolution,
    fps: result.fps,
    materials: result.materials,
    fxHidden: result.fx_hidden,
    mapping,
    video,
    contact,
    next: plan.style === "gray"
      ? "这是对照组（平涂白模），只用于 A/B；参考视频请用 --style proxy"
      : "把 proxy.mp4 作为 reference_videos 的 @视频1；prompt 里说明「参考它的光照方向/材质分区/形体，不要继承它的代理颜色」"
  };
  await writeFile(join(outDir, "proxy.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
