// Service layer shared by the DSH tools and the test suite.
// It owns media preparation, Ark calls, task records, polling, downloads, and
// the public staging helper.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, isAbsolute, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  buildPayload,
  createPlaceholderMedia,
  isAssetUri,
  isHttpUrl,
  prepareMedia,
  redactPayload,
  resolveApiKey,
  taskRecordView
} from "./core.js";
import { createSeedanceClient, ArkApiError } from "./client.js";
import {
  downloadFile,
  fileSize,
  listTaskRecords,
  md5File,
  mergeTaskRecord,
  probeVideo,
  projectContext,
  readTaskRecord,
  resolveWithinProject,
  sanitizeId,
  videoExtension,
  writeTaskRecord
} from "./store.js";
import { createStageService } from "./stage.js";

const execFileAsync = promisify(execFile);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);

function sleep(ms, signal) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      done();
    }, { once: true });
  });
}

function taskError(task) {
  const error = task?.error;
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return `${error.code ? `${error.code}: ` : ""}${error.message}`;
  return JSON.stringify(error);
}

function projectTask(task) {
  return {
    taskId: task?.id ?? task?.task_id,
    status: task?.status,
    videoUrl: task?.content?.video_url ?? task?.content?.videoUrl ?? task?.video_url,
    coverUrl: task?.content?.cover_url ?? task?.content?.coverUrl ?? task?.cover_url,
    lastFrameUrl: task?.content?.last_frame_url ?? task?.last_frame_url,
    duration: task?.duration,
    ratio: task?.ratio,
    resolution: task?.resolution,
    generateAudio: task?.generate_audio,
    outputFormat: task?.output_format,
    error: taskError(task)
  };
}

function redactUrl(url) {
  if (typeof url !== "string") return url;
  if (!url.startsWith("data:")) return url;
  const comma = url.indexOf(",");
  const mime = url.slice(5, Math.max(5, comma)).split(";")[0] || "application/octet-stream";
  return `data:${mime};base64,<${Buffer.byteLength(url.slice(comma + 1), "base64")} bytes>`;
}

function mediaSummary(payload) {
  return (payload.content ?? []).map((item) => {
    if (item.type === "text") return { type: "text", chars: item.text?.length ?? 0 };
    const url = item.image_url?.url ?? item.video_url?.url ?? item.audio_url?.url;
    return { type: item.type, role: item.role, url: redactUrl(url) };
  });
}

async function pollTask(client, taskId, { intervalMs, deadlineMs, signal }) {
  let task;
  for (;;) {
    if (signal?.aborted) return { task, aborted: true, timedOut: false };
    task = await client.getTask(taskId, signal);
    if (TERMINAL.has(task?.status)) return { task, aborted: false, timedOut: false };
    if (Date.now() >= deadlineMs) return { task, aborted: false, timedOut: true };
    await sleep(Math.min(intervalMs, Math.max(1, deadlineMs - Date.now())), signal);
  }
}

async function checkBinary(path, args = ["-version"]) {
  try {
    const { stdout, stderr } = await execFileAsync(path, args, { timeout: 15000, maxBuffer: 1024 * 1024 });
    return { ok: true, path, version: String(stdout || stderr).split(/\r?\n/)[0] };
  } catch (error) {
    return { ok: false, path, error: String(error?.message ?? error).slice(0, 300) };
  }
}

/**
 * Create the service used by the plugin. The optional fetchFn lets tests point
 * the client at a local mock Ark server without changing process-wide fetch.
 */
