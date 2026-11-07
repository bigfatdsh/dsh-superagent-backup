#!/usr/bin/env python3
"""Build and render a deterministic white-model shot in Blender.

Run with:
  blender -b --factory-startup --python shot_builder.py -- \
      --spec projects/demo/shot.json --out projects/demo/renders/shot_01

The script builds a coarse humanoid from primitives, optionally walks it along
a straight line, keyframes a camera path, renders clean Workbench PNG frames
(no grid/axes/camera cone/trajectory overlays), saves a .blend, and writes
shot_meta.json. MP4 encoding is done by the Node wrapper with ffmpeg.
"""

import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector


def mm(value):
    return float(value) / 1000.0


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)
    return path


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = "METERS"
    return scene


def make_material(name="BO_White", value=0.62):
    material = bpy.data.materials.get(name)
    if material is not None:
        return material
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (value, value, value, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.72
        bsdf.inputs["Metallic"].default_value = 0.0
    material.diffuse_color = (value, value, value, 1.0)
    return material


def link_object(obj, collection, material):
    for coll in list(obj.users_collection):
        coll.objects.unlink(obj)
    collection.objects.link(obj)
    obj.data.materials.clear()
    obj.data.materials.append(material)
    obj.color = (0.62, 0.62, 0.62, 1.0)
    return obj


def add_box(name, size_mm, at_mm, collection, material, rot_deg=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(mm(at_mm[0]), mm(at_mm[1]), mm(at_mm[2])))
    obj = bpy.context.object
    obj.name = name
    obj.scale = (mm(size_mm[0]), mm(size_mm[1]), mm(size_mm[2]))
    obj.rotation_euler = tuple(math.radians(value) for value in rot_deg)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return link_object(obj, collection, material)


def add_cylinder(name, radius_mm, depth_mm, at_mm, collection, material, axis="z", rot_deg=(0, 0, 0)):
    rotation = tuple(math.radians(value) for value in rot_deg)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=20,
        radius=mm(radius_mm),
        depth=mm(depth_mm),
        location=(mm(at_mm[0]), mm(at_mm[1]), mm(at_mm[2])),
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    if axis == "x":
        obj.rotation_euler[1] = math.radians(90)
    elif axis == "y":
        obj.rotation_euler[0] = math.radians(90)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return link_object(obj, collection, material)


def add_sphere(name, radius_mm, at_mm, collection, material):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=24,
        ring_count=12,
        radius=mm(radius_mm),
        location=(mm(at_mm[0]), mm(at_mm[1]), mm(at_mm[2])),
    )
    obj = bpy.context.object
    obj.name = name
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return link_object(obj, collection, material)


def add_empty(name, at_mm, collection, parent=None):
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = "PLAIN_AXES"
    empty.empty_display_size = 0.08
    empty.location = (mm(at_mm[0]), mm(at_mm[1]), mm(at_mm[2]))
    collection.objects.link(empty)
    if parent is not None:
        keep_world_parent(empty, parent)
    return empty


def keep_world_parent(obj, parent):
    world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_parent_inverse = parent.matrix_world.inverted()
    obj.matrix_world = world


def add_segment(name, parent, world_head, length_mm, radius_mm, collection, material, kind="box", depth_mm=None):
    """Create a limb segment hanging down from world_head and parent it there."""
    head = Vector((mm(world_head[0]), mm(world_head[1]), mm(world_head[2])))
    center = head + Vector((0.0, 0.0, -mm(length_mm) / 2.0))
    if kind == "cylinder":
        object_ = add_cylinder(name, radius_mm, length_mm, (center.x * 1000, center.y * 1000, center.z * 1000), collection, material)
    else:
        width = radius_mm * 2.0
        object_ = add_box(name, (depth_mm or width, width, length_mm), (center.x * 1000, center.y * 1000, center.z * 1000), collection, material)
    keep_world_parent(object_, parent)
    return object_


