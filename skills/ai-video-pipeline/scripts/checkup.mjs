#!/usr/bin/env node
// 项目体检：一条命令跑完全部检查，输出一张表 + 结论。
//
//   node checkup.mjs --project projects/my-film
//   node checkup.mjs --all                 # 体检 projects/ 下所有项目
//   node checkup.mjs --project … --json    # 只出 JSON
//
// 检查项：文件完整性 → 契约 → 预算/账本 → 机位扫描 → 提示词新鲜度 → 技术/一致性 QA → 超写实 QA → 交付物
// 退出码：0 全绿或有警告；1 有硬失败。

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) { args._.push(item); continue; }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) { args[key] = next; index += 1; }
    else args[key] = true;
  }
  return args;
}

async function exists(path) {
  return Boolean(await stat(path).then((info) => info.isFile(), () => false));
}

async function isDir(path) {
  return Boolean(await stat(path).then((info) => info.isDirectory(), () => false));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function run(script, args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [join(HERE, script), ...args], { timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, json: parseJson(stdout) };
  } catch (error) {
    return { code: error.code ?? 1, json: parseJson(error.stdout ?? "") ?? parseJson(error.stderr ?? "") };
  }
}

function parseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch {
    const line = trimmed.split("\n").find((item) => item.trim().startsWith("{"));
    try { return line ? JSON.parse(line) : undefined; } catch { return undefined; }
  }
}

function row(id, ok, detail, level = "check") {
  return { id, ok, detail, level };
}

