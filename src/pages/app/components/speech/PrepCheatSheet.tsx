import { useState } from "react";
import { ChevronDownIcon, ClipboardListIcon, PinIcon, PinOffIcon } from "lucide-react";
import { Button, Markdown } from "@/components";
import { safeLocalStorage } from "@/lib";
import { cn } from "@/lib/utils";

const PINNED_KEY = "overlay_prep_pinned";

type Props = {
  // Prep pack of the active interview session (Markdown).
  prepPack: string;
};

// The active session's prep pack. Pinned, it stays open at the top of the
// overlay; unpinned, it collapses to one line until expanded.
export const PrepCheatSheet = ({ prepPack }: Props) => {
  const [pinned, setPinnedState] = useState(
    () => safeLocalStorage.getItem(PINNED_KEY) === "true"
  );
  const [expanded, setExpanded] = useState(false);

  if (!prepPack) return null;

  const open = pinned || expanded;
  const setPinned = (value: boolean) => {
    setPinnedState(value);
    safeLocalStorage.setItem(PINNED_KEY, String(value));
  };

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <button
          type="button"
          className="flex flex-1 items-center gap-1.5 text-left"
          onClick={() => !pinned && setExpanded((prev) => !prev)}
          title={pinned ? undefined : open ? "Collapse" : "Show prep cheat sheet"}
        >
          <ClipboardListIcon className="w-3.5 h-3.5 text-primary" />
          <h4 className="text-xs font-medium">Prep cheat sheet</h4>
          {!pinned && (
            <ChevronDownIcon
              className={cn(
                "w-3.5 h-3.5 text-muted-foreground transition-transform",
                open && "rotate-180"
              )}
            />
          )}
        </button>
        <Button
          size="icon"
          variant="ghost"
          className="h-5 w-5"
          onClick={() => setPinned(!pinned)}
          title={pinned ? "Unpin" : "Pin open during the interview"}
          aria-pressed={pinned}
        >
          {pinned ? (
            <PinOffIcon className="h-3 w-3" />
          ) : (
            <PinIcon className="h-3 w-3" />
          )}
        </Button>
      </div>
      {open && (
        <div className="max-h-48 overflow-y-auto border-t border-border/50 px-2.5 py-2 text-[11px] leading-snug">
          <Markdown>{prepPack}</Markdown>
        </div>
      )}
    </div>
  );
};
