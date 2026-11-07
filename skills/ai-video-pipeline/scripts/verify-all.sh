#!/usr/bin/env bash
# Fast, no-API-key verification of the AI Video Studio.
#
#   bash .dsh/skills/ai-video-pipeline/scripts/verify-all.sh
#   bash .dsh/skills/ai-video-pipeline/scripts/verify-all.sh --render
#
# --render re-renders projects/demo/shot_01.json (about 20s).

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUDIO="$(cd "$HERE/../../../.." && pwd)"
cd "$STUDIO"

echo "== studio: $STUDIO"
echo "== 1/7 environment"
node .dsh/skills/ai-video-pipeline/scripts/doctor.mjs >/tmp/aivideo-doctor.json
node -e 'const j=require("/tmp/aivideo-doctor.json"); if(!j.ok) { console.error(j.checks); process.exit(1); } console.log("doctor ok")'

echo "== 2/7 seedance plugin tests"
(cd engine/dsh-plugin-seedance && node --test --test-timeout=30000 test/*.test.mjs | tail -4)

echo "== 3/7 shotlist validation"
node .dsh/skills/ai-video-pipeline/scripts/validate-shotlist.mjs \
  --file projects/demo/shotlist.json --root projects/demo >/tmp/aivideo-shotlist.json
node -e 'const j=require("/tmp/aivideo-shotlist.json"); if(!j.ok) { console.error(j.errors); process.exit(1); } console.log("shotlist ok ("+j.warnings.length+" warnings)")'

echo "== 4/7 prompt composition (legacy draft)"
node .dsh/skills/ai-video-pipeline/scripts/build-prompt.mjs \
  --file projects/demo/shotlist.json --shot shot_01 >/tmp/aivideo-prompt.json
node -e 'const j=require("/tmp/aivideo-prompt.json"); if(!j.ok || !j.prompt) process.exit(1); console.log("prompt ok ("+j.prompt.length+" chars)")'

echo "== 5/7 consistency toolchain selftest (contract / prep-shot / qa-consistency)"
node .dsh/skills/ai-video-pipeline/scripts/selftest.mjs >/tmp/aivideo-selftest.json
node -e 'const j=require("/tmp/aivideo-selftest.json"); if(!j.ok) { console.error(j.failed); process.exit(1); } console.log("selftest ok ("+j.checks+" checks)")'

if [ "${1:-}" = "--render" ]; then
  echo "== 6/7 render demo white model"
  node .dsh/skills/ai-video-pipeline/scripts/render-shot.mjs \
    --spec projects/demo/shot_01.json --out projects/demo/renders/shot_01 >/tmp/aivideo-render.json
  node -e 'const j=require("/tmp/aivideo-render.json"); console.log("render ok", j.durationSeconds+"s", j.resolution.join("x"), j.frameCount+"f")'
else
  echo "== 6/7 render skipped (pass --render to re-render)"
fi

echo "== 7/7 video QA"
node .dsh/skills/ai-video-pipeline/scripts/qa-video.mjs \
  --video projects/demo/renders/shot_01/shot_01.mp4 \
  --expect-duration 5 --expect-resolution 1280x720 --expect-fps 24 --strict >/tmp/aivideo-qa.json
node -e 'const j=require("/tmp/aivideo-qa.json"); console.log("qa ok", j.durationSeconds+"s", j.width+"x"+j.height, j.fps+"fps", j.frames+"f")'

echo "ALL OK"
