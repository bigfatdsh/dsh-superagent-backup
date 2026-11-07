#!/usr/bin/env node
// Scaffold a new AI video project under <studio>/projects/<name>.
//
//   node new-project.mjs --name my-film --title "我的短片" --duration 5
//
// The project is deliberately small: a brief, a shotlist, one shot spec, and
// asset/QA directories. Everything the agent needs is plain files.

import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, "../../../..");
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "project";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name) {
    process.stderr.write("用法：node new-project.mjs --name <slug> [--title 标题] [--ratio 16:9] [--duration 5] [--fps 24] [--resolution 1280x720]\n");
    process.exit(1);
  }
  const name = slug(args.name);
  const title = String(args.title ?? name);
  const ratio = String(args.ratio ?? "16:9");
  const duration = Number(args.duration ?? 5);
  const fps = Number(args.fps ?? 24);
  const resolutionText = String(args.resolution ?? "1280x720");
  const [width, height] = resolutionText.split("x").map(Number);
  if (!Number.isFinite(duration) || duration < 4 || duration > 30) throw new Error("--duration 必须在 4-30 秒");
  if (!Number.isFinite(fps) || fps < 12 || fps > 60) throw new Error("--fps 必须在 12-60");
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("--resolution 必须是 1280x720 这类格式");
  const projectDir = join(STUDIO, "projects", name);
  const exists = await mkdir(projectDir, { recursive: false }).then(() => false, (error) => {
    if (error.code === "EEXIST") return true;
    throw error;
  });
  if (exists) throw new Error(`项目已存在：${projectDir}（换一个 --name，或先手动归档旧项目）`);

  for (const sub of ["refs/character", "refs/scene", "refs/props", "blockout", "renders", "output", "qa", "prompts"]) {
    await mkdir(join(projectDir, sub), { recursive: true });
  }

  const shotlist = {
    project: name,
    title,
    format: { ratio, resolution: [width, height], fps },
    global: {
      style: "写实电影质感，自然光影，35mm 胶片颗粒，真实皮肤肌理，克制调色",
      characters: [],
      scenes: [],
      props: [],
      negative: "无字幕、无水印、无logo、无文字"
    },
    shots: [
      {
        id: "shot_01",
        duration,
        shot_size: "MS",
        camera: "镜头缓慢跟随人物向右移动，保持中景，轻微手持呼吸感",
        action: "人物从左向右走过房间，停在窗边，转头看向窗外",
        dialogue: "",
        hand_policy: "out_of_frame",
        fast_turn: false,
        blockout: { spec: "shot_01.json", mp4: "renders/shot_01/shot_01.mp4" },
        seedance: {
          mode: "reference",
          omni_reference_task_type: "reference",
          ratio,
          duration,
          generate_audio: false,
          whitemodel: true,
          reference_images: [],
          reference_videos: ["renders/shot_01/shot_01.mp4"]
        }
      }
    ]
  };

  const shot = {
    name: "shot_01",
    fps,
    resolution: [width, height],
    duration_seconds: duration,
    set: {
      floor: true,
      walls: [],
      props: []
    },
    actor: {
      enabled: true,
      height_mm: 1750,
      start_mm: [-1200, 0, 0],
      end_mm: [1200, 0, 0],
      facing_deg: 0,
      walk: true,
      walk_cycle_seconds: 1.0,
      hands: true
    },
    camera: {
      lens_mm: 40,
      keyframes: [
        { t: 0, from_mm: [-1500, -4000, 1450], look_at_mm: [-1200, 0, 950] },
        { t: duration, from_mm: [2000, -4000, 1400], look_at_mm: [1200, 0, 950] }
      ]
    },
    render: { engine: "workbench", background: "white", first_last: true }
  };

  const brief = `# ${title}

## 一句话
（用一句话写清楚：谁，在哪里，做什么，什么风格，最后一个画面停在哪。）

## 角色 / 场景 / 道具
- 角色 A：
- 场景：
- 道具：

## 镜头清单
| 镜头 | 时长 | 景别 | 运镜 | 动作 | 台词 |
|---|---|---|---|---|---|
| shot_01 | ${duration}s | MS | 缓慢跟随 | 人物从左向右走 | — |

## 硬约束
- 手部：不入画 / 遮挡 / 只拍中近景
- 不做快速转身、不拍复杂多人肢体接触
- 真实人脸：只用 AI 生成的虚拟人像或已授权 asset://；不直接上传真人参考图
- Seedance 2.5 时长 4-30 秒；白模参考显式设置 omni_reference_task_type=reference
- 白模画面不得出现轨迹线、坐标轴、网格线、相机锥体

## 验收标准
- 运动骨架与白模一致（走位、镜头顺序、景别变化、节奏）
- 人物身份/服装/发型稳定；手部不入画或没有畸形
- 无字幕、无水印、无白模材质泄漏
`;

  await writeFile(join(projectDir, "shotlist.json"), `${JSON.stringify(shotlist, null, 2)}\n`, "utf8");
  await writeFile(join(projectDir, "shot_01.json"), `${JSON.stringify(shot, null, 2)}\n`, "utf8");
  await writeFile(join(projectDir, "brief.md"), brief, "utf8");
  await writeFile(join(projectDir, "README.md"), `# ${title}\n\n1. 编辑 \`brief.md\` 和 \`shotlist.json\`。\n2. 修改 \`shot_01.json\` 的走位与相机关键帧。\n3. 渲染白模：\n\n\`\`\`bash\ncd "${STUDIO}"\nnode .dsh/skills/ai-video-pipeline/scripts/render-shot.mjs --spec projects/${name}/shot_01.json --out projects/${name}/renders/shot_01\n\`\`\`\n\n4. 把角色/场景参考图截成 \`blockout/anchors/\`，填完 \`consistency.json\` 并跑 \`contract-init.mjs --project projects/${name} --check\`。\n5. 用 \`prep-shot.mjs\` 生成提示词，再用 \`seedance_preview_request\` 预览，再用 \`seedance_generate_video\` 提交。\n6. 用 \`qa-video.mjs\` 验收下载的视频。\n`, "utf8");
  await writeFile(join(projectDir, "refs/README.md"), `# refs\n\n命名约定：\n- \`character/<name>_front.png\`：角色正面全身/半身，AI 生成的虚拟人像\n- \`character/<name>_face.png\`：面部特写（可选）\n- \`scene/<name>.png\`：场景光线/材质参考\n- \`props/<name>.png\`：道具参考\n\n不要放未授权的真人照片；Seedance 2.5 会拦截真人脸参考。\n`, "utf8");
  await writeFile(join(projectDir, ".gitignore"), "renders/*/frames/\nseedance-output/\noutput/seedance/\n*.blend1\n", "utf8");

  // 一致性契约骨架：新项目一律带着契约出生，缺 must_show 时 --check 会报错
  let contract = { ok: false };
  try {
    const { stdout } = await execFileAsync(process.execPath, [join(HERE, "contract-init.mjs"), "--project", projectDir]);
    contract = JSON.parse(stdout);
  } catch (error) {
    contract = { ok: false, error: String(error?.message ?? error) };
  }

  process.stdout.write(`${JSON.stringify({ ok: true, projectDir, shotlist: join(projectDir, "shotlist.json"), shot: join(projectDir, "shot_01.json"), contract: contract.created ?? contract.error }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message ?? error)}\n`);
  process.exit(1);
});
