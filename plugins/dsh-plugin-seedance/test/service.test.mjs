import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, startMockArk } from "./helpers.mjs";
import { createSeedanceService } from "../lib/service.js";
import { CN_MODEL_25 } from "../lib/core.js";

const STUDIO = "/Users/yangletian/Documents/deepseek-harness/ai-video-studio";
const VIDEO = `${STUDIO}/projects/_smoke/blockout/smoke_humanoid_turntable.mp4`;
const FFPROBE = `${STUDIO}/tools/bin/ffprobe`;

async function setup() {
  const project = await mkdtemp(join(tmpdir(), "seedance-service-"));
  const keyFile = join(project, "ark.key");
  await writeFile(keyFile, "test-key-from-file\n", { mode: 0o600 });
  const mock = await startMockArk({ videoPath: VIDEO });
  const stagePort = await freePort();
  const config = {
    enabled: true,
    apiKeyEnv: "SEEDANCE_TEST_KEY_SHOULD_BE_UNSET",
    apiKeyFile: keyFile,
    baseUrl: mock.base,
    model: CN_MODEL_25,
    modelFamily: "auto",
    defaultRatio: "adaptive",
    defaultDuration: 5,
    defaultResolution: "720p",
    defaultGenerateAudio: false,
    defaultWatermark: false,
    defaultOutputFormat: "mp4",
    outputDir: "output/seedance",
    taskDir: ".seedance/tasks",
    autoDownload: true,
    pollIntervalMs: 10,
    statusTimeoutMs: 5000,
    generateTimeoutMs: 10000,
    maxImageBytes: 30 * 1024 * 1024,
    maxAudioBytes: 15 * 1024 * 1024,
    maxVideoBytes: 200 * 1024 * 1024,
    stageEnabled: true,
    stagePublicBaseUrl: `http://127.0.0.1:${stagePort}`,
    stageHost: "127.0.0.1",
    stagePort,
    stageTtlMinutes: 10,
    cloudflaredPath: "",
    tunnelTimeoutMs: 5000,
    qualityGuard: true,
    ffprobePath: FFPROBE
  };
  const service = createSeedanceService({ config, logger: { info() {}, warn() {}, debug() {}, error() {} } });
  return { project, keyFile, mock, service, config, stagePort };
}

test("preflight rejects before any public staging and before key lookup", async () => {
  const project = await mkdtemp(join(tmpdir(), "seedance-preflight-"));
  await writeFile(join(project, "blockout.mp4"), Buffer.from("fake mp4"));
  let stageCalls = 0;
  const service = createSeedanceService({
    config: {
      apiKeyEnv: "SEEDANCE_TEST_KEY_SHOULD_BE_UNSET",
      apiKeyFile: join(project, "missing.key"),
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      model: CN_MODEL_25,
      modelFamily: "auto",
      defaultRatio: "adaptive",
      defaultDuration: 5,
      defaultResolution: "720p",
      defaultGenerateAudio: false,
      defaultWatermark: false,
      defaultOutputFormat: "mp4",
      outputDir: "output/seedance",
      taskDir: ".seedance/tasks",
      autoDownload: true,
      maxImageBytes: 30 * 1024 * 1024,
      maxAudioBytes: 15 * 1024 * 1024,
      maxVideoBytes: 200 * 1024 * 1024,
      stageEnabled: true,
      stageUploadProvider: "",
      stagePublicBaseUrl: "",
      stageHost: "127.0.0.1",
      stagePort: 0,
      stageTtlMinutes: 10,
      cloudflaredPath: "",
      tunnelTimeoutMs: 5000,
      qualityGuard: true,
      ffprobePath: FFPROBE
    },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    stageFactory: () => ({
      stage: async () => {
        stageCalls += 1;
        return { url: "https://example.com/should-not-upload.mp4" };
      },
      close() {}
    })
  });
  try {
    await assert.rejects(
      () => service.generateVideo({
        cwd: project,
        args: { prompt: "参考视频", mode: "reference", reference_videos: ["blockout.mp4"] }
      }),
      /API Key/
    );
    assert.equal(stageCalls, 0, "missing key must fail before staging");
    await assert.rejects(
      () => service.generateVideo({
        cwd: project,
        args: { prompt: "混用", mode: "auto", first_frame: "blockout.mp4", reference_images: ["https://example.com/a.png"] }
      }),
      /互斥/
    );
    assert.equal(stageCalls, 0, "invalid combination must fail before staging");
  } finally {
    service.close();
  }
});

