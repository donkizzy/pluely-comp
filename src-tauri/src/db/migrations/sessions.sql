CREATE TABLE interview_sessions (
 id TEXT PRIMARY KEY, company TEXT NOT NULL, role TEXT NOT NULL,
 round_type TEXT NOT NULL DEFAULT 'behavioral', interviewer_names TEXT NOT NULL DEFAULT '',
 job_description TEXT NOT NULL DEFAULT '', jd_source_uri TEXT NOT NULL DEFAULT '',
 scheduled_at TEXT NOT NULL DEFAULT '', prompt_template TEXT NOT NULL DEFAULT '',
 include_in_context INTEGER NOT NULL DEFAULT 0 CHECK(include_in_context IN(0,1)),
 prep_pack TEXT NOT NULL DEFAULT '', debrief TEXT NOT NULL DEFAULT '', thank_you TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
ALTER TABLE conversations ADD COLUMN session_id TEXT REFERENCES interview_sessions(id) ON DELETE SET NULL;
CREATE INDEX conversations_session ON conversations(session_id);
