import { useEffect, useRef, useState } from "react";
import { PageLayout } from "@/layouts";
import { Button, Textarea } from "@/components";
import { useProfile } from "@/contexts/profile.context";
import {
  deleteDocument,
  listDocuments,
  saveDocument,
  setDocumentIncluded,
  type KnowledgeDocument,
  type Profile,
} from "@/lib/database/knowledge.action";
import { buildInterviewContext } from "@/lib/context";
import { profileContext } from "@/lib/context/policy";
import { parseResume, resumeSections, importUrl } from "./import";
import { Action, Field, Panel, StatusToast, Toggle } from "./fields";

export default function ProfilePage() {
  const { profile, updateProfile, error: loadError } = useProfile();
  const [draft, setDraft] = useState(profile);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [source, setSource] = useState<KnowledgeDocument | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [question, setQuestion] = useState("");
  const [preview, setPreview] = useState("");
  // The last profile the draft was synced from. Refreshes (another window
  // writing localStorage, a profile-changed event) must not wipe unsaved edits
  // such as freshly parsed resume fields.
  const synced = useRef(profile);
  const dirty = JSON.stringify(draft) !== JSON.stringify(synced.current);
  useEffect(() => {
    setDraft((current) =>
      JSON.stringify(current) === JSON.stringify(synced.current)
        ? profile
        : current,
    );
    synced.current = profile;
  }, [profile]);
  const saveDraft = async () => {
    await updateProfile(draft);
    synced.current = draft;
  };
  const reviewRef = useRef<HTMLElement>(null);
  // Bring the review panel into view whenever a new source opens.
  useEffect(() => {
    if (source)
      reviewRef.current?.scrollIntoView({ block: "start" });
  }, [source?.id]);
  const profileBytes = new TextEncoder().encode(
    profileContext({ ...draft, includeInContext: true }),
  ).length;
  const refresh = async () => setDocuments(await listDocuments());
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const field = (
    key: keyof Omit<Profile, "includeInContext">,
    label: string,
    multiline = false,
  ) => (
    <Field
      key={key}
      label={label}
      value={draft[key]}
      multiline={multiline}
      onChange={(value) => setDraft((d) => ({ ...d, [key]: value }))}
    />
  );
  const fromUrl = async (uri: string, existing?: KnowledgeDocument) => {
    const result = await importUrl(uri);
    setSource({
      ...existing,
      id: existing?.id || crypto.randomUUID(),
      kind: existing?.kind || "portfolio",
      title: result.title,
      source_uri: uri,
      content: result.content,
      include_in_context: existing?.include_in_context || false,
    });
  };
  return (
    <PageLayout
      title="Your profile"
      description="Keep your resume and evidence on this device. Choose what your AI provider can see."
    >
      <StatusToast
        error={error || loadError}
        notice={notice}
        onDismiss={() => {
          setError("");
          setNotice("");
        }}
      />
      <Panel title="Personal details">
        <div className="grid gap-4 md:grid-cols-2">
          {field("name", "Name")}
          {field("currentRole", "Current role")}
          {field("yearsExperience", "Years of experience")}
          {field("targetRoles", "Target roles")}
          {field("location", "Location")}
          {field("workAuthorization", "Work authorization")}
          {field(
            "salaryExpectations",
            "Salary expectations (private; never included automatically)",
          )}
          {field("tone", "Preferred tone")}
        </div>
        {field("neverSay", "Things never to say", true)}
        {field("about", "About me", true)}
        {field("summary", "Editable profile summary (keep it brief)", true)}
        <p
          className={
            profileBytes > 300
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {profileBytes > 300
            ? `Only the first 300 of ${profileBytes} bytes of your profile details and summary are sent; shorten the summary so nothing is cut.`
            : `${profileBytes}/300 bytes of profile details and summary used.`}
        </p>
        <Toggle
          label="Include my profile summary and preferences in AI context"
          value={draft.includeInContext}
          onChange={(v) => setDraft((d) => ({ ...d, includeInContext: v }))}
        />
        <div className="flex items-center gap-3">
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await saveDraft();
                setNotice("Profile saved on this device.");
              })
            }
          >
            Save profile
          </Button>
          {dirty && (
            <span className="text-sm text-muted-foreground">
              Unsaved changes
            </span>
          )}
        </div>
      </Panel>
      <Panel title="Resume and structured evidence">
        <p className="text-sm text-muted-foreground">
          PDF and DOCX are parsed locally. Review the extracted text before
          saving. You can also upload a LinkedIn export as PDF or TXT.
        </p>
        <label className="block text-sm">
          Upload resume
          <input
            className="block mt-2"
            type="file"
            accept=".pdf,.docx,.txt,.md"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void run(async () => {
                  const content = await parseResume(file);
                  setSource({
                    id: crypto.randomUUID(),
                    kind: "resume",
                    title: file.name,
                    source_uri: null,
                    content,
                    include_in_context: false,
                  });
                  const parsed = resumeSections(content);
                  // Replace sections the resume provides; keep the rest.
                  // Name and summary only fill empty fields.
                  setDraft((d) => ({
                    ...d,
                    name: d.name || parsed.name,
                    summary: d.summary || parsed.summary,
                    experience: parsed.experience || d.experience,
                    skills: parsed.skills || d.skills,
                    education: parsed.education || d.education,
                    projects: parsed.projects || d.projects,
                  }));
                  setNotice(
                    "Resume parsed. Review the extracted text here, check Experience, Skills, Education and Projects above, then save both.",
                  );
                });
              e.target.value = "";
            }}
          />
        </label>
        {field("experience", "Experience", true)}
        {field("skills", "Skills", true)}
        {field("education", "Education", true)}
        {field("projects", "Projects", true)}
        <p className="text-sm">
          Structured fields are local notes. Save them as an included source to
          make them available to retrieval.
        </p>
        {dirty && (
          <p className="text-sm text-muted-foreground">
            These fields have unsaved changes. Use Save profile above or Review
            structured source to keep them.
          </p>
        )}
        <Action
          busy={busy}
          onClick={() =>
            void run(async () => {
              await saveDraft();
              setSource({
                id: "profile-structured",
                kind: "resume",
                title: "Structured profile evidence",
                source_uri: null,
                content: [
                  "Experience",
                  draft.experience,
                  "Skills",
                  draft.skills,
                  "Education",
                  draft.education,
                  "Projects",
                  draft.projects,
                ].join("\n"),
                include_in_context: false,
              });
            })
          }
        >
          Review structured source
        </Action>
      </Panel>
      <Panel title="Portfolio, GitHub and notes">
        <Field
          label="Website, blog, GitHub profile or repository URL"
          value={url}
          onChange={setUrl}
        />
        <Action busy={busy} onClick={() => void run(() => fromUrl(url))}>
          Fetch preview
        </Action>{" "}
        <Action
          onClick={() =>
            setSource({
              id: crypto.randomUUID(),
              kind: "note",
              title: "About me",
              source_uri: null,
              content: draft.about,
              include_in_context: false,
            })
          }
        >
          Add a note
        </Action>
        <p className="text-sm text-muted-foreground">
          Fetch and re-sync contact only the URL you choose. No automatic
          syncing.
        </p>
      </Panel>
      {source && (
        <Panel title="Review source" ref={reviewRef}>
          <Field
            label="Title"
            value={source.title}
            onChange={(title) => setSource({ ...source, title })}
          />
          <Field
            label="Extracted text (editable)"
            value={source.content}
            multiline
            onChange={(content) => setSource({ ...source, content })}
          />
          <Toggle
            label="Include this source in AI context"
            value={source.include_in_context}
            onChange={(include_in_context) =>
              setSource({ ...source, include_in_context })
            }
          />
          <Action
            busy={busy}
            onClick={() =>
              void run(async () => {
                await saveDocument(source);
                await refresh();
                setSource(null);
                setNotice(
                  source.include_in_context
                    ? "Source saved and indexed locally. Interview answers can use it."
                    : 'Source saved locally but not included in AI context, so interview answers won\'t use it. Turn on "Include in AI context" under Saved sources to use it.',
                );
              })
            }
          >
            Save and index
          </Action>{" "}
          <Action onClick={() => setSource(null)}>Cancel</Action>
        </Panel>
      )}
      <Panel title="Saved sources">
        {documents.length === 0 && <p>No sources yet.</p>}
        {documents.map((doc) => (
          <div key={doc.id} className="border rounded-lg p-4 space-y-3">
            <div className="font-medium">
              {doc.title}{" "}
              <span className="text-muted-foreground text-xs">{doc.kind}</span>
            </div>
            <Toggle
              label="Include in AI context"
              value={doc.include_in_context}
              onChange={(value) =>
                void run(async () => {
                  await setDocumentIncluded(doc.id, value);
                  await refresh();
                })
              }
            />
            <Action busy={busy} onClick={() => setSource(doc)}>
              Edit
            </Action>{" "}
            {doc.source_uri && (
              <Action
                busy={busy}
                onClick={() => void run(() => fromUrl(doc.source_uri!, doc))}
              >
                Re-sync preview
              </Action>
            )}{" "}
            <Action
              busy={busy}
              onClick={() =>
                void run(async () => {
                  await deleteDocument(doc.id);
                  await refresh();
                })
              }
            >
              Delete
            </Action>
          </div>
        ))}
      </Panel>
      <Panel title="What will be sent">
        <p className="text-sm">
          Preview the personalization addendum for a question. Your existing
          system prompt and conversation history are sent separately.
        </p>
        <Field
          label="Interview question"
          value={question}
          onChange={setQuestion}
        />
        <Action
          busy={busy}
          onClick={() =>
            void run(async () => {
              const result = await buildInterviewContext({ question });
              setPreview(
                result.systemPromptAddendum ||
                  "No personalization context for this question.",
              );
            })
          }
        >
          Preview AI context
        </Action>
        <Textarea
          aria-label="AI context preview"
          readOnly
          value={preview}
          rows={10}
        />
      </Panel>
    </PageLayout>
  );
}
