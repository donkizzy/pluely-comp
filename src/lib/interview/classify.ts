// Question detection and classification for live interview audio.
// Pure string heuristics: runs on every transcript segment, so it must be
// instant and must not call a model.

// Mirrors QuestionType in src/lib/context (owned by the knowledge track).
// Switch to importing it from there once that module lands on main.
export type QuestionType =
  | "behavioral"
  | "technical"
  | "coding"
  | "system_design"
  | "situational"
  | "small_talk"
  | "logistics"
  | "other";

const QUESTION_STARTS = [
  "what",
  "why",
  "how",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "can you",
  "could you",
  "would you",
  "will you",
  "do you",
  "did you",
  "have you",
  "are you",
  "is there",
  "is it",
  "tell me",
  "walk me through",
  "talk me through",
  "describe",
  "explain",
  "give me an example",
  "share an example",
  "imagine",
  "suppose",
  "say you",
  "let's say",
  "design",
  "implement",
  "write a",
  "write me",
];

// Phrases that make an utterance a request even mid-sentence.
const QUESTION_PHRASES = [
  "tell me about",
  "walk me through",
  "can you explain",
  "how would you",
  "what would you",
  "why did you",
  "how did you",
  "give me an example",
  "a time when",
  "a time you",
  "what's your",
  "what is your",
  "how do you",
  // Indirect questions
  "how you would",
  "how you'd",
  "what you would",
  "what you'd",
  "i'd love to hear",
  "i'm curious",
  "walk us through",
];

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// Drop conversational lead-ins so "Okay, so tell me..." counts as a question.
const stripFillers = (text: string) =>
  text.replace(
    /^((ok(ay)?|so|alright|all right|right|great|cool|well|um+|uh+|and|now|next)[\s,.!-]+)+/,
    ""
  );

export function isLikelyQuestion(text: string): boolean {
  const normalized = normalize(text);
  if (normalized.split(" ").length < 3) return false;
  if (normalized.includes("?")) return true;

  // Check every sentence: the question is often the last of several.
  const sentences = normalized
    .split(/[.!]\s+/)
    .map((s) => stripFillers(s.trim()))
    .filter(Boolean);
  if (
    sentences.some((s) =>
      QUESTION_STARTS.some((start) => s === start || s.startsWith(`${start} `))
    )
  ) {
    return true;
  }
  return QUESTION_PHRASES.some((phrase) => normalized.includes(phrase));
}

const RULES: { type: QuestionType; patterns: RegExp[] }[] = [
  {
    type: "logistics",
    patterns: [
      /\b(salary|compensation|notice period|start date|relocat\w*|visa|sponsorship|benefits|remote|hybrid|on-?site|next steps|timeline)\b/,
    ],
  },
  {
    type: "behavioral",
    patterns: [
      /\b(tell me about a time|a time (when|you)|give me an example of|describe a situation|share an example)\b/,
      /\b(conflict|disagree\w*|mistake|failure|failed|challenge|proud|difficult (person|stakeholder|colleague)|feedback|leadership|took ownership|went wrong)\b/,
    ],
  },
  {
    type: "system_design",
    patterns: [
      /\b(design (a|an|the)|system design|architect\w*|scal(e|ing|able)|high availability|load balanc\w*|sharding|rate limiter|url shortener|distributed)\b/,
    ],
  },
  {
    type: "coding",
    patterns: [
      /\b(write (a|an|the)? ?(function|method|program|query|code)|implement|algorithm|time complexity|space complexity|big o|leetcode|array|linked list|binary tree|reverse a|two sum)\b/,
    ],
  },
  {
    type: "situational",
    patterns: [
      /\b(what would you do|how would you handle|imagine|suppose|let's say|if you (were|had))\b/,
    ],
  },
  {
    type: "technical",
    patterns: [
      /\b(explain|difference between|how does|what is|what are|why (do|does|is|would)|pros and cons|trade-?offs?)\b/,
    ],
  },
  {
    type: "small_talk",
    patterns: [
      /\b(how are you|how's your day|how is your day|weekend|weather|tell me about yourself|introduce yourself|walk me through your (resume|background|cv))\b/,
    ],
  },
];

export function classifyQuestion(text: string): QuestionType {
  const normalized = normalize(text);
  for (const { type, patterns } of RULES) {
    if (patterns.some((pattern) => pattern.test(normalized))) return type;
  }
  return "other";
}
