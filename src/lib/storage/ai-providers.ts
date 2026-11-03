import { STORAGE_KEYS } from "@/config";
import { TYPE_PROVIDER } from "@/types";

import { loadSensitiveSetting, saveSensitiveSetting } from "./provider-credentials";

export async function getCustomAiProviders(): Promise<TYPE_PROVIDER[]> {
  const saved = await loadSensitiveSetting(STORAGE_KEYS.CUSTOM_AI_PROVIDERS);
  if (!saved) return [];
  const parsed = JSON.parse(saved);
  if (!Array.isArray(parsed)) throw new Error("Invalid custom provider settings");
  return parsed.filter((p: TYPE_PROVIDER) => p.id && p.isCustom && typeof p.curl === "string");
}

export async function setCustomAiProviders(providers: TYPE_PROVIDER[]): Promise<void> {
  await saveSensitiveSetting(STORAGE_KEYS.CUSTOM_AI_PROVIDERS, JSON.stringify(providers));
}

export async function addCustomAiProvider(
  newProvider: Omit<TYPE_PROVIDER, "id" | "isCustom">
): Promise<TYPE_PROVIDER | null> {
  try {
    const providers = await getCustomAiProviders();
    const id = `custom-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;
    const provider: TYPE_PROVIDER = {
      ...newProvider,
      id,
      isCustom: true,
    };
    providers.push(provider);
    await setCustomAiProviders(providers);
    return provider;
  } catch (error) {
    console.error("Error adding custom AI provider:", error);
    return null;
  }
}

export async function updateCustomAiProvider(
  id: string,
  updates: Partial<TYPE_PROVIDER>
): Promise<boolean> {
  try {
    const providers = await getCustomAiProviders();
    const index = providers.findIndex((p) => p.id === id && p.isCustom);
    if (index === -1) return false;
    providers[index] = { ...providers[index], ...updates };
    await setCustomAiProviders(providers);
    return true;
  } catch (error) {
    console.error("Error updating custom AI provider:", error);
    return false;
  }
}

export async function removeCustomAiProvider(id: string): Promise<boolean> {
  try {
    const providers = await getCustomAiProviders();
    const filtered = providers.filter((p) => p.id !== id);
    if (filtered.length === providers.length) return false; // No removal happened
    await setCustomAiProviders(filtered);
    return true;
  } catch (error) {
    console.error("Error removing custom AI provider:", error);
    return false;
  }
}
