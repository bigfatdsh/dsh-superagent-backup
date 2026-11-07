# dsh-plugin-seedance 0.2.0

Seedance 2.5 (Volcengine Ark / BytePlus ModelArk) video tools for DeepSeek Harness.

This is a substantially rewritten fork of
[`Malenia12/seedance-video-generator`](https://github.com/Malenia12/seedance-video-generator)'s
`dsh-plugin-seedance` 0.1.0 (MIT). See `NOTICE.md`.

## What it adds

The upstream 0.1.0 supported text-to-video and first/last-frame with a 5/10s
duration clamp and an outdated model default. This fork targets the real
Seedance 2.5 API:

- **Multimodal reference-to-video**: up to 30 images, 10 videos, 10 audios
  (50 assets total); `reference_video`, `reference_image`, `reference_audio`.
- **First/last-frame** with the mandatory `ratio: "adaptive"`.
- **Edit / extend** with `omni_reference_task_type` and its locked parameters.
- **4-30s or `-1`** durations; `generate_audio`; `output_format: mp4|mov`;
  `return_last_frame`; `draft`; `priority`; `callback_url`.
- **Dry-run preview** (`seedance_preview_request`) that returns the exact Ark
  payload with base64 redacted, without spending credits.
- **Local reference-video staging** (`seedance_stage_reference`) because Ark
  accepts only public URLs or `asset://` for video, never base64 video.
- **Task persistence** under `.seedance/tasks/`, auto-download under
  `output/seedance/`, and ffprobe QA metadata.
- **Honest aliases**: `negative_prompt` is merged into the positive prompt;
  `motion_strength` only adds a motion clause. Neither is sent as an API field.

## The model ID

As of 2026-11-07 the only Seedance 2.5 SKU is:

| Region | Model ID |
|---|---|
| CN (Volcengine Ark) | `doubao-seedance-2-5-260628` |
| International (BytePlus) | `dreamina-seedance-2-5-260628` |

`doubao-seedance-2-5-pro-250906` and `...-flash-250906` do **not** exist.
If your console gives you an `ep-...` endpoint ID, pass it as `model` and set
`modelFamily: "2.5"` so duration/output validation uses 2.5 rules.

## API key

The key is read from `ARK_API_KEY` first, then from `apiKeyFile`
(default `~/.dsh/secrets/ark-api-key`). A key file avoids restarting DSH:

```bash
mkdir -p ~/.dsh/secrets
install -m 600 /dev/null ~/.dsh/secrets/ark-api-key
# paste the key as a single line
```

`apiKeyFile` may also contain `ARK_API_KEY=...`.

## Reference videos need a public URL

Ark's `video_url` accepts a public http(s) URL or `asset://<ID>`, not base64.
For local Blender MP4s, either:

1. Set `stagePublicBaseUrl` to a public reverse proxy/tunnel that points at the
   plugin's staging port (default `127.0.0.1:8797`).
2. Set `cloudflaredPath` to a `cloudflared` binary; the plugin starts a
   Cloudflare quick tunnel on demand.
3. Set `stageUploadProvider: "uguu"` for a zero-config temporary public host
   (~3 hours). Only use this for non-sensitive blockout MP4s.
4. Upload the MP4 to TOS/object storage and pass the public URL directly.

`seedance_stage_reference` serves only explicitly staged files, with
unguessable tokens and an expiry (local server/tunnel modes); the uguu mode
uploads the file to a temporary public host and returns its URL.

## Real-person policy

Seedance 2.5/2.0 **reject direct reference images or videos containing real
human faces**. Use AI-generated virtual humans, preset digital humans, or
authorized `asset://` media. Stylized/3D/illustrated characters are unaffected.
The tool adds a warning whenever reference media is present; the studio skill
turns this into a hard gate.

## Tools

| Tool | Purpose |
|---|---|
| `seedance_preview_request` | Validate + show the exact payload; no API key, no credits |
| `seedance_generate_video` | Submit a task; returns `taskId` immediately |
| `seedance_video_status` | Poll/wait, download, probe; omit `taskId` to list |
| `seedance_video_cancel` | Cancel a queued task (Ark only guarantees queued) |
| `seedance_stage_reference` | Turn a local file into a public URL |
| `seedance_doctor` | Check key, Ark endpoint, model, ffprobe, staging, output dir |

## Example (white-model reference)

```js
// 1) Stage the Blender MP4
const staged = await seedance_stage_reference({ path: "renders/shot_01/shot_01.mp4" });

// 2) Preview the payload
await seedance_preview_request({
  prompt: "参考 @视频1 的运镜、走位、景别与节奏。将 @视频1 中的白色人偶映射为 @图片1 的角色；场景参考 @图片2。写实电影质感。",
  mode: "reference",
  reference_videos: [staged.url],
  reference_images: ["refs/character.png", "refs/scene.png"],
  omni_reference_task_type: "reference",
  whitemodel: true,
  ratio: "16:9",
  duration: 5,
  generate_audio: false
});

// 3) Submit and wait
const task = await seedance_generate_video({ /* same args */ });
const result = await seedance_video_status({ taskId: task.taskId, wait: true });
```

## Tests

```bash
node --test test/*.test.mjs
```

The suite covers validation, prompt merging, media roles, ratio/duration locks,
staging with range requests, mock-Ark submit/poll/download, ffprobe, doctor, and
cancel. No real API key or credits are used.

Live verification in DSH: `seedance_preview_request` returns the expected
payload, `seedance_stage_reference` produces a public uguu URL, and
`seedance_doctor` reports key + Ark + ffprobe + staging green. A real
4s/480p/draft reference task (`cgt-20261107220433-l2b7a`) submitted, succeeded,
downloaded, and passed ffprobe QA.

## Install

Installed as a profile bundle (local package directory):

```
/Users/yangletian/Documents/deepseek-harness/ai-video-studio/engine/dsh-plugin-seedance
```

The row id is `tool-seedance`. Override its config from a later bundle layer
(see `engine/dsh-ai-video-preset/cordis.patch.yml`).
