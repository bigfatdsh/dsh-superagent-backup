// Pure-ish core for the Seedance 2.5 DSH plugin: validation, prompt assembly,
// media normalization, and Ark request payload construction.
//
// Source of truth (2026-11-07):
// - https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api.md
// - https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5.md
// - https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5-prompt-guide.md
//
// This module deliberately has no DSH imports so it can be unit-tested outside
// the Harness. The plugin entry (lib/index.js) adds tool registration.

import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export const RATIOS = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
export const RESOLUTIONS = ["480p", "720p", "1080p"];
export const OUTPUT_FORMATS = ["mp4", "mov"];
export const OMNI_TASK_TYPES = ["auto", "reference", "edit", "extend"];
export const MODES = ["auto", "text", "reference", "first_last_frame", "edit", "extend"];

export const CN_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const INTL_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
export const CN_MODEL_25 = "doubao-seedance-2-5-260628";
export const INTL_MODEL_25 = "dreamina-seedance-2-5-260628";

export const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif"
};

const AUDIO_MIME = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg"
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov"]);

export const DEFAULT_NEGATIVE =
  "字幕、水印、文字、logo、多指、少指、畸形手、扭曲肢体、面部身份漂移、过度磨皮、蜡感皮肤、塑料感、白模材质、轨迹线、坐标轴、网格线、相机锥体";

const WHITEMODEL_CLAUSE =
  "白模参考约束：仅参考参考视频中的运镜、镜头顺序、景别变化、主体走位、动作路径和节奏；不要参考白模的灰色材质、几何外观或辅助元素。输出写实电影质感，人物身份、比例、站位和空间关系稳定；画面中不要出现轨迹线、坐标轴、网格线、相机锥体或任何白模辅助元素。";

const REAL_FACE_WARNING =
  "Seedance 2.5/2.0 不允许直接上传含真人人脸的参考图或参考视频；请使用 AI 生成的虚拟人像、预置虚拟人像，或已授权并入库的 asset:// 素材。风格化/3D/插画角色不受此限制。";