def build_set(scene, spec, collection, material):
    set_spec = spec.get("set") or {}
    if set_spec.get("floor", True):
        add_box("SET-floor", (8000, 8000, 100), (0, 0, -50), collection, material)
    for index, wall in enumerate(set_spec.get("walls") or []):
        add_box(
            f"SET-wall-{wall.get('id', index)}",
            wall.get("size_mm", (8000, 100, 3000)),
            wall.get("at_mm", (0, 3000, 1500)),
            collection,
            material,
        )
    for index, prop in enumerate(set_spec.get("props") or []):
        name = f"SET-prop-{prop.get('id', index)}"
        prim = prop.get("prim", "box")
        at = prop.get("at_mm", (0, 0, 0))
        if prim == "cylinder":
            add_cylinder(name, prop.get("radius_mm", 300), prop.get("depth_mm", 600), at, collection, material, axis=prop.get("axis", "z"), rot_deg=prop.get("rot_deg", (0, 0, 0)))
        elif prim == "sphere":
            add_sphere(name, prop.get("radius_mm", 300), at, collection, material)
        else:
            add_box(name, prop.get("size_mm", (600, 600, 600)), at, collection, material, prop.get("rot_deg", (0, 0, 0)))


def build_actor(scene, spec, collection, material):
    actor_spec = spec.get("actor") or {}
    if actor_spec.get("enabled", True) is False:
        return None

    height_mm = float(actor_spec.get("height_mm", 1750))
    start = actor_spec.get("start_mm", [-1500, 0, 0])
    end = actor_spec.get("end_mm", [1500, 0, 0])
    facing_deg = float(actor_spec.get("facing_deg", 0))
    walk = bool(actor_spec.get("walk", True))
    hands = bool(actor_spec.get("hands", True))

    root = bpy.data.objects.new("ACTOR-root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.2
    root.location = (0.0, 0.0, 0.0)
    root.rotation_mode = "XYZ"
    root.rotation_euler[2] = 0.0
    collection.objects.link(root)

    # Proportions in mm.
    head_r = 0.060 * height_mm
    head_z = 0.930 * height_mm
    neck_r = 0.026 * height_mm
    neck_len = 0.055 * height_mm
    neck_z = 0.855 * height_mm
    torso_h = 0.300 * height_mm
    torso_w = 0.220 * height_mm
    torso_d = 0.140 * height_mm
    torso_z = 0.670 * height_mm
    pelvis_h = 0.120 * height_mm
    pelvis_w = 0.180 * height_mm
    pelvis_d = 0.140 * height_mm
    pelvis_z = 0.510 * height_mm
    shoulder_y = 0.158 * height_mm
    shoulder_z = 0.805 * height_mm
    hip_y = 0.060 * height_mm
    hip_z = 0.500 * height_mm
    upper_arm = 0.200 * height_mm
    lower_arm = 0.180 * height_mm
    arm_r = 0.026 * height_mm
    thigh = 0.245 * height_mm
    shin = 0.235 * height_mm
    leg_r = 0.038 * height_mm
    foot_h = 0.040 * height_mm
    foot_len = 0.120 * height_mm
    hand_r = 0.030 * height_mm

    parts = []
    parts.append(add_sphere("ACTOR-head", head_r, (0, 0, head_z), collection, material))
    parts.append(add_cylinder("ACTOR-neck", neck_r, neck_len, (0, 0, neck_z), collection, material))
    parts.append(add_box("ACTOR-torso", (torso_d, torso_w, torso_h), (0, 0, torso_z), collection, material))
    parts.append(add_box("ACTOR-pelvis", (pelvis_d, pelvis_w, pelvis_h), (0, 0, pelvis_z), collection, material))
    for part in parts:
        keep_world_parent(part, root)

    joints = {}
    for side, sign in (("L", 1.0), ("R", -1.0)):
        shoulder = add_empty(
            f"ACTOR-shoulder-{side}",
            (0.0, sign * shoulder_y, shoulder_z),
            collection,
            parent=root,
        )
        joints[f"shoulder_{side}"] = shoulder
        shoulder_joint = add_sphere(f"ACTOR-shoulderjoint-{side}", 0.032 * height_mm, (0.0, sign * shoulder_y, shoulder_z), collection, material)
        keep_world_parent(shoulder_joint, root)
        add_segment(f"ACTOR-upperarm-{side}", shoulder, (0.0, sign * shoulder_y, shoulder_z), upper_arm, arm_r, collection, material, kind="cylinder")
        elbow = add_empty(
            f"ACTOR-elbow-{side}",
            (0.0, sign * shoulder_y, shoulder_z - upper_arm),
            collection,
            parent=shoulder,
        )
        joints[f"elbow_{side}"] = elbow
        elbow_joint = add_sphere(f"ACTOR-elbowjoint-{side}", 0.028 * height_mm, (0.0, sign * shoulder_y, shoulder_z - upper_arm), collection, material)
        keep_world_parent(elbow_joint, shoulder)
        add_segment(f"ACTOR-lowerarm-{side}", elbow, (0.0, sign * shoulder_y, shoulder_z - upper_arm), lower_arm, arm_r * 0.9, collection, material, kind="cylinder")
        if hands:
            hand = add_sphere(
                f"ACTOR-hand-{side}",
                hand_r,
                (0.0, sign * shoulder_y, shoulder_z - upper_arm - lower_arm - hand_r),
                collection,
                material,
            )
            keep_world_parent(hand, elbow)

        hip = add_empty(
            f"ACTOR-hip-{side}",
            (0.0, sign * hip_y, hip_z),
            collection,
            parent=root,
        )
        joints[f"hip_{side}"] = hip
        hip_joint = add_sphere(f"ACTOR-hipjoint-{side}", 0.040 * height_mm, (0.0, sign * hip_y, hip_z), collection, material)
        keep_world_parent(hip_joint, root)
        add_segment(f"ACTOR-thigh-{side}", hip, (0.0, sign * hip_y, hip_z), thigh, leg_r, collection, material, kind="cylinder")
        knee = add_empty(
            f"ACTOR-knee-{side}",
            (0.0, sign * hip_y, hip_z - thigh),
            collection,
            parent=hip,
        )
        joints[f"knee_{side}"] = knee
        knee_joint = add_sphere(f"ACTOR-kneejoint-{side}", 0.034 * height_mm, (0.0, sign * hip_y, hip_z - thigh), collection, material)
        keep_world_parent(knee_joint, hip)
        add_segment(f"ACTOR-shin-{side}", knee, (0.0, sign * hip_y, hip_z - thigh), shin, leg_r * 0.85, collection, material, kind="cylinder")
        foot = add_box(
            f"ACTOR-foot-{side}",
            (foot_len, leg_r * 1.6, foot_h),
            (foot_len * 0.25, sign * hip_y, hip_z - thigh - shin + foot_h / 2.0),
            collection,
            material,
        )
        keep_world_parent(foot, knee)

    root.location = (mm(start[0]), mm(start[1]), 0.0)
    root.rotation_euler[2] = math.radians(facing_deg)

    return {
        "root": root,
        "joints": joints,
        "height_mm": height_mm,
        "start_mm": start,
        "end_mm": end,
        "walk": walk,
        "hands": hands,
    }


def keyframe_actor(actor, spec):
    if actor is None:
        return
    scene = bpy.context.scene
    fps = float(spec.get("fps", 24))
    duration = float(spec.get("duration_seconds", 5))
    frames = max(2, int(round(duration * fps)))
    start_x = mm(actor["start_mm"][0])
    start_y = mm(actor["start_mm"][1])
    end_x = mm(actor["end_mm"][0])
    end_y = mm(actor["end_mm"][1])
    cycle = float((spec.get("actor") or {}).get("walk_cycle_seconds", 1.0))
    height = actor["height_mm"]
    root = actor["root"]
    joints = actor["joints"]
    for frame in range(1, frames + 1):
        t = (frame - 1) / max(1, frames - 1) * duration
        progress = 0.0 if frames <= 1 else (frame - 1) / (frames - 1)
        root.location.x = start_x + (end_x - start_x) * progress
        root.location.y = start_y + (end_y - start_y) * progress
        phase = 2.0 * math.pi * (t / max(0.1, cycle))
        root.location.z = mm(height) * 0.008 * abs(math.sin(phase * 2.0))
        root.keyframe_insert(data_path="location", frame=frame)
        if not actor["walk"]:
            continue
        swing = math.radians(10.0) * math.sin(phase)
        knee_l = math.radians(12.0) * max(0.0, -math.sin(phase))
        knee_r = math.radians(12.0) * max(0.0, math.sin(phase))
        arm_swing = math.radians(6.0) * math.sin(phase)
        for side, sign in (("L", 1.0), ("R", -1.0)):
            hip = joints[f"hip_{side}"]
            knee = joints[f"knee_{side}"]
            shoulder = joints[f"shoulder_{side}"]
            hip.rotation_mode = "XYZ"
            knee.rotation_mode = "XYZ"
            shoulder.rotation_mode = "XYZ"
            # Forward is +X, so the swing axis is Y (not X). X would swing the
            # leg sideways into/out of the camera.
            hip.rotation_euler[1] = sign * swing
            knee.rotation_euler[1] = -(knee_l if side == "L" else knee_r)
            shoulder.rotation_euler[1] = -sign * arm_swing
            hip.keyframe_insert(data_path="rotation_euler", frame=frame)
            knee.keyframe_insert(data_path="rotation_euler", frame=frame)
            shoulder.keyframe_insert(data_path="rotation_euler", frame=frame)


def set_linear(obj):
    if obj.animation_data is None or obj.animation_data.action is None:
        return
    for curve in obj.animation_data.action.fcurves:
        for keyframe in curve.keyframe_points:
            keyframe.interpolation = "LINEAR"


def build_camera(scene, spec, collection):
    camera_spec = spec.get("camera") or {}
    fps = float(spec.get("fps", 24))
    duration = float(spec.get("duration_seconds", 5))
    frames = max(2, int(round(duration * fps)))
    keyframes = camera_spec.get("keyframes") or []
    if not keyframes:
        keyframes = [
            {"t": 0, "from_mm": [0, -4000, 1450], "look_at_mm": [0, 0, 950]},
            {"t": duration, "from_mm": [0, -4000, 1450], "look_at_mm": [0, 0, 950]},
        ]
    if len(keyframes) == 1:
        keyframes = [keyframes[0], {**keyframes[0], "t": duration}]

    camera_data = bpy.data.cameras.new("SHOT-camera")
    camera_data.lens = float(camera_spec.get("lens_mm", 40))
    camera_data.sensor_width = 36.0
    camera_data.sensor_fit = "HORIZONTAL"
    camera = bpy.data.objects.new("SHOT-camera", camera_data)
    collection.objects.link(camera)
    scene.camera = camera

    aim = bpy.data.objects.new("SHOT-aim", None)
    aim.empty_display_type = "PLAIN_AXES"
    aim.empty_display_size = 0.2
    collection.objects.link(aim)
    constraint = camera.constraints.new(type="TRACK_TO")
    constraint.target = aim
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"

    for keyframe in sorted(keyframes, key=lambda item: float(item.get("t", 0))):
        frame = max(1, min(frames, int(round(float(keyframe.get("t", 0)) * fps)) + 1))
        source = keyframe.get("from_mm", [0, -4500, 1500])
        target = keyframe.get("look_at_mm", [0, 0, 950])
        camera.location = (mm(source[0]), mm(source[1]), mm(source[2]))
        aim.location = (mm(target[0]), mm(target[1]), mm(target[2]))
        camera.keyframe_insert(data_path="location", frame=frame)
        aim.keyframe_insert(data_path="location", frame=frame)

    for obj in (camera, aim):
        if obj.animation_data and obj.animation_data.action:
            for curve in obj.animation_data.action.fcurves:
                for point in curve.keyframe_points:
                    point.interpolation = "BEZIER"
                    point.handle_left_type = "AUTO_CLAMPED"
                    point.handle_right_type = "AUTO_CLAMPED"
    return {"camera": camera, "aim": aim, "keyframes": keyframes}


def configure_render(scene, spec, frames_dir):
    render = scene.render
    resolution = spec.get("resolution", [1280, 720])
    render.engine = "BLENDER_WORKBENCH"
    render.resolution_x = int(resolution[0])
    render.resolution_y = int(resolution[1])
    render.resolution_percentage = 100
    render.fps = int(spec.get("fps", 24))
    render.fps_base = 1.0
    render.film_transparent = False
    render.use_file_extension = True
    render.filepath = os.path.join(frames_dir, "frame_")
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGB"
    render.image_settings.compression = 15

    shading = scene.display.shading
    shading.light = "FLAT"
    shading.color_type = "MATERIAL"
    shading.single_color = (0.62, 0.62, 0.62)
    shading.show_shadows = False
    shading.show_cavity = True
    shading.cavity_type = "BOTH"
    shading.show_object_outline = False
    shading.show_specular_highlight = False
    shading.background_type = "VIEWPORT"
    shading.background_color = (1.0, 1.0, 1.0)
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.frame_start = 1
    scene.frame_end = max(2, int(round(float(spec.get("duration_seconds", 5)) * render.fps)))
    if scene.world is None:
        scene.world = bpy.data.worlds.new("SHOT-world")
    scene.world.use_nodes = False
    scene.world.color = (1.0, 1.0, 1.0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--out", required=True)
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    args = parser.parse_args(argv)
    with open(args.spec, "r", encoding="utf-8") as handle:
        spec = json.load(handle)

    out_dir = ensure_dir(os.path.abspath(args.out))
    frames_dir = ensure_dir(os.path.join(out_dir, "frames"))
    scene = clear_scene()
    actor_material = make_material("BO_White", 0.22)
    set_material = make_material("SET_White", 0.95)
    collection = bpy.data.collections.new(spec.get("name", "SHOT"))
    scene.collection.children.link(collection)

    build_set(scene, spec, collection, set_material)
    actor = build_actor(scene, spec, collection, actor_material)
    configure_render(scene, spec, frames_dir)
    keyframe_actor(actor, spec)
    camera_info = build_camera(scene, spec, collection)

    blend_path = os.path.join(out_dir, f"{spec.get('name', 'shot')}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)

    for name in os.listdir(frames_dir):
        if name.lower().endswith(".png"):
            os.remove(os.path.join(frames_dir, name))
    bpy.ops.render.render(animation=True)

    frames = sorted(
        os.path.join(frames_dir, name)
        for name in os.listdir(frames_dir)
        if name.lower().endswith(".png")
    )
    meta = {
        "ok": len(frames) > 0,
        "name": spec.get("name", "shot"),
        "fps": int(spec.get("fps", 24)),
        "duration_seconds": float(spec.get("duration_seconds", 5)),
        "resolution": [int(scene.render.resolution_x), int(scene.render.resolution_y)],
        "frames": len(frames),
        "frames_dir": frames_dir,
        "first_frame": frames[0] if frames else None,
        "last_frame": frames[-1] if frames else None,
        "blend": blend_path,
        "actor": {
            "enabled": actor is not None,
            "height_mm": actor["height_mm"] if actor else None,
            "start_mm": actor["start_mm"] if actor else None,
            "end_mm": actor["end_mm"] if actor else None,
            "walk": actor["walk"] if actor else None,
            "hands": actor["hands"] if actor else None,
        },
        "camera": {
            "lens_mm": camera_info["camera"].data.lens,
            "keyframes": camera_info["keyframes"],
        },
        "camera_position": list(camera_info["camera"].location),
        "camera_aim": list(camera_info["aim"].location),
    }
    meta_path = os.path.join(out_dir, "shot_meta.json")
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
    print("SHOT_BUILDER_RESULT " + json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
