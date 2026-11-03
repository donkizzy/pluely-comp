import { useEffect, useRef, useState } from "react";
import { useApp } from "@/contexts";
import { fetchAIResponse } from "@/lib/functions/ai-response.function";

export function useKnowledgeAI() {
  const { selectedAIProvider, allAiProviders } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const generate = async (
    instructions: string,
    input: string,
  ): Promise<string> => {
    if (controller.current) throw new Error("A draft is already in progress");
    const provider = allAiProviders.find(
      (p) => p.id === selectedAIProvider.provider,
    );
    if (!provider) throw new Error("Select an AI provider in Dev Space first");
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError("");
    try {
      let text = "";
      for await (const chunk of fetchAIResponse({
        provider,
        selectedProvider: selectedAIProvider,
        systemPrompt: instructions,
        userMessage: input,
        signal: request.signal,
      }))
        text += chunk;
      if (request.signal.aborted) throw new Error("Draft cancelled");
      if (!text.trim()) throw new Error("The provider returned an empty draft");
      return text;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      if (controller.current === request) controller.current = null;
      setBusy(false);
    }
  };
  return {
    generate,
    busy,
    error,
    cancel: () => controller.current?.abort(),
    providerName: selectedAIProvider.provider,
  };
}
