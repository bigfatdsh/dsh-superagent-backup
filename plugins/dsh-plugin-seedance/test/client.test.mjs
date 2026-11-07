import test from "node:test";
import assert from "node:assert/strict";
import { startMockArk } from "./helpers.mjs";
import { createSeedanceClient, ArkApiError } from "../lib/client.js";

test("client submits, polls to success, cancels, and lists models", async (t) => {
  const mock = await startMockArk();
  t.after(() => mock.close());
  const client = createSeedanceClient({ baseUrl: mock.base, apiKey: "test-key" });
  const submitted = await client.submitTask({ model: "doubao-seedance-2-5-260628", content: [{ type: "text", text: "hello" }] });
  assert.match(submitted.id, /^cgt-mock-/);
  const running = await client.getTask(submitted.id);
  assert.equal(running.status, "running");
  const done = await client.getTask(submitted.id);
  assert.equal(done.status, "succeeded");
  assert.match(done.content.video_url, /\/files\/video\.mp4$/);
  await client.cancelTask(submitted.id);
  const models = await client.listModels();
  assert.equal(models.data[0].id, "doubao-seedance-2-5-260628");
});

test("client surfaces status, error code, and request id", async (t) => {
  const mock = await startMockArk();
  t.after(() => mock.close());
  const client = createSeedanceClient({ baseUrl: mock.base, apiKey: "test-key" });
  await assert.rejects(
    () => client.submitTask({ prompt: "TRIGGER_ERROR" }),
    (error) => {
      assert.ok(error instanceof ArkApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "InvalidParameter");
      assert.equal(error.requestId, "req-mock-1");
      assert.match(error.message, /mock rejected prompt/);
      return true;
    }
  );
});

test("client rejects missing key and bad base URL", () => {
  assert.throws(() => createSeedanceClient({ baseUrl: "http://x", apiKey: "" }), /API key is required/);
  assert.throws(() => createSeedanceClient({ baseUrl: "ftp://x", apiKey: "k" }), /baseUrl/);
});
