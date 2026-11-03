import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
  Textarea,
} from "@/components";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { useApp } from "@/contexts";
import { fetchAIResponse } from "@/lib";

interface GenerateSystemPromptProps {
  onGenerate: (prompt: string, promptName: string) => void;
}

const GENERATOR_INSTRUCTIONS = `You write system prompts for a real-time desktop AI assistant used during meetings and interviews.
Given the user's description, reply with ONLY a JSON object, no code fences:
{"prompt_name": "<2-5 word name>", "system_prompt": "<the full system prompt>"}`;

// Models sometimes wrap JSON in prose or fences; take the outermost object.
function parseGeneratedPrompt(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (
      typeof parsed.prompt_name === "string" &&
      typeof parsed.system_prompt === "string" &&
      parsed.system_prompt.trim()
    ) {
      return parsed as { prompt_name: string; system_prompt: string };
    }
  } catch {}
  return null;
}

export const GenerateSystemPrompt = ({
  onGenerate,
}: GenerateSystemPromptProps) => {
  const { selectedAIProvider, allAiProviders } = useApp();
  const [userPrompt, setUserPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleGenerate = async () => {
    if (!userPrompt.trim()) {
      setError("Please describe what you want");
      return;
    }

    try {
      setIsGenerating(true);
      setError(null);

      const provider = allAiProviders.find(
        (p) => p.id === selectedAIProvider.provider
      );
      if (!provider) {
        setError("Select an AI provider in Dev Space first");
        return;
      }

      let text = "";
      for await (const chunk of fetchAIResponse({
        provider,
        selectedProvider: selectedAIProvider,
        systemPrompt: GENERATOR_INSTRUCTIONS,
        userMessage: userPrompt.trim(),
      })) {
        text += chunk;
      }

      const response = parseGeneratedPrompt(text);
      if (!response) {
        setError("The AI didn't return a usable prompt. Try again.");
        return;
      }
      onGenerate(response.system_prompt, response.prompt_name);
      setIsOpen(false);
      setUserPrompt("");
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to generate prompt";
      setError(errorMessage);
      console.error("Error generating system prompt:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Generate with AI"
          size="sm"
          variant="outline"
          className="w-fit"
        >
          <SparklesIcon className="h-4 w-4" /> Generate with AI
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-96 p-4 border shadow-lg"
      >
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium mb-1">Generate a system prompt</p>
            <p className="text-xs text-muted-foreground">
              Describe the AI behavior you want, and we'll generate a prompt for
              you.
            </p>
          </div>

          <Textarea
            placeholder="e.g., I want an AI that helps me with code reviews and focuses on best practices..."
            className="min-h-[100px] resize-none border-1 border-input/50 focus:border-primary/50 transition-colors"
            value={userPrompt}
            onChange={(e) => {
              setUserPrompt(e.target.value);
              setError(null);
            }}
            disabled={isGenerating}
          />

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button
            className="w-full"
            onClick={handleGenerate}
            disabled={!userPrompt.trim() || isGenerating}
          >
            {isGenerating ? (
              <>
                <SparklesIcon className="h-4 w-4 animate-pulse" />
                Generating...
              </>
            ) : (
              <>
                <SparklesIcon className="h-4 w-4" />
                Generate
              </>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
