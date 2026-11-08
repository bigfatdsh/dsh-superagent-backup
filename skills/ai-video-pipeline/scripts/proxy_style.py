# -*- coding: utf-8 -*-
"""把白模变成「材质代理（materials proxy）」——给 Seedance 的参考视频补上形体与材质信息。

为什么需要：
    原来的白模是 Workbench FLAT + 单一 0.62 灰，渲出来**没有任何明暗渐变**，
    整张图只有轮廓和一块黑色方块（枪）。模型拿到这种参考，只能从剪影猜形体，
    于是把一切画成"光滑的简单体块"——这就是成片里那个塑料感头盔、
    融成一坨的手枪、没有缝线的连指手套的来源。
    （见 references/realism-playbook.md 的实测数据）

这里做的事：
    1. 按物体名给材质分区：皮肤 / 织物 / 装备 / 金属 / 纸 / 混凝土 / 黄铜 / 特效；
    2. 换成 STUDIO 光照 + 阴影 + 空腔（cavity）+ 高光，让形体有明暗；
    3. 背景改中性灰，避免"纯白背景"诱导模型把环境画成过曝的白。

用法：
    import proxy_style
    proxy_style.apply(scene)                 # proxy（默认，推荐做参考视频）
    proxy_style.apply(scene, style="gray")   # 回到传统平灰白模（只做骨架）

它是幂等的：重复调用只会重设材质与渲染参数。
"""
import math

import bpy

PALETTE = {
    # key: (r, g, b, roughness, metallic)
    "skin": (0.70, 0.53, 0.44, 0.62, 0.0),
    "cloth": (0.19, 0.21, 0.20, 0.92, 0.0),
    "gear": (0.50, 0.41, 0.28, 0.72, 0.0),
    "rubber": (0.10, 0.10, 0.10, 0.85, 0.0),
    "metal": (0.11, 0.11, 0.12, 0.38, 0.85),
    "brass": (0.62, 0.45, 0.16, 0.32, 0.90),
    "paper": (0.82, 0.80, 0.72, 0.88, 0.0),
    "concrete": (0.34, 0.34, 0.33, 0.95, 0.0),
    "wood": (0.36, 0.26, 0.16, 0.80, 0.0),
    "fx": (0.98, 0.94, 0.86, 0.55, 0.0),
    "neutral": (0.42, 0.42, 0.42, 0.80, 0.0),
}

# 判定用「词元匹配」而不是子串匹配：否则 "forearm" 会被 "ear"（耳朵）吃掉，
# "target_bar" 会被 "target"（纸靶）吃掉。先查 SPECIAL，再查词元。
SPECIAL = [
    ("target_bar", "concrete"),
    ("target_post", "concrete"),
    ("hipjoint", "cloth"),
    ("forearm", "cloth"),
    ("upperarm", "cloth"),
    ("platecarrier", "gear"),
    ("lightbar", "concrete"),
    ("backwall", "concrete"),
]

# 判定顺序很重要："frame"(枪身) 是金属，"knee"(护膝) 是装备。
RULES = [
    ("fx", ("muzzle", "flash", "puff", "smoke", "spark", "fx")),
    ("metal", ("slide", "receiver", "barrel", "magazine", "mag", "bolt", "trigger", "sight", "gun", "pistol", "weapon", "rifle", "knife", "grip", "frame", "suppressor")),
    ("brass", ("brass", "casing", "shell")),
    ("paper", ("paper", "bullseye", "cardboard")),
    ("concrete", ("floor", "wall", "divider", "ceiling", "ground", "post", "bar", "light", "lamp", "beam", "pillar", "concrete", "backdrop")),
    ("wood", ("wood", "plank", "crate", "table", "chair")),
    ("gear", ("helmet", "goggle", "visor", "mask", "gaiter", "glove", "vest", "carrier", "pouch", "belt", "strap", "pad", "knee", "sling", "harness", "boot")),
    ("skin", ("head", "face", "neck", "ear", "skin", "hand", "finger")),
    ("rubber", ("tire", "wheel", "tube")),
    ("cloth", ("torso", "pelvis", "thigh", "shin", "foot", "leg", "shoulder", "elbow", "upperarm", "forearm", "arm", "body", "actor", "sleeve", "pant", "shirt", "uniform")),
]


def _tokens(name):
    import re
    return [piece for piece in re.split(r"[^a-z]+", str(name).lower()) if piece]