async function checkup(root) {
  const rows = [];
  const warnings = [];
  const project = root.split("/").pop();

  // 1. 文件
  const hasContract = await exists(join(root, "consistency.json"));
  const hasShotlist = await exists(join(root, "shotlist.json"));
  const hasRun = await exists(join(root, "run.json"));
  rows.push(row("files", hasContract && hasShotlist, `contract=${hasContract} shotlist=${hasShotlist} run=${hasRun}`, "warn"));
  if (!hasShotlist) return { project, rows, verdict: "FAIL" };

  const shotlist = await readJson(join(root, "shotlist.json"));
  const shots = shotlist.shots ?? [];

  // 2. 契约
  if (hasContract) {
    const check = await run("contract-init.mjs", ["--project", root, "--check"]);
    rows.push(row("contract", check.json?.ok === true, (check.json?.errors ?? []).join("；") || `${(check.json?.warnings ?? []).length} warnings`));
    warnings.push(...(check.json?.warnings ?? []));
  }

  // 3. 预算 / 账本
  let runState;
  if (hasRun) {
    runState = await readJson(join(root, "run.json"));
    const confirmed = runState.confirmed?.byUser === true;
    const totals = runState.totals ?? { calls: (runState.ledger ?? []).length, units: 0 };
    rows.push(row("intake", confirmed, confirmed ? `已确认；已花 ${totals.calls} 次 / ${totals.units} 指数` : "run.json 未确认", confirmed ? "check" : "warn"));
  } else {
    rows.push(row("intake", false, "没有 run.json：没问用户就开跑", "warn"));
  }

  // 4. 机位扫描
  const scanRows = [];
  for (const shot of shots) {
    const scanPath = join(root, "blockout", "scan", shot.id, "scan.json");
    if (!(await exists(scanPath))) { scanRows.push(`${shot.id}:missing`); continue; }
    const scan = await readJson(scanPath);
    scanRows.push(`${shot.id}:${scan.verdict ?? "?"}`);
  }
  rows.push(row("scan", scanRows.every((item) => item.endsWith(":pass")), scanRows.join(" ") || "无镜头", "warn"));

  // 5. 提示词新鲜度
  const contractHash = hasContract
    ? createHash("sha256").update(await readFile(join(root, "consistency.json"))).digest("hex").slice(0, 16)
    : undefined;
  const promptRows = [];
  for (const shot of shots) {
    const payloadPath = join(root, "prompts", `${shot.id}.payload.json`);
    if (!(await exists(payloadPath))) { promptRows.push(`${shot.id}:missing`); continue; }
    const payload = await readJson(payloadPath);
    const fresh = !payload.contractHash || !contractHash || payload.contractHash === contractHash;
    promptRows.push(`${shot.id}:${fresh ? "fresh" : "stale"}`);
  }
  rows.push(row("prompts", promptRows.every((item) => item.endsWith(":fresh")), promptRows.join(" ") || "无镜头"));

  // 6. 一致性 / 技术 QA
  const consistency = await run("qa-consistency.mjs", ["--project", root]);
  const failures = consistency.json?.hardFailures ?? [];
  rows.push(row("qa-consistency", consistency.code === 0, failures.slice(0, 3).join("；") || `${consistency.json?.warnings?.length ?? 0} warnings`));
  if (Array.isArray(consistency.json?.warnings)) warnings.push(...consistency.json.warnings);

  // 7. 超写实 QA
  if (await exists(join(root, "realism-report.json"))) {
    const realism = await readJson(join(root, "realism-report.json"));
    rows.push(row("qa-realism", realism.ok === true, (realism.failures ?? []).slice(0, 3).join("；") || `${(realism.crops ?? []).length} crops`, "warn"));
  } else if (hasContract) {
    const contract = await readJson(join(root, "consistency.json"));
    if ((contract.realism?.crops ?? []).length > 0) {
      const realism = await run("qa-realism.mjs", ["--project", root]);
      rows.push(row("qa-realism", realism.code === 0, (realism.json?.failures ?? []).slice(0, 3).join("；") || "ok", "warn"));
    } else {
      rows.push(row("qa-realism", false, "契约没写 realism.crops：超写实没验收", "warn"));
    }
  }

  // 8. 交付物
  const missing = [];
  for (const shot of shots) {
    const taskId = shot.result?.taskId;
    if (!taskId) continue;
    const candidates = [
      join(root, "output/seedance", `${taskId}.mp4`),
      join(root, "../../output/seedance", `${taskId}.mp4`)
    ];
    let found = false;
    for (const candidate of candidates) if (await exists(candidate)) { found = true; break; }
    if (!found) missing.push(shot.id);
  }
  rows.push(row("deliverables", missing.length === 0, missing.length ? `缺少成片：${missing.join(",")}` : "全部存在"));

  const failed = rows.filter((item) => !item.ok && item.level !== "warn");
  const warned = rows.filter((item) => !item.ok && item.level === "warn");
  return { project, rows, warnings, verdict: failed.length > 0 ? "FAIL" : warned.length > 0 ? "WARN" : "PASS" };
}

function render(results) {
  const lines = [];
  for (const result of results) {
    lines.push(`\n## ${result.project} — ${result.verdict}`);
    for (const item of result.rows) {
      const mark = item.ok ? "✓" : item.level === "warn" ? "!" : "✗";
      lines.push(`  ${mark} ${item.id.padEnd(16)} ${item.detail}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = [];
  if (args.all) {
    const base = resolve(args.dir ?? "projects");
    for (const name of await readdir(base)) {
      if (await isDir(join(base, name))) targets.push(join(base, name));
    }
  } else if (args.project) {
    targets.push(resolve(args.project));
  } else {
    throw new Error("用法：node checkup.mjs --project <dir> | --all [--dir projects] [--json]");
  }

  const results = [];
  for (const target of targets) results.push(await checkup(target));
  const failed = results.filter((item) => item.verdict === "FAIL").length;

  if (args.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else {
    process.stdout.write(`${render(results)}\n`);
    process.stdout.write(`\n汇总：${results.length} 个项目，FAIL ${failed}，WARN ${results.filter((item) => item.verdict === "WARN").length}，PASS ${results.filter((item) => item.verdict === "PASS").length}\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error), stack: String(error?.stack ?? "").split("\n").slice(0, 6) }, null, 2)}\n`);
  process.exit(1);
});
