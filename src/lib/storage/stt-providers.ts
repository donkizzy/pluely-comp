import { STORAGE_KEYS } from "@/config";
import { TYPE_PROVIDER } from "@/types";

import { loadSensitiveSetting, saveSensitiveSetting } from "./provider-credentials";

export async function getCustomSttProviders(): Promise<TYPE_PROVIDER[]> {
  const saved = await loadSensitiveSetting(STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS);
  if (!saved) return [];
  const parsed = JSON.parse(saved);
  if (!Array.isArray(parsed)) throw new Error("Invalid custom provider settings");
  return parsed.filter((p: TYPE_PROVIDER) => p.id && p.isCustom && typeof p.curl === "string");
}

export async function setCustomSttProviders(providers: TYPE_PROVIDER[]): Promise<void> {
  await saveSensitiveSetting(STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS, JSON.stringify(providers));
}

export async function addCustomSttProvider(
  newProvider: Omit<TYPE_PROVIDER, "id" | "isCustom">
): Promise<TYPE_PROVIDER | null> {
  try {
    const providers = await getCustomSttProviders();
    const id = `custom-stt-${Date.now()}`;
    const provider: TYPE_PROVIDER = {
      ...newProvider,
      id,
      isCustom: true,
    };
    providers.push(provider);
    await setCustomSttProviders(providers);
    return provider;
  } catch (error) {
    console.error("Error adding custom STT provider:", error);
    return null;
  }
}

export async function updateCustomSttProvider(
  id: string,
  updates: Partial<TYPE_PROVIDER>
): Promise<boolean> {
  try {
    const providers = await getCustomSttProviders();
    const index = providers.findIndex((p) => p.id === id && p.isCustom);
    if (index === -1) return false;
    providers[index] = { ...providers[index], ...updates };
    await setCustomSttProviders(providers);
    return true;
  } catch (error) {
    console.error("Error updating custom STT provider:", error);
    return false;
  }
}

export async function removeCustomSttProvider(id: string): Promise<boolean> {
  try {
    const providers = await getCustomSttProviders();
    const filtered = providers.filter((p) => p.id !== id);
    if (filtered.length === providers.length) return false;
    await setCustomSttProviders(filtered);
    return true;
  } catch (error) {
    console.error("Error removing custom STT provider:", error);
    return false;
  }
}
