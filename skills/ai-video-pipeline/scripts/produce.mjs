#!/usr/bin/env node
// 制片成本门禁：先问用户 → 再锁预算 → 再逐镜放行。
//
//   node produce.mjs intake  --project projects/p                # 打印问卷（交给 ask_user_question）
//   node produce.mjs intake  --project projects/p --set deliveryResolution=1080p,durationPerShot=5
//   node produce.mjs intake  --project projects/p --confirm --note "用户已在对话框确认"
//   node produce.mjs plan    --project projects/p
//   node produce.mjs gate    --project projects/p --shot shot_01 --tier draft|final
//   node produce.mjs record  --project projects/p --shot shot_01 --tier draft --taskId cgt-... --resolution 480p --duration 5
//   node produce.mjs approve --project projects/p --shot shot_01 --tier draft --note "骨架/构图通过"
//   node produce.mjs status  --project projects/p
//
// 设计前提：Seedance 每一次提交都花钱，而"没问用户就开跑"是本管线最贵的错误。
// 所以 gate 是一道硬门：没确认、没契约、没机位扫描、超预算、超每镜次数，一律拒绝。
//
// 成本用「成本指数」表达（非货币）：指数 = 像素比 × 秒数，以 854×480 为 1.0。
// 想换算成钱，把 unitPriceYuan 填上（自己去方舟控制台查单价），报告会附估算。

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const RESOLUTIONS = {
  "480p": [854, 480],
  "720p": [1280, 720],
  "1080p": [1920, 1080]
};
const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
const DRAFT_POLICIES = ["all", "risky", "none"];
// 上一轮《靶场校准》实测：4 个镜头用了 9 次生成（2.25×），其中 6 次是返工
const OBSERVED_RETRY_FACTOR = 2.25;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
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

function units(resolution, seconds) {
  const [width, height] = RESOLUTIONS[resolution] ?? [1280, 720];
  return Number(((width * height) / (854 * 480) * Number(seconds)).toFixed(2));
}

function parseSet(text) {
  const patch = {};
  for (const chunk of String(text).split(",")) {
    const [key, value] = chunk.split("=");
    if (!key || value === undefined) continue;
    patch[key.trim()] = value.trim();
  }
  return patch;
}

function questions() {
  return [
    { id: "deliveryResolution", header: "交付画质", question: "成片要什么画质？（直接决定每次生成的成本：1080p ≈ 720p 的 2.25 倍 ≈ 480p 的 5 倍）", options: ["1080p（交付推荐）", "720p（省一半）", "480p（只做草稿）"] },
    { id: "durationPerShot", header: "单镜时长", question: "每个镜头多长？（Seedance 2.5 只支持 4–30 秒，没有 3 秒）", options: ["5 秒（默认，最省）", "4 秒", "8 秒", "10 秒"] },
    { id: "ratio", header: "画幅", question: "成片画幅？", options: ["16:9 横屏", "9:16 竖屏", "1:1 方形", "2.35:1 宽银幕（用 21:9）"] },
    { id: "generateAudio", header: "声音", question: "声音怎么做？", options: ["后期配音（推荐：时间点可控，模型音频实测会偏 0.3–1.3s）", "模型直接生成音频（快，但声画对不齐）"] },
    { id: "shotCount", header: "镜头数", question: "这次要出几个镜头？" },
    { id: "draftPolicy", header: "样片策略", question: "要不要先出 480p 样片？（样片能提前发现构图/身份问题，一次交付返工通常比样片贵 5 倍）", options: ["每镜都先出样片（推荐：首次通过率最高）", "只给高风险镜头出样片（最省钱）", "不出样片，直接交付（返工风险最高）"] },
    { id: "maxPaidCalls", header: "调用上限", question: "这次最多允许提交多少次付费生成？（建议 = 镜头数 × 2）" },
    { id: "requireScan", header: "机位扫描", question: "是否要求每个镜头先通过机位扫描（白模 640×360 样张 + 主体位置校验，免费）？", options: ["必须通过才能生成（推荐）", "只出图不卡门"] }
  ];
}

