import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mockIPC } from "@tauri-apps/api/mocks";
import { loadProviderSelection, saveProviderSelection, loadSensitiveSetting } from "../src/lib/storage/provider-credentials.ts";

const key = "curl_selected_ai_provider";
let disk, secure, rejectWrites;
globalThis.window = globalThis;
beforeEach(() => {
  disk = new Map(); secure = new Map(); rejectWrites = false;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (name) => disk.get(name) ?? null,
    setItem: (name, value) => disk.set(name, value),
  } });
  mockIPC((command, args) => {
    if (command === "provider_settings_get") return secure.get(args.key) ?? null;
    if (command === "provider_settings_save") {
      if (rejectWrites) throw new Error("Credential store locked");
      secure.set(args.key, args.value);
      return;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

test("migrates legacy API keys and keeps only non-sensitive metadata on disk", async () => {
  const value = { provider: "openai", variables: { API_KEY: "test-secret" } };
  disk.set(key, JSON.stringify(value));
  assert.deepEqual(await loadProviderSelection(key, "deepseek"), value);
  assert.equal(JSON.parse(secure.get(key)).variables.API_KEY, "test-secret");
  assert.equal(disk.get(key).includes("test-secret"), false);
  assert.equal(JSON.parse(disk.get(key)).provider, "openai");
});

test("failed secure migration preserves existing credentials for recovery", async () => {
  const original = JSON.stringify({ provider: "openai", variables: { API_KEY: "test-secret" } });
  disk.set(key, original); rejectWrites = true;
  await assert.rejects(loadProviderSelection(key, "deepseek"));
  assert.equal(disk.get(key), original);
});

test("credential changes create a synchronization event without exposing keys", async () => {
  await saveProviderSelection(key, { provider: "openai", variables: { API_KEY: "first" } });
  const original = disk.get(key);
  await saveProviderSelection(key, { provider: "openai", variables: { API_KEY: "second" } });
  assert.notEqual(disk.get(key), original);
  assert.equal(disk.get(key).includes("second"), false);
  const latest = disk.get(key);
  await saveProviderSelection(key, { provider: "openai", variables: { API_KEY: "second" } });
  assert.equal(disk.get(key), latest);
});

test("custom cURL templates are migrated to secure storage", async () => {
  const customKey = "curl_custom_ai_providers";
  const original = JSON.stringify([{ id: "custom", curl: "curl -H 'Authorization: Bearer test-secret'" }]);
  disk.set(customKey, original);
  assert.equal(await loadSensitiveSetting(customKey), original);
  assert.equal(disk.get(customKey).includes("test-secret"), false);
  assert.equal(await loadSensitiveSetting(customKey), original);
});