def classify(name):
    lowered = str(name).lower()
    for pattern, key in SPECIAL:
        if pattern in lowered:
            return key
    tokens = _tokens(lowered)
    for key, words in RULES:
        for word in words:
            if word in tokens:
                return key
    for key, words in RULES:
        for word in words:
            if len(word) >= 6 and word in lowered:
                return key
    return "neutral"


def _material(name, spec):
    material = bpy.data.materials.get(f"PROXY_{name}") or bpy.data.materials.new(f"PROXY_{name}")
    if material.node_tree is None:
        material.use_nodes = True
    base = material.node_tree.nodes.get("Principled BSDF") if material.node_tree else None
    r, g, b, roughness, metallic = spec
    material.diffuse_color = (r, g, b, 1.0)
    material.roughness = roughness
    material.metallic = metallic
    if base is not None:
        base.inputs["Base Color"].default_value = (r, g, b, 1.0)
        base.inputs["Roughness"].default_value = roughness
        base.inputs["Metallic"].default_value = metallic
    return material


def _safe_set(target, name, value):
    try:
        setattr(target, name, value)
    except Exception:
        pass


def apply(scene, style="proxy", background=(0.232, 0.238, 0.248), mapping=None, hide_fx=True):
    """mapping: {子串: palette_key}，用来覆盖按名字猜的分类（例如 hands 其实是戴手套的手）。"""
    """把场景改成材质代理。style="gray" 时退回平灰白模（保留原行为）。"""
    if style not in ("proxy", "gray"):
        raise ValueError(f"不认识的 style: {style}")

    materials = {key: _material(key, spec) for key, spec in PALETTE.items()}
    assigned = {"skin": 0, "cloth": 0, "gear": 0, "rubber": 0, "metal": 0, "brass": 0, "paper": 0, "concrete": 0, "wood": 0, "fx": 0, "neutral": 0}

    for obj in scene.objects:
        if obj.type != "MESH":
            continue
        if style == "gray":
            key = "neutral"
        else:
            key = classify(obj.name)
            for pattern, forced in (mapping or {}).items():
                if pattern and pattern.lower() in obj.name.lower():
                    if forced not in PALETTE:
                        raise ValueError(f"mapping 里的材质不存在: {forced}")
                    key = forced
                    break
        assigned[key] = assigned.get(key, 0) + 1
        if hide_fx and key == "fx":
            # 枪口焰/粉尘在白模里是"球"，渲进参考会被模型当成实体。
            # 闪光的时机交给提示词里的 cues，不靠这个球。
            obj.hide_render = True
            obj.hide_viewport = True
        obj.data.materials.clear()
        obj.data.materials.append(materials[key])
        if style != "gray":
            # 平滑着色：低模球体如果不平滑，cavity 会把每一圈多边形描出来，
            # 参考视频就变成"线框低模"，模型会照抄成低模 CG。
            try:
                for polygon in obj.data.polygons:
                    polygon.use_smooth = True
            except Exception:
                pass

    shading = scene.display.shading
    _safe_set(shading, "color_type", "MATERIAL")
    _safe_set(shading, "show_object_outline", False)
    if style == "gray":
        _safe_set(shading, "light", "FLAT")
        _safe_set(shading, "single_color", (0.62, 0.62, 0.62))
        _safe_set(shading, "show_shadows", False)
        _safe_set(shading, "show_cavity", False)
        _safe_set(shading, "show_specular_highlight", False)
        _safe_set(shading, "background_type", "VIEWPORT")
        _safe_set(shading, "background_color", (1.0, 1.0, 1.0))
    else:
        _safe_set(shading, "light", "STUDIO")
        _safe_set(shading, "studiolight_rotate_z", math.radians(35))
        _safe_set(shading, "show_shadows", True)
        _safe_set(shading, "shadow_intensity", 0.35)
        _safe_set(shading, "show_cavity", True)
        _safe_set(shading, "cavity_type", "SCREEN")
        _safe_set(shading, "curvature_ridge_factor", 0.4)
        _safe_set(shading, "curvature_valley_factor", 0.4)
        _safe_set(shading, "show_specular_highlight", True)
        _safe_set(shading, "background_type", "VIEWPORT")
        _safe_set(shading, "background_color", background)

    try:
        if scene.world is None:
            scene.world = bpy.data.worlds.new("PROXY-world")
        scene.world.use_nodes = False
        scene.world.color = (background[0], background[1], background[2])
    except Exception:
        pass

    return {"style": style, "materials": assigned, "fx_hidden": bool(hide_fx)}
