import { invoke } from "@tauri-apps/api/core";

export type ProviderSelection = { provider: string; variables: Record<string, string> };

export async function loadSensitiveSetting(key: string): Promise<string | null> {
  const secured = await invoke<string | null>("provider_settings_get", { key });
  if (secured !== null) return secured;
  const legacy = localStorage.getItem(key);
  if (legacy && !legacy.startsWith("{\"secured\":true,")) {
    await saveSensitiveSetting(key, legacy);
    return legacy;
  }
  return null;
}

export async function saveSensitiveSetting(key: string, value: string): Promise<void> {
  await invoke("provider_settings_save", { key, value });
  localStorage.setItem(key, JSON.stringify({ secured: true, revision: crypto.randomUUID() }));
}

function parseSelection(value: string): ProviderSelection {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed.provider !== "string" || !parsed.variables ||
      typeof parsed.variables !== "object" || Array.isArray(parsed.variables) ||
      !Object.values(parsed.variables).every((item) => typeof item === "string")) {
    throw new Error("Invalid provider settings");
  }
  return { provider: parsed.provider, variables: parsed.variables };
}

export async function loadProviderSelection(key: string, fallback: string): Promise<ProviderSelection> {
  const secured = await invoke<string | null>("provider_settings_get", { key });
  if (secured !== null) return parseSelection(secured);
  const legacy = localStorage.getItem(key);
  const selection = legacy ? parseSelection(legacy) : { provider: fallback, variables: {} };
  // Only remove plaintext variables after a successful OS credential-store write.
  await saveProviderSelection(key, selection);
  return selection;
}

export async function saveProviderSelection(key: string, selection: ProviderSelection): Promise<void> {
  const value = JSON.stringify(selection);
  const current = await invoke<string | null>("provider_settings_get", { key });
  if (current !== value) await invoke("provider_settings_save", { key, value });
  // Non-sensitive metadata keeps window synchronization and startup selection working.
  const existing = localStorage.getItem(key);
  let clean = false;
  try {
    const metadata = JSON.parse(existing || "null");
    clean = metadata?.secured === true && metadata.provider === selection.provider &&
      Object.keys(metadata.variables || {}).length === 0;
  } catch { /* Replace legacy or malformed metadata after the secure write. */ }
  if (current !== value || !clean) {
    localStorage.setItem(key, JSON.stringify({
      provider: selection.provider, variables: {}, secured: true, revision: crypto.randomUUID(),
    }));
  }
}
