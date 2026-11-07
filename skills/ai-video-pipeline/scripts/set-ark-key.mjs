#!/usr/bin/env node
// Store the Ark API key in ~/.dsh/secrets/ark-api-key with mode 0600.
//
// Beginner-friendly:
//   node set-ark-key.mjs                 # hidden prompt (recommended)
//   node set-ark-key.mjs --from-clipboard # read from macOS clipboard
//   node set-ark-key.mjs --check          # check without printing the key
//
// The key is never echoed and never passed on the command line.

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const target = join(homedir(), ".dsh/secrets/ark-api-key");
const args = process.argv.slice(2);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function normalize(raw) {
  return String(raw)
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^ARK_API_KEY\s*=\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function promptHidden(label) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("当前不是交互式终端。请改用 --stdin 或 --from-clipboard。"));
      return;
    }
    const stdin = process.stdin;
    let value = "";
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (char) => {
      if (char === "\u0003") {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("已取消"));
        return;
      }
      if (char === "\r" || char === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (char === "\u007f" || char === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (char >= " ") {
        value += char;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

function readClipboard() {
  if (process.platform !== "darwin") throw new Error("--from-clipboard 目前只支持 macOS（pbpaste）");
  return execFileSync("pbpaste", [], { encoding: "utf8", timeout: 10000 });
}

async function writeKey(key) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${key}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
  process.stdout.write(
    `\n✅ 已保存到：${target}\n` +
      `   权限：0600（只有你能读）\n` +
      `   Key 长度：${key.length}（不回显）\n\n` +
      `下一步：回到 DSH，对我说「跑 seedance_doctor」。\n` +
      `通过后我们先跑一条 4 秒 / 480p / draft 的最小验证，确认能出片再加分辨率。\n`
  );
}

async function main() {
  if (args.includes("--check")) {
    try {
      const raw = await readFile(target, "utf8");
      const key = normalize(raw);
      const info = await stat(target);
      const mode = (info.mode & 0o777).toString(8);
      process.stdout.write(
        `${JSON.stringify({
          ok: key.length >= 10 && !/\s/.test(key),
          path: target,
          mode,
          secure: mode === "600",
          masked: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : ""
        }, null, 2)}\n`
      );
      return;
    } catch {
      process.stdout.write(`${JSON.stringify({ ok: false, path: target, detail: "not found" }, null, 2)}\n`);
      return;
    }
  }

  let key = "";
  if (args.includes("--from-clipboard")) {
    key = normalize(readClipboard());
    if (key === "") {
      process.stderr.write("剪贴板是空的。先在方舟控制台复制 API Key，再运行一次。\n");
      process.exit(1);
    }
  } else if (args.includes("--stdin")) {
    key = normalize(await readStdin());
  } else {
    const index = args.indexOf("--key");
    if (index >= 0) key = normalize(args[index + 1] ?? "");
  }

  if (key === "" && process.stdin.isTTY) {
    process.stdout.write(
      "== 设置 Seedance / 火山方舟 API Key ==\n" +
        "先到 https://ark.volcengine.com/region:cn-beijing/apikey 创建并复制 Key。\n" +
        "提示：Key 只显示一次；不要发到聊天里。\n\n"
    );
    key = normalize(await promptHidden("粘贴 API Key（输入不回显，回车确认）："));
  }

  if (!key || key.length < 10 || /\s/.test(key)) {
    process.stderr.write(
      "没有拿到有效 Key。\n" +
        "用法：node set-ark-key.mjs（交互式，推荐）\n" +
        "      node set-ark-key.mjs --from-clipboard（先复制 Key）\n" +
        "      node set-ark-key.mjs --check（检查已保存的 Key）\n"
    );
    process.exit(1);
  }
  await writeKey(key);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message ?? error)}\n`);
  process.exit(1);
});
