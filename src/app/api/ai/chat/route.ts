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

/** Reply field names the upstream AgentExecutionResult might use, in priority
 *  order. Tried before falling through to a bounded deep search. */
const REPLY_KEYS = [
  "reply",
  "response",
  "answer",
  "output",
  "text",
  "message",
  "content",
  "result",
];

/**
 * Pulls the agent's reply text out of an upstream response of unknown shape.
 * Tries the known reply keys at each level, recursing up to `depth` levels and
 * preferring the LAST element of arrays (so message-list shapes yield the most
 * recent turn). Treated as untrusted: returns null when nothing usable.
 */
function deepFindReply(value: unknown, depth: number): string | null {
  if (depth < 0) return null;
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : null;
  }
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const found = deepFindReply(value[i], depth - 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of REPLY_KEYS) {
      if (key in obj) {
        const found = deepFindReply(obj[key], depth - 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Pulls the session id out of an upstream response of unknown shape. */
function extractSessionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const key of ["sessionId", "session_id", "sessionID"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  for (const container of ["data", "result", "execution"]) {
    const nested = obj[container];
    if (nested && typeof nested === "object") {
      const found = extractSessionId(nested);
      if (found) return found;
    }
  }
  return null;
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

    const reply = deepFindReply(raw, 4);
    if (!reply) {
      console.warn(
        `[ai-chat] could not extract reply from upstream response; top-level keys=${
          raw && typeof raw === "object"
            ? Object.keys(raw as object).join(",")
            : typeof raw
        }`,
      );
      throw new ApiError(
        502,
        "The assistant didn't return a response. Please try again.",
      );
    }

    const sessionId = extractSessionId(raw) ?? body.sessionId ?? null;

    return Response.json({ reply, sessionId });
  } catch (err) {
    return handleApiError(err);
  }
}
