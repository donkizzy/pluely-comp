import { test } from "node:test";
import assert from "node:assert/strict";
import { isLikelyQuestion, classifyQuestion } from "../src/lib/interview/classify.ts";

test("detects questions with and without a question mark", () => {
  for (const text of [
    "What's your experience with Kubernetes?",
    "Tell me about a time you disagreed with your manager",
    "Okay so walk me through how you'd design a rate limiter",
    "Thanks for that. How did you measure the impact",
    "I'd love to hear how you would approach scaling the payments service",
  ]) {
    assert.equal(isLikelyQuestion(text), true, text);
  }
});

test("ignores statements and fragments", () => {
  for (const text of [
    "Great, thanks.",
    "So our team works mostly on the checkout flow.",
    "We use React and Go here.",
    "Uh huh",
  ]) {
    assert.equal(isLikelyQuestion(text), false, text);
  }
});

test("classifies common interview question types", () => {
  const cases = [
    ["Tell me about a time you had a conflict with a colleague", "behavioral"],
    ["How would you design a URL shortener that scales to millions of users?", "system_design"],
    ["Write a function that reverses a linked list", "coding"],
    ["What would you do if a release broke production on a Friday?", "situational"],
    ["What's the difference between a process and a thread?", "technical"],
    ["What are your salary expectations?", "logistics"],
    ["Tell me about yourself", "small_talk"],
    ["Hmm, interesting, go on", "other"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyQuestion(text), expected, text);
  }
});
