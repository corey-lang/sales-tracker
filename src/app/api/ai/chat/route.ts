import { z } from "zod";

import {
  ApiError,
  handleApiError,
  parseBody,
  requireTestAccount,
} from "@/lib/server/auth";
import {
  getRelevantKnowledge,
  isCoveragePricingQuestion,
} from "@/lib/ai/sales-knowledge";
import { answerCoverageQuestion } from "@/lib/coverage/service";
import {
  shouldAnswerFromCoverage,
  stateLabel,
  type CoverageAnswer,
  type CoverageNarrowingContext,
  type SmittySource,
} from "@/lib/coverage/answer-logic";
import {
  answerFromContract,
  answerSellerAddon,
  checkAmbiguity,
  isContractQuestion,
  isSellerAddonQuestion,
} from "@/lib/coverage/contract-answer";
import { answerFromWorkbook } from "@/lib/coverage/workbook-answer";
import { callSmittyNarrator } from "@/lib/ai/smitty-narrator";

// POST /api/ai/chat
//
// Server-side proxy in front of the external agentic AI endpoint. The browser
// only ever talks to THIS route; it never sees the upstream URL or the API
// key. Keeps the integration isolated behind one Test-AE-only gate so it can
// later be widened to more users without touching the client contract.
//
// AUDIENCE
//   `requireTestAccount` — the AI Assistant is a Test-AE-only beta. Enforcing
//   it here (not just in the UI) means a real production AE cannot reach the
//   endpoint by POSTing directly; the server re-reads `salespeople.is_test`
//   from the DB on every request.
//
// SECURITY POSTURE
//   * The upstream `x-api-key` is read from AGENTIC_AI_API_KEY and never
//     leaves the server. The upstream URL comes from AGENTIC_AI_CHAT_URL so it
//     can change without a code edit.
//   * Every failure branch surfaces a sanitized, user-safe message. Raw
//     provider errors, status text, the endpoint URL, headers, and stack
//     traces are logged server-side (prefixed `[ai-chat]`) but never returned
//     to the client. The only non-ApiError path is an unexpected bug, which
//     handleApiError turns into a generic 500.
//
// CONTRACT
//   Request  : { message: string, sessionId?: string }
//   Response : { reply: string, sessionId: string | null }
//   The client maintains `sessionId` across turns and sends it back on every
//   follow-up so the agent keeps conversation state.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Single sanitized "couldn't reach the assistant" message — one source of
 *  truth so every upstream failure branch surfaces identical copy. */
const UNAVAILABLE_MESSAGE =
  "The AI assistant is temporarily unavailable. Please try again in a moment.";

/** Safe fallback used when the response guardrail trips. Expert framing (not
 *  coaching): states what's unavailable, then offers concrete coverage/plan
 *  alternatives. */
const PLAN_DATA_NOT_CONNECTED_MESSAGE =
  "I don't currently have access to the live plan/pricing table, so I can't give exact figures. I can still tell you which add-ons and plans exist, which plans include a given item, and coverage details — or compare plans. What would you like to check?";

/** Department the request is routed to. Live testing shows the upstream agent
 *  exposes the quote/pricing workflow under "plans" but only general coverage
 *  guidance under "sales". */
type DepartmentIntent = "sales" | "plans";

/** Stage 1 — coaching/talk-track terms. A message asking HOW to talk about
 *  pricing (vs. asking FOR a price) stays in "sales" even when it also mentions
 *  pricing/cost. Checked before the pricing keywords so coaching always wins. */
const COACHING_INTENT_KEYWORDS = [
  "explain",
  "handle",
  "objection",
  "position",
  "talk track",
  "pitch",
  "what should i say",
  "how should i say",
  "help me sell",
  "value conversation",
];

/** Stage 2 — pricing/quote terms that signal the user wants an actual number
 *  or estimate (→ "plans"). Only consulted when no coaching intent matched.
 *  Lowercased substring match; some entries are subsets of others but are
 *  listed explicitly for clarity against the spec. */
const PLANS_INTENT_KEYWORDS = [
  "price",
  "pricing",
  "cost",
  "quote",
  "how much",
  "add-on cost",
  "addon cost",
  "upgrade cost",
  "pool cost",
  "sprinkler cost",
  "exact price",
  "monthly cost",
  "annual cost",
  "rate",
  "premium",
  "fee",
  "estimate",
  "estimated",
  "ballpark",
  "what would this cost",
  "what would this run",
  "charge",
  "quote me",
];

/**
 * Lightweight, server-side intent detector with a two-stage rule:
 *   1. Coaching/talk-track intent → "sales" (even if it also mentions pricing).
 *   2. Otherwise pricing/quote intent → "plans".
 *   3. Everything else → "sales".
 * Keyword-based on purpose — coverage and coaching questions must stay in the
 * sales flow; only requests for an actual price/quote route to "plans".
 */
function detectDepartmentIntent(userMessage: string): DepartmentIntent {
  const text = userMessage.toLowerCase();
  // Stage 1: coaching always wins.
  if (COACHING_INTENT_KEYWORDS.some((k) => text.includes(k))) return "sales";
  // Stage 2: explicit pricing/quote ask.
  if (PLANS_INTENT_KEYWORDS.some((k) => text.includes(k))) return "plans";
  return "sales";
}

/**
 * Conservative guardrail patterns. While the real plan/pricing table isn't
 * connected, a reply to a plan/coverage/pricing question must not state an
 * invented exact price or an absolute coverage guarantee. Kept deliberately
 * narrow so ordinary coaching answers pass through untouched.
 */
const RISKY_REPLY_PATTERNS: RegExp[] = [
  /\$\s?\d/, // "$500", "$1,000", "$ 599"
  /\bcosts?\s+\$?\d/i, // "costs 599", "cost $599"
  /\bpriced at\b/i, // "priced at ..."
  /\bprice is\b/i, // "the price is ..."
  /\b\d[\d,]*\s*dollars\b/i, // "599 dollars"
  /covers?\s+everything/i, // "covers everything"
  /\balways\s+covered\b/i, // "always covered"
  /guaranteed\s+coverage/i, // "guaranteed coverage"
  /\b100%\s*covered\b/i, // "100% covered"
  /\bfully\s+covered\b/i, // "fully covered"
];

