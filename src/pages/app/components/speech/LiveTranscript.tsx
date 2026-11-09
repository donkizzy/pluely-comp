import { useEffect, useRef } from "react";
import { MessageSquareTextIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components";
import { cn } from "@/lib/utils";
import { ANSWER_STYLES, AnswerStyle, QuestionType } from "@/lib/interview";
import type { AutoAnswerMode, TranscriptEntry } from "@/hooks/useSystemAudio";

type Props = {
  transcript: TranscriptEntry[];
  // Text of the turn still being spoken/merged, if any.
  pendingText: string;
  // Capture is running but receiving pure digital silence.
  audioSilent: boolean;
  isAIProcessing: boolean;
  autoAnswerMode: AutoAnswerMode;
  setAutoAnswerMode: (mode: AutoAnswerMode) => void;
  answerStyle: AnswerStyle;
  setAnswerStyle: (style: AnswerStyle) => void;
  onAnswer: (id: string) => void;
  onAnswerLatest: () => void;
};

const AUTO_ANSWER_MODES: { id: AutoAnswerMode; label: string; title: string }[] =
  [
    { id: "question", label: "Questions", title: "Answer detected questions automatically" },
    { id: "every", label: "Everything", title: "Answer after every utterance" },
    { id: "manual", label: "Manual", title: "Only answer when you ask" },
  ];

const TYPE_LABELS: Record<QuestionType, string> = {
  behavioral: "Behavioral",
  technical: "Technical",
  coding: "Coding",
  system_design: "System design",
  situational: "Situational",
  small_talk: "Intro",
  logistics: "Logistics",
  other: "Question",
};

const VISIBLE_ENTRIES = 8;

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string; title: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex bg-muted rounded-md p-0.5 gap-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.title}
          onClick={() => onChange(option.id)}
          className={cn(
            "px-1.5 py-0.5 rounded text-[9px] font-medium transition-all",
            value === option.id
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export const LiveTranscript = ({
  transcript,
  pendingText,
  audioSilent,
  isAIProcessing,
  autoAnswerMode,
  setAutoAnswerMode,
  answerStyle,
  setAnswerStyle,
  onAnswer,
  onAnswerLatest,
}: Props) => {
  const listRef = useRef<HTMLDivElement>(null);
  const visible = transcript.slice(-VISIBLE_ENTRIES);
  const isMac = navigator.platform.toLowerCase().includes("mac");

  // Keep the newest line in view.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [transcript.length, pendingText]);

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <MessageSquareTextIcon className="w-3.5 h-3.5 text-primary" />
          <h4 className="text-xs font-medium">Live transcript</h4>
        </div>
        <div className="flex items-center gap-1.5">
          <Segmented
            options={AUTO_ANSWER_MODES}
            value={autoAnswerMode}
            onChange={setAutoAnswerMode}
          />
          <Segmented
            options={ANSWER_STYLES}
            value={answerStyle}
            onChange={setAnswerStyle}
          />
        </div>
      </div>

      <div ref={listRef} className="space-y-1 max-h-36 overflow-y-auto">
        {visible.length === 0 && !pendingText && !audioSilent && (
          <p className="text-[10px] text-muted-foreground">
            Listening… the interviewer's words will appear here.
          </p>
        )}
        {audioSilent && !pendingText && (
          <p className="text-[10px] text-orange-500 leading-snug">
            No system audio is reaching Pluely. If the call is playing, macOS is
            blocking capture: open System Settings → Privacy &amp; Security →
            Screen &amp; System Audio Recording and enable Pluely (or, in dev,
            the app you launched it from, such as Terminal, Cursor or Claude),
            then restart it.
          </p>
        )}
        {visible.map((entry) => (
          <div
            key={entry.id}
            className={cn(
              "group flex items-start gap-2 rounded-md px-2 py-1 text-[11px] leading-snug",
              entry.isQuestion && "bg-primary/5 border-l-2 border-primary/40"
            )}
          >
            <div className="flex-1 min-w-0">
              {entry.isQuestion && (
                <span className="mr-1.5 text-[8px] font-semibold uppercase tracking-wide text-primary">
                  {TYPE_LABELS[entry.questionType]}
                </span>
              )}
              <span className={cn(!entry.isQuestion && "text-muted-foreground")}>
                {entry.text}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                "h-5 px-1.5 text-[9px] shrink-0",
                !entry.answered && entry.isQuestion
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100"
              )}
              disabled={isAIProcessing}
              onClick={() => onAnswer(entry.id)}
              title={entry.answered ? "Answer again" : "Answer this"}
            >
              {entry.answered ? "Again" : "Answer"}
            </Button>
          </div>
        ))}
        {pendingText && (
          <p className="px-2 py-1 text-[11px] italic text-muted-foreground/70">
            {pendingText}
          </p>
        )}
      </div>

      {autoAnswerMode !== "every" && (
        <div className="flex items-center justify-end">
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] gap-1 px-2"
            disabled={isAIProcessing || (visible.length === 0 && !pendingText)}
            onClick={onAnswerLatest}
            title="Answer the latest thing said"
          >
            <SparklesIcon className="w-3 h-3" />
            Answer now
            <span className="text-[9px] text-muted-foreground/60 bg-muted/50 px-1 rounded">
              {isMac ? "⌘" : "Ctrl"}+↵
            </span>
          </Button>
        </div>
      )}
    </div>
  );
};
