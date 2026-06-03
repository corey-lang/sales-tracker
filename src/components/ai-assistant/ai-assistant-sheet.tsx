"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeft, Loader2, Mic, Send, Sparkles, Square } from "lucide-react";

import { apiFetchJson } from "@/lib/api-client";
import { useSpeechRecognition } from "./use-speech-recognition";

/** One guided-flow answer chip from the agent. */
type AnswerOption = { label: string; value: string };

/** Server contract for POST /api/ai/chat. */
type ChatResponse = {
  reply: string;
  sessionId: string | null;
  answerOptions?: AnswerOption[];
  threadId?: string | null;
  currentStep?: string | null;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

/** Suggested starters for the empty state. `label` is the short chip text; the
 *  full `prompt` is what gets sent. */
const SUGGESTED_CHIPS: { label: string; prompt: string }[] = [
  { label: "Coverage Questions", prompt: "What coverage questions do customers commonly ask?" },
  { label: "Plan Options", prompt: "What plan options do we offer?" },
  { label: "Seller Coverage", prompt: "Tell me about seller coverage." },
  { label: "Buyer Coverage", prompt: "Tell me about buyer coverage." },
  { label: "Add-ons", prompt: "What optional add-ons can I offer?" },
  { label: "Objection Help", prompt: "Help me handle a pricing objection." },
  { label: "What should I recommend?", prompt: "What should I recommend to an agent?" },
];

/** Fallback answer options keyed by currentStep, used when the agent advances
 *  to a step that requires a choice but the response omitted answerOptions.
 *  Prevents the guided flow from looping (user typing free-text the agent
 *  can't use). */
const FALLBACK_OPTIONS_BY_STEP: Record<string, AnswerOption[]> = {
  coverageType: [
    { label: "Real Estate", value: "real_estate" },
    { label: "Homeowner", value: "homeowner" },
    { label: "Sellers", value: "sellers" },
  ],
};

/** Stable-ish id without Math.random/Date in render. A monotonic counter is
 *  enough to key React list items within one open session. */
let messageSeq = 0;
function nextId(): string {
  messageSeq += 1;
  return `m${messageSeq}`;
}

export function AiAssistantSheet({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  // Guided-flow state. threadId/currentStep keep follow-up option taps in the
  // same agent flow; pendingOptions are the chips shown under the latest reply.
  const [threadId, setThreadId] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [pendingOptions, setPendingOptions] = useState<AnswerOption[]>([]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Synchronous in-flight lock. `sending` (React state) updates on the next
  // render, so two taps in the same tick both see it as false; this ref flips
  // immediately and blocks the duplicate before any state settles.
  const inFlightRef = useRef(false);
  // The typed draft captured the moment the mic started, so live transcription
  // replaces only the dictated portion rather than clobbering what was typed.
  const speechBaseRef = useRef("");

  // Touch devices: keep Enter as newline (soft keyboards send Enter on the
  // return key) and require the Send button. Desktop: Enter sends.
  const isTouch = useMemo(() => {
    if (typeof window === "undefined") return false;
    return (
      "ontouchstart" in window ||
      (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
    );
  }, []);

  const handleTranscript = useCallback((transcript: string) => {
    const base = speechBaseRef.current;
    const next = base ? `${base} ${transcript}` : transcript;
    setInput(next);
  }, []);

  const { supported: voiceSupported, listening, start, stop } =
    useSpeechRecognition({
      onTranscript: handleTranscript,
      onError: (message) => setError(message),
    });

  // Lock body scroll + close on Escape while the sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Track the visual viewport so the sheet shrinks above the on-screen
  // keyboard instead of being covered by it (mobile Safari/Chrome).
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const sync = () => setViewportHeight(vv.height);
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);

  // Auto-scroll to the newest message / loading indicator.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const send = useCallback(
    // `text` is what's sent to the agent; `displayText` (when given) is what's
    // shown in the user's bubble — used for answer-option taps, where we send
    // the option's machine value but show its human label. `fromOption` marks
    // a tap so it bypasses the guided-flow free-text lock.
    async (
      text: string,
      opts?: { displayText?: string; fromOption?: boolean },
    ) => {
      const trimmed = text.trim();
      if (!trimmed || inFlightRef.current) return;

      // Guided-flow lock: while the agent is waiting on a required choice,
      // don't send arbitrary typed text — it can't advance the flow and causes
      // the agent to repeat its question. Option taps (fromOption) are exempt.
      if (!opts?.fromOption && pendingOptions.length > 0) {
        setError(
          "Please choose one of the options above so I can continue this coverage flow.",
        );
        return;
      }

      // Synchronous lock so rapid chip/Send taps can't double-fire; the
      // `sending` state still drives the loading UI below.
      inFlightRef.current = true;

      // Stop dictation cleanly the moment we send.
      if (listening) stop();

      setError(null);
      setSending(true);
      setInput("");
      speechBaseRef.current = "";
      // Moving forward — clear the previous turn's answer chips.
      setPendingOptions([]);
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "user",
          content: (opts?.displayText ?? trimmed).trim(),
        },
      ]);

      try {
        const data = await apiFetchJson<ChatResponse>("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            // Send the session id once the first response established it so
            // the agent keeps conversation state across turns.
            ...(sessionId ? { sessionId } : {}),
            // Echo back the guided-flow context so option taps resume the
            // same flow.
            ...(threadId ? { threadId } : {}),
            ...(currentStep ? { currentStep } : {}),
          }),
        });
        if (data.sessionId) setSessionId(data.sessionId);
        // Mirror the server's flow state every turn. When the flow ends the
        // server omits threadId/currentStep, so coalesce to null to clear them
        // — otherwise a stale threadId would keep resuming a finished workflow.
        setThreadId(data.threadId ?? null);
        setCurrentStep(data.currentStep ?? null);
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", content: data.reply },
        ]);

        // Use the agent's options; if a step that requires a choice came back
        // without them, fall back to the known options for that step so the
        // user always has chips to tap (no looping).
        let options = Array.isArray(data.answerOptions)
          ? data.answerOptions
          : [];
        if (
          options.length === 0 &&
          data.currentStep &&
          FALLBACK_OPTIONS_BY_STEP[data.currentStep]
        ) {
          options = FALLBACK_OPTIONS_BY_STEP[data.currentStep];
        }
        setPendingOptions(options);
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Something went wrong. Please try again.";
        setError(message);
      } finally {
        setSending(false);
        inFlightRef.current = false;
      }
    },
    [sessionId, threadId, currentStep, pendingOptions, listening, stop],
  );

  const onTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop affordance: Enter sends, Shift+Enter inserts a newline. On touch
    // devices Enter always inserts a newline (comfortable mobile UX).
    if (e.key === "Enter" && !e.shiftKey && !isTouch) {
      e.preventDefault();
      void send(input);
    }
  };

  const toggleMic = () => {
    if (listening) {
      stop();
      return;
    }
    setError(null);
    speechBaseRef.current = input.trim();
    start();
  };

  const canSend = input.trim().length > 0 && !sending;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="AI Assistant"
      className="fixed inset-x-0 top-0 z-50 flex flex-col overflow-hidden bg-background"
      style={{
        height: viewportHeight ? `${viewportHeight}px` : "100dvh",
        maxHeight: "100dvh",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "var(--app-safe-bottom, 0px)",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close AI Assistant"
          className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <ChevronLeft aria-hidden="true" className="size-5" />
        </button>
        <Sparkles aria-hidden="true" className="size-4 text-primary" />
        <p className="text-sm font-semibold">AI Assistant</p>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
          Beta
        </span>
      </div>

      {/* Conversation */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4"
      >
        {messages.length === 0 ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-2 py-8 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
              <Sparkles aria-hidden="true" className="size-6 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="text-base font-semibold">How can I help?</p>
              <p className="text-sm text-muted-foreground">
                Ask about coaching, objections, follow-up wording, weekly
                planning, or how to use the app. Type or tap the mic to speak.
              </p>
            </div>
            <div className="flex w-full flex-wrap justify-center gap-2">
              {SUGGESTED_CHIPS.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  disabled={sending}
                  onClick={() => void send(chip.prompt)}
                  className="rounded-full border border-border/70 bg-card px-3 py-1.5 text-sm text-foreground/90 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-50"
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.role === "user" ? "flex justify-end" : "flex justify-start"
                }
              >
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
                      : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-foreground"
                  }
                >
                  {m.content}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2
                    aria-hidden="true"
                    className="size-4 animate-spin"
                  />
                  Thinking…
                </div>
              </div>
            )}
            {/* Guided-flow answer chips, shown under the latest assistant
                reply. Tapping sends the option's value but shows its label. */}
            {!sending && pendingOptions.length > 0 && (
              <div className="flex flex-col gap-1.5 pt-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Choose one to continue:
                </p>
                <div className="flex flex-wrap gap-2">
                  {pendingOptions.map((opt, i) => (
                    <button
                      key={`${opt.value}-${i}`}
                      type="button"
                      disabled={sending}
                      onClick={() =>
                        void send(opt.value, {
                          displayText: opt.label,
                          fromOption: true,
                        })
                      }
                      className="rounded-full border border-primary/40 bg-primary/5 px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-50"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border/60 px-3 py-3">
        {error && (
          <div className="mb-2 rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {listening && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
            </span>
            Listening… speak now, then tap stop to review.
          </div>
        )}
        {pendingOptions.length > 0 && (
          <p className="mb-2 text-xs text-muted-foreground">
            Please choose an option above to continue this step.
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            rows={1}
            placeholder="Type a message…"
            aria-label="Message"
            className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary sm:text-sm"
          />

          {/* Mic: only when supported. Tapping requests the mic for the first
              time; it is never requested on mount. */}
          {voiceSupported ? (
            <button
              type="button"
              onClick={toggleMic}
              aria-label={listening ? "Stop voice input" : "Start voice input"}
              aria-pressed={listening}
              className={
                listening
                  ? "inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-destructive/15 text-destructive transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
                  : "inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              }
            >
              {listening ? (
                <Square aria-hidden="true" className="size-4 fill-current" />
              ) : (
                <Mic aria-hidden="true" className="size-5" />
              )}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => void send(input)}
            disabled={!canSend}
            aria-label="Send message"
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-50"
          >
            {sending ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Send aria-hidden="true" className="size-4" />
            )}
          </button>
        </div>
        {!voiceSupported && (
          <p className="mt-2 text-xs text-muted-foreground">
            Voice input isn&apos;t available on this device yet. You can still
            type your message.
          </p>
        )}
      </div>
    </div>
  );
}
