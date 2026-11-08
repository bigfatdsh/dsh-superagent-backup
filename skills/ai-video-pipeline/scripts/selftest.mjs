#!/usr/bin/env node
// 工具链自测：在临时目录里造一个小项目，把 contract-init / prep-shot /
// qa-consistency 的正例和反例都跑一遍。不联网、不花额度。
//
//   node .dsh/skills/ai-video-pipeline/scripts/selftest.mjs [--keep]
//
// 退出码：0 全过；1 有失败（失败时保留临时目录，路径会打印出来）。

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, "../../../..");
const FFMPEG = join(STUDIO, "tools/bin/ffmpeg");

async function run(script, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(HERE, script), ...args], {
      timeout: 180000,
      maxBuffer: 32 * 1024 * 1024
    });
    return { code: 0, json: parseJson(stdout), stdout, stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      json: parseJson(error.stdout ?? "") ?? parseJson(error.stderr ?? ""),
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
}

function parseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const line = trimmed.split("\n").find((item) => item.trim().startsWith("{"));
    try {
      return line ? JSON.parse(line) : undefined;
    } catch {
      return undefined;
    }
  }
}

async function main() {
  const keep = process.argv.includes("--keep");
  const root = await mkdtemp(join(tmpdir(), "aivideo-selftest-"));
  const checks = [];
  const record = (id, ok, detail) => {
    checks.push({ id, ok, detail });
    process.stderr.write(`${ok ? "✓" : "✗"} ${id}${detail ? ` — ${detail}` : ""}\n`);
  };

  try {
    await mkdir(join(root, "blockout/anchors"), { recursive: true });
    await mkdir(join(root, "renders/shot_01"), { recursive: true });
    for (const name of ["character", "scene", "prop"]) {
      await execFileAsync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=96x54", "-frames:v", "1", join(root, "blockout/anchors", `${name}.jpg`)]);
    }
    // 4s 测试片：0.5s 与 3.0s 各一声 880Hz
    const video = join(root, "renders/shot_01/shot_01.mp4");
    await execFileAsync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=24:d=4",
      "-f", "lavfi", "-i", "aevalsrc='0.6*sin(2*PI*880*t)*(gte(t\\,0.5)*lt(t\\,0.6)+gte(t\\,3.0)*lt(t\\,3.1))':s=16000:d=4",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video
    ]);

    const shotlist = {
      project: "selftest",
      title: "selftest",
      format: { ratio: "16:9", resolution: [320, 180], fps: 24 },
      global: { style: "写实", negative: "无字幕、无水印；本片特有：不出现第二个主体" },
      shots: [{
        id: "shot_01",
        duration: 4,
        shot_size: "MS",
        camera: "固定机位",
        action: "主体保持静止",
        hand_policy: "out_of_frame",
        fast_turn: false,
        blockout: { mp4: "renders/shot_01/shot_01.mp4" },
        seedance: {
          mode: "reference",
          omni_reference_task_type: "reference",
          ratio: "16:9",
          duration: 4,
          resolution: "720p",
          generate_audio: false,
          whitemodel: true,
          reference_images: ["blockout/anchors/character.jpg", "blockout/anchors/scene.jpg", "blockout/anchors/prop.jpg"],
          reference_videos: ["renders/shot_01/shot_01.mp4"]
        }
      }]
    };
    await writeFile(join(root, "shotlist.json"), `${JSON.stringify(shotlist, null, 2)}\n`, "utf8");

    const contract = {
      schema: 1,
      project: "selftest",
      title: "selftest",
      format: { ratio: "16:9", resolution: [320, 180], fps: 24 },
      grade: { look: "中性灰", tolerance: { luma: 0.05, saturationRelative: 0.25 } },
      subjects: {
        character: { anchor: "blockout/anchors/character.jpg", text: "测试主体", locked: ["外观 A", "外观 B", "外观 C"] },
        scene: { anchor: "blockout/anchors/scene.jpg", text: "测试场景", locked: ["结构 A", "结构 B", "结构 C"] },
        props: [{ id: "prop", anchor: "blockout/anchors/prop.jpg", text: "测试道具", ratios: { width_over_height: 1.2 } }]
      },
      audio: { mode: "model", tolerance: 0.2 },
      global_avoid: [],
      shots: {
        shot_01: {
          anchor_tail: "",
          logic: "主体在画面中央静止",
          must_show: [{ what: "测试主体", prop: "prop", at: [0.5, 0.5], size: 0.5 }],
          cues: [{ t: 0.5, event: "第一声" }, { t: 3.0, event: "第二声" }],
          avoid: ["第二个主体"]
        }
      }
    };
    const contractPath = join(root, "consistency.json");
    const writeContract = (value) => writeFile(contractPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await writeContract(contract);

    // 1) 契约校验
    const check = await run("contract-init.mjs", ["--project", root, "--check"]);
    record("contract-check-ok", check.code === 0 && check.json?.ok === true, check.json?.errors?.join("；"));

    // 2) 提示词生成
    const prep = await run("prep-shot.mjs", ["--project", root, "--shot", "shot_01", "--print"]);
    const prompt = prep.json?.prompt ?? "";
    record("prep-shot-ok", prep.code === 0 && prep.json?.ok === true, prep.json?.errors?.join("；"));
    record("prep-shot-contract-block", prompt.includes("【一致性契约") && prompt.includes("@视频1") && prompt.includes("@图片1"), `${prompt.length} chars`);
    record("prep-shot-negative-trim", !String(prep.json?.negativePrompt ?? "").includes("字幕"), `negative="${prep.json?.negativePrompt ?? ""}"`);

    // 3) 反例：must_show 为空
    await writeContract({ ...contract, shots: { shot_01: { ...contract.shots.shot_01, must_show: [] } } });
    const emptyMust = await run("prep-shot.mjs", ["--project", root, "--shot", "shot_01", "--print"]);
    record("prep-shot-rejects-empty-must-show", emptyMust.code === 1 && `${emptyMust.json?.errors ?? ""}`.includes("must_show"), emptyMust.json?.errors?.[0]);

    // 4) 反例：reference 模式出现 "替换"
    await writeContract({ ...contract, shots: { shot_01: { ...contract.shots.shot_01, logic: "把白色人偶替换为主体" } } });
    const editWord = await run("prep-shot.mjs", ["--project", root, "--shot", "shot_01", "--print"]);
    record("prep-shot-rejects-edit-words", editWord.code === 1 && `${editWord.json?.errors ?? ""}`.includes("替换"), editWord.json?.errors?.[0]);
    await writeContract(contract);

    // 5) QA 正例
    const qaOk = await run("qa-consistency.mjs", ["--project", root, "--video", `shot_01=${video}`]);
    record("qa-consistency-pass", qaOk.code === 0 && qaOk.json?.ok === true, `verdict=${qaOk.json?.verdict}`);
    const report = parseJson(await readFile(join(root, "qa/consistency-report.json"), "utf8"));
    record("qa-writes-evidence", Boolean(report?.shots?.[0]?.strip) && Array.isArray(report?.mustShow), report?.shots?.[0]?.strip);

    // 6) QA 反例：cue 与实际峰值错开 1.5s
    await writeContract({ ...contract, shots: { shot_01: { ...contract.shots.shot_01, cues: [{ t: 0.5, event: "第一声" }, { t: 1.5, event: "错位的一声" }] } } });
    const qaBad = await run("qa-consistency.mjs", ["--project", root, "--video", `shot_01=${video}`]);
    record("qa-consistency-detects-audio-drift", qaBad.code === 1 && (qaBad.json?.hardFailures ?? []).some((item) => item.includes("声画不同步")), qaBad.json?.hardFailures?.[0]);

    // 7) 制片门禁：问卷 → 确认 → 放行 → 契约改了要重新 prep → 记账 → 超限拒绝
    const questions = await run("produce.mjs", ["intake", "--project", root, "--questions"]);
    record("produce-intake-questions", questions.code === 0 && (questions.json?.questions ?? []).length >= 6, `${questions.json?.questions?.length ?? 0} 题`);

    const confirmed = await run("produce.mjs", ["intake", "--project", root,
      "--set", "deliveryResolution=480p,draftResolution=480p,durationPerShot=4,shotCount=1,maxPaidCalls=2,maxCallsPerShot=1,draftPolicy=none,requireScan=false",
      "--confirm", "--note", "selftest"]);
    record("produce-intake-confirm", confirmed.code === 0 && confirmed.json?.confirmed === true, confirmed.json?.errors?.join("；"));

    await writeContract(contract);
    await run("prep-shot.mjs", ["--project", root, "--shot", "shot_01", "--tier", "final"]);
    await writeContract({ ...contract, shots: { shot_01: { ...contract.shots.shot_01, logic: "契约已被修改" } } });
    const stale = await run("produce.mjs", ["gate", "--project", root, "--shot", "shot_01", "--tier", "final"]);
    record("produce-gate-detects-stale-prompt", stale.code === 1 && `${stale.json?.reasons ?? ""}`.includes("旧契约"), stale.json?.reasons?.[0]);

    await writeContract(contract);
    const gatedOk = await run("produce.mjs", ["gate", "--project", root, "--shot", "shot_01", "--tier", "final"]);
    record("produce-gate-allows", gatedOk.code === 0 && gatedOk.json?.allowed === true, gatedOk.json?.reasons?.join("；"));

    const gatedScan = await run("produce.mjs", ["intake", "--project", root, "--set", "requireScan=true", "--confirm", "--note", "selftest"]);
    const scanGate = await run("produce.mjs", ["gate", "--project", root, "--shot", "shot_01", "--tier", "final"]);
    record("produce-gate-requires-scan", gatedScan.code === 0 && scanGate.code === 1 && `${scanGate.json?.reasons ?? ""}`.includes("机位扫描"), scanGate.json?.reasons?.[0]);
    await run("produce.mjs", ["intake", "--project", root, "--set", "requireScan=false", "--confirm", "--note", "selftest"]);

    const recorded = await run("produce.mjs", ["record", "--project", root, "--shot", "shot_01", "--tier", "final", "--taskId", "cgt-selftest", "--resolution", "480p", "--duration", "4"]);
    record("produce-record", recorded.code === 0 && recorded.json?.entry?.units > 0, `units=${recorded.json?.entry?.units}`);

    const blocked = await run("produce.mjs", ["gate", "--project", root, "--shot", "shot_01", "--tier", "final"]);
    record("produce-gate-blocks-over-budget", blocked.code === 1 && `${blocked.json?.reasons ?? ""}`.includes("上限"), blocked.json?.reasons?.[0]);

    // 8) 机位扫描计划（不启动 Blender）
    const scanPlan = await run("shot-scan.mjs", ["--test", "--blend", video, "--base", "from=0,-4000,1450;look=0,0,950", "--lenses", "35,50", "--dolly", "1.0,0.9", "--plan-only", "--out", join(root, "scan-plan")]);
    record("shot-scan-plan-expands", scanPlan.code === 0 && scanPlan.json?.variants === 4, `variants=${scanPlan.json?.variants}`);
    const scanBad = await run("shot-scan.mjs", ["--test", "--blend", video, "--lenses", "50", "--plan-only", "--out", join(root, "scan-plan-bad")]);
    record("shot-scan-rejects-missing-base", scanBad.code === 1, scanBad.json?.error?.slice(0, 60));

    const failed = checks.filter((item) => !item.ok);
    process.stdout.write(`\n${JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed: failed.map((item) => item.id), dir: root }, null, 2)}\n`);
    if (failed.length === 0 && !keep) await rm(root, { recursive: true, force: true });
    process.exit(failed.length === 0 ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error), dir: root }, null, 2)}\n`);
    process.exit(1);
  }
}

main();