function defaults(shotlist) {
  const shots = shotlist?.shots ?? [];
  const durations = shots.map((shot) => Number(shot.duration ?? 5)).filter(Number.isFinite);
  const perShot = durations.length ? Math.max(...durations) : 5;
  const count = shots.length || 1;
  return {
    deliveryResolution: "1080p",
    draftResolution: "480p",
    durationPerShot: perShot,
    ratio: shotlist?.format?.ratio ?? "16:9",
    fps: shotlist?.format?.fps ?? 24,
    generateAudio: false,
    shotCount: count,
    draftPolicy: count <= 6 ? "all" : "risky",
    maxPaidCalls: Math.min(count * 2, 24),
    maxCallsPerShot: 2,
    maxUnits: null,
    unitPriceYuan: null,
    requireScan: true
  };
}

function validateAnswers(answers, errors, warnings) {
  if (!RESOLUTIONS[answers.deliveryResolution]) errors.push(`deliveryResolution 必须是 ${Object.keys(RESOLUTIONS).join("/")}`);
  if (!RESOLUTIONS[answers.draftResolution]) errors.push(`draftResolution 必须是 ${Object.keys(RESOLUTIONS).join("/")}`);
  if (answers.draftResolution === answers.deliveryResolution && answers.draftPolicy !== "none") {
    warnings.push("样片和交付用同一画质：样片就失去省钱意义了");
  }
  const duration = Number(answers.durationPerShot);
  if (!Number.isInteger(duration) || duration < 4 || duration > 30) errors.push("durationPerShot 必须是 4-30 的整数（Seedance 2.5，没有 3 秒）");
  if (!RATIOS.includes(answers.ratio)) errors.push(`ratio 必须是 ${RATIOS.join("/")}`);
  if (!DRAFT_POLICIES.includes(answers.draftPolicy)) errors.push(`draftPolicy 必须是 ${DRAFT_POLICIES.join("/")}`);
  const shots = Number(answers.shotCount);
  if (!Number.isInteger(shots) || shots < 1 || shots > 40) errors.push("shotCount 必须是 1-40");
  const maxCalls = Number(answers.maxPaidCalls);
  if (!Number.isInteger(maxCalls) || maxCalls < 1) errors.push("maxPaidCalls 必须是正整数");
  const perShot = Number(answers.maxCallsPerShot);
  if (!Number.isInteger(perShot) || perShot < 1 || perShot > 3) errors.push("maxCallsPerShot 必须是 1-3（第 3 次已经是结构性问题，必须重新确认预算）");
  if (Number(maxCalls) < Number(shots)) errors.push(`maxPaidCalls=${maxCalls} 小于镜头数 ${shots}：连一镜一条都不够`);
  if (answers.maxUnits !== null && answers.maxUnits !== undefined) {
    const cap = Number(answers.maxUnits);
    if (!Number.isFinite(cap) || cap <= 0) errors.push("maxUnits 必须是正数或 null");
  }
  if (answers.unitPriceYuan !== null && answers.unitPriceYuan !== undefined) {
    const price = Number(answers.unitPriceYuan);
    if (!Number.isFinite(price) || price < 0) errors.push("unitPriceYuan 必须是非负数或 null");
  }
  if (typeof answers.requireScan !== "boolean") errors.push("requireScan 必须是布尔值");
}

function plannedTiers(answers, shot) {
  const risky = shot?.risk === "high" || shot?.seedance?.mode === "first_last_frame" || shot?.multi_person_contact === true;
  if (answers.draftPolicy === "all") return ["draft", "final"];
  if (answers.draftPolicy === "risky") return risky ? ["draft", "final"] : ["final"];
  return ["final"];
}

