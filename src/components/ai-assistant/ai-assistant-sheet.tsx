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

/** Server contract for POST /api/ai/chat. */
type ChatResponse = { reply: string; sessionId: string | null };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const EXAMPLE_PROMPTS = [
  "Help me handle a \"we're already happy with our agent\" objection.",
  "Draft a friendly follow-up text after an office visit.",
  "Plan my activity targets for this week.",
  "Give me three ideas to work a new territory.",
];

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

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return; // guard duplicate / empty sends

      // Stop dictation cleanly the moment we send.
      if (listening) stop();

      setError(null);
      setSending(true);
      setInput("");
      speechBaseRef.current = "";
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", content: trimmed },
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
          }),
        });
        if (data.sessionId) setSessionId(data.sessionId);
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", content: data.reply },
        ]);
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Something went wrong. Please try again.";
        setError(message);
      } finally {
        setSending(false);
      }
    },
    [sending, sessionId, listening, stop],
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
            <div className="flex w-full flex-col gap-2">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => {
                    setInput(prompt);
                    textareaRef.current?.focus();
                  }}
                  className="rounded-lg border border-border/70 bg-card px-3 py-2 text-left text-sm text-foreground/90 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {prompt}
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
