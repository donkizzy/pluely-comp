import { useEffect, useState, useCallback, useRef } from "react";
import { useWindowResize, useGlobalShortcuts } from ".";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import { fetchSTT, fetchAIResponse } from "@/lib/functions";
import {
  DEFAULT_QUICK_ACTIONS,
  DEFAULT_SYSTEM_PROMPT,
  STORAGE_KEYS,
} from "@/config";
import {
  safeLocalStorage,
  generateConversationTitle,
  saveConversation,
  CONVERSATION_SAVE_DEBOUNCE_MS,
  generateConversationId,
  generateMessageId,
} from "@/lib";
import { Message } from "@/types/completion";
import {
  AnswerStyle,
  QuestionType,
  buildAnswerGuidance,
  classifyQuestion,
  isLikelyQuestion,
} from "@/lib/interview";

// VAD Configuration interface matching Rust
export interface VadConfig {
  enabled: boolean;
  hop_size: number;
  sensitivity_rms: number;
  peak_threshold: number;
  silence_chunks: number;
  min_speech_chunks: number;
  pre_speech_chunks: number;
  noise_gate_threshold: number;
  max_recording_duration_secs: number;
}

// OPTIMIZED VAD defaults - matches backend exactly for perfect performance
const DEFAULT_VAD_CONFIG: VadConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.012, // Much less sensitive - only real speech
  peak_threshold: 0.035, // Higher threshold - filters clicks/noise
  silence_chunks: 45, // ~1.0s of required silence
  min_speech_chunks: 7, // ~0.16s - captures short answers
  pre_speech_chunks: 12, // ~0.27s - enough to catch word start
  noise_gate_threshold: 0.003, // Stronger noise filtering
  max_recording_duration_secs: 180, // 3 minutes default
};

// Chat message interface (reusing from useCompletion)
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

// Conversation interface (reusing from useCompletion)
export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

// Per-turn latency in ms, measured from the moment the speech segment
// (or quick action) reached the frontend.
export interface TurnLatency {
  stt?: number;
  firstToken?: number;
  total?: number;
}

// When to answer automatically: only on detected questions, after every
// utterance, or only when the user asks.
export type AutoAnswerMode = "question" | "every" | "manual";

export interface TranscriptEntry {
  id: string;
  text: string;
  at: number;
  isQuestion: boolean;
  questionType: QuestionType;
  answered: boolean;
}

// Speech segments closer together than this are one turn (an interviewer
// pausing mid-question). A new speech start holds the turn open.
const TURN_MERGE_MS = 700;
const AUTO_ANSWER_KEY = "system_audio_auto_answer";
const ANSWER_STYLE_KEY = "system_audio_answer_style";

const loadSetting = <T extends string>(key: string, allowed: T[], fallback: T) => {
  const saved = safeLocalStorage.getItem(key) as T | null;
  return saved && allowed.includes(saved) ? saved : fallback;
};

export type useSystemAudioType = ReturnType<typeof useSystemAudio>;

