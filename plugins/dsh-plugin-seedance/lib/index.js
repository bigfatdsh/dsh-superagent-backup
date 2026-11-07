// DSH plugin entry: registers the Seedance 2.5 tools and a short system-prompt
// section. All business logic lives in service.js/core.js so it can be tested
// without the Harness runtime.

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  CN_MODEL_25,
  OUTPUT_FORMATS,
  RATIOS,
  RESOLUTIONS,
  OMNI_TASK_TYPES,
  jsonSafe
} from "./core.js";
import { createSeedanceService } from "./service.js";

export const name = "tool-seedance";
export const inject = ["tools", "systemPrompt"];

export const Config = z.object({
  enabled: z.boolean().default(true),
  apiKeyEnv: z.string().default("ARK_API_KEY"),
  apiKeyFile: z.string().default("~/.dsh/secrets/ark-api-key"),
  baseUrl: z.string().default("https://ark.cn-beijing.volces.com/api/v3"),
  model: z.string().default(CN_MODEL_25),
  modelFamily: z.string().default("auto"),
  defaultRatio: z.string().default("adaptive"),
  defaultDuration: z.number().default(5),
  defaultResolution: z.string().default("720p"),
  defaultGenerateAudio: z.boolean().default(false),
  defaultWatermark: z.boolean().default(false),
  defaultOutputFormat: z.string().default("mp4"),
  outputDir: z.string().default("output/seedance"),
  taskDir: z.string().default(".seedance/tasks"),
  autoDownload: z.boolean().default(true),
  pollIntervalMs: z.number().default(5000),
  statusTimeoutMs: z.number().default(900000),
  generateTimeoutMs: z.number().default(120000),
  maxImageBytes: z.number().default(31457280),
  maxAudioBytes: z.number().default(15728640),
  maxVideoBytes: z.number().default(209715200),
  stageEnabled: z.boolean().default(true),
  stagePublicBaseUrl: z.string().default(""),
  stageUploadProvider: z.string().default(""),
  stageUploadMaxBytes: z.number().default(104857600),
  stageHost: z.string().default("127.0.0.1"),
  stagePort: z.number().default(8797),
  stageTtlMinutes: z.number().default(120),
  cloudflaredPath: z.string().default(""),
  tunnelTimeoutMs: z.number().default(30000),
  qualityGuard: z.boolean().default(true),
  ffprobePath: z.string().default("")
});

function assertConfig(config) {
  if (!/^https?:\/\//i.test(config.baseUrl)) throw new Error(`tool-seedance: baseUrl 必须是 http(s) URL，收到 ${config.baseUrl}`);
  if (typeof config.model !== "string" || config.model.trim() === "") throw new Error("tool-seedance: model 不能为空");
  if (!["auto", "2.5", "2.0", "1.0"].includes(config.modelFamily)) throw new Error("tool-seedance: modelFamily 必须是 auto/2.5/2.0/1.0");
  if (!RATIOS.includes(config.defaultRatio)) throw new Error(`tool-seedance: defaultRatio 必须是 ${RATIOS.join(" / ")}`);
  if (!RESOLUTIONS.includes(config.defaultResolution)) throw new Error(`tool-seedance: defaultResolution 必须是 ${RESOLUTIONS.join(" / ")}`);
  if (!OUTPUT_FORMATS.includes(config.defaultOutputFormat)) throw new Error("tool-seedance: defaultOutputFormat 必须是 mp4/mov");
  if (!Number.isInteger(config.defaultDuration) || (config.defaultDuration !== -1 && (config.defaultDuration < 2 || config.defaultDuration > 30))) {
    throw new Error("tool-seedance: defaultDuration 必须是 -1 或 2-30 的整数");
  }
  for (const key of ["pollIntervalMs", "statusTimeoutMs", "generateTimeoutMs", "maxImageBytes", "maxAudioBytes", "maxVideoBytes", "stageTtlMinutes", "tunnelTimeoutMs"]) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`tool-seedance: ${key} 必须是正整数`);
  }
  if (!Number.isInteger(config.stagePort) || config.stagePort < 0 || config.stagePort > 65535) throw new Error("tool-seedance: stagePort 必须是 0-65535 的整数");
  if (!Number.isInteger(config.stageTtlMinutes) || config.stageTtlMinutes < 1) throw new Error("tool-seedance: stageTtlMinutes 必须是正整数");
  if (!["", "uguu"].includes(config.stageUploadProvider)) throw new Error("tool-seedance: stageUploadProvider 目前只支持 \"\" 或 uguu");
  if (!Number.isInteger(config.stageUploadMaxBytes) || config.stageUploadMaxBytes < 1) throw new Error("tool-seedance: stageUploadMaxBytes 必须是正整数");
}

