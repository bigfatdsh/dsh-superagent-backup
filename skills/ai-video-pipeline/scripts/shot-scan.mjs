#!/usr/bin/env node
// 白模机位扫描（--test）：同一场里渲多套候选机位/焦段，并把关键物体的
// **投影位置** 算出来，对照契约的 must_show 打分，选完再花钱。
//
//   node shot-scan.mjs --test --blend projects/p/blockout/scene.blend \
//     --project projects/p --shot shot_01 \
//     --base "from=-1500,-1500,1920;look=600,0,1560" \
//     --lenses 50,65,85 --dolly 0.9,1.0,1.15 \
//     --out projects/p/blockout/scan/shot_01
//
// 为什么：上一轮 9 次生成里有 6 次是"机位/景别不对"造成的返工。机位是**免费**的
// （Blender 单帧 1-2 秒），花在这里比花在 Seedance 上便宜两个数量级。
//
// 判定：契约要求"主体位置偏移 ≤ 5% 画面宽"。所有候选都超差 → 退出码 1，
// 说明白模摆位本身有问题，回去改场景，不要改提示词。
//
//   只出计划不渲染（自测用）：--plan-only

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, "../../../..");
const DEFAULT_BLENDER = join(STUDIO, "tools/bin/blender");
const DEFAULT_FFMPEG = join(STUDIO, "tools/bin/ffmpeg");
const SCANNER = join(HERE, "scan_cameras.py");
const POSITION_TOLERANCE = 0.05; // 契约：主体位置偏移 ≤ 5% 画面宽
const SIZE_TOLERANCE = 0.3;      // 占宽相对偏差

