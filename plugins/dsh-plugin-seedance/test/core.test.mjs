import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CN_MODEL_25,
  buildPayload,
  composePrompt,
  normalizeDuration,
  prepareMedia,
  redactPayload,
  resolveRatio,
  motionHint,
  modelFamily
} from "../lib/core.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");

const config = {
  model: CN_MODEL_25,
  modelFamily: "auto",
  defaultRatio: "adaptive",
  defaultDuration: 5,
  defaultResolution: "720p",
  defaultGenerateAudio: false,
  defaultWatermark: false,
  defaultOutputFormat: "mp4",
  maxImageBytes: 30 * 1024 * 1024,
  maxAudioBytes: 15 * 1024 * 1024,
  maxVideoBytes: 200 * 1024 * 1024
};

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "seedance-core-"));
  await writeFile(join(dir, "ref.png"), PNG);
  await writeFile(join(dir, "ref.mp4"), Buffer.alloc(2048, 1));
  return dir;
}

test("model family and duration validation", () => {
  assert.equal(modelFamily(CN_MODEL_25), "2.5");
  assert.equal(modelFamily("doubao-seedance-2-0-260128"), "2.0");
  assert.equal(modelFamily("ep-20260101"), "unknown");
  assert.deepEqual(normalizeDuration(5, "2.5"), { duration: 5, adjusted: false });
  assert.deepEqual(normalizeDuration(-1, "2.5"), { duration: -1, adjusted: false });
  assert.throws(() => normalizeDuration(3, "2.5"), /4-30/);
  assert.throws(() => normalizeDuration(31, "2.5"), /4-30/);
  assert.throws(() => normalizeDuration(16, "2.0"), /4-15/);
  assert.deepEqual(normalizeDuration(9, "2.5", { edit: true }), { duration: -1, adjusted: true, reason: "视频编辑任务 duration 必须为 -1" });
});

test("ratio locks force adaptive", () => {
  assert.deepEqual(resolveRatio("16:9", { locked: false }), { ratio: "16:9", adjusted: false });
  const locked = resolveRatio("16:9", { locked: true });
  assert.equal(locked.ratio, "adaptive");
  assert.equal(locked.adjusted, true);
  assert.throws(() => resolveRatio("2:1"), /ratio/);
});

test("negative and motion merge into the prompt, never into API fields", () => {
  const composed = composePrompt({
    prompt: "写实电影镜头",
    negative_prompt: "不要多指",
    motion_strength: 0.5,
    quality_guard: true
  });
  assert.match(composed.finalPrompt, /写实电影镜头/);
  assert.match(composed.finalPrompt, /不要多指/);
  assert.match(composed.finalPrompt, /镜头缓慢平稳运动/);
  assert.equal(composed.motion.label, "slow-camera");
  assert.throws(() => motionHint(0.9), /0.8/);
});

test("text payload has no media and no omni field", async () => {
  const cwd = await workspace();
  const media = await prepareMedia({ reference_images: [], reference_videos: [], reference_audios: [] }, { cwd, config });
  const { payload, report } = buildPayload({
    args: { prompt: "一只猫在窗边", ratio: "16:9", duration: 5, generate_audio: false },
    media,
    config
  });
  assert.equal(payload.model, CN_MODEL_25);
  assert.equal(payload.content.length, 1);
  assert.equal(payload.content[0].type, "text");
  assert.equal(payload.ratio, "16:9");
  assert.equal(payload.duration, 5);
  assert.equal(payload.omni_reference_task_type, undefined);
  assert.equal(report.mode, "text");
});

test("reference payload carries image/video/audio roles and explicit reference type", async () => {
  const cwd = await workspace();
  const media = await prepareMedia({
    reference_images: ["https://example.com/a.png"],
    reference_videos: ["https://example.com/b.mp4"],
    reference_audios: ["https://example.com/c.mp3"]
  }, { cwd, config });
  const { payload, report } = buildPayload({
    args: {
      prompt: "参考 @视频1 的运镜，角色对应 @图片1，声音参考 @音频1",
      mode: "reference",
      ratio: "16:9",
      duration: 8,
      omni_reference_task_type: "reference"
    },
    media,
    config
  });
  assert.equal(report.mode, "reference");
  assert.equal(payload.omni_reference_task_type, "reference");
  assert.deepEqual(payload.content.map((item) => item.role), [undefined, "reference_image", "reference_video", "reference_audio"]);
  assert.equal(payload.duration, 8);
});

