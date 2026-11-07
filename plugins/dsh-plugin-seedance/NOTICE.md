# NOTICE

`dsh-plugin-seedance` 0.2.0 is an independent, substantially rewritten fork of
`Malenia12/seedance-video-generator`'s `dsh-plugin-seedance` 0.1.0 (MIT).

Original project: https://github.com/Malenia12/seedance-video-generator
Original license: MIT (see `LICENSE`).

Changes in this fork:
- Added Seedance 2.5 multimodal reference-to-video support (`reference_video`,
  `reference_image`, `reference_audio`), first/last-frame mode, edit/extend,
  `omni_reference_task_type`, `generate_audio`, `output_format`,
  `return_last_frame`, and 4-30s durations.
- Corrected the model ID to the actual 2026-11-07 Seedance 2.5 SKU
  `doubao-seedance-2-5-260628` (the original 0.1.0 default
  `doubao-seedance-2-5-pro-250906` does not exist).
- Replaced the 5/10s duration clamp with the documented 4-30s/-1 range.
- Added local reference-video staging (public base URL or Cloudflare quick
  tunnel), because Ark accepts only public URLs or `asset://` for video.
- Added a dry-run payload preview, a doctor tool, request-size guards,
  real-face policy warnings, and task records with QA metadata.
- Added a testable core/client/stage split and a mock-Ark end-to-end suite.

The original `agent-role.md` prompt is not copied; the studio skill
`ai-video-pipeline` contains a stricter, source-backed workflow.
