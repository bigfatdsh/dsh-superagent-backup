# -*- coding: utf-8 -*-
"""机位扫描：对同一场白模渲多套候选机位/焦段，并把关键物体的**投影位置**算出来。

用法（由 shot-scan.mjs 调用，不单独使用）：

    blender -b scene.blend --python scan_cameras.py -- <plan.json> <out_dir>

plan.json:
{
  "resolution": [640, 360],
  "times": [0, 4.5],
  "probes": [{"object": "paper", "at": [0.68, 0.37], "size": 0.12}],
  "variants": [{"id": "s1o", "lens_mm": 65, "from_mm": [-1500,-1500,1920], "look_mm": [600,0,1560]}]
}

输出：<out_dir>/scan-result.json
      每个候选 × 每个时间点一张 PNG，外加探针的归一化坐标（左上原点）。
评分交给 shot-scan.mjs，这里只负责"渲得准、算得准"。

相机口径与 shot_builder.py / build_range_blockout.py 保持一致：
mm 单位、sensor_width=36、TRACK_TO 指向 look 点、Workbench FLAT + MATERIAL、纯白背景、无 overlays。
"""
import json
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


def log(message):
    print(f"SCAN {message}")


def mm(value):
    return float(value) * 0.001


def read_argv():
    if "--" not in sys.argv:
        raise SystemExit("scan_cameras.py 需要 -- <plan.json> <out_dir>")
    tail = sys.argv[sys.argv.index("--") + 1:]
    if len(tail) < 2:
        raise SystemExit("用法: -- <plan.json> <out_dir>")
    return tail[0], tail[1]


def lerp(a, b, t):
    return [a[i] + (b[i] - a[i]) * t for i in range(3)]


def sample_variant(variant, time_seconds):
    """候选机位在某一时刻的 (from, look)。支持静态 from/look 或 keys 关键帧。"""
    keys = variant.get("keys")
    if not keys:
        return list(variant["from_mm"]), list(variant["look_mm"])
    ordered = sorted(keys, key=lambda k: float(k.get("t", 0)))
    if time_seconds <= float(ordered[0].get("t", 0)):
        return list(ordered[0]["from"]), list(ordered[0]["look"])
    if time_seconds >= float(ordered[-1].get("t", 0)):
        return list(ordered[-1]["from"]), list(ordered[-1]["look"])
    for index in range(1, len(ordered)):
        left, right = ordered[index - 1], ordered[index]
        t0, t1 = float(left.get("t", 0)), float(right.get("t", 0))
        if t0 <= time_seconds <= t1:
            ratio = 0.0 if t1 <= t0 else (time_seconds - t0) / (t1 - t0)
            return lerp(left["from"], right["from"], ratio), lerp(left["look"], right["look"], ratio)
    return list(ordered[-1]["from"]), list(ordered[-1]["look"])


def configure_render(scene, plan):
    resolution = plan.get("resolution") or [640, 360]
    render = scene.render
    render.engine = "BLENDER_WORKBENCH"
    render.resolution_x = int(resolution[0])
    render.resolution_y = int(resolution[1])
    render.resolution_percentage = 100
    render.film_transparent = False
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGB"
    render.image_settings.compression = 15
    shading = scene.display.shading
    shading.light = "FLAT"
    shading.color_type = "MATERIAL"
    shading.single_color = (0.62, 0.62, 0.62)
    shading.show_shadows = False
    shading.show_cavity = False
    shading.show_object_outline = False
    try:
        shading.background_type = "VIEWPORT"
        shading.background_color = (1.0, 1.0, 1.0)
    except AttributeError:
        pass
    if scene.world is not None:
        scene.world.use_nodes = False
        scene.world.color = (1.0, 1.0, 1.0)


def make_camera(scene, variant):
    name = f"SCAN-{variant['id']}"
    data = bpy.data.cameras.new(name)
    data.lens = float(variant.get("lens_mm", 50))
    data.sensor_width = 36.0
    data.sensor_fit = "HORIZONTAL"
    camera = bpy.data.objects.new(name, data)
    scene.collection.objects.link(camera)
    aim = bpy.data.objects.new(f"{name}-aim", None)
    aim.empty_display_type = "PLAIN_AXES"
    aim.empty_display_size = 0.05
    scene.collection.objects.link(aim)
    constraint = camera.constraints.new(type="TRACK_TO")
    constraint.target = aim
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"
    return camera, aim


