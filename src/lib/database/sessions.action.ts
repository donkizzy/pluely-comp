import { getDatabase } from "./config.ts";
import { readActiveSessionId } from "../context/active-session.ts";

export interface InterviewSession {
  id: string;
  company: string;
  role: string;
  round_type: string;
  interviewer_names: string;
  job_description: string;
  jd_source_uri: string;
  scheduled_at: string;
  prompt_template: string;
  include_in_context: boolean;
  prep_pack: string;
  debrief: string;
  thank_you: string;
}
export function blankSession(): InterviewSession {
  return {
    id: crypto.randomUUID(),
    company: "",
    role: "",
    round_type: "behavioral",
    interviewer_names: "",
    job_description: "",
    jd_source_uri: "",
    scheduled_at: "",
    prompt_template: "",
    include_in_context: false,
    prep_pack: "",
    debrief: "",
    thank_you: "",
  };
}
export async function listSessions(): Promise<InterviewSession[]> {
  const db = await getDatabase();
  const rows = await db.select<
    (Omit<InterviewSession, "include_in_context"> & {
      include_in_context: number;
    })[]
  >(
    "SELECT * FROM interview_sessions ORDER BY scheduled_at DESC, updated_at DESC",
  );
  return rows.map((r) => ({
    ...r,
    include_in_context: r.include_in_context === 1,
  }));
}
export async function getActiveSession(): Promise<InterviewSession | null> {
  const id = readActiveSessionId();
  if (!id) return null;
  const db = await getDatabase();
  const rows = await db.select<
    (Omit<InterviewSession, "include_in_context"> & {
      include_in_context: number;
    })[]
  >("SELECT * FROM interview_sessions WHERE id=?", [id]);
  return rows[0]
    ? { ...rows[0], include_in_context: rows[0].include_in_context === 1 }
    : null;
}
export async function saveSession(session: InterviewSession): Promise<void> {
  if (!session.company.trim() || !session.role.trim())
    throw new Error("Company and role are required");
  const db = await getDatabase();
  const now = Date.now();
  await db.execute(
    `INSERT INTO interview_sessions(id,company,role,round_type,interviewer_names,job_description,jd_source_uri,scheduled_at,prompt_template,include_in_context,prep_pack,debrief,thank_you,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET company=excluded.company,role=excluded.role,round_type=excluded.round_type,interviewer_names=excluded.interviewer_names,job_description=excluded.job_description,jd_source_uri=excluded.jd_source_uri,scheduled_at=excluded.scheduled_at,prompt_template=excluded.prompt_template,include_in_context=excluded.include_in_context,prep_pack=excluded.prep_pack,debrief=excluded.debrief,thank_you=excluded.thank_you,updated_at=excluded.updated_at`,
    [
      session.id,
      session.company,
      session.role,
      session.round_type,
      session.interviewer_names,
      session.job_description,
      session.jd_source_uri,
      session.scheduled_at,
      session.prompt_template,
      session.include_in_context ? 1 : 0,
      session.prep_pack,
      session.debrief,
      session.thank_you,
      now,
      now,
    ],
  );
}
export async function deleteSession(id: string): Promise<void> {
  const db = await getDatabase();
  await db.execute(
    "UPDATE conversations SET session_id=NULL WHERE session_id=?",
    [id],
  );
  await db.execute("DELETE FROM interview_sessions WHERE id=?", [id]);
}
export async function sessionTranscript(id: string): Promise<string> {
  const db = await getDatabase();
  const rows = await db.select<
    { title: string; role: string; content: string }[]
  >(
    `SELECT c.title,m.role,m.content FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.session_id=? AND m.role IN ('user','assistant') ORDER BY m.timestamp ASC`,
    [id],
  );
  return rows
    .map(
      (r) =>
        `[${r.title}] ${r.role === "assistant" ? "AI-generated answer (not a claim about the candidate)" : "Recorded question / typed message"}: ${r.content}`,
    )
    .join("\n\n");
}
