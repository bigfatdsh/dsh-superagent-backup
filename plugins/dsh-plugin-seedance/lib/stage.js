// Public staging for local blockout MP4s.
//
// Ark accepts reference videos only as public http(s) URLs or asset:// IDs.
// This service serves explicitly staged files from 127.0.0.1 with unguessable
// tokens, and can expose that port through either:
//   - a user-provided public reverse proxy / tunnel (stagePublicBaseUrl), or
//   - a Cloudflare quick tunnel started from cloudflaredPath.
//
// Only files passed to stage() are reachable; directory traversal is not
// possible because the URL token maps to an absolute path in memory.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { randomBytes } from "node:crypto";

const MIME = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4"
};

function contentType(path) {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function normalizeBase(value) {
  return String(value).trim().replace(/\/+$/, "");
}

export class StageService {
  constructor(config = {}, logger = console) {
    this.config = config;
    this.logger = logger;
    this.server = undefined;
    this.port = undefined;
    this.entries = new Map();
    this.tunnel = undefined;
    this.tunnelUrl = undefined;
    this.tunnelPromise = undefined;
    this.cleanupTimer = undefined;
    this.closed = false;
  }

  get enabled() {
    return this.config.stageEnabled !== false;
  }

  publicBaseFromConfig() {
    return normalizeBase(this.config.stagePublicBaseUrl || process.env.SEEDANCE_STAGE_PUBLIC_BASE_URL || "");
  }

  async ensureServer() {
    if (this.server) return this.port;
    if (!this.enabled) throw new Error("seedance: 本地文件 staging 已关闭（stageEnabled=false）");
    const host = this.config.stageHost || "127.0.0.1";
    const requested = Number.isInteger(this.config.stagePort) ? this.config.stagePort : 8797;
    const baseConfigured = this.publicBaseFromConfig() !== "";
    const candidates = requested === 0 ? [0] : Array.from({ length: baseConfigured ? 1 : 8 }, (_, index) => requested + index);
    let lastError;
    for (const port of candidates) {
      try {
        const server = createServer((request, response) => this.handle(request, response));
        await new Promise((resolvePromise, reject) => {
          const onError = (error) => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            resolvePromise();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port, host);
        });
        server.on("error", (error) => this.logger?.warn?.(`seedance: stage server error: ${String(error)}`));
        this.server = server;
        this.port = server.address().port;
        this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
        this.cleanupTimer.unref?.();
        this.logger?.info?.(`seedance: reference staging server listening on http://${host}:${this.port}`);
        return this.port;
      } catch (error) {
        lastError = error;
        if (error?.code !== "EADDRINUSE") break;
      }
    }
    throw new Error(`seedance: 无法启动 staging server（${host}:${requested}）：${String(lastError?.message ?? lastError)}`);
  }

  async ensurePublicBase() {
    const configured = this.publicBaseFromConfig();
    if (configured !== "") {
      if (!/^https?:\/\//i.test(configured)) throw new Error(`seedance: stagePublicBaseUrl 必须是 http(s) URL，收到 ${configured}`);
      return { base: configured, via: "publicBaseUrl" };
    }
    const cloudflared = this.config.cloudflaredPath ? String(this.config.cloudflaredPath) : "";
    if (cloudflared === "") {
      throw new Error(
        "seedance: 本地参考视频需要一个公网 URL。设置 stagePublicBaseUrl 指向已反向代理到 staging 端口的公网地址，" +
          "或配置 cloudflaredPath 让插件自动开 Cloudflare quick tunnel；也可以先把视频上传到 TOS/对象存储，直接把公网 URL 传给 reference_videos。"
      );
    }
    const url = await this.ensureTunnel(cloudflared);
    return { base: normalizeBase(url), via: "cloudflared" };
  }

  async ensureTunnel(cloudflaredPath) {
    if (this.tunnelUrl) return this.tunnelUrl;
    if (this.tunnelPromise) return this.tunnelPromise;
    const port = await this.ensureServer();
    const timeoutMs = Number.isInteger(this.config.tunnelTimeoutMs) ? this.config.tunnelTimeoutMs : 30000;
    this.tunnelPromise = new Promise((resolvePromise, reject) => {
      let settled = false;
      let output = "";
      let timer;
      const child = spawn(cloudflaredPath, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      this.tunnel = child;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolvePromise(value);
      };
      const onChunk = (chunk) => {
        const text = String(chunk);
        output = `${output}${text}`.slice(-12000);
        const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
        if (match) {
          this.tunnelUrl = match[0];
          this.logger?.info?.(`seedance: cloudflared quick tunnel ready: ${this.tunnelUrl}`);
          finish(undefined, this.tunnelUrl);
        }
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.once("error", (error) => finish(new Error(`seedance: 启动 cloudflared 失败：${String(error?.message ?? error)}`)));
      child.once("exit", (code) => {
        this.tunnel = undefined;
        if (!settled) finish(new Error(`seedance: cloudflared 提前退出（code=${code}）：${output.slice(-2000)}`));
      });
      timer = setTimeout(() => {
        finish(new Error(`seedance: cloudflared 在 ${timeoutMs}ms 内没有返回公网 URL。输出尾部：${output.slice(-2000)}`));
      }, timeoutMs);
      timer.unref?.();    });
    try {
      return await this.tunnelPromise;
    } finally {
      this.tunnelPromise = undefined;
    }
  }

  async uploadUguu(path, info, kind) {
    const maxBytes = Number.isInteger(this.config.stageUploadMaxBytes) ? this.config.stageUploadMaxBytes : 100 * 1024 * 1024;
    if (info.size > maxBytes) throw new Error(`seedance: 第三方托管上限 ${maxBytes} 字节，文件 ${info.size} 字节；请改用 stagePublicBaseUrl/TOS/asset://`);
    const buffer = await readFile(path);
    const form = new FormData();
    form.append("files[]", new Blob([buffer], { type: contentType(path) }), basename(path));
    let response;
    try {
      response = await fetch("https://uguu.se/upload.php", { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
    } catch (error) {
      throw new Error(`seedance: uguu 上传失败（网络）：${String(error?.message ?? error)}；请改用 stagePublicBaseUrl/TOS/asset://`);
    }
    if (!response.ok) throw new Error(`seedance: uguu 上传失败 HTTP ${response.status}；请改用 stagePublicBaseUrl/TOS/asset://`);
    const data = await response.json().catch(() => undefined);
    const url = data?.files?.[0]?.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error(`seedance: uguu 返回了无效 URL：${JSON.stringify(data).slice(0, 500)}`);
    const ttlMinutes = 180;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    this.logger?.warn?.(`seedance: uploaded ${path} to uguu (public, temporary) until ~${expiresAt}`);
    return { url, expiresAt, bytes: buffer.length, via: "uguu", kind, note: "Uguu 临时公开托管（约 3 小时，任务完成后请勿依赖）" };
  }

  async stage(path, { kind = "video", ttlMinutes } = {}) {
    if (!this.enabled) throw new Error("seedance: 本地文件 staging 已关闭（stageEnabled=false）");
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`seedance: 找不到要 staging 的文件：${path}`);
    if (this.config.stageUploadProvider === "uguu") {
      return this.uploadUguu(path, info, kind);
    }
    await this.ensureServer();
    const publicBase = await this.ensurePublicBase();
    const ttl = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : (Number.isFinite(this.config.stageTtlMinutes) ? this.config.stageTtlMinutes : 120);
    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
    this.entries.set(token, { path, kind, bytes: info.size, expiresAt: Date.parse(expiresAt), contentType: contentType(path) });
    const url = `${publicBase.base}/r/${token}/${encodeURIComponent(basename(path))}`;
    this.logger?.warn?.(`seedance: staging ${path} publicly until ${expiresAt} via ${publicBase.via}`);
    return { url, expiresAt, bytes: info.size, via: publicBase.via, token: token.slice(0, 8) };
  }

  cleanup() {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }

  pipeFile(path, response, options) {
    const stream = createReadStream(path, options);
    stream.on("error", (error) => {
      this.logger?.warn?.(`seedance: staged file read failed: ${String(error?.message ?? error)}`);
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      }
      response.destroy(error);
    });
    stream.pipe(response);
  }

  handle(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("ok");
      return;
    }
    const match = /^\/r\/([a-f0-9]{48})\//.exec(url.pathname);
    if (!match) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    const entry = this.entries.get(match[1]);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(match[1]);
      response.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("expired");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const range = request.headers.range;
    const headers = {
      "Content-Type": entry.contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=0, no-store",
      "Content-Disposition": `inline; filename="${basename(entry.path).replace(/"/g, "")}"`
    };
    if (typeof range === "string" && /^bytes=\d*-\d*$/.test(range)) {
      const [startText, endText] = range.replace(/^bytes=/, "").split("-");
      let from;
      let to;
      if (startText === "") {
        const suffix = Number(endText);
        if (!Number.isFinite(suffix) || suffix <= 0) {
          response.writeHead(416, { "Content-Range": `bytes */${entry.bytes}` });
          response.end();
          return;
        }
        from = Math.max(0, entry.bytes - suffix);
        to = entry.bytes - 1;
      } else {
        from = Number(startText);
        to = endText === "" ? entry.bytes - 1 : Math.min(Number(endText), entry.bytes - 1);
      }
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || from >= entry.bytes) {
        response.writeHead(416, { "Content-Range": `bytes */${entry.bytes}` });
        response.end();
        return;
      }
      response.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${from}-${to}/${entry.bytes}`,
        "Content-Length": to - from + 1
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      this.pipeFile(entry.path, response, { start: from, end: to });
      return;
    }
    response.writeHead(200, { ...headers, "Content-Length": entry.bytes });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    this.pipeFile(entry.path, response);
  }

  close() {
    this.closed = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.entries.clear();
    if (this.server) {
      this.server.closeAllConnections?.();
      this.server.close();
      this.server = undefined;
    }
    if (this.tunnel) {
      this.tunnel.kill("SIGTERM");
      this.tunnel = undefined;
    }
    this.tunnelUrl = undefined;
  }
}

export function createStageService(config, logger) {
  return new StageService(config, logger);
}