test("first/last frame forces adaptive and cannot mix with reference media", async () => {
  const cwd = await workspace();
  const media = await prepareMedia({
    first_frame: join(cwd, "ref.png"),
    last_frame: join(cwd, "ref.png")
  }, { cwd, config });
  const { payload, report } = buildPayload({
    args: { prompt: "从首帧走到尾帧", ratio: "16:9", duration: 5, first_frame: "ignored", last_frame: "ignored" },
    media,
    config
  });
  assert.equal(payload.ratio, "adaptive");
  assert.equal(payload.content.filter((item) => item.role === "first_frame").length, 1);
  assert.equal(payload.content.filter((item) => item.role === "last_frame").length, 1);
  assert.equal(report.mode, "first_last_frame");
  const mixed = await prepareMedia({ first_frame: join(cwd, "ref.png"), reference_images: ["https://example.com/a.png"] }, { cwd, config });
  assert.throws(() => buildPayload({ args: { prompt: "x" }, media: mixed, config }), /互斥/);
});

test("first/last-frame cannot be combined with omni task type", async () => {
  const cwd = await workspace();
  const media = await prepareMedia({ first_frame: join(cwd, "ref.png") }, { cwd, config });
  assert.throws(() => buildPayload({
    args: { prompt: "首帧", first_frame: "ignored", mode: "first_last_frame", omni_reference_task_type: "auto" },
    media,
    config
  }), /互斥/);
});

test("edit forces adaptive + duration=-1 and requires a reference video", async () => {
  const cwd = await workspace();
  const media = await prepareMedia({ reference_videos: ["https://example.com/source.mp4"] }, { cwd, config });
  const { payload } = buildPayload({
    args: { prompt: "把 @视频1 中的天空改成黄昏", mode: "edit", ratio: "16:9", duration: 9 },
    media,
    config
  });
  assert.equal(payload.ratio, "adaptive");
  assert.equal(payload.duration, -1);
  assert.equal(payload.omni_reference_task_type, "edit");
  const empty = await prepareMedia({}, { cwd, config });
  assert.throws(() => buildPayload({ args: { prompt: "编辑视频", mode: "edit" }, media: empty, config }), /reference_video/);
});

test("local image becomes data URI; local video requires staging; staged URL is used", async () => {
  const cwd = await workspace();
  const media = await prepareMedia({ reference_images: ["ref.png"] }, { cwd, config });
  const { payload } = buildPayload({ args: { prompt: "参考图", mode: "reference" }, media, config });
  assert.match(payload.content[1].image_url.url, /^data:image\/png;base64,/);

  const noStage = await prepareMedia({ reference_videos: ["ref.mp4"] }, { cwd, config }).then(
    () => undefined,
    (error) => error
  );
  assert.ok(noStage instanceof Error, "local video without a staging hook must fail");
  assert.match(noStage.message, /staging|公网|seedance_stage_reference/);

  const staged = await prepareMedia({ reference_videos: ["ref.mp4"] }, {
    cwd,
    config,
    stageVideo: async () => "https://example.com/staged.mp4"
  });
  const built = buildPayload({ args: { prompt: "参考视频", mode: "reference" }, media: staged, config });
  assert.equal(built.payload.content[1].video_url.url, "https://example.com/staged.mp4");
});

test("counts and request-size guards", async () => {
  const cwd = await workspace();
  const tooMany = await prepareMedia({
    reference_images: Array.from({ length: 31 }, (_, index) => `https://example.com/${index}.png`)
  }, { cwd, config });
  assert.throws(() => buildPayload({ args: { prompt: "x", mode: "reference" }, media: tooMany, config }), /最多 30/);
});

test("redaction hides base64 but keeps structure", async () => {
  const cwd = await workspace();
  const media = await prepareMedia({ reference_images: ["ref.png"] }, { cwd, config });
  const { payload } = buildPayload({ args: { prompt: "参考图", mode: "reference" }, media, config });
  const redacted = redactPayload(payload);
  assert.match(redacted.content[1].image_url.url, /^data:image\/png;base64,<\d+ bytes>$/);
});
