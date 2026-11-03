// Per-question-type answer guidance and answer styles, appended to the
// user's system prompt for live interview answers.
import type { QuestionType } from "./classify";

export type AnswerStyle = "points" | "short" | "full";

export const ANSWER_STYLES: { id: AnswerStyle; label: string; title: string }[] =
  [
    { id: "points", label: "Points", title: "3-5 talking points to glance at" },
    { id: "short", label: "30 sec", title: "A 30-second answer to say out loud" },
    { id: "full", label: "Full", title: "A complete, structured answer" },
  ];

const STYLE_GUIDANCE: Record<AnswerStyle, string> = {
  points:
    "Answer as 3-5 short bullet talking points the candidate can glance at while speaking. No preamble.",
  short:
    "Answer in about 75 words (30 seconds spoken), first person, natural spoken language. No preamble.",
  full: "Give a complete, well-structured answer the candidate could say, first person. Use short paragraphs or bullets.",
};

const TYPE_GUIDANCE: Record<QuestionType, string> = {
  behavioral:
    "This is a behavioral question. Structure the answer as STAR (Situation, Task, Action, Result), lead with the result, and include a concrete metric. Use only experiences from the candidate's provided background; if none fits, say which kind of story to use instead of inventing one.",
  technical:
    "This is a technical concept question. Give a precise definition first, then one concrete example, then a trade-off or pitfall.",
  coding:
    "This is a coding question. Give the approach in plain words first, then concise code in a fenced block, then time and space complexity. Mention edge cases. If the problem is on screen, suggest the candidate take a screenshot.",
  system_design:
    "This is a system design question. Cover, in order: clarifying requirements, rough scale estimates, high-level components, data model, the key bottleneck and how to scale it, and trade-offs.",
  situational:
    "This is a hypothetical/situational question. Give a clear decision process: first steps, who to involve, how to measure success, and what to avoid.",
  small_talk:
    "This is small talk or an introduction. Keep it warm, brief and natural; for 'tell me about yourself', give a 3-part present-past-future pitch from the candidate's background.",
  logistics:
    "This is a logistics question (salary, start date, location, process). Answer briefly and professionally. Never invent numbers or dates; if the candidate's background doesn't state them, suggest a neutral phrasing instead.",
  other:
    "Help the candidate respond to what the interviewer just said: suggest what to say next.",
};

export function buildAnswerGuidance(
  type: QuestionType,
  style: AnswerStyle
): string {
  return `${TYPE_GUIDANCE[type]} ${STYLE_GUIDANCE[style]}`;
}
