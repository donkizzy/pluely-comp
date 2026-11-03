import { useState } from "react";
import { BookOpenIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StoryCard } from "@/lib/context";

type Props = {
  stories: StoryCard[];
};

// Your own verified stories that fit the current question, shown before the
// AI answer so you can glance at the one to tell.
export const StoryCards = ({ stories }: Props) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (stories.length === 0) return null;

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <BookOpenIcon className="w-3.5 h-3.5 text-primary" />
        <h4 className="text-xs font-medium">Your stories for this</h4>
      </div>
      {stories.map((story) => {
        const expanded = expandedId === story.id;
        return (
          <div key={story.id} className="rounded-md bg-background/60 px-2 py-1.5">
            <button
              type="button"
              className="w-full flex items-start justify-between gap-2 text-left"
              onClick={() => setExpandedId(expanded ? null : story.id)}
              disabled={!story.long}
              title={story.long ? "Show the full story" : undefined}
            >
              <span className="text-[11px] font-semibold">{story.title}</span>
              {story.long && (
                <ChevronDownIcon
                  className={cn(
                    "w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform",
                    expanded && "rotate-180"
                  )}
                />
              )}
            </button>
            <p className="text-[11px] leading-snug text-muted-foreground mt-0.5 whitespace-pre-line">
              {expanded && story.long ? story.long : story.short}
            </p>
          </div>
        );
      })}
    </div>
  );
};
