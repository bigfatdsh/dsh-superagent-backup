// Task records and artifact handling. Everything is scoped to the current
// project root so a re-open or a later turn can recover the same task.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findProjectRoot } from "./core.js";

const runFile = promisify(execFile);

export function sanitizeId(value) {
  const text = String(value ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return text === "" ? "unknown" : text.slice(0, 180);
}

export function resolveWithinProject(projectRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") throw new Error("seedance: 路径不能为空");
  if (isAbsolute(relativePath)) return relativePath;
  return resolve(projectRoot, relativePath);
}

export async function projectContext(cwd) {
  const projectRoot = await findProjectRoot(cwd);
  return { projectRoot, cwd: resolve(cwd) };
}

export function tasksDir(projectRoot, taskDir) {
  return resolveWithinProject(projectRoot, taskDir || ".seedance/tasks");
}

export function taskPath(projectRoot, taskDir, taskId) {
  return join(tasksDir(projectRoot, taskDir), `${sanitizeId(taskId)}.json`);
}

export async function readTaskRecord(projectRoot, taskDir, taskId) {
  try {
    return JSON.parse(await readFile(taskPath(projectRoot, taskDir, taskId), "utf8"));
  } catch {
    return undefined;
  }
}

export async function writeTaskRecord(record, { projectRoot, taskDir, logger } = {}) {
  if (!record?.taskId) throw new Error("seedance: 任务记录缺少 taskId");
  const dir = tasksDir(projectRoot, taskDir);
  await mkdir(dir, { recursive: true });
  const path = taskPath(projectRoot, taskDir, record.taskId);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const merged = { ...record, updatedAt: new Date().toISOString() };
  await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  logger?.debug?.(`seedance: task record written ${path}`);
  return merged;
}

export async function mergeTaskRecord(taskId, patch, { projectRoot, taskDir, logger } = {}) {
  const previous = await readTaskRecord(projectRoot, taskDir, taskId);
  return writeTaskRecord({ ...(previous ?? {}), ...patch, taskId }, { projectRoot, taskDir, logger });
}

export async function listTaskRecords(projectRoot, taskDir) {
  const dir = tasksDir(projectRoot, taskDir);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(dir, file), "utf8"));
      if (record?.taskId) records.push(record);
    } catch {
      /* skip corrupt records */
    }
  }
  return records.sort((left, right) => String(right.submittedAt ?? "").localeCompare(String(left.submittedAt ?? "")));
}

export function videoExtension(url) {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase();
    return [".mp4", ".mov", ".webm", ".mkv"].includes(ext) ? ext : ".mp4";
  } catch {
    return ".mp4";
  }
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  return timeout;
}

export async function downloadFile(url, destPath, { signal, fetchFn = globalThis.fetch, maxBytes = 512 * 1024 * 1024 } = {}) {
  const response = await fetchFn(url, { signal: combineSignals(signal, 10 * 60 * 1000) });
  if (!response.ok) throw new Error(`seedance: 下载失败 HTTP ${response.status} @ ${url}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maxBytes) throw new Error(`seedance: 下载文件超过 ${maxBytes} 字节：${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`seedance: 下载文件超过 ${maxBytes} 字节：${url}`);
  await mkdir(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, bytes);
  await rename(tmp, destPath);
  return { path: destPath, bytes: bytes.length };
}

export async function md5File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

export async function fileSize(path) {
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() ? info.size : undefined;
}

export async function probeVideo(path, { ffprobePath = "" } = {}) {
  const candidates = [ffprobePath, "ffprobe", "/usr/local/bin/ffprobe", "/opt/homebrew/bin/ffprobe"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const { stdout } = await runFile(candidate, [
        "-v", "error",
        "-show_entries", "format=duration,size:stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames",
        "-of", "json",
        path
      ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      const parsed = JSON.parse(stdout);
      const video = (parsed.streams ?? []).find((stream) => stream.codec_type === "video") ?? {};
      const audio = (parsed.streams ?? []).find((stream) => stream.codec_type === "audio");
      return {
        ok: true,
        path,
        bytes: Number(parsed.format?.size ?? 0) || undefined,
        durationSeconds: Number(parsed.format?.duration ?? 0) || undefined,
        codec: video.codec_name,
        width: video.width,
        height: video.height,
        fps: video.r_frame_rate,
        frames: video.nb_frames ? Number(video.nb_frames) : undefined,
        hasAudio: Boolean(audio),
        audioCodec: audio?.codec_name
      };
    } catch (error) {
      if (candidate === candidates[candidates.length - 1]) {
        return { ok: false, path, error: String(error?.message ?? error) };
      }
    }
  }
  return { ok: false, path, error: "ffprobe not found" };
}

export function safeName(value, fallback = "artifact") {
  const name = basename(String(value ?? "")).replace(/[^a-zA-Z0-9._-]/g, "_");
  return name === "" ? fallback : name;
}