/** True when a reply contains an obvious unsupported exact price or absolute
 *  coverage guarantee. Conservative by design. */
function replyHasRiskyClaim(reply: string): boolean {
  return RISKY_REPLY_PATTERNS.some((pattern) => pattern.test(reply));
}

const ChatSchema = z.object({
  message: z.string().trim().min(1, "Message cannot be empty.").max(4000),
  sessionId: z.string().trim().min(1).max(200).optional(),
  // Forwarded upstream when present so an in-progress guided flow
  // (status "awaiting_user_input") resumes on the same thread/step. These are
  // the COGENT (external agent) flow fields — never used for local coverage.
  threadId: z.string().trim().min(1).max(200).optional(),
  currentStep: z.string().trim().min(1).max(200).optional(),
  // Echoed back by the client to keep a guided flow in the department it
  // started in (sticky routing). Only "sales"/"plans" are honored; anything
  // else is ignored and routing falls back to per-message intent.
  department: z.string().trim().min(1).max(40).optional(),
  // LOCAL coverage narrowing fields — a separate channel from the Cogent flow
  // above. When localFlow === "coverage", the turn is intercepted by Coverage
  // Intelligence BEFORE any external-agent routing, so a bare chip value like
  // "Epic"/"homeowner" can never fall through to Cogent. The client must NOT
  // send threadId/currentStep while in a local coverage flow.
  localFlow: z.literal("coverage").optional(),
  coverageStep: z.string().trim().min(1).max(64).optional(),
  coverageContext: z
    .object({
      intent: z.enum(["list_plans", "compare", "pricing", "addons", "coverage"]),
      coverageItem: z.string().max(200).optional(),
      planName: z.string().max(200).optional(),
      comparePlans: z.array(z.string().max(200)).max(8).optional(),
      coverageAudience: z
        .enum(["real_estate", "homeowner", "sellers"])
        .optional(),
    })
    .optional(),
});

/**
 * Light sales context prepended to the FIRST message of a session only (no
 * sessionId yet). Follow-ups omit it so the preamble isn't repeated every
 * turn. Intentionally generic — no sensitive customer data is sent.
 */
const SALES_CONTEXT_PREAMBLE = [
  "Context for this conversation:",
  "- The user is a Test AE in the Elevate Sales Tracker app, often sitting with a real-estate agent.",
  "- Act primarily as an Elevate Coverage & Pricing Expert: what's covered, what isn't, which plan includes a given item, plan comparisons, add-on and plan pricing, and which plan to recommend. You can also help with light sales coaching and app guidance when asked, but coverage and pricing come first.",
  "- Do not request or rely on sensitive customer data.",
  "- Keep your tone practical, concise, and coverage/pricing-focused.",
  "",
  "How to handle unclear or broad questions:",
  "- Prefer offering a short numbered menu of likely options over asking a vague clarifying question. For example, if asked \"What plans do we offer?\" or \"Tell me about coverage,\" do NOT reply \"What type of coverage are you asking about?\" Instead offer options, e.g.:",
  "  \"I can help with a few plan/coverage areas:",
  "  1. Seller coverage",
  "  2. Buyer coverage",
  "  3. New construction",
  "  4. Optional add-ons",
  "  5. Pricing/upgrades",
  "  6. What to recommend to an agent\"",
  "- If the question is broad, give a brief helpful answer first, then offer the numbered choices.",
  "- Do not invent or imply exact pricing or coverage details. Only state specifics that appear in this context.",
  "- Exact plan and pricing data is NOT connected yet. When asked for specifics you don't have, say plainly that you don't currently have access to the live plan/pricing table, then offer what you can confirm: which add-ons and plans exist, which plans include a given item, coverage details, and plan comparisons.",
].join("\n");

/** Coverage/pricing answer-behavior instruction. Forces an expert (not
 *  coaching) answer: facts first; if data is missing, say so plainly and ask a
 *  focused follow-up or offer concrete options. Added for coverage/pricing
 *  questions (not for explicit objection/recommend coaching requests). */
const COVERAGE_PRICING_EXPERT_PREFIX = [
  "Answer as an Elevate coverage & pricing expert, not a sales coach.",
  "- Lead with the facts: what's covered, what isn't, which plan includes an item, included vs. add-on, plan comparisons, and pricing availability.",
  "- If the exact data isn't available, say so plainly (for example: \"I don't currently have access to the live add-on pricing table.\"), state what you can and can't confirm, and ask ONE focused follow-up — or offer specific options: which add-ons exist, which plans include them, coverage details, plan comparisons.",
  "- Do NOT use sales talk tracks, objection handling, recommendation framing, \"the best approach is...\", or coaching language unless the user explicitly asks for sales coaching.",
].join("\n");

/** Plans-only nudge so the upstream agent reaches for its quote/pricing tool
 *  instead of general company-knowledge search. Added only to a fresh pricing
 *  request — never to a guided-flow answerOption value — and it invents no
 *  quote details (address, property type, plan, channel). */
const PLANS_QUOTE_PREFIX =
  "This is a quote/pricing request. If exact pricing requires quote context, ask for the missing quote details using answerOptions when available. Prefer quote/pricing tools over general company knowledge.";

/**
 * Assembles the text sent upstream for one turn:
 *   1. the behavior preamble (first turn only — follow-ups inherit it via the
 *      agent's session, so we don't repeat it);
 *   2. for a coverage/pricing question, the expert answer-behavior instruction
 *      (facts first, no coaching);
 *   3. for a fresh "plans" (pricing/quote) request, a short quote-routing
 *      instruction prefix (never on guided-flow answerOption continuations);
 *   4. approved Elevate plan/coverage knowledge IF the question is on-topic
 *      (every turn — the AE might ask a coverage question mid-conversation);
 *   5. the user's message.
 * Never includes customer/contact data — only generic product context.
 */
