#!/usr/bin/env node
// Environment doctor for the AI video studio.
// Usage: node doctor.mjs [--json]

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, "../../../..");
const BIN = join(STUDIO, "tools/bin");

async function checkBinary(label, path, args = ["--version"]) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return { id: label, ok: false, path, detail: "not found" };
  try {
    const real = realpathSync(path);
    const { stdout, stderr } = await execFileAsync(real, args, { timeout: 15000, maxBuffer: 1024 * 1024 });
    return { id: label, ok: true, path: real, version: String(stdout || stderr).split(/\r?\n/)[0] };
  } catch (error) {
    return { id: label, ok: false, path, detail: String(error?.message ?? error).slice(0, 400) };
  }
}

async function checkBackend() {
  try {
    const response = await fetch("http://127.0.0.1:9877/doctor", { signal: AbortSignal.timeout(3000) });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    const kind = json?.kind ?? json?.addon?.kind ?? (response.ok ? "ok" : "unknown");
    return { id: "blender-backend", ok: kind === "ok", detail: `HTTP ${response.status} kind=${kind}`, json };
  } catch (error) {
    return {
      id: "blender-backend",
      ok: false,
      detail: `127.0.0.1:9877 不可达（${String(error?.message ?? error)}）。无头渲染不依赖它；GUI 实时连接需要 blender_viewport(op="launch")。`
    };
  }
}

async function checkKey() {
  if (typeof process.env.ARK_API_KEY === "string" && process.env.ARK_API_KEY.trim() !== "") {
    return { id: "ark-key", ok: true, source: "env:ARK_API_KEY" };
  }
  const file = join(homedir(), ".dsh/secrets/ark-api-key");
  try {
    const raw = await readFile(file, "utf8");
    const line = raw.split(/\r?\n/).map((value) => value.trim()).find((value) => value && !value.startsWith("#"));
    const key = line?.includes("=") ? line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") : line;
    if (key && key.length >= 10) return { id: "ark-key", ok: true, source: `file:${file}` };
    return { id: "ark-key", ok: false, detail: `文件存在但没有有效 Key：${file}` };
  } catch {
    return { id: "ark-key", ok: false, detail: `未设置 ARK_API_KEY，且没有 ${file}` };
  }
}

async function main() {
  const checks = [];
  const blender = await checkBinary("blender", join(STUDIO, "tools/bin/blender"), ["--version"]);
  checks.push(blender);
  checks.push(await checkBinary("ffmpeg", join(BIN, "ffmpeg"), ["-version"]));
  checks.push(await checkBinary("ffprobe", join(BIN, "ffprobe"), ["-version"]));
  const cloudflared = await checkBinary("cloudflared", join(BIN, "cloudflared"), ["--version"]);
  checks.push({ ...cloudflared, optional: true });
  checks.push(await checkBackend());
  checks.push(await checkKey());
  const studioInfo = await stat(join(STUDIO, ".dsh/skills/ai-video-pipeline/SKILL.md")).catch(() => undefined);
  checks.push({ id: "studio-skill", ok: Boolean(studioInfo?.isFile()), detail: join(STUDIO, ".dsh/skills/ai-video-pipeline/SKILL.md") });
  checks.push({ id: "studio-root", ok: true, detail: STUDIO });
  const required = checks.filter((check) => !check.optional).filter((check) => ["blender", "ffmpeg", "ffprobe", "studio-skill"].includes(check.id));
  const report = {
    ok: required.every((check) => check.ok),
    studioRoot: STUDIO,
    checks,
    notes: [
      "无头渲染只依赖 blender/ffmpeg/ffprobe；Blender addon 后端只影响 GUI 实时连接。",
      "Seedance API 还需要 ARK_API_KEY 或 ~/.dsh/secrets/ark-api-key。",
      "本地参考视频还需要 stagePublicBaseUrl / cloudflaredPath / 第三方托管之一；Ark 不接受 base64 视频。"
    ]
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
