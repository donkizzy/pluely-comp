import { getDatabase } from "./config.ts";
import { saveDocument } from "./knowledge.action.ts";

// Explicit indexing is read-only with respect to the original chat messages.
// AI answers are labelled as generated, never candidate-authored evidence.
export async function indexPastTranscripts(
  sessionId?: string,
): Promise<number> {
  const db = await getDatabase();
  const conversations = await db.select<
    { id: string; title: string; company: string | null }[]
  >(
    `SELECT c.id,c.title,s.company FROM conversations c LEFT JOIN interview_sessions s ON s.id=c.session_id ${sessionId ? "WHERE c.session_id=?" : ""} ORDER BY c.updated_at DESC`,
    sessionId ? [sessionId] : [],
  );
  let count = 0;
  for (const conversation of conversations) {
    const messages = await db.select<{ role: string; content: string }[]>(
      "SELECT role,content FROM messages WHERE conversation_id=? AND role IN ('user','assistant') ORDER BY timestamp ASC",
      [conversation.id],
    );
    const id = `transcript:${conversation.id}`;
    const previous = await db.select<{ include_in_context: number }[]>(
      "SELECT include_in_context FROM documents WHERE id=?",
      [id],
    );
    await saveDocument({
      id,
      kind: "transcript",
      title: `${conversation.company ? conversation.company + ": " : ""}${conversation.title}`,
      source_uri: null,
      include_in_context: previous[0]?.include_in_context === 1,
      content:
        "Historical interview record. AI-generated answers are NOT evidence of the candidate's experience.\n\n" +
        messages
          .map(
            (m) =>
              `${m.role === "assistant" ? "AI-generated answer" : "Question / typed user message"}: ${m.content}`,
          )
          .join("\n\n"),
    });
    count++;
  }
  return count;
}
