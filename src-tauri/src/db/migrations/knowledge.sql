CREATE TABLE documents (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('resume','portfolio','note','job_description','story','transcript')),
 title TEXT NOT NULL, source_uri TEXT, content TEXT NOT NULL,
 include_in_context INTEGER NOT NULL DEFAULT 0 CHECK(include_in_context IN (0,1)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE chunks (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 ord INTEGER NOT NULL, text TEXT NOT NULL, embedding BLOB, tokens INTEGER NOT NULL,
 UNIQUE(document_id, ord)
);
CREATE INDEX chunks_document ON chunks(document_id);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER chunks_insert AFTER INSERT ON chunks BEGIN
 INSERT INTO chunks_fts(rowid,text) VALUES(new.rowid,new.text);
END;
CREATE TRIGGER chunks_delete AFTER DELETE ON chunks BEGIN
 INSERT INTO chunks_fts(chunks_fts,rowid,text) VALUES('delete',old.rowid,old.text);
END;
CREATE TRIGGER chunks_update AFTER UPDATE OF text ON chunks BEGIN
 INSERT INTO chunks_fts(chunks_fts,rowid,text) VALUES('delete',old.rowid,old.text);
 INSERT INTO chunks_fts(rowid,text) VALUES(new.rowid,new.text);
END;
CREATE TABLE profile (key TEXT PRIMARY KEY, value TEXT NOT NULL);