export function expandHome(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

export function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

export function isDataUri(value) {
  return typeof value === "string" && /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(value);
}

export function isAssetUri(value) {
  return typeof value === "string" && /^asset:\/\//i.test(value);
}

export function normalizeList(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  throw new Error(`seedance: 需要字符串或字符串数组，收到 ${typeof value}`);
}

export function modelFamily(model, override = "auto") {
  if (override && override !== "auto") {
    if (!["2.5", "2.0", "1.0"].includes(override)) throw new Error(`seedance: modelFamily 必须是 auto/2.5/2.0/1.0，收到 ${override}`);
    return override;
  }
  const id = String(model ?? "").toLowerCase();
  if (id.includes("seedance-2-5") || id.includes("seedance_2_5")) return "2.5";
  if (id.includes("seedance-2-0") || id.includes("seedance_2_0")) return "2.0";
  if (id.includes("seedance-1-0") || id.includes("seedance_1_0")) return "1.0";
  // An endpoint ID (ep-...) can point at any family. The plugin is for Seedance
  // 2.5, so assume 2.5 but keep the broad 4-15s safety range until the caller
  // sets modelFamily explicitly.
  return "unknown";
}

export function familyLimits(family) {
  switch (family) {
    case "2.5":
      return { min: 4, max: 30, maxImages: 30, maxVideos: 10, maxAudios: 10, supportsMov: true, supportsOmni: true, supportsNegativeAudioControls: true };
    case "2.0":
      return { min: 4, max: 15, maxImages: 9, maxVideos: 3, maxAudios: 3, supportsMov: false, supportsOmni: true, supportsNegativeAudioControls: true };
    case "1.0":
      return { min: 2, max: 12, maxImages: 0, maxVideos: 0, maxAudios: 0, supportsMov: false, supportsOmni: false, supportsNegativeAudioControls: false };
    default:
      return { min: 4, max: 15, maxImages: 30, maxVideos: 10, maxAudios: 10, supportsMov: false, supportsOmni: true, supportsNegativeAudioControls: true };
  }
}

export function motionHint(strength) {
  if (typeof strength !== "number" || !Number.isFinite(strength)) {
    throw new Error("seedance: motion_strength 必须是 0-0.8 之间的数字");
  }
  if (strength < 0) throw new Error("seedance: motion_strength 不能为负数");
  if (strength > 0.8) throw new Error("seedance: motion_strength 最高 0.8；Seedance API 没有该字段，本插件只把它映射成提示词");
  if (strength === 0) return { label: "static", text: "镜头固定，主体基本静止，只保留呼吸和极轻微的自然动作" };
  if (strength <= 0.4) return { label: "subtle", text: "镜头基本固定，主体动作幅度克制、自然" };
  if (strength <= 0.6) return { label: "slow-camera", text: "镜头缓慢平稳运动，节奏舒缓，动作连贯" };
  return { label: "dynamic", text: "镜头运动明确，主体动作连贯有力，但不要快速转身或复杂肢体交互" };
}

export function composePrompt(args, { family } = {}) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const parts = [];
  if (prompt) parts.push(prompt);
  if (args.whitemodel === true) parts.push(WHITEMODEL_CLAUSE);
  let motion;
  if (args.motion_strength !== undefined && args.motion_strength !== null) {
    motion = motionHint(Number(args.motion_strength));
    parts.push(`运动强度：${motion.text}`);
  }
  const userNegative = typeof args.negative_prompt === "string" ? args.negative_prompt.trim() : "";
  const guard = args.quality_guard === false ? "" : DEFAULT_NEGATIVE;
  const negative = [userNegative, guard].filter(Boolean).join("；");
  if (negative) parts.push(`【严格排除】${negative}`);
  return {
    finalPrompt: parts.join("\n\n"),
    negativePrompt: negative,
    userNegative,
    motion
  };
}

function pickNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`seedance: ${name} 必须是数字`);
  return number;
}

export function normalizeDuration(value, family, { edit = false, auto = false } = {}) {
  const limits = familyLimits(family);
  let duration = value === undefined || value === null ? undefined : Number(value);
  if (duration === undefined) return undefined;
  if (!Number.isInteger(duration)) throw new Error(`seedance: duration 必须是整数秒，收到 ${value}`);
  if (edit) return { duration: -1, adjusted: true, reason: "视频编辑任务 duration 必须为 -1" };
  if (auto) return { duration: -1, adjusted: true, reason: "omni_reference_task_type=auto 且含参考视频，按官方建议使用 duration=-1" };
  if (duration === -1) {
    if (family === "1.0") throw new Error("seedance: Seedance 1.0 不支持 duration=-1");
    return { duration: -1, adjusted: false };
  }
  if (duration < limits.min || duration > limits.max) {
    throw new Error(`seedance: ${family === "unknown" ? "未知模型族（按 4-15s 保守校验，可用 modelFamily 覆盖）" : `Seedance ${family}`} 的 duration 必须在 ${limits.min}-${limits.max} 秒或 -1，收到 ${duration}`);
  }
  return { duration, adjusted: false };
}

export function resolveRatio(value, { locked = false, fallback = "adaptive" } = {}) {
  const ratio = value === undefined || value === null || value === "" ? fallback : String(value);
  if (!RATIOS.includes(ratio)) throw new Error(`seedance: ratio 必须是 ${RATIOS.join(" / ")} 之一，收到 ${ratio}`);
  if (locked && ratio !== "adaptive") {
    return { ratio: "adaptive", adjusted: true, reason: "首帧/首尾帧、编辑、延长或 auto 任务只支持 ratio=adaptive" };
  }
  return { ratio, adjusted: false };
}