function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

function sessionId(exec) {
  return typeof exec?.agent?.session?.id === "string" ? exec.agent.session.id : "unknown";
}

function errorText(error) {
  const parts = [String(error?.message ?? error)];
  if (error?.requestId) parts.push(`requestId: ${error.requestId}`);
  if (error?.details?.requestBytes) parts.push(`请求体: ${error.details.requestBytes} bytes`);
  if (error?.details?.report?.warnings?.length) {
    parts.push(`警告:\n- ${error.details.report.warnings.join("\n- ")}`);
  }
  return parts.join("\n");
}

const videoParameters = {
  prompt: {
    type: "string",
    description: "正向提示词。写清楚主体、场景、构图、光影、材质、镜头运动、节奏与风格。白模参考时请说明哪些信息继承自参考视频、哪些来自参考图。"
  },
  negative_prompt: {
    type: "string",
    description: "负面/规避词（插件会并入正向提示词，不会作为 API 字段发送）。建议只写必须排除的内容；默认已带字幕/水印/多指/白模辅助元素等质量护栏。"
  },
  motion_strength: {
    type: "number",
    description: "运动强度 0-0.8（不是 API 字段，插件只映射成提示词）。0=静止，0.2-0.4=克制，0.5-0.6=缓慢运镜，0.7-0.8=明确运动；禁止 >0.8。"
  },
  mode: {
    type: "string",
    enum: ["auto", "text", "reference", "first_last_frame", "edit", "extend"],
    description: "任务模式。auto 根据素材推断：有首尾帧→first_last_frame，有参考素材→reference，否则 text。白模参考必须用 reference。"
  },
  reference_images: {
    type: "array",
    items: { type: "string" },
    description: "参考图数组（最多 30 张）：公网 URL、data URI、asset://，或当前项目内的图片路径（自动转 base64）。按出场顺序编号，提示词里用 @图片1/@图片2 指代。"
  },
  reference_videos: {
    type: "array",
    items: { type: "string" },
    description: "参考视频数组（最多 10 个）：公网 URL 或 asset://。本地 Blender MP4 先用 seedance_stage_reference 变成公网 URL；Ark 不接受 base64 视频。"
  },
  reference_audios: {
    type: "array",
    items: { type: "string" },
    description: "参考音频数组（最多 10 段）：公网 URL、data URI、asset://，或项目内音频路径（自动转 base64）。Seedance 2.5 可单独用音频，2.0 不能。"
  },
  first_frame: {
    type: "string",
    description: "首帧图（首帧/首尾帧模式）：URL、data URI、asset:// 或项目内路径。此模式与 reference_* 互斥，ratio 只能 adaptive。"
  },
  last_frame: {
    type: "string",
    description: "尾帧图（首尾帧模式）：与 first_frame 同时使用；建议首尾帧画幅一致。"
  },
  ratio: {
    type: "string",
    enum: RATIOS,
    description: "画幅。首帧/首尾帧、edit、extend 只能 adaptive；参考生视频/文生视频可用 16:9 等。默认取插件配置。"
  },
  duration: {
    type: "integer",
    description: "时长秒。Seedance 2.5: 4-30 或 -1（智能时长）；2.0: 4-15 或 -1；1.0: 2-12。edit 必须 -1。不是 3 秒；3 秒会被拒绝。"
  },
  resolution: {
    type: "string",
    enum: RESOLUTIONS,
    description: "分辨率 480p/720p/1080p（Seedance 2.5 无 4K）。"
  },
  generate_audio: {
    type: "boolean",
    description: "是否生成同步人声/音效/BGM。含台词/口型时设 true；只要画面时设 false 更可控。"
  },
  watermark: {
    type: "boolean",
    description: "是否加 AI 生成水印。默认 false。"
  },
  output_format: {
    type: "string",
    enum: OUTPUT_FORMATS,
    description: "mp4 或 mov。edit/extend 建议 mov；mov 仅 Seedance 2.5 支持。"
  },
  omni_reference_task_type: {
    type: "string",
    enum: OMNI_TASK_TYPES,
    description: "全模态子任务类型。白模参考请显式用 reference，避免提示词里的“修改/延长”等词被误判为 edit/extend。edit 需 reference_video + ratio=adaptive + duration=-1。"
  },
  whitemodel: {
    type: "boolean",
    description: "白模参考专用：自动加入“只参考运镜/走位/节奏，不保留白模材质/轨迹线/坐标轴/相机锥体”的强约束。"
  },
  quality_guard: {
    type: "boolean",
    description: "是否追加默认质量负面词（字幕/水印/多指/白模辅助元素等）。默认 true。"
  },
  model: {
    type: "string",
    description: "覆盖本次任务的 Model ID（默认 doubao-seedance-2-5-260628）。也可传控制台里的 ep-... 接入点 ID。"
  },
  modelFamily: {
    type: "string",
    enum: ["auto", "2.5", "2.0", "1.0"],
    description: "模型族。用 ep-... 接入点 ID 时显式设为 2.5，才能按 4-30s/mov 规则校验。"
  },
  return_last_frame: {
    type: "boolean",
    description: "是否让 Ark 返回生成视频的尾帧 URL（可用于下一镜首帧/续写）。"
  },
  dry_run: {
    type: "boolean",
    description: "仅 seedance_generate_video 使用；true 时等价 preview，只校验并返回 payload，不提交、不花额度。"
  },
  draft: {
    type: "boolean",
    description: "Seedance 2.5 样片模式：只支持 480p，生成低分辨率预览，确认后再用 draft_task 出正式片。"
  },
  web_search: {
    type: "boolean",
    description: "是否允许模型联网搜索（tools=[{type:web_search}]）。会增加时延。"
  },
  priority: {
    type: "integer",
    description: "队列优先级 0-9（Seedance 2.5/2.0 支持）。"
  },
  callback_url: {
    type: "string",
    description: "任务状态回调地址（公网 http(s)）。"
  },
  safety_identifier: {
    type: "string",
    description: "终端用户稳定标识（≤64 字符，建议哈希）。"
  }
};

