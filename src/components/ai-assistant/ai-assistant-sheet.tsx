"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  FileText,
  Loader2,
  Mic,
  Send,
  Sparkles,
  Square,
} from "lucide-react";

import { apiFetchJson } from "@/lib/api-client";
import { useSpeechRecognition } from "./use-speech-recognition";

/** One guided-flow answer chip from the agent. */
type AnswerOption = { label: string; value: string };

/** A brochure source attached to a grounded coverage answer. */
type Citation = {
  brochure: string;
  version: string | null;
  /** Source pages the answer's facts came from (unique, sorted). */
  pages: number[];
  /** Rendered chip text, e.g. "Utah Brochure 2025.7, pp. 3, 5". */
  label: string;
};

/** The state the answer was grounded in, for the "Answering using …" banner. */
type StateContext = { code: string; label: string };

/** Accumulated LOCAL coverage-narrowing slots. Round-tripped to the server each
 *  turn so a later chip tap ("Epic") still carries the earlier slot ("HVAC").
 *  Kept entirely separate from the Cogent threadId/currentStep channel. */
type CoverageContext = {
  intent: string;
  coverageItem?: string;
  planName?: string;
  comparePlans?: string[];
  coverageAudience?: string;
};

/** Server contract for POST /api/ai/chat. */
type ChatResponse = {
  reply: string;
  sessionId: string | null;
  answerOptions?: AnswerOption[];
  threadId?: string | null;
  currentStep?: string | null;
  /** Routed department ("sales"/"plans"/"coverage"); echoed back to keep a
   *  guided flow sticky to its department. */
  department?: string | null;
  /** Coverage-grounded answer fields (present when department === "coverage"). */
  grounded?: boolean;
  stateContext?: StateContext | null;
  citations?: Citation[];
  /** Optional AE tip from Anthropic narrator — never replaces the grounded
   *  reply. Absent when narrator is skipped (contract answers, needs_review,
   *  or no API key). */
  aeNote?: string;
  /** LOCAL coverage-narrowing channel — set only on a clarify turn. */
  localFlow?: "coverage" | null;
  coverageStep?: string | null;
  coverageContext?: CoverageContext | null;
  /** Normalized AskSmittyResponse fields. */
  type?: "clarification" | "answer" | "needs_review";
  sources?: Array<{ title: string; pages: number[]; sourceType: "brochure" | "contract" | "workbook" }>;
  confidence?: "high" | "medium" | "needs_review";
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** State banner shown above a grounded coverage answer. */
  stateContext?: StateContext | null;
  /** Optional AE tip from narrator — rendered below the grounded reply. */
  aeNote?: string;
  /** Normalized source chips — one entry per citation document. */
  sources?: Array<{ title: string; pages: number[]; sourceType: "brochure" | "contract" | "workbook" }>;
};

/** Suggested starters for the empty state — coverage/pricing first, ordered
 *  for the questions an AE asks while sitting with an agent. `label` is the
 *  short chip text; the full `prompt` is what gets sent. Pricing prompts
 *  include cost/pricing wording so department routing sends them to the
 *  quote-capable flow. */
const SUGGESTED_CHIPS: { label: string; prompt: string }[] = [
  { label: "What's Covered?", prompt: "What's covered under our plans?" },
  { label: "Plan Comparison", prompt: "Compare our plan options and what each one includes." },
  { label: "Coverage Lookup", prompt: "Which plan includes coverage for a specific system or appliance?" },
  { label: "Add-On Pricing", prompt: "How much do our optional add-ons cost?" },
  { label: "Plan Pricing", prompt: "How much do our plans cost?" },
  { label: "Seller Plans", prompt: "Tell me about our seller plans and what they cover." },
  { label: "Buyer Plans", prompt: "Tell me about our buyer plans and what they cover." },
  { label: "New Construction", prompt: "What coverage applies to new construction?" },
];

/** Follow-up chips shown below a narrated grounded coverage answer. Let the AE
 *  drill into the most common follow-up questions without typing them out. */
