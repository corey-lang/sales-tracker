import { z } from "zod";

import {
  ApiError,
  handleApiError,
  parseBody,
  requireTestAccount,
} from "@/lib/server/auth";

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
  "",
  "User message:",
].join("\n");

/** Returns the value as a non-empty trimmed string, or null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Reply-bearing field names, in priority order. Checked at every nesting
 *  level by the recursive extractor. */
const REPLY_FIELDS = [
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

/** Picks the assistant reply from a chat-style array (messages / choices):
 *  scans from the END so the latest assistant turn wins, skipping user echoes. */
function replyFromArray(arr: unknown[]): string | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const fromMsg = replyFromMessageObject(arr[i]);
    if (fromMsg) return fromMsg;
    const plain = asString(arr[i]);
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
  if (Array.isArray(raw)) return replyFromArray(raw);

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
      const fromArr = replyFromArray(arr);
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
 * a large/recursive payload can't blow up the log line.
 *
 * TEMPORARY (debugging aid): added to map the real AgentExecutionResult shape
 * onto extractReply/extractSessionId. Safe to remove once the mapping is
 * confirmed from the logs.
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

    // Prepend the sales context only on the first turn (no sessionId yet) so
    // follow-ups stay lean and the preamble isn't repeated.
    const outgoingMessage = body.sessionId
      ? body.message
      : `${SALES_CONTEXT_PREAMBLE}\n${body.message}`;

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

    // Redacted, top-level/data-level key view used by both the success-shape
    // log and the failure diagnostics. Never includes string CONTENT.
    const topLevelKeys =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.keys(raw as object)
        : Array.isArray(raw)
          ? [`(array:${(raw as unknown[]).length})`]
          : [typeof raw];
    const dataValue =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).data
        : undefined;
    const dataLevelKeys =
      dataValue && typeof dataValue === "object" && !Array.isArray(dataValue)
        ? Object.keys(dataValue as object)
        : Array.isArray(dataValue)
          ? [`(array:${(dataValue as unknown[]).length})`]
          : dataValue === undefined
            ? ["(none)"]
            : [typeof dataValue];

    // TEMPORARY (debugging aid): log the REDACTED shape of every successful
    // upstream 200 so we can confirm the AgentExecutionResult mapping. Strings
    // are reduced to lengths by summarizeShape — no message text or secrets.
    console.log(
      `[ai-chat] upstream 200 top-level keys=${topLevelKeys.join(",")} data keys=${dataLevelKeys.join(
        ",",
      )} shape=${JSON.stringify(summarizeShape(raw))}`,
    );

    const reply = extractReply(raw);
    if (!reply) {
      // Failure diagnostics: top-level keys, data-level keys, the dotted paths
      // of every string field (with lengths only), and a depth summary — no
      // message bodies or secrets — so we can map the reply field next.
      console.warn(
        `[ai-chat] could not extract reply from upstream 200; ` +
          `top-level keys=${topLevelKeys.join(",")}; ` +
          `data keys=${dataLevelKeys.join(",")}; ` +
          `string fields=${collectStringFieldPaths(raw).join(" | ") || "(none)"}; ` +
          `shape=${JSON.stringify(summarizeShape(raw))}`,
      );
      throw new ApiError(
        502,
        "The agent responded, but I couldn't read the reply format yet.",
      );
    }

    const sessionId = extractSessionId(raw) ?? body.sessionId ?? null;

    return Response.json({ reply, sessionId });
  } catch (err) {
    return handleApiError(err);
  }
}
