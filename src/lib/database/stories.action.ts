import { invoke } from "@tauri-apps/api/core";
import { getDatabase } from "./config.ts";

export interface Story {
  id: string;
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  metrics: string;
  tags: string[];
  company: string;
  role: string;
  verified: boolean;
  include_in_context: boolean;
}
export function blankStory(): Story {
  return {
    id: crypto.randomUUID(),
    title: "",
    situation: "",
    task: "",
    action: "",
    result: "",
    metrics: "",
    tags: [],
    company: "",
    role: "",
    verified: false,
    include_in_context: false,
  };
}
export async function listStories(): Promise<Story[]> {
  const db = await getDatabase();
  const rows = await db.select<
    (Omit<Story, "tags" | "verified" | "include_in_context"> & {
      tags: string;
      verified: number;
      include_in_context: number;
    })[]
  >("SELECT * FROM stories ORDER BY updated_at DESC");
  return rows.map((row) => ({
    ...row,
    tags: parseTags(row.tags),
    verified: row.verified === 1,
    include_in_context: row.include_in_context === 1,
  }));
}
function parseTags(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}
export async function saveStory(story: Story): Promise<void> {
  if (!story.title.trim()) throw new Error("Give this story a title");
  const db = await getDatabase();
  const now = Date.now();
  // Editing always resets approval, including when the input object carries verified=true.
  await db.execute(
    `INSERT INTO stories(id,title,situation,task,action,result,metrics,tags,company,role,verified,include_in_context,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,situation=excluded.situation,task=excluded.task,action=excluded.action,result=excluded.result,metrics=excluded.metrics,tags=excluded.tags,company=excluded.company,role=excluded.role,verified=0,include_in_context=excluded.include_in_context,updated_at=MAX(stories.updated_at+1,excluded.updated_at)`,
    [
      story.id,
      story.title,
      story.situation,
      story.task,
      story.action,
      story.result,
      story.metrics,
      JSON.stringify(story.tags),
      story.company,
      story.role,
      story.include_in_context ? 1 : 0,
      now,
      now,
    ],
  );
}
export async function approveStory(id: string): Promise<void> {
  await invoke("kb_index_story", { id, approve: true });
}
export async function setStoryIncluded(
  id: string,
  included: boolean,
): Promise<void> {
  const db = await getDatabase();
  await db.execute(
    "UPDATE stories SET include_in_context=?,updated_at=MAX(updated_at+1,?) WHERE id=?",
    [included ? 1 : 0, Date.now(), id],
  );
  await db.execute(
    "UPDATE documents SET include_in_context=? WHERE id=? AND kind='story'",
    [included ? 1 : 0, id],
  );
}
export async function deleteStory(id: string): Promise<void> {
  const db = await getDatabase();
  await db.execute("DELETE FROM stories WHERE id=?", [id]);
  await db.execute("DELETE FROM chunks WHERE document_id=?", [id]);
  await db.execute("DELETE FROM documents WHERE id=? AND kind='story'", [id]);
}
export const COMPETENCIES = [
  "leadership",
  "conflict",
  "failure",
  "ambiguity",
  "ownership",
  "collaboration",
  "disagreeing with a manager",
  "customer focus",
  "prioritization",
  "technical depth",
];
export function storyGaps(stories: Story[], jd = ""): string[] {
  const covered = new Set(
    stories
      .filter((s) => s.verified)
      .flatMap((s) => s.tags.map((t) => t.toLowerCase())),
  );
  const relevant = COMPETENCIES.filter(
    (c) =>
      !jd ||
      jd.toLowerCase().includes(c) ||
      ["leadership", "conflict", "failure", "ownership"].includes(c),
  );
  return relevant.filter((c) => !covered.has(c));
}
export function parseStoryDrafts(text: string): Story[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed))
    throw new Error("The provider did not return a story list");
  return parsed.slice(0, 10).map((item) => {
    const story = blankStory();
    if (!item || typeof item !== "object")
      throw new Error("Invalid story draft");
    for (const key of [
      "title",
      "situation",
      "task",
      "action",
      "result",
      "metrics",
      "company",
      "role",
    ] as const) {
      story[key] =
        typeof item[key] === "string" ? item[key].slice(0, 8000) : "";
    }
    story.tags = Array.isArray(item.tags)
      ? item.tags
          .filter((t: unknown): t is string => typeof t === "string")
          .slice(0, 20)
      : [];
    // Model-supplied approval/inclusion values are deliberately ignored.
    return story;
  });
}
