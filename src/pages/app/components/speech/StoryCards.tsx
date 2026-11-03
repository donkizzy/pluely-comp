import { useState } from "react";
import { BookOpenIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StoryCard } from "@/lib/context";

type AiMode = "points" | "followups";

type Props = {
  stories: StoryCard[];
  isAIProcessing: boolean;
  // Generate talking points or likely follow-ups from a story.
  onStoryAction: (story: StoryCard, mode: AiMode) => void;
};

// Your own verified stories that fit the current question, shown before the
// AI answer so you can glance at the one to tell.
export const StoryCards = ({ stories, isAIProcessing, onStoryAction }: Props) => {
  // Cards showing the full STAR version instead of the 30-second one.
  const [fullIds, setFullIds] = useState<Set<string>>(new Set());

  if (stories.length === 0) return null;

  const setFull = (id: string, full: boolean) =>
    setFullIds((prev) => {
      const next = new Set(prev);
      if (full) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <BookOpenIcon className="w-3.5 h-3.5 text-primary" />
        <h4 className="text-xs font-medium">Your stories for this</h4>
      </div>
      {stories.map((story) => {
        const showFull = fullIds.has(story.id) && !!story.long;
        const modes = [
          { label: "30 sec", title: "Short version", active: !showFull, onClick: () => setFull(story.id, false) },
          {
            label: "STAR",
            title: story.long ? "Full Situation-Task-Action-Result version" : "No full version saved",
            active: showFull,
            disabled: !story.long,
            onClick: () => setFull(story.id, true),
          },
          {
            label: "Points",
            title: "Turn into talking points (AI answer)",
            disabled: isAIProcessing,
            onClick: () => onStoryAction(story, "points"),
          },
          {
            label: "Follow-ups",
            title: "Likely follow-up questions and answers (AI answer)",
            disabled: isAIProcessing,
            onClick: () => onStoryAction(story, "followups"),
          },
        ];
        return (
          <div key={story.id} className="rounded-md bg-background/60 px-2 py-1.5 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[11px] font-semibold">{story.title}</span>
              <div className="flex shrink-0 bg-muted rounded-md p-0.5 gap-0.5">
                {modes.map((mode) => (
                  <button
                    key={mode.label}
                    type="button"
                    title={mode.title}
                    disabled={mode.disabled}
                    onClick={mode.onClick}
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[9px] font-medium transition-all disabled:opacity-40",
                      mode.active
                        ? "bg-background shadow-sm text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground whitespace-pre-line">
              {showFull ? story.long : story.short}
            </p>
          </div>
        );
      })}
    </div>
  );
};
