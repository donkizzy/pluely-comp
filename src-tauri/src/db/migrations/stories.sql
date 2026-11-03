CREATE TABLE stories (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL, situation TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
 action TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', metrics TEXT NOT NULL DEFAULT '',
 tags TEXT NOT NULL DEFAULT '[]', company TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
 verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
 include_in_context INTEGER NOT NULL DEFAULT 0 CHECK(include_in_context IN (0,1)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK(verified=0 OR (length(trim(situation))>0 AND length(trim(task))>0 AND length(trim(action))>0 AND length(trim(result))>0))
);
CREATE INDEX stories_verified ON stories(verified,include_in_context);
-- Any edit revokes approval. Approve after the updated facts have been reviewed.
CREATE TRIGGER stories_revoke_approval AFTER UPDATE OF title,situation,task,action,result,metrics,tags,company,role ON stories
BEGIN UPDATE stories SET verified=0, updated_at=NEW.updated_at+1 WHERE id=NEW.id; END;