function parseArgs(argv) {
  const args = { probe: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      if (key === "probe") args.probe.push(next);
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

function parseTriplet(value) {
  const parts = String(value).split(",").map((piece) => Number(piece.trim()));
  if (parts.length !== 3 || parts.some((piece) => !Number.isFinite(piece))) {
    throw new Error(`坐标必须是 x,y,z 三个数字：${value}`);
  }
  return parts;
}

function parseBase(text) {
  const result = {};
  for (const chunk of String(text).split(";")) {
    const [key, value] = chunk.split("=");
    if (!value) continue;
    if (key.trim() === "from") result.from_mm = parseTriplet(value);
    if (key.trim() === "look") result.look_mm = parseTriplet(value);
  }
  if (!result.from_mm || !result.look_mm) throw new Error('--base 需要 "from=x,y,z;look=x,y,z"');
  return result;
}

function parseProbe(text) {
  // paper@0.68,0.37@0.12
  const [object, at, size] = String(text).split("@");
  const [x, y] = String(at ?? "").split(",").map(Number);
  if (!object || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`--probe 格式：object@x,y@size（收到 ${text}）`);
  return { object: object.trim(), at: [x, y], size: Number(size) || 0.2 };
}

function dolly(from, look, factor) {
  return from.map((value, index) => look[index] + (value - look[index]) * factor);
}

function fmt(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "-";
}

function safeLabel(text) {
  return String(text).replace(/[^A-Za-z0-9._%+-]+/g, " ").trim().slice(0, 40);
}

async function findFont() {
  const candidates = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Verdana.ttf"
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function labelImage(ffmpeg, input, output, text, font) {
  const safe = safeLabel(text) || "candidate";
  const filter = `drawtext=fontfile='${font}':text='${safe}':x=10:y=8:fontsize=22:fontcolor=black:box=1:boxcolor=white@0.8:boxborderw=6`;
  const run = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vf", filter, output], { maxBuffer: 32 * 1024 * 1024 });
  return run.status === 0;
}

async function buildContactSheet(ffmpeg, files, columns, outDir, font) {
  const seqDir = join(outDir, "_seq");
  await mkdir(seqDir, { recursive: true });
  const staged = [];
  for (const [index, entry] of files.entries()) {
    const target = join(seqDir, `${String(index + 1).padStart(3, "0")}.png`);
    let ok = false;
    if (font) ok = await labelImage(ffmpeg, entry.file, target, entry.label, font);
    if (!ok) await copyFile(entry.file, target);
    staged.push(target);
  }
  const rows = Math.ceil(staged.length / columns);
  const contact = join(outDir, "contact.png");
  const run = spawnSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", "1", "-i", join(seqDir, "%03d.png"),
    "-vf", `tile=${columns}x${rows}:padding=4:margin=4:color=white`,
    "-frames:v", "1", contact
  ], { maxBuffer: 64 * 1024 * 1024 });
  return run.status === 0 ? contact : undefined;
}

function scoreVariant(variant, probes) {
  const worst = new Map();
  const missing = [];
  for (const frame of variant.frames) {
    for (const sample of frame.probes ?? []) {
      if (sample.missing) {
        if (!missing.includes(sample.object)) missing.push(sample.object);
        continue;
      }
      if (!sample.visible) continue;
      const target = probes.find((probe) => probe.object === sample.object);
      if (!target) continue;
      const posErr = Math.hypot(sample.x - target.at[0], sample.y - target.at[1]);
      const sizeErr = target.size ? Math.abs(sample.size - target.size) / target.size : 0;
      const previous = worst.get(sample.object) ?? { posErr: 0, sizeErr: 0, sample };
      if (posErr >= previous.posErr) {
        worst.set(sample.object, { posErr, sizeErr, sample });
      }
    }
  }
  const entries = [...worst.values()];
  const posErr = entries.length ? Math.max(...entries.map((entry) => entry.posErr)) : NaN;
  const sizeErr = entries.length ? Math.max(...entries.map((entry) => entry.sizeErr)) : NaN;
  const outside = entries.some((entry) => entry.sample.inFrame === false);
  const score = Number.isFinite(posErr)
    ? posErr * 2 + (Number.isFinite(sizeErr) ? sizeErr * 0.5 : 0) + (outside ? 0.5 : 0)
    : NaN;
  return {
    posErr,
    sizeErr,
    outside,
    score,
    missing,
    probes: [...worst.entries()].map(([object, entry]) => ({
      object,
      x: entry.sample.x,
      y: entry.sample.y,
      size: entry.sample.size,
      posErr: entry.posErr,
      sizeErr: entry.sizeErr
    }))
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.blend) throw new Error("用法：node shot-scan.mjs --test --blend <scene.blend> (--plan <json> | --base \"from=..;look=..\" --lenses 50,65) [--project p --shot s] [--out dir]");
  const blend = realpathSync(resolve(args.blend));
  const project = args.project ? resolve(args.project) : undefined;
  const shotId = args.shot;
  const outDir = resolve(args.out ?? (project && shotId ? join(project, "blockout/scan", shotId) : join(dirname(blend), "scan")));
  await mkdir(outDir, { recursive: true });

  const warnings = [];
  // ---------- 计划 ----------
  let plan;
  if (args.plan) {
    plan = await readJson(resolve(args.plan));
  } else {
    const base = parseBase(args.base);
    const lenses = String(args.lenses ?? "50").split(",").map(Number).filter(Number.isFinite);
    const dollies = String(args.dolly ?? "1.0").split(",").map(Number).filter(Number.isFinite);
    if (lenses.length === 0) throw new Error("--lenses 为空");
    const variants = [];
    for (const lens of lenses) {
      for (const factor of dollies) {
        variants.push({
          id: `${lens}mm_d${factor.toFixed(2)}`,
          lens_mm: lens,
          from_mm: dolly(base.from_mm, base.look_mm, factor),
          look_mm: base.look_mm
        });
      }
    }
    plan = {
      resolution: String(args.resolution ?? "640x360").split("x").map(Number),
      times: String(args.times ?? "0").split(",").map(Number).filter(Number.isFinite),
      fps: Number(args.fps ?? 24),
      variants
    };
  }
  if (!Array.isArray(plan.variants) || plan.variants.length === 0) throw new Error("计划里没有 variants");
  if (!plan.resolution) plan.resolution = [640, 360];
  if (!plan.times) plan.times = [0];
  if (!plan.fps) plan.fps = 24;

  // ---------- 探针 ----------
  const probes = [...(plan.probes ?? [])];
  for (const text of args.probe) probes.push(parseProbe(text));
  let contract;
  if (project) {
    const contractPath = join(project, "consistency.json");
    if (await exists(contractPath)) contract = await readJson(contractPath);
  }
  if (probes.length === 0 && project && shotId) {
    if (contract) {
      for (const item of contract.shots?.[shotId]?.must_show ?? []) {
        if (!item.object) continue;
        probes.push({ object: item.object, at: item.at ?? [0.5, 0.5], size: item.size ?? 0.2, what: item.what });
      }
      if (probes.length === 0) warnings.push("契约的 must_show 没有 object 字段：扫描只能出图，不能打分");
    } else {
      warnings.push("没有 consistency.json，且未给 --probe：本次只出图不打分");
    }
  }
  const tolerance = {
    position: Number(args["position-tolerance"] ?? contract?.scan?.tolerance?.position ?? POSITION_TOLERANCE),
    size: Number(args["size-tolerance"] ?? contract?.scan?.tolerance?.size ?? SIZE_TOLERANCE)
  };
  plan.probes = probes;

  const planPath = join(outDir, "scan-plan.json");
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  const base = {
    ok: true,
    blend: blend.replace(`${STUDIO}/`, ""),
    project,
    shot: shotId ?? null,
    outDir,
    planPath,
    probes,
    variants: plan.variants.length,
    tolerance,
    warnings,
    errors: []
  };

  if (args["plan-only"]) {
    process.stdout.write(`${JSON.stringify({ ...base, mode: "plan-only", plan }, null, 2)}\n`);
    return;
  }

  // ---------- 渲染 + 投影 ----------
  const blender = realpathSync(resolve(args.blender ?? process.env.BLENDER ?? DEFAULT_BLENDER));
  const run = spawnSync(blender, ["-b", blend, "--python", SCANNER, "--", planPath, outDir], {
    maxBuffer: 128 * 1024 * 1024,
    encoding: "utf8"
  });
  if (run.error) throw new Error(`Blender 启动失败：${run.error.message}`);
  if (run.status !== 0) {
    throw new Error(`Blender 扫描失败（exit=${run.status}）\n${String(run.stdout ?? "").slice(-3000)}\n${String(run.stderr ?? "").slice(-3000)}`);
  }
  const resultPath = join(outDir, "scan-result.json");
  if (!(await exists(resultPath))) throw new Error("Blender 没有产出 scan-result.json");
  const raw = await readJson(resultPath);
  if (raw.missing_probes?.length) warnings.push(`场景里找不到这些探针物体：${raw.missing_probes.join(", ")}`);

  const table = [];
  for (const variant of raw.variants ?? []) {
    const scored = scoreVariant(variant, probes);
    table.push({
      id: variant.id,
      lens_mm: variant.lens_mm,
      frames: (variant.frames ?? []).length,
      ...scored
    });
  }
  table.sort((a, b) => {
    if (!Number.isFinite(a.score) && !Number.isFinite(b.score)) return 0;
    if (!Number.isFinite(a.score)) return 1;
    if (!Number.isFinite(b.score)) return -1;
    return a.score - b.score;
  });

  const best = table.find((entry) => Number.isFinite(entry.score));
  let verdict = "unscored";
  if (best) {
    const positionOk = best.posErr <= tolerance.position + 1e-6;
    const sizeOk = !Number.isFinite(best.sizeErr) || best.sizeErr <= tolerance.size + 1e-6;
    verdict = positionOk && sizeOk && !best.outside ? "pass" : "fail";
    if (verdict === "fail") {
      const reasons = [];
      if (!positionOk) reasons.push(`位置偏差 ${fmt(best.posErr)} > ${tolerance.position}`);
      if (!sizeOk) reasons.push(`占宽偏差 ${fmt(best.sizeErr)} > ${tolerance.size}`);
      if (best.outside) reasons.push("主体中心出画");
      base.errors.push(`没有候选满足契约：最好的是 ${best.id}，${reasons.join("；")}。回 Blender 调主体/机位（或改契约里量错的 at/size），不要靠提示词补救。`);
    }
  } else if (probes.length > 0) {
    base.errors.push("所有候选都没有测到探针（物体可能全在画面外或相机背后），回 Blender 检查机位");
    verdict = "fail";
  }

  // ---------- contact sheet ----------
  const ffmpeg = realpathSync(resolve(args.ffmpeg ?? process.env.FFMPEG ?? DEFAULT_FFMPEG));
  // 按评分排序出图：最好的候选排在左上，看 contact 时不用来回对表
  const byId = new Map((raw.variants ?? []).map((variant) => [variant.id, variant]));
  const shots = [];
  for (const scored of table) {
    const variant = byId.get(scored.id);
    for (const frame of variant?.frames ?? []) {
      shots.push({
        file: join(outDir, frame.file),
        label: `${scored.id} ${frame.t}s pos=${fmt(scored.posErr, 2)}`
      });
    }
  }
  const columns = Math.min(4, Math.max(1, (raw.variants ?? []).length));
  const font = await findFont();
  if (!font) warnings.push("没有可用字体，contact.png 不带文字标签；对照 scan.md 的行列顺序看");
  const contact = await buildContactSheet(ffmpeg, shots, columns, outDir, font);
  if (!contact) warnings.push("contact sheet 生成失败，可直接看单张 PNG");

  // ---------- 报告 ----------
  const report = {
    ...base,
    verdict,
    recommended: verdict === "pass" ? best.id : null,
    best: best ?? null,
    table,
    contact: contact ? contact.replace(`${STUDIO}/`, "") : null,
    resultPath,
    next: verdict === "pass"
      ? `把 ${best.id} 的 lens/机位写进 shot spec 与 shotlist.camera，再 prep-shot`
      : "改白模（主体位置/场景/机位），重跑 --test；扫描不通过不许进 Seedance"
  };
  await writeFile(join(outDir, "scan.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const lines = [];
  lines.push(`# 机位扫描 — ${shotId ?? dirname(blend).split("/").pop()}`);
  lines.push("");
  lines.push(`- 结论：**${verdict.toUpperCase()}**${report.recommended ? `（推荐 ${report.recommended}）` : ""}`);
  lines.push(`- 场景：\`${base.blend}\`，候选 ${plan.variants.length} 个，探针 ${probes.length} 个`);
  lines.push(`- 容差：位置 ≤ ${tolerance.position}（画面宽归一化），占宽相对偏差 ≤ ${Math.round(tolerance.size * 100)}%`);
  lines.push("");
  lines.push("| 候选 | 焦段 | 位置偏差 | 占宽偏差 | 出画 | 评分 |");
  lines.push("|---|---|---|---|---|---|");
  for (const entry of table) {
    lines.push(`| ${entry.id} | ${entry.lens_mm}mm | ${fmt(entry.posErr)} | ${fmt(entry.sizeErr)} | ${entry.outside ? "是" : "否"} | ${fmt(entry.score)} |`);
  }
  lines.push("");
  if (probes.length > 0) {
    lines.push("## 契约探针");
    lines.push("");
    lines.push("| 物体 | 目标位置 | 目标占宽 | 最差候选实测 |");
    lines.push("|---|---|---|---|");
    for (const probe of probes) {
      const worst = table[table.length - 1];
      const measured = worst?.probes?.find((item) => item.object === probe.object);
      lines.push(`| ${probe.object}${probe.what ? `（${probe.what}）` : ""} | ${fmt(probe.at[0], 2)},${fmt(probe.at[1], 2)} | ${fmt(probe.size, 2)} | ${measured ? `${fmt(measured.x, 2)},${fmt(measured.y, 2)} / ${fmt(measured.size, 2)}` : "未测到"} |`);
    }
    lines.push("");
  }
  lines.push(report.next);
  lines.push("");
  if (contact) lines.push(`![contact](${contact})`);
  await writeFile(join(outDir, "scan.md"), `${lines.join("\n")}\n`, "utf8");

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length > 0) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