const COVERAGE_FOLLOWUP_CHIPS: { label: string; prompt: string }[] = [
  { label: "What's excluded?", prompt: "What's excluded from this coverage?" },
  { label: "Which plan?", prompt: "Which specific plan covers this?" },
  { label: "What's the limit?", prompt: "What's the coverage limit?" },
  { label: "Homeowner language", prompt: "How do I explain this to a homeowner?" },
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
  // COGENT guided-flow state. threadId/currentStep keep follow-up option taps in
  // the same external-agent flow; pendingOptions are the chips shown under the
  // latest reply.
  const [threadId, setThreadId] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [department, setDepartment] = useState<string | null>(null);
  const [pendingOptions, setPendingOptions] = useState<AnswerOption[]>([]);
  // LOCAL coverage-narrowing state — a separate channel from the Cogent fields
  // above. While localFlow === "coverage" we send these (and NOT threadId/
  // currentStep), so coverage clarification chips can never route to Cogent.
  const [localFlow, setLocalFlow] = useState<"coverage" | null>(null);
  const [coverageStep, setCoverageStep] = useState<string | null>(null);
  const [coverageContext, setCoverageContext] = useState<CoverageContext | null>(
    null,
  );

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

      // Guided-flow lock: while the COGENT agent is waiting on a required
      // choice, don't send arbitrary typed text — it can't advance the flow and
      // causes the agent to repeat its question. Option taps (fromOption) are
      // exempt. LOCAL coverage narrowing is exempt too: the server validates
      // typed text against the current step's vocabulary and re-asks if it
      // doesn't match, so free-text is safe (and the "Ask a new question" reset
      // is always available).
      if (
        !opts?.fromOption &&
        pendingOptions.length > 0 &&
        localFlow !== "coverage"
      ) {
        setError(
          "Please choose one of the options above so I can continue this flow.",
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
            // Two MUTUALLY EXCLUSIVE flow channels:
            //  - LOCAL coverage narrowing: send localFlow + step + context and
            //    DO NOT send the Cogent threadId/currentStep (keeps them
            //    isolated, so a coverage chip can't resume a Cogent thread).
            //  - Otherwise the Cogent guided flow: echo threadId/currentStep/
            //    department so option taps stay in the same external flow.
            ...(localFlow === "coverage"
              ? {
                  localFlow,
                  ...(coverageStep ? { coverageStep } : {}),
                  ...(coverageContext ? { coverageContext } : {}),
                }
              : {
                  ...(threadId ? { threadId } : {}),
                  ...(currentStep ? { currentStep } : {}),
                  ...(department ? { department } : {}),
                }),
          }),
        });
        if (data.sessionId) setSessionId(data.sessionId);
        // Mirror the server's flow state every turn, keeping the two channels
        // isolated. A LOCAL coverage clarify turn (data.localFlow === "coverage")
        // stores the local slots AND clears any Cogent thread, so foreign
        // guided-flow state can never reroute a coverage chip. Any other turn
        // clears the local flow and mirrors the Cogent fields.
        if (data.localFlow === "coverage") {
          setLocalFlow("coverage");
          setCoverageStep(data.coverageStep ?? null);
          setCoverageContext(data.coverageContext ?? null);
          setThreadId(null);
          setCurrentStep(null);
          setDepartment(null);
        } else {
          setLocalFlow(null);
          setCoverageStep(null);
          setCoverageContext(null);
          setThreadId(data.threadId ?? null);
          setCurrentStep(data.currentStep ?? null);
          setDepartment(data.department ?? null);
        }
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            // Deterministic grounded reply is always the primary content.
            content: data.reply,
            stateContext:
              data.department === "coverage"
                ? data.stateContext ?? null
                : null,
            // Optional AE tip from narrator — shown below the reply when present.
            aeNote: data.aeNote,
            // Source chips: normalized entries with sourceType and page list.
            // Only grounded answers have sources; clarify/refusal return [].
            sources: data.sources ?? [],
          },
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
    [
      sessionId,
      threadId,
      currentStep,
      department,
      localFlow,
      coverageStep,
      coverageContext,
      pendingOptions,
      listening,
      stop,
    ],
  );

  /** Clears the LOCAL coverage-narrowing flow so the next message is treated as
   *  a fresh question. The explicit escape from a guided coverage flow. */
  const resetLocalFlow = useCallback(() => {
    setLocalFlow(null);
    setCoverageStep(null);
    setCoverageContext(null);
    setPendingOptions([]);
    setError(null);
  }, []);

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
      aria-label="Ask Smitty"
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
          aria-label="Close Ask Smitty"
          className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <ChevronLeft aria-hidden="true" className="size-5" />
        </button>
        <Sparkles aria-hidden="true" className="size-4 text-primary" />
        <p className="text-sm font-semibold">Ask Smitty</p>
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
              <p className="text-base font-semibold">
                Coverage &amp; Pricing Expert
              </p>
              <p className="text-sm text-muted-foreground">
                Ask what&apos;s covered, what isn&apos;t, which plan includes
                something, how much it costs, or which plan to recommend. Type
                or tap the mic to speak.
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
                  m.role === "user"
                    ? "flex flex-col items-end"
                    : "flex flex-col items-start"
                }
              >
                {/* State banner — Utah badge + makes it obvious which state's
                    documents the answer is grounded in. */}
                {m.role === "assistant" && m.stateContext && (
                  <p className="mb-1 flex max-w-[85%] items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                      {m.stateContext.label}
                    </span>
                    Answering from plan documents.
                  </p>
                )}
                {/* Answer bubble — deterministic grounded reply is always the
                    primary content. AE note (optional, from narrator) is
                    embedded below the reply when present. */}
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
                      : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-foreground"
                  }
                >
                  {m.content}
                  {m.role === "assistant" && m.aeNote && (
                    <p className="mt-2 border-t border-border/50 pt-2 text-xs italic text-muted-foreground">
                      AE note: {m.aeNote}
                    </p>
                  )}
                </div>
                {/* Source chips — display source type and page so the AE knows
                    whether the answer came from the contract, brochure, or
                    workbook. Never shown on clarify/refusal turns (empty sources). */}
                {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                  <div className="mt-1.5 flex max-w-[85%] flex-wrap gap-1.5">
                    {m.sources.map((s, i) => {
                      const typeLabel =
                        s.sourceType === "contract"
                          ? "Contract"
                          : s.sourceType === "workbook"
                            ? "Workbook"
                            : "Brochure";
                      const pageLabel =
                        s.pages.length === 1
                          ? ` p. ${s.pages[0]}`
                          : s.pages.length > 1
                            ? ` pp. ${s.pages.join(", ")}`
                            : "";
                      return (
                        <span
                          key={`${s.title}-${i}`}
                          className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                        >
                          <FileText aria-hidden="true" className="size-3" />
                          {typeLabel}{pageLabel}
                        </span>
                      );
                    })}
                  </div>
                )}
                {/* Follow-up chips — shown after a narrated grounded answer
                    (aeNote present) so the AE can drill in with one tap. */}
                {m.role === "assistant" && m.aeNote && !sending && (
                  <div className="mt-2 flex max-w-[85%] flex-wrap gap-1.5">
                    {COVERAGE_FOLLOWUP_CHIPS.map((chip) => (
                      <button
                        key={chip.label}
                        type="button"
                        onClick={() => void send(chip.prompt)}
                        className="rounded-full border border-border/70 bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                )}
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
                reply. Tapping sends the option's value but shows its label. In a
                LOCAL coverage flow the AE can also type an answer or reset. */}
            {!sending && pendingOptions.length > 0 && (
              <div className="flex flex-col gap-1.5 pt-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {localFlow === "coverage"
                    ? "Tap an option — or type your answer:"
                    : "Choose one to continue:"}
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
                {localFlow === "coverage" && (
                  <button
                    type="button"
                    onClick={resetLocalFlow}
                    className="self-start text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    Ask a new question
                  </button>
                )}
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
        {pendingOptions.length > 0 && localFlow !== "coverage" && (
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
