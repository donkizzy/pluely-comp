import { assembleContext } from "./build-context.ts";

export type QuestionType =
  | "behavioral"
  | "technical"
  | "coding"
  | "system_design"
  | "situational"
  | "small_talk"
  | "logistics"
  | "other";

export interface StoryCard {
  id: string;
  title: string;
  short: string;
  long?: string;
  verified: boolean;
}

export interface ContextRequest {
  question: string;
  questionType?: QuestionType;
  history?: { role: "user" | "assistant"; content: string }[];
}

export interface ContextResult {
  /** User-approved contract extension, 2026-11-03. */
  prepPack?: string;
  systemPromptAddendum: string;
  stories: StoryCard[];
  keyterms: string[];
}

export async function buildInterviewContext(
  req: ContextRequest,
): Promise<ContextResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const empty = (): ContextResult => ({
    systemPromptAddendum: "",
    stories: [],
    keyterms: [],
  });
  try {
    const result = await Promise.race([
      assembleContext(req),
      new Promise<ContextResult>((resolve) => {
        timer = setTimeout(() => resolve(empty()), 45);
      }),
    ]);
    return {
      ...result,
      stories: result.stories
        .filter((story) => story.verified === true)
        .slice(0, 2),
    };
  } catch {
    return empty();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The user's system prompt plus the personalization addendum for this
 * question (empty unless the profile, a source or the active session is
 * included in context). Never throws; bounded by buildInterviewContext.
 */
export async function personalizeSystemPrompt(
  base: string,
  question: string,
): Promise<string> {
  const { systemPromptAddendum } = await buildInterviewContext({ question });
  return [base.trim(), systemPromptAddendum.trim()]
    .filter(Boolean)
    .join("\n\n");
}
