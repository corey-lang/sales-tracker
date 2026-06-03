import { z } from "zod";

import {
  ApiError,
  handleApiError,
  parseBody,
  requireTestAccount,
} from "@/lib/server/auth";
import { getRelevantKnowledge } from "@/lib/ai/sales-knowledge";

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

/** Safe fallback used when the response guardrail trips — same wording the
 *  preamble already promises for missing plan/pricing specifics. */
const PLAN_DATA_NOT_CONNECTED_MESSAGE =
  "I don't have the live plan/pricing details connected yet, but I can help frame the options or explain what info we should connect.";

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
});

/**
 * Light sales context prepended to the FIRST message of a session only (no
 * sessionId yet). Follow-ups omit it so the preamble isn't repeated every
 * turn. Intentionally generic — no sensitive customer data is sent.
 */
const SALES_CONTEXT_PREAMBLE = [
  "Context for this conversation:",
  "- The user is a Test AE in the Elevate Sales Tracker app.",
  "- Act as a sales assistant for: sales coaching, territory ideas, objection handling, follow-up wording, weekly activity planning, and app guidance.",
  "- Do not request or rely on sensitive customer data.",
  "- Keep your tone practical and sales-coaching oriented.",
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
  "- Exact plan and pricing data is NOT connected yet. When asked for specifics you don't have, say: \"I don't have the live plan/pricing details connected yet, but I can help frame the options or explain what info we should connect.\"",
].join("\n");

/**
 * Assembles the text sent upstream for one turn:
 *   1. the behavior preamble (first turn only — follow-ups inherit it via the
 *      agent's session, so we don't repeat it);
 *   2. approved Elevate plan/coverage knowledge IF the question is on-topic
 *      (every turn — the AE might ask a coverage question mid-conversation);
 *   3. the user's message.
 * Never includes customer/contact data — only generic product coaching.
 */
function buildAgentMessage(
  userMessage: string,
  opts: { includePreamble: boolean },
): string {
  const knowledge = getRelevantKnowledge(userMessage);
  const parts: string[] = [];
  if (opts.includePreamble) parts.push(SALES_CONTEXT_PREAMBLE);
  if (knowledge) parts.push(knowledge);
  // A plain follow-up with no preamble and no matched knowledge goes through
  // verbatim so the agent isn't handed needless scaffolding.
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

export async function POST(req: Request) {
  try {
    await requireTestAccount(req);
    const body = await parseBody(req, ChatSchema);

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

    // Behavior preamble on the first turn (no sessionId yet); approved
    // plan/coverage knowledge is layered in on any turn the question is
    // on-topic. See buildAgentMessage.
    const outgoingMessage = buildAgentMessage(body.message, {
      includePreamble: !body.sessionId,
    });

    const payload: Record<string, unknown> = {
      message: outgoingMessage,
      customerId: "test-ae",
      departmentId: "sales",
    };
    if (body.sessionId) payload.sessionId = body.sessionId;

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

    const reply = extractReply(raw);
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

    // Response guardrail: on plan/coverage/pricing questions, if the reply
    // states an obvious invented exact price or absolute coverage guarantee
    // (while the live plan/pricing table isn't connected), swap it for the safe
    // framing. getRelevantKnowledge(...) !== null is the on-topic signal — the
    // same detector that decides whether approved knowledge was attached.
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

    const sessionId = extractSessionId(raw) ?? body.sessionId ?? null;

    return Response.json({ reply: safeReply, sessionId });
  } catch (err) {
    return handleApiError(err);
  }
}