export function useSystemAudio() {
  const { resizeWindow } = useWindowResize();
  const globalShortcuts = useGlobalShortcuts();
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  const [lastTranscription, setLastTranscription] = useState<string>("");
  const [lastAIResponse, setLastAIResponse] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [setupRequired, setSetupRequired] = useState<boolean>(false);
  const [quickActions, setQuickActions] = useState<string[]>([]);
  const [isManagingQuickActions, setIsManagingQuickActions] =
    useState<boolean>(false);
  const [showQuickActions, setShowQuickActions] = useState<boolean>(true);
  const [vadConfig, setVadConfig] = useState<VadConfig>(DEFAULT_VAD_CONFIG);
  const [recordingProgress, setRecordingProgress] = useState<number>(0); // For continuous mode
  const [isContinuousMode, setIsContinuousMode] = useState<boolean>(false);
  const [isRecordingInContinuousMode, setIsRecordingInContinuousMode] =
    useState<boolean>(false);

  const [conversation, setConversation] = useState<ChatConversation>({
    id: "",
    title: "",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  });

  // Context management states
  const [useSystemPrompt, setUseSystemPrompt] = useState<boolean>(true);
  const [contextContent, setContextContent] = useState<string>("");

  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    selectedAudioDevices,
  } = useApp();
  const [latency, setLatency] = useState<TurnLatency>({});
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [pendingText, setPendingText] = useState("");
  const [autoAnswerMode, setAutoAnswerModeState] = useState<AutoAnswerMode>(
    () => loadSetting(AUTO_ANSWER_KEY, ["question", "every", "manual"], "question")
  );
  const [answerStyle, setAnswerStyleState] = useState<AnswerStyle>(() =>
    loadSetting(ANSWER_STYLE_KEY, ["points", "short", "full"], "points")
  );
  // Transcribed segments waiting to be merged into one turn.
  const pendingTurnRef = useRef<{ texts: string[]; startedAt: number; stt: number } | null>(null);
  const turnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishTurnRef = useRef<() => void>(() => {});
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  // Transcriptions run one at a time, in arrival order, so utterances are never
  // dropped or reordered while the STT provider is busy.
  const sttQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Latest render values for the long-lived speech listener.
  const capturingRef = useRef(capturing);
  const conversationRef = useRef(conversation);
  const handleSpeechRef = useRef<
    (base64Audio: string, receivedAt: number) => Promise<void>
  >(async () => {});
  const isContinuousModeRef = useRef(isContinuousMode);
  const autoAnswerModeRef = useRef(autoAnswerMode);
  const answerStyleRef = useRef(answerStyle);
  capturingRef.current = capturing;
  conversationRef.current = conversation;
  isContinuousModeRef.current = isContinuousMode;
  autoAnswerModeRef.current = autoAnswerMode;
  answerStyleRef.current = answerStyle;
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef<boolean>(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Load context settings and VAD config from localStorage on mount
  useEffect(() => {
    const savedContext = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT
    );
    if (savedContext) {
      try {
        const parsed = JSON.parse(savedContext);
        setUseSystemPrompt(parsed.useSystemPrompt ?? true);
        setContextContent(parsed.contextContent ?? "");
      } catch (error) {
        console.error("Failed to load system audio context:", error);
      }
    }

    // Load VAD config
    const savedVadConfig = safeLocalStorage.getItem("vad_config");
    if (savedVadConfig) {
      try {
        const parsed = JSON.parse(savedVadConfig);
        setVadConfig(parsed);
      } catch (error) {
        console.error("Failed to load VAD config:", error);
      }
    }
  }, []);

  // Load quick actions from localStorage on mount
  useEffect(() => {
    const savedActions = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS
    );
    if (savedActions) {
      try {
        const parsed = JSON.parse(savedActions);
        setQuickActions(parsed);
      } catch (error) {
        console.error("Failed to load quick actions:", error);
        setQuickActions(DEFAULT_QUICK_ACTIONS);
      }
    } else {
      setQuickActions(DEFAULT_QUICK_ACTIONS);
    }
  }, []);

  // Handle continuous recording progress events AND error events
  useEffect(() => {
    let progressUnlisten: (() => void) | undefined;
    let startUnlisten: (() => void) | undefined;
    let stopUnlisten: (() => void) | undefined;
    let errorUnlisten: (() => void) | undefined;
    let discardedUnlisten: (() => void) | undefined;

    const setupContinuousListeners = async () => {
      try {
        // Progress updates (every second)
        progressUnlisten = await listen("recording-progress", (event) => {
          const seconds = event.payload as number;
          setRecordingProgress(seconds);
        });

        // Recording started
        startUnlisten = await listen("continuous-recording-start", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(true);
        });

        // Recording stopped
        stopUnlisten = await listen("continuous-recording-stopped", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(false);
        });

        // Audio encoding errors
        errorUnlisten = await listen("audio-encoding-error", (event) => {
          const errorMsg = event.payload as string;
          console.error("Audio encoding error:", errorMsg);
          setError(`Failed to process audio: ${errorMsg}`);
          setIsProcessing(false);
          setIsAIProcessing(false);
          setIsRecordingInContinuousMode(false);
        });

        // Speech discarded (too short)
        discardedUnlisten = await listen("speech-discarded", (event) => {
          const reason = event.payload as string;
          console.log("Speech discarded:", reason);
          // Don't show error - this is expected behavior
        });
      } catch (err) {
        console.error("Failed to setup continuous recording listeners:", err);
      }
    };

    setupContinuousListeners();

    return () => {
      if (progressUnlisten) progressUnlisten();
      if (startUnlisten) startUnlisten();
      if (stopUnlisten) stopUnlisten();
      if (errorUnlisten) errorUnlisten();
      if (discardedUnlisten) discardedUnlisten();
    };
  }, []);

  // Handle a single speech segment (both VAD and continuous modes).
  // Recreated every render so it always sees current providers and prompts.
  handleSpeechRef.current = async (base64Audio: string, receivedAt: number) => {
    if (!capturingRef.current) return;

    if (!selectedSttProvider.provider) {
      setError("No speech provider selected.");
      return;
    }

    const providerConfig = allSttProviders.find(
      (p) => p.id === selectedSttProvider.provider
    );
    if (!providerConfig) {
      setError("Speech provider config not found.");
      return;
    }

    const bytes = Uint8Array.from(atob(base64Audio), (c) => c.charCodeAt(0));
    const audioBlob = new Blob([bytes], { type: "audio/wav" });

    setIsProcessing(true);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<string>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Speech transcription timed out (30s)")),
          30000
        );
      });

      const transcription = await Promise.race([
        fetchSTT({
          provider: providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
        }),
        timeoutPromise,
      ]);

      // Capture may have been stopped while we were transcribing.
      if (!capturingRef.current) return;

      // Noise or silence: nothing to add, but let a pending turn finish.
      if (!transcription.trim()) {
        scheduleTurnEnd();
        return;
      }
      setError("");

      const stt = performance.now() - receivedAt;
      const pending = pendingTurnRef.current;
      if (pending) {
        pending.texts.push(transcription.trim());
        pending.stt = stt;
      } else {
        pendingTurnRef.current = {
          texts: [transcription.trim()],
          startedAt: receivedAt,
          stt,
        };
      }
      setPendingText(pendingTurnRef.current!.texts.join(" "));

      // A manual stop-and-send is always a complete turn; so is an explicit
      // question mark. Otherwise wait briefly in case the speaker continues.
      if (!isContinuousModeRef.current && !transcription.trim().endsWith("?")) {
        scheduleTurnEnd();
      } else {
        finishTurnRef.current();
      }
    } catch (sttError: any) {
      console.error("STT Error:", sttError);
      setError(sttError.message || "Failed to transcribe audio");
      setIsPopoverOpen(true);
    } finally {
      clearTimeout(timeoutId);
      setIsProcessing(false);
    }
  };

  const clearTurnTimer = () => {
    if (turnTimerRef.current) clearTimeout(turnTimerRef.current);
    turnTimerRef.current = null;
  };

  const scheduleTurnEnd = () => {
    clearTurnTimer();
    if (!pendingTurnRef.current) return;
    turnTimerRef.current = setTimeout(() => finishTurnRef.current(), TURN_MERGE_MS);
  };

  const getEffectiveSystemPrompt = () =>
    useSystemPrompt
      ? systemPrompt || DEFAULT_SYSTEM_PROMPT
      : contextContent || DEFAULT_SYSTEM_PROMPT;

  // Answer one transcript turn, with guidance for its question type.
  const answerTurn = (
    entry: TranscriptEntry,
    timing: { startedAt: number; stt?: number } = { startedAt: performance.now() }
  ) => {
    setTranscript((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, answered: true } : e))
    );
    setLastTranscription(entry.text);
    const prompt = `${getEffectiveSystemPrompt()}\n\n${buildAnswerGuidance(
      entry.questionType,
      answerStyleRef.current
    )}`;
    const previousMessages = conversationRef.current.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    // Not awaited: the next utterance can be transcribed while this answer
    // streams. A newer answer aborts this one.
    void processWithAI(entry.text, prompt, previousMessages, timing);
  };

  // Close the pending turn: record it and answer it if the mode says so.
  finishTurnRef.current = () => {
    clearTurnTimer();
    const pending = pendingTurnRef.current;
    pendingTurnRef.current = null;
    setPendingText("");
    if (!pending || !capturingRef.current) return;

    const text = pending.texts.join(" ");
    const isQuestion = isLikelyQuestion(text);
    const entry: TranscriptEntry = {
      id: generateMessageId("user", Date.now()),
      text,
      at: Date.now(),
      isQuestion,
      questionType: classifyQuestion(text),
      answered: false,
    };
    setTranscript((prev) => [...prev, entry]);

    const mode = autoAnswerModeRef.current;
    const shouldAnswer =
      isContinuousModeRef.current ||
      mode === "every" ||
      (mode === "question" && isQuestion);
    if (shouldAnswer) {
      answerTurn(entry, { startedAt: pending.startedAt, stt: pending.stt });
    }
  };

  // While the speaker keeps talking, hold the current turn open.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: (() => void)[] = [];
    const register = async () => {
      const fns = await Promise.all([
        listen("speech-start", () => clearTurnTimer()),
        listen("speech-discarded", () => scheduleTurnEnd()),
      ]);
      if (cancelled) fns.forEach((fn) => fn());
      else unlisteners.push(...fns);
    };
    register().catch((err) =>
      console.error("Failed to set up speech turn listeners:", err)
    );
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
      clearTurnTimer();
    };
  }, []);

  // Register the speech listener once for the hook's lifetime.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    listen<string>("speech-detected", (event) => {
      if (!capturingRef.current) return;
      const receivedAt = performance.now();
      sttQueueRef.current = sttQueueRef.current
        .then(() => handleSpeechRef.current(event.payload, receivedAt))
        .catch((err) => {
          console.error("Failed to process speech:", err);
          setError("Failed to process speech");
        });
    })
      .then((fn) => {
        // The effect may have been cleaned up before listen() resolved.
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => setError("Failed to setup speech listener"));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Context management functions
  const saveContextSettings = useCallback(
    (usePrompt: boolean, content: string) => {
      try {
        const contextSettings = {
          useSystemPrompt: usePrompt,
          contextContent: content,
        };
        safeLocalStorage.setItem(
          STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT,
          JSON.stringify(contextSettings)
        );
      } catch (error) {
        console.error("Failed to save context settings:", error);
      }
    },
    []
  );

  const updateUseSystemPrompt = useCallback(
    (value: boolean) => {
      setUseSystemPrompt(value);
      saveContextSettings(value, contextContent);
    },
    [contextContent, saveContextSettings]
  );

  const updateContextContent = useCallback(
    (content: string) => {
      setContextContent(content);
      saveContextSettings(useSystemPrompt, content);
    },
    [useSystemPrompt, saveContextSettings]
  );

  // Quick actions management
  const saveQuickActions = useCallback((actions: string[]) => {
    try {
      safeLocalStorage.setItem(
        STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS,
        JSON.stringify(actions)
      );
    } catch (error) {
      console.error("Failed to save quick actions:", error);
    }
  }, []);

  const addQuickAction = useCallback(
    (action: string) => {
      if (action && !quickActions.includes(action)) {
        const newActions = [...quickActions, action];
        setQuickActions(newActions);
        saveQuickActions(newActions);
      }
    },
    [quickActions, saveQuickActions]
  );

  const removeQuickAction = useCallback(
    (action: string) => {
      const newActions = quickActions.filter((a) => a !== action);
      setQuickActions(newActions);
      saveQuickActions(newActions);
    },
    [quickActions, saveQuickActions]
  );

  const setAutoAnswerMode = useCallback((mode: AutoAnswerMode) => {
    setAutoAnswerModeState(mode);
    safeLocalStorage.setItem(AUTO_ANSWER_KEY, mode);
  }, []);

  const setAnswerStyle = useCallback((style: AnswerStyle) => {
    setAnswerStyleState(style);
    safeLocalStorage.setItem(ANSWER_STYLE_KEY, style);
  }, []);

  // Answer a transcript line on demand ("Answer this").
  const answerTranscriptEntry = (id: string) => {
    const entry = transcript.find((e) => e.id === id);
    if (entry) answerTurn(entry);
  };

  // Answer the most recent turn, finishing it first if still pending.
  const answerLatest = () => {
    if (pendingTurnRef.current) {
      const previousMode = autoAnswerModeRef.current;
      autoAnswerModeRef.current = "every";
      finishTurnRef.current();
      autoAnswerModeRef.current = previousMode;
      return;
    }
    const latest = transcript[transcript.length - 1];
    if (latest) answerTurn(latest);
  };

  const handleQuickActionClick = async (action: string) => {
    setError("");

    const effectiveSystemPrompt = useSystemPrompt
      ? systemPrompt || DEFAULT_SYSTEM_PROMPT
      : contextContent || DEFAULT_SYSTEM_PROMPT;

    // Include what was said since the last answer (or, failing that, the last
    // transcription) in the conversation history.
    let updatedMessages = [...conversation.messages];
    const lastAnsweredIndex = transcript.map((e) => e.answered).lastIndexOf(true);
    const unanswered = transcript
      .slice(lastAnsweredIndex + 1)
      .map((e) => e.text)
      .join(" ");
    const recentSpeech = unanswered || lastTranscription;
    if (unanswered) {
      setTranscript((prev) =>
        prev.map((e, i) => (i > lastAnsweredIndex ? { ...e, answered: true } : e))
      );
    }

    if (recentSpeech && recentSpeech.trim()) {
      const lastMessage = updatedMessages[updatedMessages.length - 1];
      // Only add if it's not already the last message
      if (!lastMessage || lastMessage.content !== recentSpeech) {
        const timestamp = Date.now();
        const userMessage = {
          id: generateMessageId("user", timestamp),
          role: "user" as const,
          content: recentSpeech,
          timestamp,
        };
        updatedMessages.push(userMessage);

        // Update conversation state with the latest transcription
        setConversation((prev) => ({
          ...prev,
          messages: [...prev.messages, userMessage],
          updatedAt: timestamp,
          title: prev.title || generateConversationTitle(recentSpeech),
        }));
      }
    }

    const previousMessages = updatedMessages.map((msg) => {
      return { role: msg.role, content: msg.content };
    });

    await processWithAI(action, effectiveSystemPrompt, previousMessages, {
      startedAt: performance.now(),
    });
  };

  // Start continuous recording manually
  const startContinuousRecording = useCallback(async () => {
    try {
      setRecordingProgress(0);
      setError("");

      const deviceId =
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      // Start a new continuous recording session
      await invoke<string>("start_system_audio_capture", {
        vadConfig: vadConfig,
        deviceId: deviceId,
      });
    } catch (err) {
      console.error("Failed to start continuous recording:", err);
      setError(`Failed to start recording: ${err}`);
    }
  }, [vadConfig, selectedAudioDevices.output.id]);

  // Ignore current recording (stop without transcription)
  const ignoreContinuousRecording = useCallback(async () => {
    try {
      if (!isContinuousMode || !isRecordingInContinuousMode) return;

      // Stop the capture without processing
      await invoke<string>("stop_system_audio_capture");

      // Reset states
      setRecordingProgress(0);
      setIsProcessing(false);
      setIsRecordingInContinuousMode(false);
    } catch (err) {
      console.error("Failed to ignore recording:", err);
      setError(`Failed to ignore recording: ${err}`);
    }
  }, [isContinuousMode, isRecordingInContinuousMode]);

  // AI Processing function. previousMessages must be in chronological order.
  const processWithAI = useCallback(
    async (
      transcription: string,
      prompt: string,
      previousMessages: Message[],
      timing: { startedAt: number; stt?: number } = {
        startedAt: performance.now(),
      }
    ) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const requestId = ++requestIdRef.current;
      const isCurrent = () =>
        requestIdRef.current === requestId && !controller.signal.aborted;

      try {
        setIsAIProcessing(true);
        setLastAIResponse("");
        setError("");
        setLatency({ stt: timing.stt });

        let fullResponse = "";

        if (!selectedAIProvider.provider) {
          setError("No AI provider selected.");
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider) {
          setError("AI provider config not found.");
          return;
        }

        try {
          for await (const chunk of fetchAIResponse({
            provider,
            selectedProvider: selectedAIProvider,
            systemPrompt: prompt,
            history: previousMessages,
            userMessage: transcription,
            imagesBase64: [],
            signal: controller.signal,
          })) {
            if (!isCurrent()) return;
            if (!fullResponse) {
              const firstToken = performance.now() - timing.startedAt;
              setLatency((prev) => ({ ...prev, firstToken }));
            }
            fullResponse += chunk;
            setLastAIResponse((prev) => prev + chunk);
          }
        } catch (aiError: any) {
          if (isCurrent()) {
            setError(aiError.message || "Failed to get AI response");
          }
        }

        if (!isCurrent()) return;
        setLatency((prev) => ({
          ...prev,
          total: performance.now() - timing.startedAt,
        }));

        if (fullResponse) {
          const timestamp = Date.now();
          setConversation((prev) => ({
            ...prev,
            messages: [
              ...prev.messages,
              {
                id: generateMessageId("user", timestamp),
                role: "user" as const,
                content: transcription,
                timestamp,
              },
              {
                id: generateMessageId("assistant", timestamp + 1),
                role: "assistant" as const,
                content: fullResponse,
                timestamp: timestamp + 1,
              },
            ],
            updatedAt: timestamp,
            title: prev.title || generateConversationTitle(transcription),
          }));
        }
      } catch (err) {
        if (isCurrent()) setError("Failed to get AI response");
      } finally {
        // A newer request owns the processing flag once it has started.
        if (requestIdRef.current === requestId) setIsAIProcessing(false);
      }
    },
    [selectedAIProvider, allAiProviders]
  );

  const startCapture = useCallback(async () => {
    try {
      setError("");

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setSetupRequired(true);
        setIsPopoverOpen(true);
        return;
      }

      const isContinuous = !vadConfig.enabled;

      // Set up conversation
      setTranscript([]);
      const conversationId = generateConversationId("sysaudio");
      setConversation({
        id: conversationId,
        title: "",
        messages: [],
        createdAt: 0,
        updatedAt: 0,
      });

      setCapturing(true);
      setIsPopoverOpen(true);
      setIsContinuousMode(isContinuous);
      setRecordingProgress(0);

      // If continuous mode
      if (isContinuous) {
        setIsRecordingInContinuousMode(false);
        return;
      }

      // VAD mode: Start recording immediately
      // Stop any existing capture
      await invoke<string>("stop_system_audio_capture");

      const deviceId =
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      // Start capture with VAD config
      await invoke<string>("start_system_audio_capture", {
        vadConfig: vadConfig,
        deviceId: deviceId,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setIsPopoverOpen(true);
    }
  }, [vadConfig, selectedAudioDevices.output.id]);

  const stopCapture = useCallback(async () => {
    try {
      // Abort any ongoing AI requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      // Stop the audio capture
      await invoke<string>("stop_system_audio_capture");

      // Reset ALL states
      setCapturing(false);
      setIsProcessing(false);
      setIsAIProcessing(false);
      setIsContinuousMode(false);
      setIsRecordingInContinuousMode(false);
      setRecordingProgress(0);
      setLastTranscription("");
      setLastAIResponse("");
      setError("");
      setIsPopoverOpen(false);
      clearTurnTimer();
      pendingTurnRef.current = null;
      setPendingText("");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to stop capture: ${errorMessage}`);
      console.error("Stop capture error:", err);
    }
  }, []);

  // Manual stop for continuous recording
  const manualStopAndSend = useCallback(async () => {
    try {
      if (!isContinuousMode) {
        console.warn("Not in continuous mode");
        return;
      }

      // Show processing state immediately
      setIsProcessing(true);

      // Trigger manual stop event
      await invoke("manual_stop_continuous");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to manually stop: ${errorMessage}`);
      setIsProcessing(false); // Clear processing state on error
      console.error("Manual stop error:", err);
    }
  }, [isContinuousMode]);

  const handleSetup = useCallback(async () => {
    try {
      const platform = navigator.platform.toLowerCase();

      if (platform.includes("mac") || platform.includes("win")) {
        await invoke("request_system_audio_access");
      }

      // Delay to give the user time to grant permissions in the system dialog.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (hasAccess) {
        setSetupRequired(false);
        await startCapture();
      } else {
        setSetupRequired(true);
        setError("Permission not granted. Please try the manual steps.");
      }
    } catch (err) {
      setError("Failed to request access. Please try the manual steps below.");
      setSetupRequired(true);
    }
  }, [startCapture]);

  useEffect(() => {
    const shouldOpenPopover =
      capturing ||
      setupRequired ||
      isAIProcessing ||
      !!lastAIResponse ||
      !!error;
    setIsPopoverOpen(shouldOpenPopover);
    resizeWindow(shouldOpenPopover);
  }, [
    capturing,
    setupRequired,
    isAIProcessing,
    lastAIResponse,
    error,
    resizeWindow,
  ]);

  useEffect(() => {
    globalShortcuts.registerSystemAudioCallback(async () => {
      if (capturing) {
        await stopCapture();
      } else {
        await startCapture();
      }
    });
  }, [startCapture, stopCapture]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      invoke("stop_system_audio_capture").catch(() => {});
    };
  }, []);

  // Debounced save to prevent race conditions and improve performance
  useEffect(() => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Only debounce if there are messages to save
    if (
      !conversation.id ||
      conversation.updatedAt === 0 ||
      conversation.messages.length === 0
    ) {
      return;
    }

    // Debounce saves (only save 500ms after last change)
    saveTimeoutRef.current = setTimeout(async () => {
      // Don't save if already saving (prevent concurrent saves)
      if (isSavingRef.current) {
        return;
      }

      try {
        isSavingRef.current = true;
        await saveConversation(conversation);
      } catch (error) {
        console.error("Failed to save system audio conversation:", error);
      } finally {
        isSavingRef.current = false;
      }
    }, CONVERSATION_SAVE_DEBOUNCE_MS);

    // Cleanup on unmount or dependency change
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [
    conversation.messages.length,
    conversation.title,
    conversation.id,
    conversation.updatedAt,
  ]);

  const startNewConversation = useCallback(() => {
    setConversation({
      id: generateConversationId("sysaudio"),
      title: "",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });
    setTranscript([]);
    clearTurnTimer();
    pendingTurnRef.current = null;
    setPendingText("");
    setLastTranscription("");
    setLastAIResponse("");
    setError("");
    setSetupRequired(false);
    setIsProcessing(false);
    setIsAIProcessing(false);
    setIsPopoverOpen(false);
    setUseSystemPrompt(true);
  }, []);

  // Update VAD configuration
  const updateVadConfiguration = useCallback(async (config: VadConfig) => {
    try {
      setVadConfig(config);
      safeLocalStorage.setItem("vad_config", JSON.stringify(config));
      await invoke("update_vad_config", { config });
    } catch (error) {
      console.error("Failed to update VAD config:", error);
    }
  }, []);

  useEffect(() => {
    if (capturing) {
      setIsContinuousMode(!vadConfig.enabled);

      if (!vadConfig.enabled) {
        setIsRecordingInContinuousMode(false);
      }
    }
  }, [vadConfig.enabled, capturing]);

  // Keyboard arrow key support for scrolling (local shortcut)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      const scrollElement = scrollAreaRef.current?.querySelector(
        "[data-radix-scroll-area-viewport]"
      ) as HTMLElement;

      if (!scrollElement) return;

      const scrollAmount = 100; // pixels to scroll

      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollElement.scrollBy({ top: scrollAmount, behavior: "smooth" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollElement.scrollBy({ top: -scrollAmount, behavior: "smooth" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen]);

  // Keyboard shortcuts for continuous mode recording (local shortcuts)
  useEffect(() => {
    const handleRecordingShortcuts = (e: KeyboardEvent) => {
      if (!isPopoverOpen || !isContinuousMode) return;
      if (isProcessing || isAIProcessing) return;

      // Enter: Start recording (when not recording) or Stop & Send (when recording)
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!isRecordingInContinuousMode) {
          startContinuousRecording();
        } else {
          manualStopAndSend();
        }
      }

      // Escape: Ignore recording (when recording)
      if (e.key === "Escape" && isRecordingInContinuousMode) {
        e.preventDefault();
        ignoreContinuousRecording();
      }

      // Space: Start recording (when not recording) - only if not typing in input
      if (
        e.key === " " &&
        !isRecordingInContinuousMode &&
        !e.metaKey &&
        !e.ctrlKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        startContinuousRecording();
      }
    };

    window.addEventListener("keydown", handleRecordingShortcuts);
    return () =>
      window.removeEventListener("keydown", handleRecordingShortcuts);
  }, [
    isPopoverOpen,
    isContinuousMode,
    isRecordingInContinuousMode,
    isProcessing,
    isAIProcessing,
    startContinuousRecording,
    manualStopAndSend,
    ignoreContinuousRecording,
  ]);

  return {
    capturing,
    isProcessing,
    isAIProcessing,
    lastTranscription,
    lastAIResponse,
    error,
    setupRequired,
    startCapture,
    stopCapture,
    handleSetup,
    isPopoverOpen,
    setIsPopoverOpen,
    // Conversation management
    conversation,
    setConversation,
    // AI processing
    processWithAI,
    latency,
    // Live transcript and answering
    transcript,
    pendingText,
    answerTranscriptEntry,
    answerLatest,
    autoAnswerMode,
    setAutoAnswerMode,
    answerStyle,
    setAnswerStyle,
    // Context management
    useSystemPrompt,
    setUseSystemPrompt: updateUseSystemPrompt,
    contextContent,
    setContextContent: updateContextContent,
    startNewConversation,
    // Window resize
    resizeWindow,
    quickActions,
    addQuickAction,
    removeQuickAction,
    isManagingQuickActions,
    setIsManagingQuickActions,
    showQuickActions,
    setShowQuickActions,
    handleQuickActionClick,
    // VAD configuration
    vadConfig,
    updateVadConfiguration,
    // Continuous recording
    isContinuousMode,
    isRecordingInContinuousMode,
    recordingProgress,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    // Scroll area ref for keyboard navigation
    scrollAreaRef,
  };
}
