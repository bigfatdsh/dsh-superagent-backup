import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";

export async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

export async function startMockArk({ videoPath, model = "doubao-seedance-2-5-260628" } = {}) {
  const requests = [];
  const polls = new Map();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    const send = (status, value, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.method === "GET" && request.url === "/models") {
        send(200, { data: [{ id: model, object: "model" }] });
        return;
      }
      if (request.method === "POST" && request.url === "/contents/generations/tasks") {
        if (typeof body?.prompt === "string" && body.prompt.includes("TRIGGER_ERROR")) {
          send(400, { error: { code: "InvalidParameter", message: "mock rejected prompt" } }, { "x-request-id": "req-mock-1" });
          return;
        }
        const id = `cgt-mock-${requests.length}`;
        polls.set(id, 0);
        send(200, { id, status: "queued" });
        return;
      }
      const taskMatch = /^\/contents\/generations\/tasks\/([^/]+)$/.exec(request.url ?? "");
      if (taskMatch && request.method === "GET") {
        const id = decodeURIComponent(taskMatch[1]);
        const count = (polls.get(id) ?? 0) + 1;
        polls.set(id, count);
        if (count <= 1) {
          send(200, { id, status: "running", model, duration: 2 });
          return;
        }
        send(200, {
          id,
          status: "succeeded",
          model,
          duration: 2,
          ratio: "16:9",
          resolution: "720p",
          generate_audio: false,
          content: { video_url: `${base}/files/video.mp4`, cover_url: `${base}/files/cover.png`, last_frame_url: `${base}/files/last.png` }
        });
        return;
      }
      if (taskMatch && request.method === "DELETE") {
        send(200, {});
        return;
      }
      if (request.method === "GET" && request.url === "/files/video.mp4" && videoPath) {
        const size = statSync(videoPath).size;
        response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size });
        createReadStream(videoPath).pipe(response);
        return;
      }
      if (request.method === "GET" && request.url === "/files/cover.png") {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === "GET" && request.url === "/files/last.png") {
        response.writeHead(404);
        response.end();
        return;
      }
      send(404, { error: { code: "NotFound", message: `no route ${request.method} ${request.url}` } });
    } catch (error) {
      send(500, { error: { code: "MockError", message: String(error?.stack ?? error) } });
    }
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    polls,
    close: () => new Promise((resolvePromise) => {
      server.closeAllConnections?.();
      server.close(() => resolvePromise());
    })
  };
}