def project_probe(scene, camera, obj):
    """物体包围盒 → 归一化屏幕矩形（左上原点）。"""
    try:
        corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    except Exception:
        return None
    projected = []
    for corner in corners:
        view = world_to_camera_view(scene, camera, corner)
        if view.z <= 0.001:
            return {"visible": False, "reason": "behind-camera"}
        projected.append(view)
    xs = [point.x for point in projected]
    ys = [1.0 - point.y for point in projected]  # Blender 原点在左下，契约用左上
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    center_x = (max(xs) + min(xs)) / 2.0
    center_y = (max(ys) + min(ys)) / 2.0
    return {
        "visible": True,
        "x": round(center_x, 4),
        "y": round(center_y, 4),
        "width": round(width, 4),
        "height": round(height, 4),
        "size": round(max(width, height), 4),
        "inFrame": 0.0 <= center_x <= 1.0 and 0.0 <= center_y <= 1.0,
    }


def main():
    plan_path, out_dir = read_argv()
    with open(plan_path, "r", encoding="utf-8") as handle:
        plan = json.load(handle)
    os.makedirs(out_dir, exist_ok=True)

    scene = bpy.context.scene
    configure_render(scene, plan)
    fps = float(plan.get("fps") or scene.render.fps or 24)
    times = [float(value) for value in (plan.get("times") or [0])]
    probes = plan.get("probes") or []
    variants = plan.get("variants") or []
    if not variants:
        raise SystemExit("plan.variants 为空")

    missing = [probe["object"] for probe in probes if bpy.data.objects.get(probe["object"]) is None]
    log(f"variants={len(variants)} times={times} probes={len(probes)} missing={missing}")

    # 评估后的几何复杂度：参考视频会把拓扑复杂度一并传给视频模型
    depsgraph = bpy.context.evaluated_depsgraph_get()
    polygons = 0
    top = []
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        try:
            evaluated = obj.evaluated_get(depsgraph)
            mesh = evaluated.to_mesh()
            count = len(mesh.polygons)
            evaluated.to_mesh_clear()
        except Exception:
            count = len(obj.data.polygons)
        polygons += count
        top.append((count, obj.name, [modifier.type for modifier in obj.modifiers]))
    top.sort(reverse=True)

    results = []
    for index, variant in enumerate(variants):
        camera, aim = make_camera(scene, variant)
        scene.camera = camera
        frames = []
        for time_seconds in times:
            source, target = sample_variant(variant, time_seconds)
            camera.location = (mm(source[0]), mm(source[1]), mm(source[2]))
            aim.location = (mm(target[0]), mm(target[1]), mm(target[2]))
            frame = max(1, int(round(time_seconds * fps)) + 1)
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            filename = f"{variant['id']}__t{time_seconds:g}.png"
            scene.render.filepath = os.path.join(out_dir, filename)
            bpy.ops.render.render(write_still=True)
            measured = []
            for probe in probes:
                obj = bpy.data.objects.get(probe["object"])
                if obj is None:
                    measured.append({"object": probe["object"], "missing": True})
                    continue
                value = project_probe(scene, camera, obj)
                entry = {"object": probe["object"]}
                entry.update(value or {"visible": False})
                measured.append(entry)
            frames.append({"t": time_seconds, "frame": frame, "file": filename, "probes": measured})
        results.append({
            "id": variant["id"],
            "lens_mm": float(variant.get("lens_mm", 50)),
            "index": index,
            "frames": frames,
        })
        scene.camera = None

    payload = {
        "ok": True,
        "blender": bpy.app.version_string,
        "scene_camera": None,
        "resolution": [scene.render.resolution_x, scene.render.resolution_y],
        "times": times,
        "missing_probes": missing,
        "geometry": {
            "polygons": polygons,
            "objects": len([obj for obj in bpy.data.objects if obj.type == "MESH"]),
            "top": [{"name": name, "polygons": count, "modifiers": mods} for count, name, mods in top[:10]],
        },
        "variants": results,
    }
    with open(os.path.join(out_dir, "scan-result.json"), "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    log(f"done: {len(results)} variants -> {out_dir}/scan-result.json")


main()
