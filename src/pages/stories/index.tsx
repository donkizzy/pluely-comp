import { useEffect, useState } from "react";
import { PageLayout } from "@/layouts";
import { Textarea, Button } from "@/components";
import {
  listStories,
  blankStory,
  saveStory,
  approveStory,
  deleteStory,
  setStoryIncluded,
  storyGaps,
  parseStoryDrafts,
  COMPETENCIES,
  type Story,
} from "@/lib/database/stories.action";
import { listDocuments } from "@/lib/database/knowledge.action";
import { useProfile } from "@/contexts/profile.context";
import { profileContext, limitText } from "@/lib/context/policy";
import { Action, Field, Panel, Toggle } from "@/pages/profile/fields";
import { useKnowledgeAI } from "@/pages/profile/useKnowledgeAI";

export default function StoriesPage() {
  const [stories, setStories] = useState<Story[]>([]);
  const [draft, setDraft] = useState<Story | null>(null);
  const [tagsInput, setTagsInput] = useState("");
  const editStory = (story: Story) => {
    setDraft(story);
    setTagsInput(story.tags.join(", "));
  };
  const [mode, setMode] = useState("star");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const { profile } = useProfile();
  const ai = useKnowledgeAI();
  const refresh = async () => setStories(await listStories());
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const field = (
    key:
      | "title"
      | "situation"
      | "task"
      | "action"
      | "result"
      | "metrics"
      | "company"
      | "role",
    label: string,
    multi = false,
  ) =>
    draft && (
      <Field
        key={key}
        label={label}
        value={draft[key]}
        multiline={multi}
        onChange={(value) =>
          setDraft({ ...draft, [key]: value, verified: false })
        }
      />
    );
  const gaps = storyGaps(stories);
  return (
    <PageLayout
      title="Story Bank"
      description="Build real examples. AI drafts stay out of live answers until you review and approve them."
    >
      {(error || ai.error) && (
        <p role="alert" className="text-destructive">
          {error || ai.error}
        </p>
      )}
      <div>
        <Button onClick={() => editStory(blankStory())}>Write a story</Button>
      </div>
      <Panel title="Coverage gaps">
        <p className="text-sm">
          Based on approved stories:{" "}
          {gaps.length ? gaps.join(", ") : "all core competencies covered"}.
        </p>
        {gaps.map((gap) => (
          <Action
            key={gap}
            onClick={() =>
              editStory({ ...blankStory(), title: gap, tags: [gap] })
            }
          >
            Write about {gap}
          </Action>
        ))}
      </Panel>
      <Panel title="Mine draft stories">
        <p className="text-sm">
          Only included resume/portfolio sources enter the preview. Check every
          proposed fact. Nothing is approved automatically.
        </p>
        <Action
          busy={busy || ai.busy}
          onClick={() =>
            void run(async () => {
              const docs = await listDocuments();
              setInput(
                limitText(
                  [
                    profileContext(profile),
                    ...docs
                      .filter(
                        (d) =>
                          d.include_in_context &&
                          ["resume", "portfolio", "note"].includes(d.kind),
                      )
                      .map((d) => `[${d.title}]\n${d.content}`),
                  ].join("\n\n"),
                  14000,
                ),
              );
            })
          }
        >
          Prepare source preview
        </Action>
        <Textarea
          aria-label="Story mining data sent to provider"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={7}
        />
        <Action
          busy={busy || ai.busy || !input.trim()}
          onClick={() =>
            void run(async () => {
              const text = await ai.generate(
                "Propose up to 5 draft STAR stories grounded ONLY in the supplied candidate facts. Never invent numbers, actions or outcomes. Leave unknown fields empty, use the title to flag missing details. Return ONLY a JSON array of objects with string fields title,situation,task,action,result,metrics,company,role and tags:string[]. These are unverified drafts.",
                input,
              );
              for (const story of parseStoryDrafts(text))
                await saveStory(story);
              await refresh();
            })
          }
        >
          Send preview to {ai.providerName} and draft stories
        </Action>
        {ai.busy && <Action onClick={ai.cancel}>Cancel generation</Action>}
      </Panel>
      {draft && (
        <Panel
          title={
            draft.verified
              ? "Review approved story (editing revokes approval)"
              : "Draft — fill in real details"
          }
        >
          {field("title", "Title")}
          {field("situation", "Situation", true)}
          {field("task", "Task", true)}
          {field("action", "Action you took", true)}
          {field("result", "Result", true)}
          {field("metrics", "Verified metrics (optional)")}
          {field("company", "Company")}
          {field("role", "Role")}
          <Field
            label={`Competency tags, separated by commas (${COMPETENCIES.join(", ")})`}
            value={tagsInput}
            onChange={setTagsInput}
          />
          <Toggle
            label="Allow this story in live context after approval"
            value={draft.include_in_context}
            onChange={(v) => setDraft({ ...draft, include_in_context: v })}
          />
          <Action
            busy={busy}
            onClick={() =>
              void run(async () => {
                await saveStory({
                  ...draft,
                  tags: tagsInput
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                });
                setDraft(null);
                await refresh();
              })
            }
          >
            Save draft (requires approval)
          </Action>{" "}
          <Action onClick={() => setDraft(null)}>Cancel</Action>
        </Panel>
      )}
      <Panel title="Your stories">
        <label className="block text-sm">
          Answer view
          <select
            value={mode}
            className="block border rounded p-2 bg-background"
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="points">Talking points</option>
            <option value="short">30-second version</option>
            <option value="star">Full STAR script</option>
            <option value="followup">Likely follow-ups</option>
          </select>
        </label>
        {!stories.length && (
          <p>
            No stories yet. Start with a project you can describe from personal
            experience.
          </p>
        )}
        {stories.map((story) => (
          <article key={story.id} className="border rounded-lg p-4 space-y-3">
            <h3 className="font-medium">
              {story.title}{" "}
              <span className="text-xs">
                {story.verified ? "Approved" : "Draft — never used live"}
              </span>
            </h3>
            <p className="text-sm whitespace-pre-wrap">
              {mode === "points"
                ? `• ${story.action}\n• ${story.result}`
                : mode === "short"
                  ? limitText(`${story.action} ${story.result}`, 600)
                  : mode === "followup"
                    ? "What was your specific contribution?\nHow did you measure the outcome?\nWhat would you do differently?"
                    : [
                        `Situation: ${story.situation}`,
                        `Task: ${story.task}`,
                        `Action: ${story.action}`,
                        `Result: ${story.result}`,
                        `Metrics: ${story.metrics}`,
                        `Company: ${story.company}`,
                        `Role: ${story.role}`,
                      ].join("\n")}
            </p>
            <p className="text-sm">{story.tags.join(", ")}</p>
            <Toggle
              label="Include approved story in live context"
              value={story.include_in_context}
              onChange={(v) =>
                void run(async () => {
                  await setStoryIncluded(story.id, v);
                  await refresh();
                })
              }
            />
            <Action busy={busy} onClick={() => editStory(story)}>
              Edit STAR
            </Action>{" "}
            {!story.verified && mode === "star" && (
              <Action
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    await approveStory(story.id);
                    await refresh();
                  })
                }
              >
                I confirm these facts — approve
              </Action>
            )}{" "}
            <Action
              busy={busy}
              onClick={() =>
                void run(async () => {
                  await deleteStory(story.id);
                  await refresh();
                })
              }
            >
              Delete
            </Action>
          </article>
        ))}
      </Panel>
    </PageLayout>
  );
}