function buildAgentMessage(
  userMessage: string,
  opts: {
    includePreamble: boolean;
    coveragePricingExpert: boolean;
    plansQuotePrefix: boolean;
  },
): string {
  const knowledge = getRelevantKnowledge(userMessage);
  const parts: string[] = [];
  if (opts.includePreamble) parts.push(SALES_CONTEXT_PREAMBLE);
  if (opts.coveragePricingExpert) parts.push(COVERAGE_PRICING_EXPERT_PREFIX);
  if (opts.plansQuotePrefix) parts.push(PLANS_QUOTE_PREFIX);
  if (knowledge) parts.push(knowledge);
  // A plain follow-up with no preamble, no prefix, and no matched knowledge
  // goes through verbatim so the agent isn't handed needless scaffolding.
  if (parts.length === 0) return userMessage;
  parts.push(`User message:\n${userMessage}`);
  return parts.join("\n\n");
}

/** Returns the value as a non-empty trimmed string, or null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Reply-bearing field names, in priority order. Checked at every nesting
 *  level by the recursive extractor. `responseText` is the field the live
 *  agent uses (data[0].responseText), so it leads. */
const REPLY_FIELDS = [
  "responseText",
  "response_text",
  "reply",
  "message",
  "response",
  "content",
  "text",
  "output",
  "answer",
  "finalAnswer",
  "final_answer",
];

/** Container keys we recurse into when no direct reply field matches. */
const CONTAINER_FIELDS = ["data", "result", "response", "output", "execution"];

/** Roles whose message text is a USER prompt echo, never the assistant reply. */
const USER_ROLES = new Set(["user", "human", "system"]);

/** Pulls the text out of one chat-message-shaped object ({ role?, content|text }).
 *  Returns null for user/system echoes so we don't surface the prompt back. */
function replyFromMessageObject(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const role = typeof obj.role === "string" ? obj.role.toLowerCase() : null;
  if (role && USER_ROLES.has(role)) return null;
  // OpenAI choice shape: { message: { content } } — recurse one level.
  if (obj.message && typeof obj.message === "object") {
    const nested = replyFromMessageObject(obj.message);
    if (nested) return nested;
  }
  return asString(obj.content) ?? asString(obj.text) ?? null;
}

/** Picks the assistant reply from an array of result/message objects (e.g. the
 *  live agent's `data: [{ responseText }]`, or chat `messages` / `choices`).
 *  Scans from the END so the latest turn wins. Elements explicitly tagged with
 *  a user/system role are skipped so a prompt echo is never returned; every
 *  other element gets the full recursive reply extraction. */
function replyFromArray(arr: unknown[], depth: number): string | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const el = arr[i];
    if (el && typeof el === "object" && !Array.isArray(el)) {
      const role = (el as Record<string, unknown>).role;
      if (typeof role === "string" && USER_ROLES.has(role.toLowerCase())) {
        continue; // user/system prompt echo — never the assistant reply
      }
    }
    const fromMsg = replyFromMessageObject(el);
    if (fromMsg) return fromMsg;
    const deep = extractReply(el, depth + 1);
    if (deep) return deep;
    const plain = asString(el);
    if (plain) return plain;
  }
  return null;
}

/**
 * Recursively finds the first usable assistant reply string in an upstream
 * response of unknown shape. Strategy at each object level:
 *   1. direct reply fields (reply, message, response, content, text, output,
 *      answer, finalAnswer, final_answer) in priority order;
 *   2. chat-style arrays — `messages[last]` / `choices[0].message.content` —
 *      preferring the latest non-user turn so prompt echoes are skipped;
 *   3. recurse into known containers (data, result, response, output, …).
 * Depth-bounded and treated as untrusted; returns null when nothing usable.
 */