function estimate(answers, shotlist) {
  const shots = shotlist?.shots ?? [];
  const rows = [];
  let calls = 0;
  let cost = 0;
  for (const shot of shots) {
    const tiers = plannedTiers(answers, shot);
    const seconds = Number(shot.duration ?? answers.durationPerShot);
    let shotUnits = 0;
    for (const tier of tiers) {
      const resolution = tier === "draft" ? answers.draftResolution : answers.deliveryResolution;
      shotUnits += units(resolution, seconds);
      calls += 1;
    }
    cost += shotUnits;
    rows.push({ shot: shot.id, tiers, units: Number(shotUnits.toFixed(2)) });
  }
  return { rows, calls, units: Number(cost.toFixed(2)) };
}

async function loadState(root) {
  const path = join(root, "run.json");
  if (!(await exists(path))) return { path, state: undefined };
  return { path, state: await readJson(path) };
}

function ensureStateShape(state) {
  state.ledger ??= [];
  state.approvals ??= {};
  return state;
}

function spentUnits(state) {
  return Number((state.ledger ?? []).reduce((sum, entry) => sum + Number(entry.units ?? 0), 0).toFixed(2));
}

function callsFor(state, shot, tier) {
  return (state.ledger ?? []).filter((entry) => entry.shot === shot && (tier ? entry.tier === tier : true)).length;
}

async function contractHash(root) {
  const path = join(root, "consistency.json");
  if (!(await exists(path))) return undefined;
  return createHash("sha256").update(await readFile(path)).digest("hex").slice(0, 16);
}