const jsonOutput = {
  schema: { type: "object", properties: {}, additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
};

export function apply(ctx, config) {
  if (config.enabled === false) return;
  assertConfig(config);
  const logger = ctx.logger ?? console;
  const service = createSeedanceService({ config, logger });
  ctx.effect(() => () => service.close());

  ctx.systemPrompt.section({
    name: "tool:seedance",
    order: 120,
    text:
      "Seedance 2.5 (Volcengine Ark) tools are available. Use seedance_preview_request before spending credits; it validates the exact payload without calling Ark. " +
      "For a Blender white-model shot: stage the MP4 with seedance_stage_reference, then call seedance_generate_video with mode=reference, omni_reference_task_type=reference, whitemodel=true, reference_videos=[stagedUrl], reference_images=[character/scene refs], ratio=16:9, duration in 4-30 (default 5). " +
      "For a locked end pose: use first_frame/last_frame and ratio=adaptive. " +
      "negative_prompt and motion_strength are agent-friendly aliases: negative_prompt is merged into the positive text (Ark has no negative field), and motion_strength (0-0.8) only adds a motion clause; never send them as raw API fields. " +
      "Ark video inputs must be public http(s) URLs or asset:// — base64 video is rejected. " +
      "Seedance 2.5/2.0 reject direct reference images/videos containing real human faces; use AI-generated virtual humans, preset digital humans, or authorized asset:// media. " +
      "Report adjusted values (ratio/duration/output_format), warnings, taskId, and status honestly; never fabricate a result."
  });

  // ------------------------------------------------------------------ preview
  ctx.tools.register(defineTool({
    name: "seedance_preview_request",
    description:
      "Dry-run a Seedance 2.5 request: validates media, counts, ratio/duration locks, prompts, and returns the exact Ark JSON payload with base64 redacted. No API key and no credits are used. Use this before seedance_generate_video.",
    parameters: videoParameters,
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        return jsonSafe(await service.previewRequest({ args, cwd: sessionCwd(exec) }));
      } catch (error) {
        throw new Error(errorText(error));
      }
    }
  }));

  // ----------------------------------------------------------------- generate
  ctx.tools.register(defineTool({
    name: "seedance_generate_video",
    description:
      "Submit a Seedance 2.5 (Volcengine Ark) video generation task. Supports text-to-video, multimodal reference-to-video (reference_videos + reference_images + reference_audios), first/last-frame, edit, and extend. " +
      "Returns a taskId immediately; use seedance_video_status to poll and download. Local reference videos must be staged first with seedance_stage_reference (Ark accepts only public URLs or asset:// for video). " +
      "The tool reports finalPrompt, adjusted ratio/duration/output_format, content counts, and warnings; relay them honestly.",
    parameters: videoParameters,
    output: jsonOutput,
    timeoutMs: config.generateTimeoutMs,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: "generic",
      title: String(args.prompt ?? "Seedance 视频").slice(0, 80),
      kind: "video",
      rawInput: String(args.prompt ?? "").slice(0, 500)
    }),
    async execute(args, exec) {
      try {
        return jsonSafe(await service.generateVideo({
          args,
          cwd: sessionCwd(exec),
          signal: exec?.signal,
          sessionId: sessionId(exec)
        }));
      } catch (error) {
        throw new Error(errorText(error));
      }
    }
  }));

  // ------------------------------------------------------------------- status
  ctx.tools.register(defineTool({
    name: "seedance_video_status",
    description:
      "Query a Seedance task by id. With wait=true (default) it polls until the task finishes/fails or the wait budget expires, then auto-downloads the finished video into the project's output directory and probes it with ffprobe. " +
      "Call without a taskId to list this project's recent Seedance tasks and refresh their remote status.",
    parameters: {
      taskId: { type: "string", description: "seedance_generate_video 返回的任务 id；省略则列出当前项目最近的任务" },
      wait: { type: "boolean", description: "是否轮询等待完成（默认 true）；false 只查询一次" },
      maxWaitSeconds: { type: "number", description: "本次最多等待秒数（受插件 statusTimeoutMs 上限约束）" }
    },
    output: jsonOutput,
    timeoutMs: config.statusTimeoutMs,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: "generic", title: args.taskId ?? "列出 Seedance 任务", kind: "video", rawInput: args.taskId ?? "" }),
    async execute(args, exec) {
      try {
        return jsonSafe(await service.videoStatus({
          taskId: args.taskId,
          wait: args.wait,
          maxWaitSeconds: args.maxWaitSeconds,
          cwd: sessionCwd(exec),
          signal: exec?.signal
        }));
      } catch (error) {
        throw new Error(errorText(error));
      }
    }
  }));

  // ------------------------------------------------------------------- cancel
  ctx.tools.register(defineTool({
    name: "seedance_video_cancel",
    description: "Cancel a still-queued Seedance task (Ark only guarantees queued cancellation; a running task's DELETE may delete the record instead of stopping execution).",
    parameters: {
      taskId: { type: "string", required: true, description: "要取消的任务 id" }
    },
    output: jsonOutput,
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        return jsonSafe(await service.cancelVideo({ taskId: args.taskId, cwd: sessionCwd(exec), signal: exec?.signal }));
      } catch (error) {
        throw new Error(errorText(error));
      }
    }
  }));

  // -------------------------------------------------------------------- stage
  ctx.tools.register(defineTool({
    name: "seedance_stage_reference",
    description:
      "Expose a local image/video/audio file at a public URL for Ark. Uses stagePublicBaseUrl or a Cloudflare quick tunnel from cloudflaredPath; if stageUploadProvider=uguu, uploads to a temporary public host (~3h, public). " +
      "Only explicitly staged files are served in local modes; uguu files are public, so use it only for non-sensitive blockout MP4s. Ark reference videos cannot be base64; stage the Blender MP4 before seedance_generate_video.",
    parameters: {
      path: { type: "string", required: true, description: "项目内文件路径（或已经是公网 URL/asset://，会原样返回）" },
      kind: { type: "string", enum: ["video", "image", "audio"], description: "素材类型，默认 video" },
      ttlMinutes: { type: "number", description: "公网可访问时长（分钟），默认取 stageTtlMinutes" }
    },
    output: jsonOutput,
    timeoutMs: 90000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        return jsonSafe(await service.stageReference({ path: args.path, kind: args.kind, ttlMinutes: args.ttlMinutes, cwd: sessionCwd(exec) }));
      } catch (error) {
        throw new Error(errorText(error));
      }
    }
  }));

  // ------------------------------------------------------------------- doctor
  ctx.tools.register(defineTool({
    name: "seedance_doctor",
    description:
      "Diagnose the Seedance setup without spending credits: API key source, Ark /models reachability, whether the configured model is listed, ffprobe availability, reference-video staging configuration, and output directory writability.",
    parameters: {},
    output: jsonOutput,
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      try {
        return jsonSafe(await service.doctor({ cwd: sessionCwd(exec), signal: exec?.signal }));
      } catch (error) {
        throw new Error(errorText(error));
      }
    }
  }));
}

export default { name, inject, Config, apply };
