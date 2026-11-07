// Minimal Ark (Volcengine / BytePlus) video-generation REST client.
// No SDK dependency; Node >= 18 global fetch.

export class ArkApiError extends Error {
  constructor(message, { status, code, requestId, body } = {}) {
    super(message);
    this.name = "ArkApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.body = body;
  }
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, "")}${path}`;
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  return timeout;
}

async function parseError(response) {
  const text = await response.text().catch(() => "");
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const error = body?.error;
  const code = typeof error?.code === "string" ? error.code : typeof body?.code === "string" ? body.code : undefined;
  const message = typeof error?.message === "string"
    ? error.message
    : typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
        ? body.error
        : text.slice(0, 800);
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-tt-logid") ?? undefined;
  return { code, message, requestId, body };
}

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.apiKey
 * @param {typeof fetch} [options.fetchFn]
 * @param {string} [options.userAgent]
 */
export function createSeedanceClient({ baseUrl, apiKey, fetchFn, userAgent = "dsh-plugin-seedance/0.2.0" } = {}) {
  const run = fetchFn ?? globalThis.fetch;
  if (typeof run !== "function") throw new Error("seedance: 当前运行时没有 fetch（需要 Node >= 18）");
  if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error("seedance: API key is required");
  if (typeof baseUrl !== "string" || !/^https?:\/\//i.test(baseUrl)) throw new Error(`seedance: 非法 baseUrl：${baseUrl}`);

  async function request(path, { method = "GET", body, signal, timeoutMs = 60000 } = {}) {
    let response;
    try {
      response = await run(joinUrl(baseUrl, path), {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          "User-Agent": userAgent
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combineSignals(signal, timeoutMs)
      });
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        throw new ArkApiError(`Seedance API ${method} ${path} 超时（${timeoutMs}ms）`, { status: 0 });
      }
      throw new ArkApiError(`Seedance API ${method} ${path} 网络错误：${String(error?.message ?? error)}`, { status: 0 });
    }
    if (!response.ok) {
      const parsed = await parseError(response);
      throw new ArkApiError(
        `Seedance API ${method} ${path} 失败：HTTP ${response.status}${parsed.message ? ` — ${parsed.message}` : ""}`,
        { status: response.status, code: parsed.code, requestId: parsed.requestId, body: parsed.body }
      );
    }
    if (response.status === 204) return {};
    const text = await response.text();
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ArkApiError(`Seedance API ${method} ${path} 返回了非 JSON 响应`, { status: response.status, body: text.slice(0, 800) });
    }
  }

  return {
    baseUrl,
    submitTask(payload, signal) {
      return request("/contents/generations/tasks", { method: "POST", body: payload, signal, timeoutMs: 120000 });
    },
    getTask(taskId, signal) {
      return request(`/contents/generations/tasks/${encodeURIComponent(taskId)}`, { signal, timeoutMs: 60000 });
    },
    cancelTask(taskId, signal) {
      return request(`/contents/generations/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE", signal, timeoutMs: 60000 });
    },
    listModels(signal) {
      return request("/models", { signal, timeoutMs: 20000 });
    },
    probe(signal) {
      return request("/models", { signal, timeoutMs: 20000 });
    }
  };
}