export function createSeedanceService({ config, logger = console, fetchFn, stageFactory } = {}) {
  if (!config || typeof config !== "object") throw new Error("seedance: missing config");
  let stageService;

  function stage() {
    if (!stageService) stageService = stageFactory ? stageFactory(config, logger) : createStageService(config, logger);
    return stageService;
  }

  async function clientOrThrow() {
    const resolved = await resolveApiKey(config);
    if (resolved.key === "") {
      const error = new Error(
        `seedance: 找不到 API Key。设置环境变量 ${config.apiKeyEnv || "ARK_API_KEY"}，` +
          `或把 Key 写入 ${resolved.file ?? config.apiKeyFile}（一行，chmod 600），然后重新调用；不需要重启 DSH。` +
          `Key 来源状态：${resolved.source}`
      );
      error.code = "SEEDANCE_NO_KEY";
      error.keySource = resolved;
      throw error;
    }
    return { ...createSeedanceClient({ baseUrl: config.baseUrl, apiKey: resolved.key, fetchFn }), keySource: resolved.source, keyFile: resolved.file };
  }

  async function previewRequest({ args = {}, cwd = process.cwd() } = {}) {
    const context = await projectContext(cwd);
    const staged = [];
    const stageVideo = async (path) => {
      staged.push(path);
      return { url: `https://staged.invalid/${staged.length}/${encodeURIComponent(basename(path))}` };
    };
    const media = await prepareMedia(args, {
      cwd: context.projectRoot,
      config,
      stageVideo
    });
    const { payload, report } = buildPayload({ args, media, config });
    const warnings = [...report.warnings];
    if (staged.length > 0) warnings.push(`预览未真正上传：${staged.length} 个本地视频在提交时会通过 staging 变成公网 URL。`);
    return {
      ok: true,
      dryRun: true,
      payload: redactPayload(payload),
      report: { ...report, warnings: [...new Set(warnings)], stagedVideos: staged },
      requestBytes: report.requestBytes
    };
  }

  async function generateVideo({ args = {}, cwd = process.cwd(), signal, sessionId } = {}) {
    if (args.dry_run === true) return previewRequest({ args, cwd });
    const context = await projectContext(cwd);
    // 1) Validate all parameters and media counts with placeholders first.
    //    This never reads, uploads, or stages a local file.
    buildPayload({ args, media: createPlaceholderMedia(args), config });
    // 2) Resolve the key before any public staging side effect.
    const client = await clientOrThrow();
    // 3) Only now resolve real media (images/audio -> base64, local video -> staging).
    const media = await prepareMedia(args, {
      cwd: context.projectRoot,
      config,
      stageVideo: async (path, options) => stage().stage(path, options)
    });
    const { payload, report } = buildPayload({ args, media, config });
    let submitted;
    try {
      submitted = await client.submitTask(payload, signal);
    } catch (error) {
      if (error && typeof error === "object") {
        error.details = {
          payloadPreview: redactPayload(payload),
          report,
          requestBytes: report.requestBytes
        };
      }
      throw error;
    }
    const taskId = submitted?.id ?? submitted?.task_id;
    if (typeof taskId !== "string" || taskId === "") {
      throw new Error(`seedance: 提交响应缺少任务 id：${JSON.stringify(submitted).slice(0, 500)}`);
    }
    const record = {
      taskId,
      sessionId: sessionId ?? "unknown",
      status: "queued",
      lastStatus: submitted?.status ?? "queued",
      mode: report.mode,
      family: report.family,
      model: report.model,
      prompt: report.prompt,
      finalPrompt: report.finalPrompt,
      negativePrompt: report.negativePrompt,
      motionStrength: report.motionStrength,
      motionMappedTo: report.motionMappedTo,
      ratio: report.ratio,
      duration: report.duration,
      resolution: report.resolution,
      generateAudio: report.generateAudio,
      watermark: report.watermark,
      outputFormat: report.outputFormat,
      omniReferenceTaskType: report.omniReferenceTaskType,
      requestBytes: report.requestBytes,
      contentCounts: report.contentCounts,
      media: mediaSummary(payload),
      submittedAt: new Date().toISOString(),
      workspace: context.projectRoot,
      cwd: context.cwd,
      keySource: client.keySource,
      warnings: report.warnings
    };
    await writeTaskRecord(record, { projectRoot: context.projectRoot, taskDir: config.taskDir, logger });
    return {
      taskId,
      status: record.lastStatus,
      ...report,
      nextStep: `任务异步执行中。用 seedance_video_status 查询 ${taskId}（wait=true 会等待并自动下载到 ${config.outputDir ?? "output/seedance"}/）。`
    };
  }

  async function refreshOne(client, record, context, signal) {
    const task = await client.getTask(record.taskId, signal);
    const projected = projectTask({ ...task, id: task?.id ?? record.taskId });
    const merged = await mergeTaskRecord(record.taskId, {
      lastStatus: projected.status,
      videoUrl: projected.videoUrl,
      coverUrl: projected.coverUrl,
      lastFrameUrl: projected.lastFrameUrl,
      duration: projected.duration,
      ratio: projected.ratio,
      resolution: projected.resolution,
      error: projected.error
    }, { projectRoot: context.projectRoot, taskDir: config.taskDir, logger });
    return { record: merged, task: projected };
  }

  async function videoStatus({ taskId, wait = true, maxWaitSeconds, cwd = process.cwd(), signal } = {}) {
    const context = await projectContext(cwd);
    let client;
    try {
      client = await clientOrThrow();
    } catch (error) {
      if (error.code !== "SEEDANCE_NO_KEY") throw error;
      if (taskId === undefined || String(taskId).trim() === "") {
        const records = await listTaskRecords(context.projectRoot, config.taskDir);
        return {
          status: "local-only",
          note: "没有 API Key，只列出本地任务记录，未刷新远端状态。",
          tasks: records.slice(0, 10).map(taskRecordView)
        };
      }
      throw error;
    }

    if (taskId === undefined || String(taskId).trim() === "") {
      const records = (await listTaskRecords(context.projectRoot, config.taskDir)).slice(0, 10);
      if (records.length === 0) return { status: "idle", note: "当前工作区还没有 Seedance 任务记录；先调用 seedance_generate_video。" };
      const tasks = [];
      for (const record of records) {
        try {
          const refreshed = await refreshOne(client, record, context, signal);
          tasks.push({
            taskId: refreshed.record.taskId,
            status: refreshed.task.status,
            prompt: refreshed.record.prompt,
            videoUrl: refreshed.task.videoUrl,
            localPath: refreshed.record.localPath,
            error: refreshed.task.error
          });
        } catch (error) {
          tasks.push({ taskId: record.taskId, status: "unknown", prompt: record.prompt, error: String(error?.message ?? error) });
        }
      }
      return { status: "listed", tasks };
    }

    const id = String(taskId).trim();
    let task;
    try {
      task = await client.getTask(id, signal);
    } catch (error) {
      if (signal?.aborted) return { status: "unknown", taskId: id, note: "查询被调用方中止" };
      throw error;
    }
    const waitEnabled = wait !== false;
    const maxWait = Number.isFinite(maxWaitSeconds) && maxWaitSeconds > 0
      ? Math.min(maxWaitSeconds, (config.statusTimeoutMs ?? 900000) / 1000)
      : (config.statusTimeoutMs ?? 900000) / 1000;
    if (waitEnabled && !TERMINAL.has(task?.status)) {
      const outcome = await pollTask(client, id, {
        intervalMs: config.pollIntervalMs ?? 5000,
        deadlineMs: Date.now() + maxWait * 1000,
        signal
      });
      if (outcome.task) task = outcome.task;
      if (outcome.aborted) {
        await mergeTaskRecord(id, { lastStatus: task?.status ?? "unknown", workspace: context.projectRoot }, { projectRoot: context.projectRoot, taskDir: config.taskDir, logger });
        return { status: task?.status ?? "unknown", taskId: id, note: "轮询被中止；任务仍在服务端执行，稍后再查询。" };
      }
      if (outcome.timedOut) {
        await mergeTaskRecord(id, { lastStatus: task?.status ?? "unknown", workspace: context.projectRoot }, { projectRoot: context.projectRoot, taskDir: config.taskDir, logger });
        return { status: task?.status ?? "unknown", taskId: id, note: `等待 ${maxWait}s 仍未完成；任务仍在服务端执行，稍后再查询。` };
      }
    }

    const projected = projectTask({ ...task, id: task?.id ?? id });
    let localPath;
    let video;
    let downloadError;
    if (projected.status === "succeeded" && projected.videoUrl && config.autoDownload !== false) {
      const outputDir = resolveWithinProject(context.projectRoot, config.outputDir ?? "output/seedance");
      const dest = resolve(outputDir, `${sanitizeId(id)}${videoExtension(projected.videoUrl)}`);
      try {
        await downloadFile(projected.videoUrl, dest, { signal, fetchFn });
        localPath = dest;
        video = await probeVideo(dest, { ffprobePath: config.ffprobePath });
        if (video?.ok) {
          video.md5 = await md5File(dest);
          video.bytes = video.bytes ?? await fileSize(dest);
        }
      } catch (error) {
        downloadError = String(error?.message ?? error);
      }
    }
    const merged = await mergeTaskRecord(id, {
      lastStatus: projected.status,
      videoUrl: projected.videoUrl,
      coverUrl: projected.coverUrl,
      lastFrameUrl: projected.lastFrameUrl,
      duration: projected.duration,
      ratio: projected.ratio,
      resolution: projected.resolution,
      error: projected.error,
      ...(localPath ? { localPath, downloadedAt: new Date().toISOString(), video } : {}),
      ...(downloadError ? { downloadError } : {})
    }, { projectRoot: context.projectRoot, taskDir: config.taskDir, logger });
    return {
      status: projected.status,
      taskId: id,
      videoUrl: projected.videoUrl,
      coverUrl: projected.coverUrl,
      lastFrameUrl: projected.lastFrameUrl,
      localPath,
      video,
      error: projected.error,
      ...(downloadError ? { downloadError } : {}),
      ...(localPath ? { note: `已下载到 ${localPath}` } : {})
    };
  }

  async function cancelVideo({ taskId, cwd = process.cwd(), signal } = {}) {
    if (typeof taskId !== "string" || taskId.trim() === "") throw new Error("seedance: taskId 不能为空");
    const id = taskId.trim();
    const context = await projectContext(cwd);
    const client = await clientOrThrow();
    try {
      await client.cancelTask(id, signal);
    } catch (error) {
      if (error?.status === 404) return { status: "unknown", taskId: id, note: "服务端已没有该任务（可能已结束、被清理或已被删除）。" };
      throw error;
    }
    await mergeTaskRecord(id, { lastStatus: "cancelled", workspace: context.projectRoot, cancelledAt: new Date().toISOString() }, { projectRoot: context.projectRoot, taskDir: config.taskDir, logger });
    return {
      status: "cancelled",
      taskId: id,
      note: "已发送取消请求。Ark 只保证取消 queued 状态的任务；若任务已 running，DELETE 可能删除记录而不是停止执行。"
    };
  }

  async function stageReference({ path, kind = "video", ttlMinutes, cwd = process.cwd() } = {}) {
    if (typeof path !== "string" || path.trim() === "") throw new Error("seedance: path 不能为空");
    const value = path.trim();
    if (isHttpUrl(value) || isAssetUri(value)) return { url: value, via: "passthrough", kind };
    const context = await projectContext(cwd);
    const absolute = isAbsolute(value) ? value : resolve(context.projectRoot, value);
    const info = await fileSize(absolute);
    if (info === undefined) throw new Error(`seedance: 找不到文件：${absolute}`);
    const staged = await stage().stage(absolute, { kind, ttlMinutes });
    return { ...staged, path: absolute, kind };
  }

  async function doctor({ cwd = process.cwd(), signal } = {}) {
    const context = await projectContext(cwd);
    const checks = [];
    const actions = [];
    const key = await resolveApiKey(config);
    checks.push({
      id: "api-key",
      ok: key.key !== "",
      detail: key.key !== "" ? `来源 ${key.source}` : `未找到；环境变量 ${config.apiKeyEnv || "ARK_API_KEY"} 或文件 ${key.file ?? config.apiKeyFile}`,
      fix: key.key !== "" ? undefined : `运行 ${config.apiKeyFile ?? "~/.dsh/secrets/ark-api-key"} 写入 Key，或 export ${config.apiKeyEnv || "ARK_API_KEY"}=...`
    });
    if (key.key === "") {
      actions.push("设置 API Key 后再跑 seedance_doctor；预览 seedance_preview_request 不需要 Key。");
    } else {
      const client = createSeedanceClient({ baseUrl: config.baseUrl, apiKey: key.key, fetchFn });
      try {
        const models = await client.listModels(signal);
        const list = Array.isArray(models?.data) ? models.data : Array.isArray(models?.items) ? models.items : [];
        const found = list.some((model) => model?.id === config.model || model?.name === config.model);
        checks.push({
          id: "ark-endpoint",
          ok: true,
          detail: `GET /models 成功；返回 ${list.length} 个模型${found ? `，包含 ${config.model}` : `，未包含 ${config.model}（可能不是模型列表项，或需要开通）`}`
        });
        if (!found) actions.push(`确认方舟控制台已开通模型 ${config.model}，或把 model 改为实际 Model ID / Endpoint ID。`);
      } catch (error) {
        if (error?.status === 404) {
          checks.push({
            id: "ark-endpoint",
            ok: true,
            detail: "Ark base URL 可达，但 GET /models 返回 404（该部署不暴露模型列表，或视频 API 不走这个端点）；无法据此判断 Key/模型，提交一次 preview 或真实任务才能最终确认。"
          });
        } else {
          checks.push({
            id: "ark-endpoint",
            ok: false,
            detail: String(error?.message ?? error),
            fix: "检查 baseUrl（CN: https://ark.cn-beijing.volces.com/api/v3）、Key 权限、账户余额/模型开通状态。"
          });
          actions.push("修好 Ark 连接后重跑 seedance_doctor。");
        }
      }
    }
    const ffprobe = await checkBinary(config.ffprobePath || "ffprobe", ["-version"]);
    checks.push({
      id: "ffprobe",
      ok: ffprobe.ok,
      detail: ffprobe.ok ? ffprobe.version : ffprobe.error,
      fix: ffprobe.ok ? undefined : "安装 ffprobe，或把 ffprobePath 指向可执行文件（例如工作室 tools/bin/ffprobe）。"
    });
    if (!ffprobe.ok) actions.push("安装 ffprobe 后视频 QA 才能自动读取时长/分辨率/编码。");
    const stageBase = String(config.stagePublicBaseUrl || process.env.SEEDANCE_STAGE_PUBLIC_BASE_URL || "");
    const cloudflared = String(config.cloudflaredPath || "");
    const uploadProvider = String(config.stageUploadProvider || "");
    const staged = stageBase !== "" || cloudflared !== "" || uploadProvider !== "";
    checks.push({
      id: "reference-video-staging",
      ok: staged,
      detail: stageBase !== ""
        ? `publicBaseUrl=${stageBase}`
        : cloudflared !== ""
          ? `cloudflaredPath=${cloudflared}`
          : uploadProvider !== ""
            ? `stageUploadProvider=${uploadProvider}（临时公开托管；只用于非敏感白模 MP4）`
            : "未配置",
      fix: staged
        ? undefined
        : "本地白模 MP4 不能直接提交；配置 stagePublicBaseUrl / cloudflaredPath / stageUploadProvider，或先把 MP4 上传到 TOS 并传公网 URL。"
    });
    if (!staged) actions.push("为本地白模 MP4 配置 staging（stagePublicBaseUrl / cloudflaredPath / stageUploadProvider），否则只能用公网 URL/asset://。");
    if (uploadProvider !== "") actions.push(`当前 staging 走 ${uploadProvider} 临时公开托管；角色/客户敏感素材不要走这条路，改用 TOS/反代/asset://。`);
    if (cloudflared !== "") {
      const cf = await checkBinary(cloudflared, ["--version"]);
      checks.push({ id: "cloudflared", ok: cf.ok, detail: cf.ok ? cf.version : cf.error, fix: cf.ok ? undefined : "检查 cloudflaredPath 是否指向可执行文件。" });
    }
    const outputDir = resolveWithinProject(context.projectRoot, config.outputDir ?? "output/seedance");
    try {
      await mkdir(outputDir, { recursive: true });
      checks.push({ id: "output-dir", ok: true, detail: outputDir });
    } catch (error) {
      checks.push({ id: "output-dir", ok: false, detail: String(error?.message ?? error), fix: "检查目录权限。" });
    }
    return {
      ok: checks.filter((check) => ["api-key", "ark-endpoint"].includes(check.id)).every((check) => check.ok),
      projectRoot: context.projectRoot,
      baseUrl: config.baseUrl,
      model: config.model,
      checks,
      nextActions: [...new Set(actions)]
    };
  }

  return {
    previewRequest,
    generateVideo,
    videoStatus,
    cancelVideo,
    stageReference,
    doctor,
    close() {
      stageService?.close();
    }
  };
}
