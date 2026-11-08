#!/usr/bin/env node
// 一致性契约（consistency.json）的生成与校验。
//
//   新建：node contract-init.mjs --project projects/my-film
//   校验：node contract-init.mjs --project projects/my-film --check
//
// 契约是全片唯一真源：角色 / 场景 / 道具 / 调色 / 画幅，以及每镜的
// must_show（必须可见）、cues（声画时间点）、avoid（本片特有排除项）。
// 生成的是骨架，人（导演）必须填完 —— 没填完 -check 会报错，这是故意的。
//
// 退出码：0 通过；1 有阻塞问题。

import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const RATIOS = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];

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

function isNormalized(value) {
  return Array.isArray(value) && value.length === 2 && value.every((n) => Number.isFinite(n) && n >= 0 && n <= 1);
}

function skeleton(shotlist) {
  const format = shotlist.format ?? {};
  const shots = {};
  for (const shot of shotlist.shots ?? []) {
    shots[shot.id] = {
      anchor_tail: "",
      logic: "",
      must_show: [],
      cues: [],
      avoid: []
    };
  }
  return {
    schema: 1,
    project: shotlist.project,
    title: shotlist.title ?? shotlist.project,
    format: {
      ratio: format.ratio ?? "16:9",
      resolution: format.resolution ?? [1280, 720],
      fps: format.fps ?? 24
    },
    grade: {
      look: String(shotlist.global?.style ?? "写实电影质感，克制调色"),
      luma: { min: 0.08, max: 0.4 },
      saturation: { min: 0.02, max: 0.3 },
      tolerance: { luma: 0.05, saturationRelative: 0.25 }
    },
    subjects: {
      character: {
        anchor: "blockout/anchors/character.jpg",
        text: String(shotlist.global?.character_description ?? ""),
        locked: []
      },
      scene: {
        anchor: "blockout/anchors/scene.jpg",
        text: String(shotlist.global?.scene_description ?? ""),
        locked: []
      },
      props: []
    },
    audio: {
      mode: "post",
      tolerance: 0.2,
      note: "时间敏感镜头默认不生成模型音频；后期按帧配音。mode=model 时用 cues 的峰值校验。"
    },
    global_avoid: [],
    shots
  };
}

function validate(data, shotlist) {
  const errors = [];
  const warnings = [];
  if (data.schema !== 1) errors.push("schema 必须是 1");
  if (!data.project) errors.push("project 必填");
  if (shotlist.project && data.project !== shotlist.project) errors.push(`project=${data.project} 与 shotlist.project=${shotlist.project} 不一致`);

  const fmt = data.format ?? {};
  if (!RATIOS.includes(fmt.ratio)) errors.push(`format.ratio 非法：${fmt.ratio}`);
  if (!Array.isArray(fmt.resolution) || fmt.resolution.length !== 2) errors.push("format.resolution 必须是 [width,height]");
  if (!Number.isFinite(Number(fmt.fps))) errors.push("format.fps 必须是数字");
  const shotFmt = shotlist.format ?? {};
  if (shotFmt.ratio && fmt.ratio !== shotFmt.ratio) warnings.push(`契约 ratio=${fmt.ratio} 与 shotlist ratio=${shotFmt.ratio} 不一致`);
  if (Array.isArray(shotFmt.resolution) && Array.isArray(fmt.resolution) && shotFmt.resolution.join("x") !== fmt.resolution.join("x")) {
    warnings.push(`契约分辨率 ${fmt.resolution.join("x")} 与 shotlist ${shotFmt.resolution.join("x")} 不一致`);
  }

  const grade = data.grade ?? {};
  if (!grade.look) errors.push("grade.look 必填（调色一句话，全片统一）");
  const tol = grade.tolerance ?? {};
  if (!Number.isFinite(Number(tol.luma))) warnings.push("grade.tolerance.luma 未设置，默认 0.05");
  if (!Number.isFinite(Number(tol.saturationRelative))) warnings.push("grade.tolerance.saturationRelative 未设置，默认 0.25");

  const subjects = data.subjects ?? {};
  for (const key of ["character", "scene"]) {
    const subject = subjects[key];
    if (!subject || typeof subject !== "object") {
      errors.push(`subjects.${key} 必填`);
      continue;
    }
    if (!subject.anchor) errors.push(`subjects.${key}.anchor 必填（定妆锚图路径）`);
    const style = String(data.look?.style ?? "photoreal").toLowerCase();
    const provenance = subject.anchorProvenance;
    if (provenance === undefined) {
      warnings.push(`${key}.anchorProvenance 未声明（photo / accepted-frame / blockout）：写实项目的锚图必须是照片级`);
    } else if (!["photo", "accepted-frame", "blockout"].includes(provenance)) {
      errors.push(`subjects.${key}.anchorProvenance 非法：${provenance}（photo / accepted-frame / blockout）`);
    } else if (provenance === "blockout" && style !== "stylized") {
      errors.push(`subjects.${key} 的定妆锚是白模渲染（blockout）：模型只能给白模"染色"，不会"渲染"。换成真实照片或已验收成片帧；纯风格化项目请写 look.style="stylized"`);
    }
    if (!Array.isArray(subject.locked) || subject.locked.length === 0) {
      errors.push(`subjects.${key}.locked 至少列 3 条「锁死项」（锚图里不许变的外观特征）`);
    }
  }
  if (!Array.isArray(subjects.props)) errors.push("subjects.props 必须是数组（可以是空数组，但道具镜头必须加）");
  for (const [index, prop] of (subjects.props ?? []).entries()) {
    if (!prop?.id) errors.push(`subjects.props[${index}].id 必填`);
    if (!prop?.anchor) errors.push(`subjects.props[${index}].anchor 必填`);
    if (prop?.ratios && typeof prop.ratios !== "object") errors.push(`subjects.props[${index}].ratios 必须是对象`);
  }

  const known = new Set((shotlist.shots ?? []).map((shot) => shot.id));
  const shots = data.shots ?? {};
  for (const id of Object.keys(shots)) {
    if (!known.has(id)) errors.push(`shots.${id} 不在 shotlist 里`);
  }
  for (const shot of shotlist.shots ?? []) {
    const entry = shots[shot.id];
    if (!entry) {
      errors.push(`shots.${shot.id} 缺失：每颗镜头都必须有 must_show / cues`);
      continue;
    }
    if (!Array.isArray(entry.must_show) || entry.must_show.length === 0) {
      errors.push(`shots.${shot.id}.must_show 不能为空：写清这颗镜头「必须看得见什么」`);
    }
    for (const [index, item] of (entry.must_show ?? []).entries()) {
      if (!item?.what) errors.push(`shots.${shot.id}.must_show[${index}].what 必填`);
      if (item?.object !== undefined && (typeof item.object !== "string" || item.object.trim() === "")) {
        errors.push(`shots.${shot.id}.must_show[${index}].object 必须是非空字符串（白模里的物体名，供机位扫描用）`);
      }
      if (!isNormalized(item?.at)) errors.push(`shots.${shot.id}.must_show[${index}].at 必须是 [0-1, 0-1] 的归一化坐标`);
      const size = Number(item?.size);
      if (!Number.isFinite(size) || size <= 0.02 || size > 1) errors.push(`shots.${shot.id}.must_show[${index}].size 必须落在 (0.02, 1]`);
    }
    const duration = Number(shot.duration ?? 5);
    const cues = entry.cues ?? [];
    if (!Array.isArray(cues)) errors.push(`shots.${shot.id}.cues 必须是数组`);
    let last = -1;
    for (const [index, cue] of cues.entries()) {
      const t = Number(cue?.t);
      if (!Number.isFinite(t)) errors.push(`shots.${shot.id}.cues[${index}].t 必须是数字`);
      else if (t < 0 || t > duration) errors.push(`shots.${shot.id}.cues[${index}].t=${t} 超出镜头时长 ${duration}s`);
      else if (t < last) errors.push(`shots.${shot.id}.cues 必须按时间升序`);
      else last = t;
      if (!cue?.event) errors.push(`shots.${shot.id}.cues[${index}].event 必填`);
    }
    if (entry.avoid !== undefined && !Array.isArray(entry.avoid)) errors.push(`shots.${shot.id}.avoid 必须是字符串数组`);
    if (!(entry.must_show ?? []).some((item) => item.object)) {
      warnings.push(`shots.${shot.id}.must_show 没有 object 字段：机位扫描只能出图、不能校验主体位置`);
    }
    if (!entry.logic) warnings.push(`shots.${shot.id}.logic 为空：物理/因果逻辑（准星是否对准靶心、运动方向）没写，容易被模型画错`);
  }

  if (!data.audio?.mode) errors.push("audio.mode 必填：post（后期配音）或 model（模型音频）");
  return { errors, warnings };
}