export function parseKeyFile(raw, envName = "ARK_API_KEY") {
  if (typeof raw !== "string") return "";
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) {
      if (match[1] === envName || match[1] === "ARK_API_KEY") return stripQuotes(match[2]);
      continue;
    }
    return stripQuotes(line);
  }
  return "";
}

function stripQuotes(value) {
  const text = String(value).trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1).trim();
  return text;
}

export async function resolveApiKey(config) {
  const envName = config.apiKeyEnv || "ARK_API_KEY";
  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return { key: fromEnv.trim(), source: `env:${envName}` };
  const file = expandHome(config.apiKeyFile || "~/.dsh/secrets/ark-api-key");
  try {
    const raw = await readFile(file, "utf8");
    const key = parseKeyFile(raw, envName);
    if (key !== "") return { key, source: `file:${file}` };
    return { key: "", source: "missing", file };
  } catch (error) {
    if (error?.code !== "ENOENT") return { key: "", source: "unreadable", file, error: String(error?.message ?? error) };
    return { key: "", source: "missing", file };
  }
}

export async function findProjectRoot(cwd) {
  let current = resolve(cwd || process.cwd());
  for (let depth = 0; depth < 10; depth += 1) {
    for (const marker of [".git", "shotlist.json", ".dsh/project.json"]) {
      try {
        const info = await stat(resolve(current, marker));
        if (info) return current;
      } catch {
        /* keep walking */
      }
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return resolve(cwd || process.cwd());
}

function mimeFor(path, table, fallback) {
  const ext = extname(path).toLowerCase();
  return table[ext] ?? fallback;
}

async function fileInfo(path) {
  const info = await stat(path).catch(() => undefined);
  if (!info || !info.isFile()) throw new Error(`seedance: 找不到文件：${path}`);
  return info;
}

export async function fileToDataUri(path, kind, maxBytes) {
  const info = await fileInfo(path);
  if (info.size > maxBytes) throw new Error(`seedance: 文件超过大小上限（${info.size} > ${maxBytes} 字节）：${path}`);
  const table = kind === "image" ? IMAGE_MIME : AUDIO_MIME;
  const fallback = kind === "image" ? "image/png" : "audio/wav";
  const mime = mimeFor(path, table, fallback);
  const buffer = await readFile(path);
  return { url: `data:${mime};base64,${buffer.toString("base64")}`, bytes: buffer.length, sourcePath: path, source: "file" };
}

export async function resolveImageInput(value, { cwd, maxBytes }) {
  if (isHttpUrl(value) || isDataUri(value) || isAssetUri(value)) {
    return { url: value, bytes: 0, source: isAssetUri(value) ? "asset" : isHttpUrl(value) ? "url" : "data" };
  }
  if (/^file:\/\//i.test(value)) value = decodeURIComponent(value.replace(/^file:\/\//i, ""));
  const absolute = isAbsolute(value) ? value : resolve(cwd, value);
  return fileToDataUri(absolute, "image", maxBytes);
}

export async function resolveAudioInput(value, { cwd, maxBytes }) {
  if (isHttpUrl(value) || isDataUri(value) || isAssetUri(value)) {
    return { url: value, bytes: 0, source: isAssetUri(value) ? "asset" : isHttpUrl(value) ? "url" : "data" };
  }
  if (/^file:\/\//i.test(value)) value = decodeURIComponent(value.replace(/^file:\/\//i, ""));
  const absolute = isAbsolute(value) ? value : resolve(cwd, value);
  return fileToDataUri(absolute, "audio", maxBytes);
}

export async function resolveVideoInput(value, { cwd, maxBytes, stageVideo }) {
  if (isHttpUrl(value) || isAssetUri(value)) return { url: value, bytes: 0, source: isAssetUri(value) ? "asset" : "url" };
  if (isDataUri(value)) throw new Error("seedance: Ark 的视频输入只接受公网 URL 或 asset://，不接受 base64 视频；请用 seedance_stage_reference 把本地 MP4 变成公网 URL");
  if (/^file:\/\//i.test(value)) value = decodeURIComponent(value.replace(/^file:\/\//i, ""));
  const absolute = isAbsolute(value) ? value : resolve(cwd, value);
  const info = await fileInfo(absolute);
  if (!VIDEO_EXTENSIONS.has(extname(absolute).toLowerCase())) throw new Error(`seedance: 参考视频只支持 mp4/mov，收到 ${absolute}`);
  if (info.size > maxBytes) throw new Error(`seedance: 参考视频超过大小上限（${info.size} > ${maxBytes} 字节）：${absolute}`);
  if (typeof stageVideo !== "function") {
    throw new Error(`seedance: 本地参考视频必须变成公网 URL 或 asset:// 才能提交。请调用 seedance_stage_reference 生成公网 URL，或配置 stagePublicBaseUrl / cloudflaredPath。文件：${absolute}`);
  }
  const staged = await stageVideo(absolute, { kind: "video" });
  const url = typeof staged === "string" ? staged : staged?.url;
  if (!isHttpUrl(url) && !isAssetUri(url)) throw new Error(`seedance: stage 未返回可用的公网 URL：${JSON.stringify(staged)}`);
  return { url, bytes: info.size, sourcePath: absolute, source: "staged", staged: true, expiresAt: typeof staged === "object" ? staged.expiresAt : undefined };
}

export function createPlaceholderMedia(args) {
  const images = normalizeList(args.reference_images).map((_, index) => ({ url: `https://placeholder.invalid/image-${index + 1}`, bytes: 0, source: "url" }));
  const videos = normalizeList(args.reference_videos).map((_, index) => ({ url: `https://placeholder.invalid/video-${index + 1}`, bytes: 0, source: "url" }));
  const audios = normalizeList(args.reference_audios).map((_, index) => ({ url: `https://placeholder.invalid/audio-${index + 1}`, bytes: 0, source: "url" }));
  const firstFrame = typeof args.first_frame === "string" && args.first_frame.trim() !== ""
    ? { url: "https://placeholder.invalid/first.png", bytes: 0, source: "url" }
    : undefined;
  const lastFrame = typeof args.last_frame === "string" && args.last_frame.trim() !== ""
    ? { url: "https://placeholder.invalid/last.png", bytes: 0, source: "url" }
    : undefined;
  return { images, videos, audios, firstFrame, lastFrame, totalBytes: 0, placeholder: true };
}

export async function prepareMedia(args, { cwd, config, stageVideo }) {
  const images = [];
  for (const value of normalizeList(args.reference_images)) {
    images.push(await resolveImageInput(value, { cwd, maxBytes: config.maxImageBytes ?? MAX_IMAGE_BYTES }));
  }
  const videos = [];
  for (const value of normalizeList(args.reference_videos)) {
    videos.push(await resolveVideoInput(value, { cwd, maxBytes: config.maxVideoBytes ?? MAX_VIDEO_BYTES, stageVideo }));
  }
  const audios = [];
  for (const value of normalizeList(args.reference_audios)) {
    audios.push(await resolveAudioInput(value, { cwd, maxBytes: config.maxAudioBytes ?? MAX_AUDIO_BYTES }));
  }
  const firstFrame = typeof args.first_frame === "string" && args.first_frame.trim() !== ""
    ? await resolveImageInput(args.first_frame.trim(), { cwd, maxBytes: config.maxImageBytes ?? MAX_IMAGE_BYTES })
    : undefined;
  const lastFrame = typeof args.last_frame === "string" && args.last_frame.trim() !== ""
    ? await resolveImageInput(args.last_frame.trim(), { cwd, maxBytes: config.maxImageBytes ?? MAX_IMAGE_BYTES })
    : undefined;
  const totalBytes = [...images, ...videos, ...audios, ...(firstFrame ? [firstFrame] : []), ...(lastFrame ? [lastFrame] : [])]
    .reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  return { images, videos, audios, firstFrame, lastFrame, totalBytes };
}

function inferMode(args, media) {
  const hasFirst = Boolean(media.firstFrame || media.lastFrame);
  const hasMedia = media.images.length + media.videos.length + media.audios.length > 0;
  const requested = args.mode === undefined || args.mode === null || args.mode === "" ? "auto" : String(args.mode);
  if (!MODES.includes(requested)) throw new Error(`seedance: mode 必须是 ${MODES.join(" / ")} 之一，收到 ${requested}`);
  if (requested !== "auto") return requested;
  if (hasFirst) return "first_last_frame";
  if (hasMedia) return "reference";
  return "text";
}

function assertCounts(media, limits, family) {
  if (media.images.length > limits.maxImages) throw new Error(`seedance: Seedance ${family} 最多 ${limits.maxImages} 张参考图，收到 ${media.images.length}`);
  if (media.videos.length > limits.maxVideos) throw new Error(`seedance: Seedance ${family} 最多 ${limits.maxVideos} 个参考视频，收到 ${media.videos.length}`);
  if (media.audios.length > limits.maxAudios) throw new Error(`seedance: Seedance ${family} 最多 ${limits.maxAudios} 段参考音频，收到 ${media.audios.length}`);
  if (family === "2.5" && media.images.length + media.videos.length + media.audios.length > 50) {
    throw new Error("seedance: Seedance 2.5 单次最多 50 个参考素材（30 图 + 10 视频 + 10 音频）");
  }
}

function boolOr(value, fallback) {
  return value === undefined || value === null ? fallback : value === true;
}

export function buildPayload({ args, media, config }) {
  const warnings = [];
  const model = args.model || config.model || CN_MODEL_25;
  const family = modelFamily(model, args.modelFamily ?? config.modelFamily ?? "auto");
  const limits = familyLimits(family);
  if (family === "unknown") warnings.push("未知模型族，按 4-15s 保守校验；请把 modelFamily 设为 2.5/2.0/1.0 或使用官方模型 ID。");

  const mode = inferMode(args, media);
  const hasFirst = Boolean(media.firstFrame || media.lastFrame);
  const hasReferenceMedia = media.images.length + media.videos.length + media.audios.length > 0;
  if ((mode === "first_last_frame" || mode === "text") && args.omni_reference_task_type) {
    throw new Error(`seedance: ${mode} 模式与 omni_reference_task_type 互斥；首帧/首尾帧/文生视频不要设置该字段。`);
  }

  if (hasFirst && hasReferenceMedia) {
    throw new Error("seedance: 首帧/首尾帧 与 全模态参考（reference_image/video/audio）互斥，不能混用。需要首尾帧锁定就用 first_frame/last_frame；需要参考素材就用 reference_*。");
  }
  if (media.lastFrame && !media.firstFrame) throw new Error("seedance: 传 last_frame 时必须同时传 first_frame");
  if (mode === "first_last_frame" && !media.firstFrame) throw new Error("seedance: first_last_frame 模式缺少 first_frame");
  if (mode === "text" && (hasFirst || hasReferenceMedia)) throw new Error("seedance: text 模式不能带参考素材；请用 mode=auto 或 mode=reference");
  if (mode === "reference" && !hasReferenceMedia) throw new Error("seedance: reference 模式至少需要一张参考图、一段参考视频或一段参考音频");
  if (mode === "edit" && media.videos.length === 0) throw new Error("seedance: edit 模式至少需要一个 reference_video");
  if (mode === "extend" && media.videos.length === 0) throw new Error("seedance: extend 模式至少需要一个 reference_video");
  if (family === "1.0" && hasReferenceMedia) throw new Error("seedance: Seedance 1.0 不支持全模态参考；请用 2.5/2.0 模型");
  if (family === "2.0" && media.audios.length > 0 && media.images.length + media.videos.length === 0) {
    throw new Error("seedance: Seedance 2.0 不能单独输入音频，至少还要一张图片或一个视频");
  }
  assertCounts(media, limits, family);

  if (mode === "edit" && !/编辑视频|增加|加上|删除|去掉|修改|替换|改成/i.test(args.prompt ?? "")) {
    warnings.push("edit 模式的提示词建议包含 编辑视频/增加/删除/修改/替换/改成 等意图关键词，否则模型可能判定为 reference，导致异步 TaskTypeMismatch。");
  }
  if (mode === "extend" && !/延长|续写|延续|向前|向后/i.test(args.prompt ?? "")) {
    warnings.push("extend 模式的提示词建议包含 延长/续写/延续/向前/向后 等意图关键词，否则模型可能判定为 reference，导致异步 TaskTypeMismatch。");
  }
  if (mode === "reference" && /编辑视频|增加|加上|删除|去掉|修改|替换|改成|延长|续写|延续/i.test(args.prompt ?? "")) {
    warnings.push("reference 模式的提示词含编辑/延长类关键词，但已显式设置 omni_reference_task_type=reference；请确认不想做 edit/extend。");
  }

  const lockedRatio = mode === "first_last_frame" || mode === "edit" || mode === "extend";
  const ratioResult = resolveRatio(args.ratio, { locked: lockedRatio, fallback: config.defaultRatio ?? "adaptive" });
  if (ratioResult.adjusted) warnings.push(`${ratioResult.reason}，已从 ${args.ratio} 改为 adaptive。`);
  let ratio = ratioResult.ratio;

  const requestedDuration = args.duration === undefined || args.duration === null ? (config.defaultDuration ?? 5) : Number(args.duration);
  let omniType;
  if (mode === "edit") omniType = "edit";
  else if (mode === "extend") omniType = "extend";
  else if (mode === "reference") omniType = args.omni_reference_task_type ? String(args.omni_reference_task_type) : "reference";
  else if (args.omni_reference_task_type) {
    const requested = String(args.omni_reference_task_type);
    if (!OMNI_TASK_TYPES.includes(requested)) throw new Error(`seedance: omni_reference_task_type 必须是 ${OMNI_TASK_TYPES.join(" / ")}`);
    if (requested === "edit" || requested === "extend") throw new Error(`seedance: ${requested} 需要 reference_video，并且请直接用 mode=${requested}`);
    if (requested === "reference" && !hasReferenceMedia) throw new Error("seedance: omni_reference_task_type=reference 需要参考素材");
    if (requested === "auto") {
      if (!limits.supportsOmni) throw new Error("seedance: 当前模型族不支持全模态参考");
      omniType = "auto";
    }
  }
  if (omniType !== undefined && !limits.supportsOmni) throw new Error(`seedance: Seedance ${family} 不支持 omni_reference_task_type`);

  const autoWithVideo = omniType === "auto" && media.videos.length > 0;
  if (autoWithVideo && !lockedRatio) {
    ratio = "adaptive";
    warnings.push("omni_reference_task_type=auto 且含参考视频：按官方建议改用 ratio=adaptive、duration=-1，兼容模型可能判定的 edit/extend。");
  }
  const durationResult = normalizeDuration(requestedDuration, family, { edit: mode === "edit", auto: autoWithVideo });
  let duration = durationResult.duration;
  if (durationResult.adjusted) warnings.push(`${durationResult.reason}，已改为 duration=${duration}。`);
  if (duration === -1 && family === "unknown") warnings.push("未知模型族选择了 duration=-1；如果实际是 Seedance 2.5/2.0 才支持智能时长。");

  if (mode === "edit" && media.videos.some((video) => video.bytes === 0)) {
    warnings.push("edit 模式要求参考视频时长 4-30s；公网 URL 的时长无法在本地校验，请确保素材合规。");
  }

  const resolution = args.draft === true ? "480p" : String(args.resolution ?? config.defaultResolution ?? "720p");
  if (!RESOLUTIONS.includes(resolution)) throw new Error(`seedance: resolution 必须是 ${RESOLUTIONS.join(" / ")}，收到 ${resolution}`);
  if (args.draft === true && args.resolution && args.resolution !== "480p") warnings.push("draft=true 只支持 480p，已强制 480p。");

  let outputFormat = String(args.output_format ?? config.defaultOutputFormat ?? (mode === "edit" || mode === "extend" ? "mov" : "mp4"));
  if (!OUTPUT_FORMATS.includes(outputFormat)) throw new Error(`seedance: output_format 必须是 mp4 / mov，收到 ${outputFormat}`);
  if (outputFormat === "mov" && !limits.supportsMov) {
    outputFormat = "mp4";
    warnings.push(`Seedance ${family} 不支持 mov，已改为 mp4。`);
  }
  if ((mode === "edit" || mode === "extend") && args.output_format === undefined && outputFormat === "mp4") {
    warnings.push("编辑/延长任务建议 output_format=mov 以保持色彩与声画一致性；当前为 mp4，可显式改 mov。");
  }

  const generateAudio = boolOr(args.generate_audio, config.defaultGenerateAudio ?? false);
  const watermark = boolOr(args.watermark, config.defaultWatermark ?? false);
  const returnLastFrame = args.return_last_frame === true;
  const qualityGuard = args.quality_guard !== false;
  const composed = composePrompt({ ...args, quality_guard: qualityGuard }, { family });
  if (mode === "text" && composed.finalPrompt.trim() === "") throw new Error("seedance: 文生视频必须提供 prompt");
  if (mode === "reference" && composed.finalPrompt.trim() === "") warnings.push("参考生视频没有 prompt，模型只靠素材生成，身份/场景控制会更弱。");
  if (mode === "first_last_frame" && !composed.finalPrompt.trim()) warnings.push("首帧/首尾帧没有 prompt，建议补一句运动与镜头描述。");
  if (/说|台词|对白|口型|对话/.test(composed.finalPrompt) && generateAudio === false) {
    warnings.push("提示词含台词/口型，但 generate_audio=false；需要同步人声时请设 generate_audio=true。");
  }
  if (media.images.length + media.videos.length > 0) warnings.push(REAL_FACE_WARNING);

  for (const key of ["seed", "camera_fixed", "frames", "service_tier", "sound", "negative_prompt", "motion_strength"]) {
    if (args[key] !== undefined) {
      if (key === "negative_prompt" || key === "motion_strength") continue;
      warnings.push(`${key} 不是 Seedance 2.5 的 API 字段，已忽略（不会发送）。`);
    }
  }

  const content = [];
  if (composed.finalPrompt.trim() !== "") content.push({ type: "text", text: composed.finalPrompt });
  if (media.firstFrame) content.push({ type: "image_url", image_url: { url: media.firstFrame.url }, role: "first_frame" });
  if (media.lastFrame) content.push({ type: "image_url", image_url: { url: media.lastFrame.url }, role: "last_frame" });
  for (const image of media.images) content.push({ type: "image_url", image_url: { url: image.url }, role: "reference_image" });
  for (const video of media.videos) content.push({ type: "video_url", video_url: { url: video.url }, role: "reference_video" });
  for (const audio of media.audios) content.push({ type: "audio_url", audio_url: { url: audio.url }, role: "reference_audio" });

  const payload = {
    model,
    content,
    generate_audio: generateAudio,
    ratio,
    duration,
    resolution,
    watermark,
    output_format: outputFormat,
    return_last_frame: returnLastFrame
  };
  if (omniType !== undefined) payload.omni_reference_task_type = omniType;
  if (args.web_search === true) payload.tools = [{ type: "web_search" }];
  if (typeof args.callback_url === "string" && args.callback_url.trim() !== "") {
    if (!/^https?:\/\//i.test(args.callback_url.trim())) throw new Error("seedance: callback_url 必须是公网 http(s) URL");
    payload.callback_url = args.callback_url.trim();
  }
  if (args.priority !== undefined) {
    const priority = pickNumber(args.priority, "priority");
    if (!Number.isInteger(priority) || priority < 0 || priority > 9) throw new Error("seedance: priority 必须是 0-9 的整数");
    payload.priority = priority;
  }
  if (typeof args.safety_identifier === "string" && args.safety_identifier.trim() !== "") {
    if (args.safety_identifier.length > 64) throw new Error("seedance: safety_identifier 长度不能超过 64");
    payload.safety_identifier = args.safety_identifier.trim();
  }
  if (args.draft === true) payload.draft = true;

  const requestBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (requestBytes > MAX_REQUEST_BYTES) {
    throw new Error(`seedance: 请求体 ${requestBytes} 字节，超过 Ark 的 64MB 上限。请减少参考图/音频，或改用公网 URL 而不是 base64。`);
  }
  if (requestBytes > 60 * 1024 * 1024) warnings.push(`请求体约 ${(requestBytes / 1024 / 1024).toFixed(1)}MB，接近 64MB 上限。`);

  const report = {
    mode,
    family,
    model,
    ratio,
    duration,
    resolution,
    generateAudio,
    watermark,
    outputFormat,
    omniReferenceTaskType: omniType,
    returnLastFrame,
    prompt: typeof args.prompt === "string" ? args.prompt : "",
    finalPrompt: composed.finalPrompt,
    negativePrompt: composed.negativePrompt,
    negativePromptMerged: composed.negativePrompt !== "",
    motionStrength: args.motion_strength,
    motionMappedTo: composed.motion?.label,
    motionHint: composed.motion?.text,
    contentCounts: {
      text: content.filter((item) => item.type === "text").length,
      images: media.images.length + (media.firstFrame ? 1 : 0) + (media.lastFrame ? 1 : 0),
      videos: media.videos.length,
      audios: media.audios.length
    },
    totalMedia: media.images.length + media.videos.length + media.audios.length + (media.firstFrame ? 1 : 0) + (media.lastFrame ? 1 : 0),
    requestBytes,
    warnings: [...new Set(warnings)],
    stagedVideos: media.videos.filter((video) => video.staged).map((video) => ({ path: video.sourcePath, url: video.url, expiresAt: video.expiresAt }))
  };
  return { payload, report };
}

export function redactPayload(payload) {
  const clone = structuredClone(payload);
  for (const item of clone.content ?? []) {
    for (const key of ["image_url", "video_url", "audio_url"]) {
      const url = item?.[key]?.url;
      if (typeof url === "string" && url.startsWith("data:")) {
        const comma = url.indexOf(",");
        const mime = url.slice(5, Math.max(5, comma)).split(";")[0] || "application/octet-stream";
        const bytes = Buffer.byteLength(url.slice(comma + 1), "base64");
        item[key].url = `data:${mime};base64,<${bytes} bytes>`;
      }
    }
  }
  return clone;
}

export function jsonSafe(value) {
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      output[key] = jsonSafe(item);
    }
    return output;
  }
  return value;
}

export function taskRecordView(record) {
  if (!record || typeof record !== "object") return record;
  return {
    taskId: record.taskId,
    status: record.lastStatus ?? record.status,
    model: record.model,
    mode: record.mode,
    ratio: record.ratio,
    duration: record.duration,
    resolution: record.resolution,
    generateAudio: record.generateAudio,
    prompt: record.prompt,
    localPath: record.localPath,
    videoUrl: record.videoUrl,
    createdAt: record.submittedAt,
    updatedAt: record.updatedAt
  };
}