async function scanVerdict(root, shot) {
  const path = join(root, "blockout", "scan", shot, "scan.json");
  if (!(await exists(path))) return { exists: false };
  const data = await readJson(path);
  return { exists: true, verdict: data.verdict, recommended: data.recommended, path };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- commands

async function cmdIntake(args, root, shotlist) {
  const { path, state } = await loadState(root);
  const answers = { ...defaults(shotlist), ...(state?.answers ?? {}) };

  if (args.questions) {
    printJson({ ok: true, questions: questions(), current: answers, confirmed: state?.confirmed?.byUser ?? false });
    return 0;
  }

  if (args.set) {
    const patch = parseSet(args.set);
    for (const [key, value] of Object.entries(patch)) {
      if (key === "deliveryResolution" || key === "draftResolution" || key === "ratio" || key === "draftPolicy") answers[key] = value;
      else if (key === "generateAudio" || key === "requireScan") answers[key] = value === "true" || value === "1";
      else if (["durationPerShot", "shotCount", "maxPaidCalls", "maxCallsPerShot"].includes(key)) answers[key] = Number(value);
      else if (key === "maxUnits" || key === "unitPriceYuan") answers[key] = value === "null" || value === "" ? null : Number(value);
      else if (key === "fps") answers.fps = Number(value);
      else throw new Error(`不认识的字段：${key}`);
    }
  }

  const errors = [];
  const warnings = [];
  validateAnswers(answers, errors, warnings);
  const est = estimate(answers, shotlist);
  if (est.calls > Number(answers.maxPaidCalls)) {
    warnings.push(`计划调用 ${est.calls} 次 > 上限 ${answers.maxPaidCalls}；正式跑之前会卡在 gate`);
  }

  const next = ensureStateShape(state ?? {
    schema: 1,
    project: shotlist?.project ?? root.split("/").pop(),
    createdAt: new Date().toISOString()
  });
  next.answers = answers;
  const confirmed = Boolean(args.confirm) && errors.length === 0;
  if (args.confirm && errors.length > 0) {
    process.stderr.write("有阻塞项，不能确认：\n" + errors.map((item) => `- ${item}`).join("\n") + "\n");
  }
  next.confirmed = {
    byUser: confirmed,
    at: confirmed ? new Date().toISOString() : (next.confirmed?.at ?? null),
    note: args.note ? String(args.note) : (next.confirmed?.note ?? ""),
    questions: questions().map((item) => item.id)
  };
  next.estimate = est;
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  if (args.set || args.confirm) {
    const report = {
      ok: errors.length === 0,
      file: path,
      confirmed: next.confirmed.byUser,
      answers,
      estimate: {
        calls: est.calls,
        units: est.units,
        moneyYuan: answers.unitPriceYuan ? Number((est.units * Number(answers.unitPriceYuan)).toFixed(2)) : null,
        perShot: est.rows
      },
      errors,
      warnings,
      ...(next.confirmed.byUser ? {} : { next: "把 answers 交给用户确认后，跑 intake --confirm --note \"用户在对话框确认\"" })
    };
    printJson(report);
    return report.ok ? 0 : 1;
  }

  printJson({
    ok: true,
    file: path,
    confirmed: next.confirmed.byUser,
    questions: questions(),
    defaults: answers,
    estimate: { calls: est.calls, units: est.units },
    note: "先 ask_user_question 把这 8 项问完，再 intake --set ... --confirm --note ..."
  });
  return 0;
}

async function cmdPlan(args, root, shotlist) {
  const { state } = await loadState(root);
  const errors = [];
  const warnings = [];
  if (!state) {
    errors.push("没有 run.json：先跑 intake 问用户");
    printJson({ ok: false, errors, warnings });
    return 1;
  }
  const answers = { ...defaults(shotlist), ...(state.answers ?? {}) };
  const est = estimate(answers, shotlist);
  const spent = spentUnits(state);
  const maxUnits = answers.maxUnits;
  const deliverySeconds = (shotlist?.shots ?? []).map((shot) => Number(shot.duration ?? answers.durationPerShot));
  const legacyUnits = Number((deliverySeconds.reduce((sum, seconds) => sum + units(answers.deliveryResolution, seconds), 0) * OBSERVED_RETRY_FACTOR).toFixed(2));

  if (!state.confirmed?.byUser) errors.push("run.json 还没确认（confirmed.byUser=false）");
  if (est.calls > Number(answers.maxPaidCalls)) errors.push(`计划调用 ${est.calls} 次 > 上限 ${answers.maxPaidCalls}`);
  if (maxUnits !== null && maxUnits !== undefined && est.units > Number(maxUnits)) errors.push(`计划成本指数 ${est.units} > 上限 ${maxUnits}`);
  if (spent > 0 && maxUnits !== null && maxUnits !== undefined) {
    warnings.push(`已花费 ${spent} 指数，剩余 ${Number((Number(maxUnits) - spent).toFixed(2))}`);
  }

  const rows = [];
  for (const shot of shotlist?.shots ?? []) {
    const tiers = plannedTiers(answers, shot);
    const scan = await scanVerdict(root, shot.id);
    const used = callsFor(state, shot.id);
    rows.push({
      shot: shot.id,
      duration: Number(shot.duration ?? answers.durationPerShot),
      tiers,
      calls: used,
      approved: Boolean(state.approvals?.[shot.id]?.draft),
      scan: scan.exists ? scan.verdict : "missing"
    });
  }

  printJson({
    ok: errors.length === 0,
    project: state.project,
    confirmed: state.confirmed?.byUser ?? false,
    answers,
    plan: rows,
    estimate: { calls: est.calls, units: est.units, spent, remaining: maxUnits === null || maxUnits === undefined ? null : Number((Number(maxUnits) - spent).toFixed(2)) },
    compare: {
      observedRetryFactor: OBSERVED_RETRY_FACTOR,
      legacyUnits,
      plannedUnits: est.units,
      saving: Number((legacyUnits - est.units).toFixed(2)),
      savingPercent: legacyUnits > 0 ? Math.round(((legacyUnits - est.units) / legacyUnits) * 100) : null
    },
    errors,
    warnings
  });
  return errors.length === 0 ? 0 : 1;
}

async function cmdGate(args, root, shotlist) {
  const { state } = await loadState(root);
  const reasons = [];
  const warnings = [];
  const shotId = args.shot;
  const tier = args.tier ?? "final";
  if (!shotId) throw new Error("gate 需要 --shot <id>");
  if (!["draft", "final"].includes(tier)) throw new Error("--tier 只能是 draft 或 final");
  const shot = (shotlist?.shots ?? []).find((item) => item.id === shotId);
  if (!shot) throw new Error(`shotlist 里没有 ${shotId}`);

  if (!state) {
    reasons.push("没有 run.json：先 intake 并让用户确认画质/时长/预算");
  } else {
    const answers = { ...defaults(shotlist), ...(state.answers ?? {}) };
    if (!state.confirmed?.byUser) reasons.push("用户还没确认制片参数（intake --confirm）");
    const resolution = tier === "draft" ? answers.draftResolution : answers.deliveryResolution;
    const seconds = Number(shot.duration ?? answers.durationPerShot);
    const nextUnits = units(resolution, seconds);

    if (callsFor(state, shotId) >= Number(answers.maxCallsPerShot)) {
      reasons.push(`${shotId} 已提交 ${callsFor(state, shotId)} 次，达到每镜上限 ${answers.maxCallsPerShot}；继续必须先改结构并重新确认预算`);
    }
    const totalCalls = (state.ledger ?? []).length;
    if (totalCalls >= Number(answers.maxPaidCalls)) {
      reasons.push(`全片已提交 ${totalCalls} 次，达到上限 ${answers.maxPaidCalls}`);
    }
    if (answers.maxUnits !== null && answers.maxUnits !== undefined) {
      const spent = spentUnits(state);
      if (spent + nextUnits > Number(answers.maxUnits)) {
        reasons.push(`成本指数将达 ${(spent + nextUnits).toFixed(2)}，超过上限 ${answers.maxUnits}`);
      }
    }
    if (tier === "final" && answers.draftPolicy !== "none" && plannedTiers(answers, shot).includes("draft")) {
      if (!state.approvals?.[shotId]?.draft) reasons.push(`${shotId} 还没有通过 draft：先出样片并 approve draft`);
    }
    // 契约 + 提示词新鲜度
    const contractPath = join(root, "consistency.json");
    if (!(await exists(contractPath))) {
      reasons.push("没有 consistency.json：一致性契约是所有镜头的前提");
    } else {
      const contract = await readJson(contractPath);
      if (!(contract.shots?.[shotId]?.must_show ?? []).length) reasons.push(`${shotId} 的 must_show 为空`);
      const payloadPath = join(root, "prompts", `${shotId}.payload.json`);
      if (!(await exists(payloadPath))) {
        reasons.push(`没有 prompts/${shotId}.payload.json：先跑 prep-shot`);
      } else {
        const payload = await readJson(payloadPath);
        const current = await contractHash(root);
        if (payload.contractHash && current && payload.contractHash !== current) {
          reasons.push(`prompts/${shotId}.payload.json 是旧契约生成的（契约已改）：重跑 prep-shot`);
        }
        if (payload.tier && payload.tier !== tier) {
          warnings.push(`payload 的 tier=${payload.tier} 与本次 ${tier} 不同：用 prep-shot --tier ${tier} 重新生成`);
        }
      }
    }
    // 机位扫描
    if (answers.requireScan) {
      const scan = await scanVerdict(root, shotId);
      if (!scan.exists) reasons.push(`没有 ${shotId} 的机位扫描：先跑 shot-scan --test（免费）`);
      else if (scan.verdict !== "pass") reasons.push(`${shotId} 的机位扫描结论是 ${scan.verdict}：回白模调主体/机位`);
    }

    const payload = { shot: shotId, tier, resolution, duration: seconds, units: nextUnits };
    const decision = {
      ok: reasons.length === 0,
      allowed: reasons.length === 0,
      ...payload,
      spent: spentUnits(state),
      calls: { total: totalCalls, shot: callsFor(state, shotId), limits: { total: answers.maxPaidCalls, perShot: answers.maxCallsPerShot } },
      reasons,
      warnings
    };
    printJson(decision);
    return decision.allowed ? 0 : 1;
  }

  printJson({ ok: false, allowed: false, shot: shotId, tier, reasons, warnings });
  return 1;
}

async function cmdRecord(args, root, shotlist) {
  const { path, state } = await loadState(root);
  if (!state) throw new Error("没有 run.json：先 intake");
  ensureStateShape(state);
  const shotId = args.shot;
  const tier = args.tier ?? "final";
  if (!shotId || !args.taskId) throw new Error("record 需要 --shot 和 --taskId");
  const answers = { ...defaults(shotlist), ...(state.answers ?? {}) };
  const resolution = String(args.resolution ?? (tier === "draft" ? answers.draftResolution : answers.deliveryResolution));
  const seconds = Number(args.duration ?? (shotlist?.shots ?? []).find((item) => item.id === shotId)?.duration ?? answers.durationPerShot);
  const entry = {
    at: new Date().toISOString(),
    shot: shotId,
    tier,
    taskId: String(args.taskId),
    resolution,
    duration: seconds,
    units: units(resolution, seconds)
  };
  state.ledger.push(entry);
  state.totals = { calls: state.ledger.length, units: spentUnits(state) };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  printJson({ ok: true, entry, totals: state.totals, remainingCalls: Number(answers.maxPaidCalls) - state.ledger.length });
  return 0;
}

async function cmdApprove(args, root) {
  const { path, state } = await loadState(root);
  if (!state) throw new Error("没有 run.json：先 intake");
  ensureStateShape(state);
  const shotId = args.shot;
  const tier = args.tier ?? "draft";
  if (!shotId) throw new Error("approve 需要 --shot");
  const recorded = (state.ledger ?? []).some((entry) => entry.shot === shotId && entry.tier === tier);
  if (!recorded) throw new Error(`${shotId} 还没有 ${tier} 的提交记录：先生成并 record`);
  state.approvals[shotId] ??= {};
  state.approvals[shotId][tier] = { at: new Date().toISOString(), note: String(args.note ?? "") };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  printJson({ ok: true, shot: shotId, tier, approvals: state.approvals[shotId] });
  return 0;
}

async function cmdStatus(args, root, shotlist) {
  const { state } = await loadState(root);
  if (!state) {
    printJson({ ok: false, errors: ["没有 run.json"] });
    return 1;
  }
  const answers = { ...defaults(shotlist), ...(state.answers ?? {}) };
  const rows = [];
  for (const shot of shotlist?.shots ?? []) {
    const scan = await scanVerdict(root, shot.id);
    rows.push({
      shot: shot.id,
      calls: callsFor(state, shot.id),
      draftApproved: Boolean(state.approvals?.[shot.id]?.draft),
      scan: scan.exists ? scan.verdict : "missing"
    });
  }
  printJson({
    ok: true,
    confirmed: state.confirmed?.byUser ?? false,
    answers,
    ledger: state.ledger ?? [],
    totals: { calls: (state.ledger ?? []).length, units: spentUnits(state) },
    shots: rows
  });
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command) throw new Error("用法：node produce.mjs <intake|plan|gate|record|approve|status> --project <dir> [...]");
  if (!args.project) throw new Error("缺少 --project <项目目录>");
  const root = resolve(args.project);
  const shotlistPath = join(root, "shotlist.json");
  const shotlist = (await exists(shotlistPath)) ? await readJson(shotlistPath) : undefined;
  if (!shotlist) throw new Error(`读不到 ${shotlistPath}`);
  await mkdir(root, { recursive: true });

  switch (command) {
    case "intake": return cmdIntake(args, root, shotlist);
    case "plan": return cmdPlan(args, root, shotlist);
    case "gate": return cmdGate(args, root, shotlist);
    case "record": return cmdRecord(args, root, shotlist);
    case "approve": return cmdApprove(args, root);
    case "status": return cmdStatus(args, root, shotlist);
    default: throw new Error(`不认识的命令：${command}`);
  }
}

main().then((code) => process.exit(code ?? 0)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exit(1);
});