async function checkAnchors(data, root) {
  const errors = [];
  const warnings = [];
  const paths = [];
  if (data.subjects?.character?.anchor) paths.push(["subjects.character.anchor", data.subjects.character.anchor]);
  if (data.subjects?.scene?.anchor) paths.push(["subjects.scene.anchor", data.subjects.scene.anchor]);
  for (const [index, prop] of (data.subjects?.props ?? []).entries()) {
    if (prop?.anchor) paths.push([`subjects.props[${index}].anchor`, prop.anchor]);
  }
  for (const [shotId, entry] of Object.entries(data.shots ?? {})) {
    if (entry?.anchor_tail) paths.push([`shots.${shotId}.anchor_tail`, entry.anchor_tail]);
  }
  for (const [label, path] of paths) {
    const absolute = isAbsolute(path) ? path : join(root, path);
    if (!(await exists(absolute))) errors.push(`${label} 锚图不存在：${absolute}`);
  }
  if (paths.length > 0) warnings.push(`已登记 ${paths.length} 张锚图；锚图必须来自「已通过」的成片或白模渲染，不许用未验收的生成帧`);
  return { errors, warnings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) throw new Error("用法：node contract-init.mjs --project projects/<name> [--check] [--force]");
  const root = resolve(args.project);
  const shotlistPath = args.file ? resolve(args.file) : join(root, "shotlist.json");
  let shotlist;
  try {
    shotlist = await readJson(shotlistPath);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: `读不到 ${shotlistPath}: ${String(error?.message ?? error)}` }, null, 2)}\n`);
    process.exit(1);
  }
  const contractPath = args.contract ? resolve(args.contract) : join(root, "consistency.json");

  if (!args.check) {
    if (await exists(contractPath) && !args.force) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: `${contractPath} 已存在；要重建加 --force（会覆盖已填的契约）` }, null, 2)}\n`);
      process.exit(1);
    }
    const data = skeleton(shotlist);
    await writeFile(contractPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, created: contractPath, shots: Object.keys(data.shots).length, next: "填完 subjects/props/grade 与每镜 must_show/cues/logic，再跑 --check" }, null, 2)}\n`);
    return;
  }

  let data;
  try {
    data = await readJson(contractPath);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, errors: [`读不到 ${contractPath}: ${String(error?.message ?? error)}`], warnings: [] }, null, 2)}\n`);
    process.exit(1);
  }
  const base = validate(data, shotlist);
  const anchors = await checkAnchors(data, root);
  const errors = [...base.errors, ...anchors.errors];
  const warnings = [...base.warnings, ...anchors.warnings];
  const report = { ok: errors.length === 0, contract: contractPath, project: root, errors, warnings };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