test("preview is dry, validated, and redacted", async () => {
  const ctx = await setup();
  try {
    const preview = await ctx.service.previewRequest({
      cwd: ctx.project,
      args: {
        prompt: "参考 @视频1 的运镜，角色对应 @图片1",
        mode: "reference",
        reference_images: ["https://example.com/character.png"],
        reference_videos: ["https://example.com/motion.mp4"],
        ratio: "16:9",
        duration: 5,
        whitemodel: true
      }
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.payload.omni_reference_task_type, "reference");
    assert.equal(preview.payload.content[1].role, "reference_image");
    assert.equal(preview.payload.content[2].role, "reference_video");
    assert.equal(preview.report.requestBytes > 0, true);
    assert.equal(ctx.mock.requests.length, 0);
  } finally {
    ctx.service.close();
    await ctx.mock.close();
  }
});

test("generate, wait, download, probe, doctor, and cancel", async () => {
  const ctx = await setup();
  try {
    const generated = await ctx.service.generateVideo({
      cwd: ctx.project,
      sessionId: "test-session",
      args: {
        prompt: "参考 @视频1 的运镜，角色对应 @图片1，写实电影质感",
        mode: "reference",
        reference_images: ["https://example.com/character.png"],
        reference_videos: ["https://example.com/motion.mp4"],
        ratio: "16:9",
        duration: 5,
        whitemodel: true,
        generate_audio: false
      }
    });
    assert.match(generated.taskId, /^cgt-mock-/);
    assert.equal(generated.status, "queued");
    assert.equal(generated.mode, "reference");
    assert.equal(generated.ratio, "16:9");
    assert.equal(generated.duration, 5);

    const status = await ctx.service.videoStatus({ taskId: generated.taskId, wait: true, cwd: ctx.project });
    assert.equal(status.status, "succeeded");
    assert.ok(status.localPath, "expected a downloaded localPath");
    assert.equal(status.video.ok, true);
    assert.equal(Math.round(status.video.durationSeconds), 2);
    assert.equal(status.video.width, 480);
    assert.match(status.localPath, /output\/seedance\/cgt-mock-\d+\.mp4$/);

    const doctor = await ctx.service.doctor({ cwd: ctx.project });
    assert.equal(doctor.ok, true);
    assert.ok(doctor.checks.find((check) => check.id === "api-key")?.ok);
    assert.ok(doctor.checks.find((check) => check.id === "ark-endpoint")?.ok);
    assert.ok(doctor.checks.find((check) => check.id === "ffprobe")?.ok);

    const cancelled = await ctx.service.cancelVideo({ taskId: generated.taskId, cwd: ctx.project });
    assert.equal(cancelled.status, "cancelled");
  } finally {
    ctx.service.close();
    await ctx.mock.close();
  }
});

test("local reference video is staged and the submitted payload uses the public URL", async () => {
  const ctx = await setup();
  try {
    await writeFile(join(ctx.project, "blockout.mp4"), Buffer.from("not a real mp4 but a valid staged file"));
    const staged = await ctx.service.stageReference({ path: "blockout.mp4", kind: "video", cwd: ctx.project });
    assert.match(staged.url, new RegExp(`^http://127\\.0\\.0\\.1:${ctx.stagePort}/r/`));
    const full = await fetch(staged.url);
    assert.equal(full.status, 200);
    const bytes = Buffer.from(await full.arrayBuffer());
    assert.ok(bytes.length > 0);
    const range = await fetch(staged.url, { headers: { Range: "bytes=0-7" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 0-7/${bytes.length}`);

    const generated = await ctx.service.generateVideo({
      cwd: ctx.project,
      args: {
        prompt: "参考 @视频1 的走位和运镜，白模只做骨架",
        mode: "reference",
        reference_videos: ["blockout.mp4"],
        whitemodel: true,
        ratio: "16:9",
        duration: 5
      }
    });
    assert.match(generated.taskId, /^cgt-mock-/);
    const posted = ctx.mock.requests.filter((request) => request.method === "POST").at(-1).body;
    const video = posted.content.find((item) => item.type === "video_url");
    assert.match(video.video_url.url, new RegExp(`^http://127\\.0\\.0\\.1:${ctx.stagePort}/r/`));
    assert.equal(video.role, "reference_video");
  } finally {
    ctx.service.close();
    await ctx.mock.close();
  }
});
