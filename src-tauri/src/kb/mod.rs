mod model;
mod text;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub source_uri: Option<String>,
    pub content: String,
    pub include_in_context: bool,
}
#[derive(Clone, Serialize)]
pub struct SearchHit {
    pub id: String,
    pub document_id: String,
    pub kind: String,
    pub title: String,
    pub text: String,
    pub score: f32,
}
fn paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    Ok((
        app.path()
            .app_config_dir()
            .map_err(|e| e.to_string())?
            .join("pluely.db"),
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("resources/models/minilm"),
    ))
}
fn connection(path: &PathBuf) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_millis(1000))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|e| e.to_string())?;
    Ok(db)
}
fn timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn validate(doc: &Document) -> Result<(), String> {
    if ![
        "resume",
        "portfolio",
        "note",
        "job_description",
        "story",
        "transcript",
    ]
    .contains(&doc.kind.as_str())
        || doc.id.is_empty()
        || doc.title.trim().is_empty()
    {
        return Err("A document needs a valid kind, id and title".into());
    }
    if doc.kind == "story" {
        return Err("Save stories through the Story Bank".into());
    }
    if doc.content.len() > 2_000_000 {
        return Err("Document exceeds 2 MB of text".into());
    }
    Ok(())
}
fn index(
    db: &mut Connection,
    root: &PathBuf,
    doc: &Document,
    story_revision: Option<(i64, bool)>,
) -> Result<(), String> {
    let chunks = text::chunk(&doc.content);
    let embeddings = if chunks.is_empty() {
        vec![]
    } else {
        model::embed(root, chunks.clone())?
    };
    let tx = db.transaction().map_err(|e| e.to_string())?;
    if let Some((revision, approve)) = story_revision {
        let current: i64 = tx
            .query_row(
                "SELECT updated_at FROM stories WHERE id=?1",
                [&doc.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if current != revision {
            return Err("Story changed while indexing; review it again".into());
        }
        if approve {
            tx.execute("UPDATE stories SET verified=1 WHERE id=?1", [&doc.id])
                .map_err(|e| e.to_string())?;
        }
    }
    let now = timestamp();
    tx.execute("INSERT INTO documents(id,kind,title,source_uri,content,include_in_context,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(id) DO UPDATE SET title=excluded.title, source_uri=excluded.source_uri, content=excluded.content, include_in_context=excluded.include_in_context, updated_at=excluded.updated_at",
        params![doc.id,doc.kind,doc.title,doc.source_uri,doc.content,doc.include_in_context,now]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM chunks WHERE document_id=?1", [&doc.id])
        .map_err(|e| e.to_string())?;
    for (ord, (text, vector)) in chunks.iter().zip(embeddings).enumerate() {
        let bytes: Vec<u8> = vector.iter().flat_map(|n| n.to_le_bytes()).collect();
        tx.execute("INSERT INTO chunks(id,document_id,ord,text,embedding,tokens) VALUES(?1,?2,?3,?4,?5,?6)",
            params![format!("{}:{ord}",doc.id),doc.id,ord as i64,text,bytes,text.len() as i64]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn kb_save_document(app: AppHandle, document: Document) -> Result<(), String> {
    validate(&document)?;
    let (path, root) = paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        index(&mut connection(&path)?, &root, &document, None)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kb_ingest(app: AppHandle, document_id: String) -> Result<(), String> {
    let (path, root) = paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut db = connection(&path)?;
        let doc = db.query_row("SELECT id,kind,title,source_uri,content,include_in_context FROM documents WHERE id=?1", [&document_id], |r| Ok(Document {
            id:r.get(0)?,kind:r.get(1)?,title:r.get(2)?,source_uri:r.get(3)?,content:r.get(4)?,include_in_context:r.get(5)?,
        })).map_err(|e| e.to_string())?;
        if doc.kind == "story" { return Err("Reindex stories through the Story Bank".into()); }
        index(&mut db,&root,&doc,None)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn kb_search(
    app: AppHandle,
    query: String,
    k: usize,
    kinds: Vec<String>,
) -> Result<Vec<SearchHit>, String> {
    if query.trim().is_empty() || k == 0 {
        return Ok(vec![]);
    }
    let (path, root) = paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        search(&connection(&path)?, &root, &query, k.min(20), &kinds)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn search(
    db: &Connection,
    root: &PathBuf,
    query: &str,
    k: usize,
    kinds: &[String],
) -> Result<Vec<SearchHit>, String> {
    // Privacy and approval are enforced before *either* ranking, including the lexical path.
    let sql = "SELECT c.id,c.document_id,d.kind,d.title,c.text,c.embedding FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.include_in_context=1 AND (d.kind<>'story' OR EXISTS(SELECT 1 FROM stories s WHERE s.id=d.id AND s.verified=1 AND s.include_in_context=1))";
    let mut stmt = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                SearchHit {
                    id: r.get(0)?,
                    document_id: r.get(1)?,
                    kind: r.get(2)?,
                    title: r.get(3)?,
                    text: r.get(4)?,
                    score: 0.0,
                },
                r.get::<_, Option<Vec<u8>>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut candidates = HashMap::new();
    let mut vector_rank = Vec::new();
    let embedded = model::embed(root, vec![query.chars().take(700).collect()])
        .ok()
        .and_then(|mut v| v.pop());
    for row in rows {
        let (hit, bytes) = row.map_err(|e| e.to_string())?;
        if !kinds.is_empty() && !kinds.contains(&hit.kind) {
            continue;
        }
        if let (Some(q), Some(blob)) = (&embedded, bytes) {
            let vec: Vec<f32> = blob
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();
            vector_rank.push((hit.id.clone(), text::cosine(q, &vec)));
        }
        candidates.insert(hit.id.clone(), hit);
    }
    vector_rank.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut scores: HashMap<String, f32> = HashMap::new();
    for (rank, (id, _)) in vector_rank.into_iter().take(100).enumerate() {
        scores.insert(id, 1.0 / (60.0 + rank as f32));
    }
    let fts = text::fts_query(query);
    if !fts.is_empty() {
        let mut stmt = db.prepare("SELECT c.id FROM chunks_fts JOIN chunks c ON c.rowid=chunks_fts.rowid JOIN documents d ON d.id=c.document_id WHERE chunks_fts MATCH ?1 AND d.include_in_context=1 AND (d.kind<>'story' OR EXISTS(SELECT 1 FROM stories s WHERE s.id=d.id AND s.verified=1 AND s.include_in_context=1)) ORDER BY bm25(chunks_fts) LIMIT 500").map_err(|e| e.to_string())?;
        let mut rank = 0;
        for id in stmt
            .query_map([fts], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            let id = id.map_err(|e| e.to_string())?;
            if candidates.contains_key(&id) {
                *scores.entry(id).or_default() += 1.0 / (60.0 + rank as f32);
                rank += 1;
            }
        }
    }
    let mut result: Vec<_> = scores
        .into_iter()
        .filter_map(|(id, score)| {
            candidates.remove(&id).map(|mut h| {
                h.score = score;
                h
            })
        })
        .collect();
    result.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.id.cmp(&b.id)));
    result.truncate(k);
    Ok(result)
}
#[tauri::command]
pub async fn kb_warm(app: AppHandle) -> Result<(), String> {
    let (_, root) = paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        model::embed(&root, vec!["warm up".into()]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn kb_index_story(app: AppHandle, id: String, approve: bool) -> Result<(), String> {
    let (path, root) = paths(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut db=connection(&path)?;
        let (doc,revision)=db.query_row("SELECT title,situation,task,action,result,metrics,tags,company,role,include_in_context,updated_at FROM stories WHERE id=?1", [&id], |r| {
            let fields: Vec<String>=(0..9).map(|i|r.get(i)).collect::<rusqlite::Result<_>>()?;
            Ok((Document{id:id.clone(),kind:"story".into(),title:fields[0].clone(),source_uri:None,
                content:format!("{}\nSituation: {}\nTask: {}\nAction: {}\nResult: {}\nMetrics: {}\nTags: {}\nCompany: {}\nRole: {}",fields[0],fields[1],fields[2],fields[3],fields[4],fields[5],fields[6],fields[7],fields[8]),include_in_context:r.get(9)?},r.get::<_,i64>(10)?))
        }).map_err(|e|e.to_string())?;
        index(&mut db,&root,&doc,Some((revision,approve)))
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        for sql in [
            include_str!("../db/migrations/system-prompts.sql"),
            include_str!("../db/migrations/chat-history.sql"),
            include_str!("../db/migrations/knowledge.sql"),
            include_str!("../db/migrations/stories.sql"),
            include_str!("../db/migrations/sessions.sql"),
        ] {
            db.execute_batch(sql).unwrap();
        }
        db
    }
    fn root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/models/minilm")
    }
    #[test]
    fn local_model_understands_resume_paraphrases() {
        let embeddings=model::embed(&root(),vec!["How did you reduce infrastructure costs?".into(),"Reduced cloud spending by optimizing Kubernetes workloads and removing unused servers.".into(),"Enjoy painting landscapes and gardening on weekends.".into()]).unwrap();
        assert_eq!(embeddings[0].len(), 384);
        assert!(
            text::cosine(&embeddings[0], &embeddings[1])
                > text::cosine(&embeddings[0], &embeddings[2])
        );
        let started = std::time::Instant::now();
        model::embed(&root(), vec!["Kubernetes leadership".into()]).unwrap();
        eprintln!("Warm local query embedding: {:?}", started.elapsed());
    }
    #[test]
    fn hybrid_search_filters_private_and_unapproved_stories() {
        let mut db = setup();
        for (id, kind, included) in [
            ("resume", "resume", true),
            ("private", "note", false),
            ("draft", "story", true),
            ("approved", "story", true),
        ] {
            if kind == "story" {
                db.execute("INSERT INTO stories(id,title,situation,task,action,result,verified,include_in_context,created_at,updated_at) VALUES(?1,?1,'S','T','A','R',?2,1,1,1)",params![id,id=="approved"]).unwrap();
            }
            index(
                &mut db,
                &root(),
                &Document {
                    id: id.into(),
                    kind: kind.into(),
                    title: id.into(),
                    source_uri: None,
                    content: "Kubernetes incident response and deployment rollback".into(),
                    include_in_context: included,
                },
                None,
            )
            .unwrap();
        }
        let results = search(&db, &root(), "Kubernetes", 20, &[]).unwrap();
        assert!(results.iter().any(|h| h.document_id == "resume"));
        assert!(results.iter().any(|h| h.document_id == "approved"));
        assert!(results
            .iter()
            .all(|h| h.document_id != "draft" && h.document_id != "private"));
        let stories = search(&db, &root(), "Kubernetes", 20, &["story".into()]).unwrap();
        assert_eq!(stories.len(), 1);
        db.execute("UPDATE stories SET action='Edited' WHERE id='approved'", [])
            .unwrap();
        assert!(search(&db, &root(), "Kubernetes", 20, &["story".into()])
            .unwrap()
            .is_empty());
        assert!(search(&db, &root(), "", 20, &[]).is_ok());
    }
}
