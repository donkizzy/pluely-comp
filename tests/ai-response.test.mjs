import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mockIPC } from "@tauri-apps/api/mocks";
import { runnerImport } from "vite";
import { AI_PROVIDERS } from "../src/config/ai-providers.constants.ts";

const { module: { fetchAIResponse } } = await runnerImport(
  "/src/lib/functions/ai-response.function.ts",
  { resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } } },
);

globalThis.window = globalThis;
Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => null } });

const request = {
  provider: AI_PROVIDERS.find(({ id }) => id === "openai"),
  selectedProvider: {
    provider: "openai",
    variables: { api_key: "test-key", model: "test-model" },
  },
  userMessage: "Hello",
};

async function collectResponse() {
  let answer = "";
  for await (const chunk of fetchAIResponse(request)) answer += chunk;
  return answer;
}

function mockProvider(status, parts, inspectRequest = () => {}) {
  const chunks = parts.map((part) => [...new TextEncoder().encode(part), 0]);
  chunks.push([1]);
  mockIPC((command, args) => {
    switch (command) {
      case "plugin:http|fetch":
        inspectRequest(args.clientConfig);
        return 1;
      case "plugin:http|fetch_send":
        return { status, url: "https://api.openai.com/v1/chat/completions", headers: [], rid: 2 };
      case "plugin:http|fetch_read_body":
        return chunks.shift();
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
}

test("streams an AI reply over native HTTP when the webview blocks provider requests", async (t) => {
  const browserFetch = t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Load failed");
  });
  mockProvider(
    200,
    ['data: {"choices":[{"delta":{"content":"Hi ', 'there"}}]}\n\ndata: [DONE]\n\n'],
    (config) => {
      assert.equal(config.url, "https://api.openai.com/v1/chat/completions");
      assert.equal(config.method, "POST");
      const headers = new Map(config.headers);
      assert.equal(headers.get("authorization"), "Bearer test-key");
      assert.equal(headers.get("content-type"), "application/json");
      const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(config.data)));
      assert.equal(payload.model, "test-model");
      assert.equal(payload.stream, true);
      assert.equal(payload.messages.at(-1).content[0].text, "Hello");
    },
  );
  assert.equal(await collectResponse(), "Hi there");
  assert.equal(browserFetch.mock.callCount(), 0);
});

test("surfaces provider HTTP failures through the error path", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Load failed");
  });
  mockProvider(401, ['{"error":{"message":"Invalid API key"}}']);
  await assert.rejects(collectResponse(), /401.*Invalid API key/);
});
