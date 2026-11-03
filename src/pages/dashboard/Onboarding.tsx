import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageLayout } from "@/layouts";
import { Button, Textarea } from "@/components";
import { useApp } from "@/contexts";
import { useProfile } from "@/contexts/profile.context";
import { fetchSTT } from "@/lib/functions/stt.function";
import { buildInterviewContext } from "@/lib/context";
import { Action, Field, Panel } from "@/pages/profile/fields";
import { useKnowledgeAI } from "@/pages/profile/useKnowledgeAI";

const STEPS = [
  "Choose providers",
  "Test speech",
  "Add your resume",
  "Create a session",
  "Practice",
];
export default function Onboarding() {
  const { selectedAIProvider, selectedSttProvider, allSttProviders } = useApp();
  const speechProvider = allSttProviders.find(
    (p) => p.id === selectedSttProvider.provider,
  );
  const { profile, activeSessionId } = useProfile();
  const ai = useKnowledgeAI();
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [question, setQuestion] = useState("Tell me about yourself");
  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState("");
  useEffect(() => {
    try {
      const saved = Number(
        localStorage.getItem("knowledge_onboarding_step") || 0,
      );
      if (saved >= 0 && saved < STEPS.length) setStep(saved);
    } catch {}
  }, []);
  const next = () => {
    const value = Math.min(step + 1, 4);
    setStep(value);
    localStorage.setItem("knowledge_onboarding_step", String(value));
  };
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
  return (
    <PageLayout
      title="Get ready for your first interview"
      description="Set up your providers, choose your evidence, and try a practice question."
    >
      <nav aria-label="Onboarding steps" className="flex flex-wrap gap-2">
        {STEPS.map((label, i) => (
          <Button
            key={label}
            variant={i === step ? "default" : "outline"}
            onClick={() => setStep(i)}
            aria-current={i === step ? "step" : undefined}
          >
            {i + 1}. {label}
          </Button>
        ))}
      </nav>
      {(error || ai.error) && (
        <p role="alert" className="text-destructive">
          {error || ai.error}
        </p>
      )}
      {step === 0 && (
        <Panel title="1. Choose providers">
          <p>
            Your AI provider: {selectedAIProvider.provider || "Not selected"}.
            Speech provider: {selectedSttProvider.provider || "Not selected"}.
          </p>
          <p>
            Use your own provider credentials. Requests go directly from this
            device to your selected provider. Local providers work offline after
            setup.
          </p>
          <Link className="underline" to="/dev-space">
            Choose and configure providers
          </Link>
          <div>
            <Action onClick={next}>Continue</Action>
          </div>
        </Panel>
      )}
      {step === 1 && (
        <Panel title="2. Test speech transcription">
          <p className="text-sm">
            {speechProvider?.realtime
              ? "Test live streaming in the main overlay: start listening, play a short question, and confirm its transcript appears. Audio file tests are for request-based speech providers."
              : `Choose a short audio clip to send to ${selectedSttProvider.provider}. This uses your existing speech provider configuration. For local Whisper, start the local service in Audio first.`}
          </p>
          <Link className="underline" to="/audio">
            Audio setup
          </Link>
          <label className="block">
            Test audio clip
            <input
              className="block mt-2"
              type="file"
              accept="audio/*"
              disabled={busy || Boolean(speechProvider?.realtime)}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  void run(async () => {
                    if (file.size > 10 * 1024 * 1024)
                      throw new Error("Choose a clip under 10 MB");
                    const provider = allSttProviders.find(
                      (p) => p.id === selectedSttProvider.provider,
                    );
                    if (!provider)
                      throw new Error(
                        "Select a supported speech provider first",
                      );
                    setTranscript(
                      await fetchSTT({
                        provider,
                        selectedProvider: selectedSttProvider,
                        audio: file,
                      }),
                    );
                  });
                e.target.value = "";
              }}
            />
          </label>
          <Textarea
            readOnly
            aria-label="Speech test result"
            value={transcript}
            rows={4}
          />
          <Action onClick={next}>Continue</Action>
        </Panel>
      )}
      {step === 2 && (
        <Panel title="3. Add your resume">
          <p>
            Profile: {profile.name || "Not filled in yet"}. Upload a PDF, DOCX,
            TXT or Markdown resume, review the extracted text, and choose which
            sources to include.
          </p>
          <Link className="underline" to="/profile">
            Open your profile and upload
          </Link>
          <div>
            <Action onClick={next}>Continue</Action>
          </div>
        </Panel>
      )}
      {step === 3 && (
        <Panel title="4. Create a session">
          <p>
            {activeSessionId
              ? "A session is selected."
              : "Create and select your first company and role."}{" "}
            Include the JD, choose a round type, and generate a prep pack after
            reviewing the data preview.
          </p>
          <Link className="underline" to="/sessions">
            Create or select a session
          </Link>
          <div>
            <Action onClick={next}>Continue</Action>
          </div>
        </Panel>
      )}
      {step === 4 && (
        <Panel title="5. Try a practice question">
          <Field
            label="Practice question"
            value={question}
            onChange={(v) => {
              setQuestion(v);
              setInput("");
            }}
          />
          <Action
            busy={busy || ai.busy}
            onClick={() =>
              void run(async () => {
                const context = await buildInterviewContext({ question });
                setInput(
                  `Question: ${question}\n\n${context.systemPromptAddendum}`,
                );
              })
            }
          >
            Preview practice request
          </Action>
          {input && (
            <>
              <Textarea
                aria-label="Practice data sent to AI provider"
                rows={8}
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              <Action
                busy={busy || ai.busy}
                onClick={() =>
                  void run(async () => {
                    setAnswer(
                      await ai.generate(
                        "Help the candidate practice an interview answer. Use only supplied facts and approved stories. If evidence is missing, suggest a structure and ask for real details. Do not invent achievements.",
                        input,
                      ),
                    );
                  })
                }
              >
                Send preview to {ai.providerName} and practice
              </Action>
              {ai.busy && <Action onClick={ai.cancel}>Cancel</Action>}
            </>
          )}
          <Textarea
            aria-label="Practice answer"
            rows={8}
            value={answer}
            readOnly
          />
          <p className="text-sm">
            Return to Get started at any time to review setup.
          </p>
          <Action
            onClick={() => {
              localStorage.setItem("knowledge_onboarding_complete", "true");
              setAnswer(
                "Setup complete. Your profile, stories, and sessions are ready to use.",
              );
            }}
          >
            Finish setup
          </Action>
        </Panel>
      )}
    </PageLayout>
  );
}
