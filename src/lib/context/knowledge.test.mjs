import { beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { buildInterviewContext } from "./index.ts";
import { profileContext, sourceContext, limitText } from "./policy.ts";
import { emptyProfile, saveProfile } from "../database/knowledge.action.ts";
import {
  blankStory,
  saveStory,
  parseStoryDrafts,
} from "../database/stories.action.ts";
let db, disk, hits, fail, delay, slowSearch;
globalThis.window = globalThis;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  disk = new Map();
  hits = [];
  fail = false;
  delay = false;
  slowSearch = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k) => disk.get(k) ?? null,
      setItem: (k, v) => disk.set(k, v),
      removeItem: (k) => disk.delete(k),
    },
  });
  for (const file of [
    "system-prompts",
    "chat-history",
    "knowledge",
    "stories",
    "sessions",
  ])
    db.exec(
      readFileSync(
        new URL(
          `../../../src-tauri/src/db/migrations/${file}.sql`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  mockIPC(async (command, args) => {
    if (fail) throw new Error("DB offline");
    if (delay) return new Promise(() => {});
    if (command === "plugin:sql|load") return args.db;
    if (command === "plugin:sql|select")
      return db.prepare(args.query).all(...(args.values ?? []));
    if (command === "plugin:sql|execute") {
      const r = db.prepare(args.query).run(...(args.values ?? []));
      return [Number(r.changes), Number(r.lastInsertRowid)];
    }
    if (command === "kb_search")
      return slowSearch ? new Promise(() => {}) : hits;
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(() => {
  db.close();
  clearMocks();
});
test("migration preserves existing conversations and adds FTS with deletion cleanup", () => {
  db.prepare(
    "INSERT INTO conversations(id,title,created_at,updated_at) VALUES('old','Old interview',1,1)",
  ).run();
  assert.equal(
    db.prepare("SELECT session_id FROM conversations").get().session_id,
    null,
  );
  db.prepare(
    "INSERT INTO documents VALUES('d','resume','Resume',NULL,'Kubernetes',1,1,1)",
  ).run();
  db.prepare("INSERT INTO chunks VALUES('c','d',0,'Kubernetes',NULL,10)").run();
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'Kubernetes'",
      )
      .get().n,
    1,
  );
  db.prepare("DELETE FROM documents WHERE id='d'").run();
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'Kubernetes'",
      )
      .get().n,
    0,
  );
});
test("privacy formatter omits salary, gates profile, respects UTF-8 budget and de-duplicates sources", () => {
  const p = {
    ...emptyProfile,
    includeInContext: true,
    name: "Ada",
    salaryExpectations: "PRIVATE SALARY",
    summary: "🦀".repeat(1000),
  };
  assert.ok(!profileContext(p).includes("PRIVATE SALARY"));
  assert.ok(new TextEncoder().encode(profileContext(p)).length <= 300);
  assert.equal(profileContext({ ...p, includeInContext: false }), "");
  assert.equal(limitText("🦀abc", 5), "🦀a");
  const hit = {
    id: "1",
    document_id: "d",
    kind: "resume",
    title: "CV",
    text: "Evidence",
    score: 1,
  };
  assert.equal(
    sourceContext([hit, { ...hit, id: "2" }]).match(/Evidence/g).length,
    1,
  );
});
test("LLM cannot set approval or inclusion, and editing revokes approval in SQLite", async () => {
  const drafts = parseStoryDrafts(
    '[{"title":"Draft","verified":true,"include_in_context":true,"tags":["leadership",99]}]',
  );
  assert.equal(drafts[0].verified, false);
  assert.equal(drafts[0].include_in_context, false);
  assert.deepEqual(drafts[0].tags, ["leadership"]);
  const story = {
    ...blankStory(),
    title: "Launch",
    situation: "Context",
    task: "Goal",
    action: "My action",
    result: "Real result",
    verified: true,
    include_in_context: true,
  };
  await saveStory(story);
  assert.equal(
    db.prepare("SELECT verified FROM stories WHERE id=?").get(story.id)
      .verified,
    0,
  );
  db.prepare("UPDATE stories SET verified=1 WHERE id=?").run(story.id);
  db.prepare("UPDATE stories SET action='Different claim' WHERE id=?").run(
    story.id,
  );
  assert.equal(
    db.prepare("SELECT verified FROM stories WHERE id=?").get(story.id)
      .verified,
    0,
  );
  assert.throws(() =>
    db
      .prepare("UPDATE stories SET situation='',verified=1 WHERE id=?")
      .run(story.id),
  );
});
test("live context returns at most two approved, included stories and active session context", async () => {
  await saveProfile({
    ...emptyProfile,
    name: "Ada",
    includeInContext: true,
    salaryExpectations: "PRIVATE SALARY",
  });
  for (let i = 0; i < 5; i++) {
    const story = {
      ...blankStory(),
      id: `s${i}`,
      title: `Story ${i}`,
      situation: "Real context",
      task: "Goal",
      action: "I delivered",
      result: "Worked",
      include_in_context: i !== 4,
    };
    await saveStory(story);
    if (i !== 3)
      db.prepare("UPDATE stories SET verified=1 WHERE id=?").run(story.id);
    hits.push({
      id: `c${i}`,
      document_id: story.id,
      kind: "story",
      title: story.title,
      text: "Must use authoritative STAR fields",
      score: 1,
    });
  }
  db.prepare(
    "INSERT INTO interview_sessions(id,company,role,include_in_context,prep_pack,created_at,updated_at) VALUES('active','Example Co','Engineer',1,'Approved prep sheet',1,1)",
  ).run();
  disk.set("active_interview_session_id", "active");
  const result = await buildInterviewContext({
    question: "Tell me about a time",
    questionType: "behavioral",
  });
  assert.equal(result.prepPack, "Approved prep sheet");
  assert.equal(result.stories.length, 2);
  assert.ok(result.stories.every((s) => s.verified));
  assert.match(result.systemPromptAddendum, /Example Co/);
  assert.ok(result.keyterms.includes("Example Co"));
  assert.ok(!result.systemPromptAddendum.includes("PRIVATE SALARY"));
  assert.ok(!result.systemPromptAddendum.includes("Story 3"));
});
test("errors and a hung backend return empty context promptly", async () => {
  fail = true;
  assert.deepEqual(await buildInterviewContext({ question: "hi" }), {
    systemPromptAddendum: "",
    stories: [],
    keyterms: [],
  });
  fail = false;
  delay = true;
  const start = performance.now();
  assert.deepEqual(await buildInterviewContext({ question: "hi" }), {
    systemPromptAddendum: "",
    stories: [],
    keyterms: [],
  });
  assert.ok(performance.now() - start < 200);
});

test("session links are captured once and deleting a chat removes its indexed copy", async () => {
  const { saveConversation, deleteConversation } =
    await import("../database/chat-history.action.ts");
  for (const id of ["first", "second"])
    db.prepare(
      "INSERT INTO interview_sessions(id,company,role,created_at,updated_at) VALUES(?,?,'Engineer',1,1)",
    ).run(id, id);
  disk.set("active_interview_session_id", "first");
  const conversation = {
    id: "chat",
    title: "Interview",
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: "q1", role: "user", content: "Question", timestamp: 1 }],
  };
  await saveConversation(conversation);
  assert.equal(
    db.prepare("SELECT session_id FROM conversations WHERE id='chat'").get()
      .session_id,
    "first",
  );
  disk.set("active_interview_session_id", "second");
  await saveConversation({
    ...conversation,
    updatedAt: 2,
    messages: [
      ...conversation.messages,
      { id: "a1", role: "assistant", content: "Suggestion", timestamp: 2 },
    ],
  });
  assert.equal(
    db.prepare("SELECT session_id FROM conversations WHERE id='chat'").get()
      .session_id,
    "first",
  );
  db.prepare(
    "INSERT INTO documents VALUES('transcript:chat','transcript','History',NULL,'Question',0,1,1)",
  ).run();
  db.prepare(
    "INSERT INTO chunks VALUES('tc','transcript:chat',0,'Question',NULL,8)",
  ).run();
  await deleteConversation("chat");
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM documents WHERE id='transcript:chat'")
      .get().n,
    0,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM chunks WHERE id='tc'").get().n,
    0,
  );
});
test("an excluded active session exposes neither prep pack nor session details", async () => {
  db.prepare(
    "INSERT INTO interview_sessions(id,company,role,include_in_context,prep_pack,created_at,updated_at) VALUES('hidden','PRIVATE CO','Engineer',0,'PRIVATE PREP',1,1)",
  ).run();
  disk.set("active_interview_session_id", "hidden");
  const result = await buildInterviewContext({ question: "hello" });
  assert.equal(result.prepPack, undefined);
  assert.ok(!result.systemPromptAddendum.includes("PRIVATE CO"));
  assert.ok(!result.keyterms.includes("PRIVATE CO"));
});

test("a stalled search still sends the profile instead of dropping all context", async () => {
  await saveProfile({
    ...emptyProfile,
    includeInContext: true,
    name: "Ada",
    summary: "Builds payment systems.",
  });
  slowSearch = true;
  const result = await buildInterviewContext({ question: "Tell me about yourself" });
  assert.match(result.systemPromptAddendum, /Name: Ada/);
  assert.match(result.systemPromptAddendum, /Builds payment systems/);
  assert.ok(!result.systemPromptAddendum.includes("Never say"));
});
