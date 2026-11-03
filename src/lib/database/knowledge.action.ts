import { invoke } from "@tauri-apps/api/core";
import { getDatabase } from "./config.ts";

export type DocumentKind =
  "resume" | "portfolio" | "note" | "job_description" | "story" | "transcript";
export interface KnowledgeDocument {
  id: string;
  kind: DocumentKind;
  title: string;
  source_uri: string | null;
  content: string;
  include_in_context: boolean;
}
export interface KnowledgeHit {
  id: string;
  document_id: string;
  kind: DocumentKind;
  title: string;
  text: string;
  score: number;
}
export interface Profile {
  name: string;
  currentRole: string;
  yearsExperience: string;
  targetRoles: string;
  location: string;
  workAuthorization: string;
  salaryExpectations: string;
  tone: string;
  neverSay: string;
  about: string;
  summary: string;
  experience: string;
  skills: string;
  education: string;
  projects: string;
  includeInContext: boolean;
}
export const emptyProfile: Profile = {
  name: "",
  currentRole: "",
  yearsExperience: "",
  targetRoles: "",
  location: "",
  workAuthorization: "",
  salaryExpectations: "",
  tone: "Conversational and concise",
  neverSay: "",
  about: "",
  summary: "",
  experience: "",
  skills: "",
  education: "",
  projects: "",
  includeInContext: false,
};
export async function getProfile(): Promise<Profile> {
  const db = await getDatabase();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM profile WHERE key='personal'",
  );
  if (!rows[0]) return { ...emptyProfile };
  const parsed: unknown = JSON.parse(rows[0].value);
  if (!parsed || typeof parsed !== "object") return { ...emptyProfile };
  const result = { ...emptyProfile };
  for (const key of Object.keys(emptyProfile) as (keyof Profile)[]) {
    const value = (parsed as Record<string, unknown>)[key];
    if (key === "includeInContext") result[key] = value === true;
    else if (typeof value === "string") result[key] = value;
  }
  return result;
}
export async function saveProfile(profile: Profile): Promise<void> {
  const db = await getDatabase();
  await db.execute(
    "INSERT INTO profile(key,value) VALUES('personal',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [JSON.stringify(profile)],
  );
}
export async function listDocuments(): Promise<KnowledgeDocument[]> {
  const db = await getDatabase();
  const rows = await db.select<
    (Omit<KnowledgeDocument, "include_in_context"> & {
      include_in_context: number;
    })[]
  >(
    "SELECT id,kind,title,source_uri,content,include_in_context FROM documents WHERE kind<>'story' ORDER BY updated_at DESC",
  );
  return rows.map((row) => ({
    ...row,
    include_in_context: row.include_in_context === 1,
  }));
}
export async function saveDocument(document: KnowledgeDocument): Promise<void> {
  await invoke("kb_save_document", { document });
}
export async function deleteDocument(id: string): Promise<void> {
  const db = await getDatabase();
  // Explicit deletion also works on plugin-sql connections without foreign_keys enabled.
  await db.execute("DELETE FROM chunks WHERE document_id=?", [id]);
  await db.execute("DELETE FROM documents WHERE id=? AND kind<>'story'", [id]);
}
export async function setDocumentIncluded(
  id: string,
  included: boolean,
): Promise<void> {
  const db = await getDatabase();
  await db.execute(
    "UPDATE documents SET include_in_context=?,updated_at=? WHERE id=? AND kind<>'story'",
    [included ? 1 : 0, Date.now(), id],
  );
}
export async function searchKnowledge(
  question: string,
  k = 5,
  kinds: DocumentKind[] = [],
): Promise<KnowledgeHit[]> {
  return invoke("kb_search", { query: question, k, kinds });
}
