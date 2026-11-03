import { useEffect, useState } from "react";
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
import { parseResume, resumeSections, importUrl } from "./import";
import { Action, Field, Panel, Toggle } from "./fields";

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
  useEffect(() => setDraft(profile), [profile]);
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
      {(error || loadError) && (
        <p role="alert" className="text-destructive">
          {error || loadError}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
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
        <Toggle
          label="Include my profile summary and preferences in AI context"
          value={draft.includeInContext}
          onChange={(v) => setDraft((d) => ({ ...d, includeInContext: v }))}
        />
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await updateProfile(draft);
              setNotice("Profile saved on this device.");
            })
          }
        >
          Save profile
        </Button>
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
                  setDraft((d) => ({
                    ...d,
                    ...resumeSections(content),
                    summary:
                      d.summary ||
                      content
                        .split(/\r?\n/)
                        .filter(
                          (line) =>
                            !/salary|compensation|pay expectation/i.test(line),
                        )
                        .join(" ")
                        .replace(/\s+/g, " ")
                        .slice(0, 800),
                  }));
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
        <Action
          busy={busy}
          onClick={() =>
            void run(async () => {
              await updateProfile(draft);
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
        <Panel title="Review source">
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
                setNotice("Source saved and indexed locally.");
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
