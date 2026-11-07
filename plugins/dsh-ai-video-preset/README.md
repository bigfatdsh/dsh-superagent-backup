# AI Video Studio preset bundle

This bundle declares the **AI 视频导演** agent preset and overrides the
`tool-seedance` row to point at the studio's `tools/bin/ffprobe` and a
zero-config staging fallback.

## What it declares

- Agent preset `ai-video`:
  - persona: director + technical director, with the pipeline hard rules
  - `agent-instructions` (reads the workspace `AGENTS.md`)
  - `skill-filesystem` with `customSkillDirs` → studio `.dsh/skills`
  - bash / fs / fs-search / jobs / web / todo / ask / present
  - subagent + workflow delegation
  - compaction + tool-result pruner
- `tool-seedance` override:
  - model `doubao-seedance-2-5-260628`
  - key file `~/.dsh/secrets/ark-api-key`
  - `ffprobePath` → `tools/bin/ffprobe`
  - `stageUploadProvider: uguu` (temporary public hosting for non-sensitive
    blockout MP4s; change to `stagePublicBaseUrl`/TOS for production)

## Install

Installed through the DSH Plugin Manager as a profile bundle:

```
/Users/yangletian/Documents/deepseek-harness/ai-video-studio/engine/dsh-ai-video-preset
```

or via the `plugin_manager` tool with `action: install_bundle` and that
absolute path.

## Use

1. Open the studio as a workspace:
   `/Users/yangletian/Documents/deepseek-harness/ai-video-studio`
2. New session → choose **AI 视频导演**.
3. Ask for a shot. The preset loads the `ai-video-pipeline` skill and the
   hard rules automatically.

## Change staging

Edit `cordis.patch.yml`’s `tool-seedance` row:

- Production: set `stagePublicBaseUrl: "https://your-tunnel.example"` and
  `stageUploadProvider: ""`.
- TOS/object storage: leave staging empty and pass public URLs to
  `reference_videos`.
- Sensitive assets: never use `uguu`; use TOS/your reverse proxy/`asset://`.

Reinstall the bundle after edits (Plugin Manager) so the profile layer is
recomposed.

## Uninstall

Remove the bundle in Plugin Manager. The Seedance plugin and Blender plugin are
separate bundles; remove them independently if needed.
