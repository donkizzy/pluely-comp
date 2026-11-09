import {
  buildDynamicMessages,
  deepVariableReplacer,
  extractVariables,
  getByPath,
  getStreamingContent,
} from "./common.function";
import { Message, TYPE_PROVIDER } from "@/types";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import curl2Json from "@bany/curl-to-json";
import { getResponseSettings, RESPONSE_LENGTHS, LANGUAGES } from "@/lib";
import { MARKDOWN_FORMATTING_INSTRUCTIONS } from "@/config/constants";

function buildEnhancedSystemPrompt(baseSystemPrompt?: string): string {
  const responseSettings = getResponseSettings();
  const prompts: string[] = [];

  if (baseSystemPrompt) {
    prompts.push(baseSystemPrompt);
  }

  const lengthOption = RESPONSE_LENGTHS.find(
    (l) => l.id === responseSettings.responseLength
  );
  if (lengthOption?.prompt?.trim()) {
    prompts.push(lengthOption.prompt);
  }

  const languageOption = LANGUAGES.find(
    (l) => l.id === responseSettings.language
  );
  if (languageOption?.prompt?.trim()) {
    prompts.push(languageOption.prompt);
  }

  // Add markdown formatting instructions
  prompts.push(MARKDOWN_FORMATTING_INSTRUCTIONS);

  return prompts.join(" ");
}

export async function* fetchAIResponse(params: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: string[];
  signal?: AbortSignal;
}): AsyncIterable<string> {
  try {
    const {
      provider,
      selectedProvider,
      systemPrompt,
      history = [],
      userMessage,
      imagesBase64 = [],
      signal,
    } = params;

    // Check if already aborted
    if (signal?.aborted) {
      return;
    }

    const enhancedSystemPrompt = buildEnhancedSystemPrompt(systemPrompt);

    if (!provider) {
      throw new Error(`Provider not provided`);
    }
    if (!selectedProvider) {
      throw new Error(`Selected provider not provided`);
    }

    let curlJson;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    const extractedVariables = extractVariables(provider.curl);
    const requiredVars = extractedVariables.filter(
      ({ key }) => key !== "SYSTEM_PROMPT" && key !== "TEXT" && key !== "IMAGE"
    );
    for (const { key } of requiredVars) {
      if (
        !selectedProvider.variables?.[key] ||
        selectedProvider.variables[key].trim() === ""
      ) {
        throw new Error(
          `Missing required variable: ${key}. Please configure it in settings.`
        );
      }
    }

    if (!userMessage) {
      throw new Error("User message is required");
    }
    if (imagesBase64.length > 0 && !provider.curl.includes("{{IMAGE}}")) {
      throw new Error(
        `Provider ${provider?.id ?? "unknown"} does not support image input`
      );
    }

    let bodyObj: any = curlJson.data
      ? JSON.parse(JSON.stringify(curlJson.data))
      : {};
    const messagesKey = Object.keys(bodyObj).find((key) =>
      ["messages", "contents", "conversation", "history"].includes(key)
    );

    if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
      const finalMessages = buildDynamicMessages(
        bodyObj[messagesKey],
        history,
        userMessage,
        imagesBase64
      );
      bodyObj[messagesKey] = finalMessages;
    }

    const allVariables = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
      SYSTEM_PROMPT: enhancedSystemPrompt || "",
    };

    bodyObj = deepVariableReplacer(bodyObj, allVariables);
    const url = deepVariableReplacer(curlJson.url || "", allVariables);

    const headers = new Headers(deepVariableReplacer(curlJson.header || {}, allVariables));
    headers.set("Content-Type", "application/json");

    if (provider?.streaming) {
      if (typeof bodyObj === "object" && bodyObj !== null) {
        const streamKey = Object.keys(bodyObj).find(
          (k) => k.toLowerCase() === "stream"
        );
        if (streamKey) {
          bodyObj[streamKey] = true;
        } else {
          bodyObj.stream = true;
        }
      }
    }

    let response;
    try {
      // Provider requests run through Tauri because the webview CSP blocks them.
      response = await tauriFetch(url, {
        method: curlJson.method || "POST",
        headers,
        body: curlJson.method === "GET" ? undefined : JSON.stringify(bodyObj),
        signal,
      });
    } catch (fetchError) {
      // Check if aborted
      if (
        signal?.aborted ||
        (fetchError instanceof Error && fetchError.name === "AbortError")
      ) {
        return; // Silently return on abort
      }
      const detail =
        fetchError instanceof Error ? fetchError.message : String(fetchError);
      throw new Error(`Network error during API request: ${detail}`);
    }

    if (signal?.aborted) {
      await response.body?.cancel().catch(() => {});
      return;
    }

    if (!response.ok) {
      let errorText = "";
      try {
        errorText = await response.text();
      } catch {}
      throw new Error(`API request failed: ${response.status} ${response.statusText}${
        errorText ? ` - ${errorText}` : ""
      }`);
    }

    if (!provider?.streaming) {
      let json;
      try {
        json = await response.json();
      } catch (parseError) {
        throw new Error(`Failed to parse non-streaming response: ${
          parseError instanceof Error ? parseError.message : "Unknown error"
        }`);
      }
      const content =
        getByPath(json, provider?.responseContentPath || "") || "";
      yield content;
      return;
    }

    if (!response.body) {
      throw new Error("Streaming not supported or response body missing");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!signal?.aborted) {
        const { done, value } = await reader.read();
        if (done || signal?.aborted) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data:")) {
            const trimmed = line.substring(5).trim();
            if (!trimmed || trimmed === "[DONE]") continue;
            try {
              const parsed = JSON.parse(trimmed);
              const delta = getStreamingContent(
                parsed,
                provider?.responseContentPath || ""
              );
              if (delta) {
                yield delta;
              }
            } catch {
              // Ignore parsing errors for partial JSON chunks
            }
          }
        }
      }
    } catch (readError) {
      if (readError instanceof Error && readError.name === "AbortError") return;
      const detail =
        readError instanceof Error ? readError.message : String(readError);
      throw new Error(`Error reading stream: ${detail}`);
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    if (params.signal?.aborted) return;
    throw error;
  }
}
