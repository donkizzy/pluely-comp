export type QuestionType =
  | "behavioral" | "technical" | "coding" | "system_design"
  | "situational" | "small_talk" | "logistics" | "other";

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
  systemPromptAddendum: string;
  stories: StoryCard[];
  keyterms: string[];
}

export async function buildInterviewContext(_req: ContextRequest): Promise<ContextResult> {
  return { systemPromptAddendum: "", stories: [], keyterms: [] };
}
