import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  requireSalesperson,
} from "@/lib/server/auth";
import { TEAM_MESSAGES_TABLE, type TeamMessage } from "@/lib/team-messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MESSAGE_COLUMNS =
  "id, created_at, salesperson_id, salesperson_name, message, is_deleted, reply_to_message_id, reply_to_salesperson_name, reply_to_message_preview, media_type, media_url, media_thumb_url, media_width, media_height, media_alt, media_provider, media_attachments";

const SEARCH_LIMIT_DEFAULT = 30;

const QuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  // Supabase returns timestamptz values with offsets (for example +00:00),
  // so Date.parse validation is safer than strict Zod datetime() defaults.
  before: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid before cursor.")
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  peopleOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  recentOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  hasMedia: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  mentionsMe: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

/**
 * Sanitizes a freeform term for PostgREST ilike/or filters.
 *
 * Keeps letters, digits, whitespace, '-', '.', '/', '&', apostrophe.
 * Strips punctuation that has grammar meaning in the `.or(...)` DSL.
 */
function sanitizeSearchTerm(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9\s\-./&']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function GET(req: Request) {
  try {
    const me = await requireSalesperson(req);
    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      q: url.searchParams.get("q") ?? undefined,
      before: url.searchParams.get("before") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      peopleOnly: url.searchParams.get("peopleOnly") ?? undefined,
      recentOnly: url.searchParams.get("recentOnly") ?? undefined,
      hasMedia: url.searchParams.get("hasMedia") ?? undefined,
      mentionsMe: url.searchParams.get("mentionsMe") ?? undefined,
    });

    if (!parsed.success) {
      throw badRequest("Invalid search query.");
    }

    const q = parsed.data.q ? sanitizeSearchTerm(parsed.data.q) : "";
    const limit = parsed.data.limit ?? SEARCH_LIMIT_DEFAULT;
    const supabase = getServerSupabase();

    let query = supabase
      .from(TEAM_MESSAGES_TABLE)
      .select(MESSAGE_COLUMNS)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (parsed.data.before) {
      query = query.lt("created_at", parsed.data.before);
    }

    if (parsed.data.recentOnly) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      query = query.gte("created_at", cutoff.toISOString());
    }

    if (parsed.data.hasMedia) {
      query = query.not("media_url", "is", null);
    }

    if (parsed.data.mentionsMe && me.first_name.trim().length > 0) {
      const mentionsNeedle = `%${sanitizeSearchTerm(me.first_name)}%`;
      query = query.ilike("message", mentionsNeedle);
    }

    if (q.length > 0) {
      const needle = `%${q}%`;
      if (parsed.data.peopleOnly) {
        query = query.ilike("salesperson_name", needle);
      } else {
        query = query.or(
          `message.ilike.${needle},salesperson_name.ilike.${needle},reply_to_message_preview.ilike.${needle}`,
        );
      }
    }

    const res = await query;
    if (res.error) {
      console.warn(
        `[team-messages-search] load failed caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Couldn't search Juice Box.");
    }

    const messages = (res.data ?? []) as TeamMessage[];

    return Response.json({
      messages,
      hasMore: messages.length === limit,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
