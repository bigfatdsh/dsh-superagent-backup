# -*- coding: utf-8 -*-
"""对**已有**的 .blend 做材质代理渲染（不改工程、不改建模脚本）。

用法（由 proxy-render.mjs 调用）：
    blender -b scene.blend --python proxy_render.py -- <plan.json>

plan.json:
{
  "out_dir": "/abs/out",
  "style": "proxy",
  "camera": "shot_03_cam",
  "frames": [1, 120],
  "fps": 24,
  "resolution": [1280, 720]
}

产物：<out_dir>/frames/frame_0001.png …，以及 <out_dir>/proxy-result.json
"""
import json
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import proxy_style  # noqa: E402


def read_plan():
    if "--" not in sys.argv:
        raise SystemExit("proxy_render.py 需要 -- <plan.json>")
    return json.load(open(sys.argv[sys.argv.index("--") + 1], "r", encoding="utf-8"))


def main():
    plan = read_plan()
    scene = bpy.context.scene
    out_dir = os.path.abspath(plan["out_dir"])
    frames_dir = os.path.join(out_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    for name in os.listdir(frames_dir):
        if name.lower().endswith(".png"):
            os.remove(os.path.join(frames_dir, name))

    camera_name = plan.get("camera")
    if camera_name:
        camera = bpy.data.objects.get(camera_name)
        if camera is None:
            cameras = [obj.name for obj in bpy.data.objects if obj.type == "CAMERA"]
            raise SystemExit(f"找不到相机 {camera_name}；场景里有：{cameras}")
        scene.camera = camera
    if scene.camera is None:
        raise SystemExit("场景没有相机")

    resolution = plan.get("resolution")
    if resolution:
        scene.render.resolution_x = int(resolution[0])
        scene.render.resolution_y = int(resolution[1])
    scene.render.resolution_percentage = 100
    scene.render.fps = int(plan.get("fps", scene.render.fps or 24))
    scene.render.fps_base = 1.0
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.compression = 15
    scene.render.filepath = os.path.join(frames_dir, "frame_")

    start, end = plan.get("frames", [scene.frame_start, scene.frame_end])
    scene.frame_start = int(start)
    scene.frame_end = int(end)

    info = proxy_style.apply(
        scene,
        style=plan.get("style", "proxy"),
        mapping=plan.get("mapping") or None,
        hide_fx=plan.get("hide_fx", True),
    )

    bpy.ops.render.render(animation=True)

    frames = sorted(name for name in os.listdir(frames_dir) if name.lower().endswith(".png"))
    result = {
        "ok": len(frames) > 0,
        "style": info["style"],
        "materials": info["materials"],
        "fx_hidden": info.get("fx_hidden"),
        "camera": scene.camera.name,
        "frames": len(frames),
        "frames_dir": frames_dir,
        "resolution": [scene.render.resolution_x, scene.render.resolution_y],
        "fps": scene.render.fps,
        "first": frames[0] if frames else None,
        "last": frames[-1] if frames else None,
    }
    with open(os.path.join(out_dir, "proxy-result.json"), "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    print("PROXY_RESULT " + json.dumps(result, ensure_ascii=False))


main()