function extractReply(raw: unknown, depth = 0): string | null {
  if (typeof raw === "string") return asString(raw);
  if (depth > 6 || !raw || typeof raw !== "object") return null;
  if (Array.isArray(raw)) return replyFromArray(raw, depth);

  const obj = raw as Record<string, unknown>;

  // 1. Direct reply fields. A nested object/array under one of these (e.g.
  //    `message: { content }`) is resolved by recursing into it.
  for (const key of REPLY_FIELDS) {
    if (!(key in obj)) continue;
    const v = obj[key];
    const direct = asString(v);
    if (direct) return direct;
    if (v && typeof v === "object") {
      const nested = extractReply(v, depth + 1);
      if (nested) return nested;
    }
  }

  // 2. Chat-style arrays (assistant reply lives in the latest turn).
  for (const arrKey of ["messages", "choices"]) {
    const arr = obj[arrKey];
    if (Array.isArray(arr)) {
      const fromArr = replyFromArray(arr, depth);
      if (fromArr) return fromArr;
    }
  }

  // 3. Recurse into known containers only (keeps prompt echoes elsewhere in
  //    the payload from being mistaken for the reply).
  for (const container of CONTAINER_FIELDS) {
    if (container in obj) {
      const nested = extractReply(obj[container], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** Session-id field names searched recursively. */
const SESSION_FIELDS = [
  "sessionId",
  "session_id",
  "conversationId",
  "conversation_id",
  "threadId",
  "thread_id",
];

/**
 * Recursively finds the session/conversation id in an upstream response of
 * unknown shape. Checks the known id fields at each level, then recurses into
 * containers. Depth-bounded; returns null when none is present.
 */
function extractSessionId(raw: unknown, depth = 0): string | null {
  if (depth > 6 || !raw || typeof raw !== "object") return null;
  // Arrays (e.g. the live agent's `data: [{ sessionId }]`) — search elements.
  if (Array.isArray(raw)) {
    for (const el of raw) {
      const found = extractSessionId(el, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = raw as Record<string, unknown>;

  for (const key of SESSION_FIELDS) {
    const s = asString(obj[key]);
    if (s) return s;
  }
  for (const container of CONTAINER_FIELDS) {
    if (container in obj) {
      const nested = extractSessionId(obj[container], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Finds the agent result object (the one carrying `steps` / `responseText` /
 * `totalSteps`) inside an upstream response of unknown shape — top level, the
 * `data` array/object, or a known container. Used only for the TEMPORARY tool
 * diagnostics below; returns null when no such object is present.
 */
function findAgentResultObject(raw: unknown): Record<string, unknown> | null {
  const looksLikeResult = (v: unknown): v is Record<string, unknown> =>
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    ("steps" in (v as object) ||
      "totalSteps" in (v as object) ||
      "responseText" in (v as object));

  if (looksLikeResult(raw)) return raw;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  for (const container of ["data", ...CONTAINER_FIELDS]) {
    const v = obj[container];
    if (Array.isArray(v)) {
      for (const el of v) if (looksLikeResult(el)) return el;
    } else if (looksLikeResult(v)) {
      return v;
    }
  }
  return null;
}

/** Field names on a step that hold a tool/step NAME (safe to log). Deliberately
 *  excludes input/output/content/observation fields, which can carry message
 *  bodies or customer data. */
const STEP_NAME_FIELDS = [
  "toolName",
  "tool",
  "name",
  "type",
  "action",
  "step",
  "kind",
  "stepType",
];

/**
 * Extracts ONLY the tool/step names from a `steps` array — never step content.
 * For object steps it reads a name-ish field; for bare-string steps (which
 * could be content) it logs just a length placeholder. Bounded to 25 entries.
 */
function extractStepNames(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const names: string[] = [];
  for (const step of steps.slice(0, 25)) {
    if (step && typeof step === "object" && !Array.isArray(step)) {
      const s = step as Record<string, unknown>;
      let name: string | null = null;
      for (const field of STEP_NAME_FIELDS) {
        name = asString(s[field]);
        if (name) break;
      }
      names.push(name ?? "(unnamed)");
    } else if (typeof step === "string") {
      // Could be a label or could be content — log only its length, not text.
      names.push(`string(${step.length})`);
    } else {
      names.push(typeof step);
    }
  }
  return names;
}

/** One guided-flow answer chip, the only step-derived data we expose. */
type AnswerOption = { label: string; value: string };

/** The safe slice of a tool result we surface to the client. */
type ToolFlow = {
  answerOptions: AnswerOption[];
  threadId: string | null;
  currentStep: string | null;
  /** Used server-side only as a reply fallback; not returned as its own field. */
  messageToUser: string | null;
};

/** Normalizes an `answerOptions` value into a clean {label,value}[] — strings
 *  only, capped, with sensible label/value fallbacks. Anything malformed is
 *  dropped so no raw tool-result object reaches the client. */
function sanitizeAnswerOptions(value: unknown): AnswerOption[] {
  if (!Array.isArray(value)) return [];
  const out: AnswerOption[] = [];
  for (const item of value.slice(0, 20)) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      const label = asString(o.label) ?? asString(o.value);
      const val = asString(o.value) ?? asString(o.label);
      if (label && val) out.push({ label, value: val });
    } else if (typeof item === "string" && item.trim().length > 0) {
      out.push({ label: item, value: item });
    }
  }
  return out;
}

/** Reads a flow field by either camelCase or snake_case key. */
function readField(obj: Record<string, unknown>, camel: string, snake: string): unknown {
  return camel in obj ? obj[camel] : obj[snake];
}

/** Reads an answerOptions array under either casing. */
function readAnswerOptions(obj: Record<string, unknown>): unknown {
  return readField(obj, "answerOptions", "answer_options");
}

/** True when an object carries any guided-flow signal (options or metadata). */
function isFlowCandidate(obj: Record<string, unknown>): boolean {
  if (Array.isArray(readAnswerOptions(obj))) return true;
  return Boolean(
    readField(obj, "threadId", "thread_id") ||
      readField(obj, "currentStep", "current_step") ||
      readField(obj, "messageToUser", "message_to_user"),
  );
}

/**
 * Shape-agnostic deep walk that collects every object carrying a guided-flow
 * signal, in document order. Independent of the exact nesting (steps /
 * toolResults / tool_results / result / data) so a small change in the upstream
 * envelope can't hide the answer options. Depth/breadth bounded.
 */
function collectFlowCandidates(
  raw: unknown,
  depth: number,
  out: Record<string, unknown>[],
): void {
  if (depth > 8 || out.length >= 200 || !raw || typeof raw !== "object") return;
  if (Array.isArray(raw)) {
    for (const el of raw) collectFlowCandidates(el, depth + 1, out);
    return;
  }
  const obj = raw as Record<string, unknown>;
  if (isFlowCandidate(obj)) out.push(obj);
  for (const value of Object.values(obj)) {
    collectFlowCandidates(value, depth + 1, out);
  }
}

/**
 * Extracts the guided-flow data from the LATEST relevant result object:
 * answerOptions (preferred when present), threadId, currentStep, and the
 * messageToUser fallback. Returns empty/null fields when there's no flow.
 */
function extractToolFlow(raw: unknown): ToolFlow {
  const candidates: Record<string, unknown>[] = [];
  collectFlowCandidates(raw, 0, candidates);

  // Prefer the latest candidate that actually carries answer options; else the
  // latest with any flow metadata.
  let chosen: Record<string, unknown> | null = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (sanitizeAnswerOptions(readAnswerOptions(candidates[i])).length > 0) {
      chosen = candidates[i];
      break;
    }
  }
  if (!chosen) {
    chosen = candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }

  if (!chosen) {
    return {
      answerOptions: [],
      threadId: null,
      currentStep: null,
      messageToUser: null,
    };
  }
  return {
    answerOptions: sanitizeAnswerOptions(readAnswerOptions(chosen)),
    threadId: asString(readField(chosen, "threadId", "thread_id")),
    currentStep: asString(readField(chosen, "currentStep", "current_step")),
    messageToUser: asString(readField(chosen, "messageToUser", "message_to_user")),
  };
}

/** Reads the NAME of a tool-call / tool-result element. Only name-ish fields —
 *  never inputs, outputs, args, or results, which can carry prices or content. */
function readToolName(el: unknown): string {
  if (!el || typeof el !== "object" || Array.isArray(el)) return "(unnamed)";
  const o = el as Record<string, unknown>;
  const fn =
    o.function && typeof o.function === "object" && !Array.isArray(o.function)
      ? (o.function as Record<string, unknown>).name
      : undefined;
  return (
    asString(o.name) ??
    asString(o.toolName) ??
    asString(o.tool) ??
    asString(o.toolNamespace) ??
    asString(fn) ??
    "(unnamed)"
  );
}

/** Tool names detected in the response, separated by source. */
type ToolNames = { calls: string[]; results: string[] };

/**
 * Heuristic, NON-binding candidate check: does a tool name look like a
 * coverage/pricing tool? Used ONLY for the `trustedToolDetected` diagnostic so
 * we can spot likely-authoritative results in the logs. This is NOT an
 * allowlist and does NOT grant trust or change the guardrail — it just flags
 * names worth confirming before any real trust model is built.
 */
function looksLikeCoveragePricingTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes("coverage") ||
    n.includes("plan") ||
    n.includes("pricing") ||
    n.includes("price") ||
    n.includes("quote") ||
    n.includes("rate")
  );
}

/**
 * Shape-agnostic deep walk that collects tool NAMES only from any `toolCalls`
 * / `tool_calls` and `toolResults` / `tool_results` arrays in the response.
 * Reads no inputs/outputs/args — so prices, content, and secrets are never
 * touched. Depth/breadth bounded.
 */
function collectToolNames(
  raw: unknown,
  depth: number,
  acc: ToolNames,
): void {
  if (
    depth > 8 ||
    acc.calls.length + acc.results.length >= 200 ||
    !raw ||
    typeof raw !== "object"
  ) {
    return;
  }
  if (Array.isArray(raw)) {
    for (const el of raw) collectToolNames(el, depth + 1, acc);
    return;
  }
  const obj = raw as Record<string, unknown>;

  const calls = readField(obj, "toolCalls", "tool_calls");
  if (Array.isArray(calls)) {
    for (const el of calls.slice(0, 50)) acc.calls.push(readToolName(el));
  }
  const results = readField(obj, "toolResults", "tool_results");
  if (Array.isArray(results)) {
    for (const el of results.slice(0, 50)) acc.results.push(readToolName(el));
  }

  for (const value of Object.values(obj)) {
    collectToolNames(value, depth + 1, acc);
  }
}

/**
 * Collects the dotted paths of every STRING-valued field in the payload, with
 * each value's length (never its content). Used only when extraction fails, so
 * the logs reveal which field actually holds the reply without leaking text.
 * Depth/breadth bounded.
 */
function collectStringFieldPaths(
  value: unknown,
  prefix = "",
  depth = 0,
  out: string[] = [],
): string[] {
  if (out.length >= 60 || depth > 6) return out;
  if (typeof value === "string") {
    out.push(`${prefix || "(root)"}=string(${value.length})`);
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && i < 10; i++) {
      collectStringFieldPaths(value[i], `${prefix}[${i}]`, depth + 1, out);
    }
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (out.length >= 60) break;
      collectStringFieldPaths(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
    }
  }
  return out;
}

/**
 * Builds a REDACTED structural summary of an upstream value for server logs.
 * Strings collapse to `string(<length>)`, so no message text, customer data,
 * or secrets are ever logged — only the shape. Bounded in depth and breadth so
 * a large/recursive payload can't blow up the log line. Used only on the
 * extraction-failure path, to identify an unmapped reply field if the upstream
 * shape ever changes again.
 */
function summarizeShape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (typeof value === "string") return `string(${value.length})`;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "undefined") return "undefined";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array(0)";
    if (depth >= 4) return `array(${value.length})`;
    return { _array: value.length, item0: summarizeShape(value[0], depth + 1) };
  }
  if (typeof value === "object") {
    if (depth >= 4) return "object{…}";
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
    for (const [k, v] of entries) {
      out[k] = summarizeShape(v, depth + 1);
    }
    return out;
  }
  return typeof value;
}

/**
 * Runs the brochure DB lookup with a workbook fallback. When the DB returns
 * a refusal (e.g., no current brochure published for the state), tries the
 * hardcoded Utah workbook facts before returning the refusal to the client.
 * This ensures the core MVP questions always have grounded answers during the
 * Utah beta even when the brochure hasn't been fully published in the DB.
 */
async function runBrochureLookup(
  stateCode: string,
  message: string,
  context: CoverageNarrowingContext | undefined,
  step: string | undefined,
): Promise<CoverageAnswer> {
  try {
    const answer = await answerCoverageQuestion(stateCode, message, context, step);
    // Workbook fallback: if the brochure isn't published, try hardcoded facts.
    if (answer.kind === "refusal") {
      const workbookAnswer = answerFromWorkbook(message, stateCode, context, step);
      if (workbookAnswer) return workbookAnswer;
    }
    return answer;
  } catch (err) {
    console.warn(`[ai-chat] coverage brochure lookup failed: ${String(err)}`);
    // For the Utah MVP, try the hardcoded workbook before surfacing a
    // connectivity error — the AE still gets a grounded answer when the DB
    // is unreachable, as long as the question is in the workbook's scope.
    const workbookFallback = answerFromWorkbook(message, stateCode, context, step);
    if (workbookFallback) return workbookFallback;
    return {
      kind: "refusal",
      text: "I'm having trouble reaching the plan documents right now. Please try again in a moment.",
      citations: [],
    };
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireTestAccount(req);
    const body = await parseBody(req, ChatSchema);

    // -----------------------------------------------------------------------
    // Utah-only lock for Ask Smitty Beta — applied BEFORE any routing.
    // Pin null state to "UT"; block any non-Utah state before coverage or
    // external-assistant routing so a non-UT test account can never reach the
    // Cogent path either.
    // -----------------------------------------------------------------------
    const effectiveState = me.state_code?.trim().toUpperCase() || "UT";
    if (effectiveState !== "UT") {
      return Response.json({
        reply:
          "Ask Smitty is currently in beta for Utah only. Your account is set to a different state — check with your admin to enable access.",
        sessionId: body.sessionId ?? null,
        answerOptions: [],
        threadId: null,
        currentStep: null,
        department: "coverage",
        grounded: false,
        stateContext: null,
        citations: [],
        type: "needs_review",
        sources: [],
        confidence: "needs_review",
        localFlow: null,
        coverageStep: null,
        coverageContext: null,
      });
    }

    // -----------------------------------------------------------------------
    // PRIMARY SOURCE: Coverage Intelligence — checked FIRST, before any
    // guided-flow / external-agent routing.
    //
    // A coverage/pricing/plan/brochure question is answered ONLY from the AE's
    // current, approved state brochure — grounded, cited, and never from the
    // external agent or generic reasoning. If the brochure doesn't support an
    // answer, Ask Smitty refuses from the docs rather than guessing or falling
    // back. Cross-state answers are impossible: the lookup is scoped to
    // `me.state_code`.
    //
    // Intercept BEFORE any external-agent routing. Two ways a turn lands here:
    //   1. body.localFlow === "coverage" — an in-progress LOCAL narrowing flow.
    //      The message is a chip value/answer ("Epic", "homeowner", "HVAC") that
    //      may NOT itself read as a coverage question, so it must be matched on
    //      the marker, not the words — otherwise it would fall through to Cogent.
    //   2. A fresh coverage question ("Does Epic cover HVAC?") — caught by the
    //      dedicated word-boundary detector, even mid-Cogent-flow, so a new
    //      coverage question is never routed to the external assistant.
    // Either way the answer comes ONLY from Coverage Intelligence (grounded,
    // clarify, or refusal) — never Cogent generic prose.
    if (shouldAnswerFromCoverage(body.localFlow, body.message)) {
      const stateContext = { code: effectiveState, label: stateLabel(effectiveState) };

      // -----------------------------------------------------------------------
      // Source routing — contract facts have priority over brochure for coverage
      // and legal questions; brochure/workbook handles pricing and plan catalogs.
      //   1. Seller + add-on → contract (blocks generic add-on catalog route)
      //   2. Contract question → contract facts
      //   3. Item ambiguity → specific clarification chips (fridge, pool)
      //   4. Everything else → brochure DB lookup
      // -----------------------------------------------------------------------
      let answer: CoverageAnswer;
      const hasItemContext = Boolean(body.coverageContext?.coverageItem);

      if (isSellerAddonQuestion(body.message)) {
        // Seller coverage + add-on → always contract-backed, no DB needed.
        answer = answerSellerAddon();

      } else if (!body.localFlow && isContractQuestion(body.message)) {
        // Fresh contract question (not a guided-flow chip echo) → contract facts.
        const contractAnswer = answerFromContract(body.message, effectiveState);
        if (contractAnswer) {
          answer = contractAnswer;
        } else {
          // Contract routing matched but no fact found → refusal from docs.
          answer = {
            kind: "refusal",
            text: `I don't have a contract-backed answer for that yet. Ask an admin to add it to Ask Smitty's knowledge base.`,
            citations: [],
          };
        }

      } else if (!hasItemContext && !body.localFlow) {
        // Pre-DB ambiguity check — only on fresh questions, not guided-flow echoes.
        const ambiguity = checkAmbiguity(body.message, hasItemContext);
        if (ambiguity) {
          answer = ambiguity;
        } else {
          answer = await runBrochureLookup(
            effectiveState,
            body.message,
            body.coverageContext as CoverageNarrowingContext | undefined,
            body.coverageStep,
          );
        }

      } else {
        // In-progress local flow or non-ambiguous fresh question → brochure.
        answer = await runBrochureLookup(
          effectiveState,
          body.message,
          body.coverageContext as CoverageNarrowingContext | undefined,
          body.coverageStep,
        );
      }

      const isClarify = answer.kind === "clarify";

      // Narrator — only for non-contract, non-needs_review grounded answers.
      // Contract/legal answers must not be softened by Anthropic. The narrator
      // only contributes an optional AE tip (aeNote); the deterministic reply is
      // always the primary visible answer. Fails open: null = no aeNote.
      let aeNote: string | null = null;
      const shouldNarrate =
        answer.kind === "grounded" &&
        answer.confidence !== "needs_review" &&
        answer.sourceType !== "contract";
      if (shouldNarrate) {
        const narrated = await callSmittyNarrator(answer, body.message, effectiveState);
        aeNote = narrated?.aeNote ?? null;
      }

      // Build normalized sources — never emit page 0; multiple pages preserved.
      const sourceType = answer.sourceType ?? "brochure";
      const sources: SmittySource[] = answer.citations
        .map((c) => ({
          title: c.brochure,
          pages: c.pages.filter((p) => p > 0),
          sourceType,
        }))
        .filter((s) => s.pages.length > 0);

      // Response type for the normalized discriminated union.
      const responseType: "clarification" | "answer" | "needs_review" = isClarify
        ? "clarification"
        : answer.kind === "grounded" && answer.confidence !== "needs_review"
          ? "answer"
          : "needs_review";

      const confidence = answer.confidence ?? (answer.kind === "grounded" ? "medium" : "needs_review");

      console.log(
        `[ai-chat] coverage: state=${effectiveState} ` +
          `kind=${answer.kind} sourceType=${sourceType} ` +
          `confidence=${confidence} ` +
          `citations=${answer.citations.length} ` +
          `aeNote=${aeNote !== null} ` +
          `localFlow=${isClarify ? "coverage" : "(none)"} ` +
          `coverageStep=${isClarify ? answer.coverageStep ?? "(none)" : "(none)"}`,
      );

      return Response.json({
        // Primary: the deterministic grounded reply. Always the source of truth;
        // never replaced or softened by Anthropic narration.
        reply: answer.text,
        sessionId: body.sessionId ?? null,
        answerOptions: isClarify ? answer.answerOptions ?? [] : [],
        threadId: null,
        currentStep: null,
        department: "coverage",
        grounded: answer.kind === "grounded",
        stateContext,
        citations: answer.citations,
        localFlow: isClarify ? "coverage" : null,
        coverageStep: isClarify ? answer.coverageStep ?? null : null,
        coverageContext: isClarify ? answer.context ?? null : null,
        // Optional AE tip from narrator — never replaces the grounded reply.
        ...(aeNote ? { aeNote } : {}),
        // Normalized AskSmittyResponse fields.
        type: responseType,
        sources,
        confidence,
      });
    }

    const apiKey = process.env.AGENTIC_AI_API_KEY?.trim();
    const endpoint = process.env.AGENTIC_AI_CHAT_URL?.trim();
    if (!apiKey || !endpoint) {
      // Names the missing env vars in the server log so an admin can fix the
      // deploy; the client gets the same sanitized 502 it gets for any other
      // upstream issue.
      console.warn(
        "[ai-chat] AGENTIC_AI_API_KEY and/or AGENTIC_AI_CHAT_URL is not set; AI assistant is disabled until configured",
      );
      throw new ApiError(502, UNAVAILABLE_MESSAGE);
    }

    // Routing fields into the Elevate agent. customerId is env-overridable (or
    // "test-ae"). departmentId is chosen by intent: pricing/quote questions
    // route to "plans" (quote-capable workflow), everything else stays "sales".
    //
    // Resolution order:
    //   1. AGENTIC_AI_DEPARTMENT_ID env value PINS the department (manual mode).
    //   2. Mid guided flow (client echoes threadId/currentStep + department) →
    //      stick with the flow's department so a quote's option taps — which
    //      carry no pricing keywords — don't bounce back to "sales".
    //   3. Otherwise per-message intent.
    const customerId =
      process.env.AGENTIC_AI_CUSTOMER_ID?.trim() || "test-ae";
    const departmentOverride = process.env.AGENTIC_AI_DEPARTMENT_ID?.trim();
    const intent = detectDepartmentIntent(body.message);

    const isContinuation = Boolean(body.threadId || body.currentStep);
    const stickyDepartment: DepartmentIntent | null =
      isContinuation && (body.department === "sales" || body.department === "plans")
        ? body.department
        : null;

    // What the request came in as, before intent routing: an env pin, the
    // sticky department of an active guided flow, or the "sales" default.
    const originalDepartment: string =
      departmentOverride ?? stickyDepartment ?? "sales";

    let routingReason: string;
    let departmentId: string;
    if (departmentOverride) {
      departmentId = departmentOverride;
      routingReason = "pinned by env";
    } else if (stickyDepartment) {
      departmentId = stickyDepartment;
      routingReason = "sticky (guided flow)";
    } else {
      departmentId = intent;
      routingReason = "intent";
    }

    // Safe routing diagnostic — intent + departments only, never the message.
    console.log(
      `[ai-chat] routing: intent=${intent} originalDepartment=${originalDepartment} ` +
        `routedDepartment=${departmentId} (${routingReason})`,
    );

    // Behavior preamble on the first turn (no sessionId yet); approved
    // plan/coverage knowledge layered in when on-topic. Coverage/pricing
    // questions get the expert answer-behavior instruction (facts first, no
    // coaching). A FRESH "plans" request also gets the quote-routing prefix.
    // None of these are applied to a guided-flow answerOption continuation.
    const coveragePricingExpert =
      !isContinuation &&
      (departmentId === "plans" || isCoveragePricingQuestion(body.message));
    const plansQuotePrefix = departmentId === "plans" && !isContinuation;
    const outgoingMessage = buildAgentMessage(body.message, {
      includePreamble: !body.sessionId,
      coveragePricingExpert,
      plansQuotePrefix,
    });

    const payload: Record<string, unknown> = {
      message: outgoingMessage,
      customerId,
      departmentId,
    };
    if (body.sessionId) payload.sessionId = body.sessionId;
    // Keep an in-progress guided flow on the same thread/step when the client
    // echoes back the threadId/currentStep from a prior "awaiting_user_input"
    // response.
    if (body.threadId) payload.threadId = body.threadId;
    if (body.currentStep) payload.currentStep = body.currentStep;

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      });
    } catch (err) {
      console.warn(`[ai-chat] upstream fetch failed err=${String(err)}`);
      throw new ApiError(502, UNAVAILABLE_MESSAGE);
    }

    const text = await res.text();
    let raw: unknown = null;
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null;
      }
    }

    if (!res.ok) {
      // The upstream error body ({ error: "..." }) is logged for debugging but
      // never forwarded verbatim — it could carry provider-internal detail.
      const upstreamError =
        raw &&
        typeof raw === "object" &&
        typeof (raw as { error?: unknown }).error === "string"
          ? (raw as { error: string }).error
          : "(no parseable error body)";
      console.warn(
        `[ai-chat] upstream non-2xx status=${res.status} error=${upstreamError}`,
      );
      throw new ApiError(502, UNAVAILABLE_MESSAGE);
    }

    // Guided-flow data (answer options / threadId / currentStep) from the
    // latest tool result, plus a messageToUser fallback when the agent asks a
    // question with no top-level responseText.
    const flow = extractToolFlow(raw);

    // Safe guided-flow diagnostics: count + labels only (labels are UI text,
    // not customer data), plus currentStep and whether a threadId is present.
    // Never logs message bodies, raw tool results, inputs/outputs, or secrets.
    if (
      flow.answerOptions.length > 0 ||
      flow.currentStep ||
      flow.threadId
    ) {
      console.log(
        `[ai-chat] answerOptions: count=${flow.answerOptions.length} ` +
          `labels=[${flow.answerOptions.map((o) => o.label).join(", ")}] ` +
          `currentStep=${flow.currentStep ?? "(none)"} ` +
          `threadId=${flow.threadId ? "present" : "absent"}`,
      );
    }

    const reply = extractReply(raw) ?? flow.messageToUser;
    if (!reply) {
      // Failure diagnostics only (fires only when extraction fails): top-level
      // keys, the dotted paths of every string field (lengths only), and a
      // depth summary — no message bodies or secrets — so an unmapped reply
      // field can be identified. Redacted by summarizeShape/collectStringFieldPaths.
      const topLevelKeys =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? Object.keys(raw as object).join(",")
          : Array.isArray(raw)
            ? `(array:${(raw as unknown[]).length})`
            : typeof raw;
      console.warn(
        `[ai-chat] could not extract reply from upstream 200; ` +
          `top-level keys=${topLevelKeys}; ` +
          `string fields=${collectStringFieldPaths(raw).join(" | ") || "(none)"}; ` +
          `shape=${JSON.stringify(summarizeShape(raw))}`,
      );
      throw new ApiError(
        502,
        "The agent responded, but I couldn't read the reply format yet.",
      );
    }

    // TEMPORARY (diagnostic): log the agent's tool/step NAMES only — never step
    // content — so we can see whether the agent is invoking a knowledge/plan
    // tool for plan/coverage questions, and whether routing (departmentId /
    // customerId) is reaching that knowledge. No message bodies, secrets, or
    // customer data are logged. Remove once routing is confirmed.
    const resultObj = findAgentResultObject(raw);
    if (resultObj) {
      const stepNames = extractStepNames(resultObj.steps);
      const totalSteps =
        typeof resultObj.totalSteps === "number"
          ? resultObj.totalSteps
          : stepNames.length;
      const budgetExhausted =
        typeof resultObj.budgetExhausted === "boolean"
          ? resultObj.budgetExhausted
          : "(unknown)";
      const firstStepKeys =
        Array.isArray(resultObj.steps) &&
        resultObj.steps[0] &&
        typeof resultObj.steps[0] === "object" &&
        !Array.isArray(resultObj.steps[0])
          ? Object.keys(resultObj.steps[0] as object).join(",")
          : "(n/a)";
      console.log(
        `[ai-chat] agent tools: onTopic=${getRelevantKnowledge(body.message) !== null} ` +
          `dept=${departmentId} customer=${customerId} ` +
          `totalSteps=${totalSteps} budgetExhausted=${budgetExhausted} ` +
          `stepNames=[${stepNames.join(", ")}] stepKeys=[${firstStepKeys}]`,
      );
    }

    // Response guardrail (BACKUP, external-agent path only): a coverage/pricing
    // question never reaches here — it returns from the Coverage Intelligence
    // branch above. This only hardens the external agent's NON-coverage replies
    // against an invented exact price / absolute coverage guarantee. The
    // `getRelevantKnowledge(...) !== null` check here is just this guardrail's
    // own narrow topic signal; it does NOT gate coverage routing (that's
    // `isCoverageQuestion`, checked at the top of the handler).
    const isPlanPricingTopic = getRelevantKnowledge(body.message) !== null;
    const safeReply =
      isPlanPricingTopic && replyHasRiskyClaim(reply)
        ? PLAN_DATA_NOT_CONNECTED_MESSAGE
        : reply;
    if (safeReply !== reply) {
      console.warn(
        "[ai-chat] response guardrail tripped: unsupported exact price/coverage claim replaced with safe framing",
      );
    }

    // TEMPORARY (diagnostic): determine whether plan/coverage answers are
    // tool-backed, so we can decide if the generic pricing guardrail should be
    // bypassed for trusted tools. Logs tool NAMES + counts only — never prices,
    // response text, tool inputs, tool outputs, or secrets. Remove once the
    // tool-trust decision is made.
    const toolNames: ToolNames = { calls: [], results: [] };
    collectToolNames(raw, 0, toolNames);
    const pricingGuardTriggered = safeReply !== reply;
    // Candidate detection only: true when a tool RESULT (not merely a call)
    // has a coverage/pricing-looking name. Heuristic + non-binding — it does
    // NOT bypass the guardrail; it just surfaces likely-authoritative results
    // so we can confirm real tool names before designing a trust model.
    const trustedToolDetected = toolNames.results.some(
      looksLikeCoveragePricingTool,
    );
    console.log(
      `[ai-chat] tool diagnostics: ` +
        `toolCallNames=[${toolNames.calls.join(", ")}] ` +
        `toolResultNames=[${toolNames.results.join(", ")}] ` +
        `answerOptionsCount=${flow.answerOptions.length} ` +
        `currentStep=${flow.currentStep ?? "(none)"} ` +
        `pricingGuardTriggered=${pricingGuardTriggered} ` +
        `trustedToolDetected=${trustedToolDetected}`,
    );

    // TEMPORARY (validation): correlate the routed department with the tools the
    // agent actually invoked, to verify pricing questions routed to "plans"
    // reach the quote workflow. Names + department only — no prices, response
    // text, tool inputs/outputs, or secrets.
    console.log(
      `[ai-chat] routing result: ` +
        `department=${departmentId} ` +
        `toolCallNames=[${toolNames.calls.join(", ")}] ` +
        `toolResultNames=[${toolNames.results.join(", ")}]`,
    );

    const sessionId = extractSessionId(raw) ?? body.sessionId ?? null;

    // Only safe, whitelisted fields cross to the client — never the raw tool
    // results. A guardrail-replaced reply also drops any answer options, since
    // they belonged to the suppressed message. `department` is our own routing
    // value (not sensitive); the client echoes it back to keep a guided flow
    // sticky to its department.
    return Response.json({
      reply: safeReply,
      sessionId,
      answerOptions: safeReply === reply ? flow.answerOptions : [],
      threadId: flow.threadId,
      currentStep: flow.currentStep,
      department: departmentId,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
