export const ACTIVE_SESSION_KEY = "active_interview_session_id";
export function readActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY) || null;
  } catch {
    return null;
  }
}
