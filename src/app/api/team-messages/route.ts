import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  badRequest,
  handleApiError,
  parseBody,
  requireSalesperson,
} from "@/lib/server/auth";
import { fetchGiphyById, isGiphyHost } from "@/lib/server/giphy";
import { fanOutJuiceBoxPush } from "@/lib/server/push";
import {
  FEED_PAGE_SIZE,
  MESSAGE_MAX_LENGTH,
  REPLY_PREVIEW_MAX_LENGTH,
  TEAM_MESSAGES_TABLE,
  TEAM_MESSAGE_REACTIONS_TABLE,
  type TeamMessage,
  type TeamMessageReaction,
  type TeamMessageReactionRow,
  type TeamMessageReactor,
} from "@/lib/team-messages";

// Juice Box live team feed — list + create.
//   GET  /api/team-messages[?before=ISO&limit=N]
//                              -> { messages: …[], hasMore: boolean }
//                                 oldest -> newest within the page
//   POST /api/team-messages    -> { message: TeamMessage & { reactions: [] } }
//
// PAGINATION
//   The feed is paginated backwards. The initial load fetches the most
//   recent FEED_PAGE_SIZE messages. The client supplies `?before=<ISO>`
//   (the created_at of the oldest currently-loaded message) on subsequent
//   "Load older" calls; the route returns up to `limit` messages older
//   than that timestamp. `hasMore` is true when the page returned exactly
//   `limit` rows — a heuristic that resolves to false on the empty page
//   the next click produces.
//
// ACCESS
//   Both verbs require any signed-in salesperson (requireSalesperson).
//   Juice Box is now open to the whole team; the prior admin/test gate
//   was removed when the feature graduated out of pilot.
//
// IDENTITY
//   salesperson_id and salesperson_name come from the server-validated
//   session (me.id / me.first_name) — never from the request body. The
//   client cannot impersonate a teammate even by editing the POST payload.
//
// REPLY METADATA (Pass 4)
//   reply_to_salesperson_name and reply_to_message_preview are derived
//   server-side from the parent row — clients send only reply_to_message_id.
//   That way a teammate can't spoof "in reply to X" with arbitrary text.
//
// REACTION REACTORS (Pass 4 polish)
//   Each aggregated reaction now ships with the list of reactor names so
//   the "who reacted" detail popover can render without a second
//   round-trip per chip. Names are denormalized on team_message_reactions
//   at insert time, so this is just an extra column in the SELECT below.
//
// MEDIA POSTS (Pass 5 — hardened in this revision)
//
//   Two attachment kinds: image (uploaded to juice-box-media Storage)
//   and GIF (sourced from GIPHY). The wire shape is intentionally
//   minimal — the client never supplies media_url/thumb_url/storage_path
//   directly, because trusting those previously let an eligible user
//   bypass the picker and hot-link arbitrary assets (Tenor pivot
//   notwithstanding, same class of bug for any provider).
//
//   IMAGE
//     Client sends `image_url` (the public URL returned by the signed-
//     upload route) plus intrinsic dimensions read from the file +
//     optional alt text. Server:
//       1. Verifies `image_url` starts with our juice-box-media public
//          prefix (URL host pinned).
//       2. Parses the path tail and requires it to be
//             <salesperson_id>/<uuid>.<ext>
//          AND the leading <salesperson_id> segment to equal the
//          authenticated caller's me.id — binds the post to its
//          uploader, prevents claiming someone else's leaked URL.
//       3. Stores the DERIVED storage path (not anything client-sent).
//
//   GIF
//     Client sends only `gif_id` (the provider id returned by the
//     picker proxy). Server:
//       1. Re-fetches that id from GIPHY using our server-only API key.
//       2. Verifies the upstream-supplied URLs are GIPHY-hosted
//          (*.giphy.com) — defense in depth in case GIPHY ever returns
//          something unexpected.
//       3. Stores DERIVED media_url, media_thumb_url, width, height,
//          alt straight from the upstream response.
//
//   Empty `message` is permitted when media is attached so users can
//   post images / GIFs without a caption. The DB CHECK constraint pairs
//   media_type + media_url so the row layout stays consistent.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MESSAGE_COLUMNS =
  "id, created_at, salesperson_id, salesperson_name, message, is_deleted, reply_to_message_id, reply_to_salesperson_name, reply_to_message_preview, media_type, media_url, media_thumb_url, media_width, media_height, media_alt, media_provider";

const CreateMessageSchema = z
  .object({
    // Trimmed; allow empty when media is attached. Cap stays the same.
    message: z
      .string()
      .trim()
      .max(MESSAGE_MAX_LENGTH, `Keep posts under ${MESSAGE_MAX_LENGTH} characters.`),
    reply_to_message_id: z.uuid().optional(),
    // Image attachment — declared by sending image_url (the public URL
    // produced by the signed-upload route). Dimensions read by the
    // client from the file before posting; alt text optional.
    image_url: z.url().optional(),
    image_width: z.number().int().positive().max(20000).optional(),
    image_height: z.number().int().positive().max(20000).optional(),
    image_alt: z.string().max(500).optional(),
    // GIF attachment — declared by sending gif_id only. Server re-
    // fetches the asset from the provider and derives every other
    // media_* field from that response.
    gif_id: z.string().min(1).max(128).optional(),
  })
  .refine((d) => !(d.image_url && d.gif_id), {
    message: "A post can't have both an image and a GIF.",
    path: ["gif_id"],
  })
  .refine(
    (d) => d.message.length > 0 || d.image_url || d.gif_id,
    {
      message: "A message or media attachment is required.",
      path: ["message"],
    },
  )
  .refine(
    (d) => !d.image_url || (d.image_width && d.image_height),
    {
      message: "Image dimensions are required.",
      path: ["image_width"],
    },
  );

// Allowed origin for image URLs — the public path of the juice-box-media
// bucket. Computed once at module load (NEXT_PUBLIC_SUPABASE_URL is
// validated in supabase/server.ts so missing env is already a fatal
// startup error in practice).
const ALLOWED_IMAGE_PREFIX = (() => {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/storage/v1/object/public/juice-box-media/`;
})();

// Matches the filename the signed-upload route mints:
//   <uuid (RFC 4122 form)>.{jpg|png|webp|gif}
// Salesperson_id is treated as opaque (it's also a UUID, but we check
// it by string-equality against me.id rather than by pattern).
const IMAGE_FILENAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/i;

/**
 * Verifies `imageUrl` was produced by THIS user's signed-upload flow
 * and returns the derived storage path. Returns null on any mismatch,
 * which the caller turns into a 400.
 *
 * Checks, in order:
 *   1. URL parses + uses https.
 *   2. Starts with our juice-box-media public prefix (host + bucket pin).
 *   3. Has the shape `<salesperson_id>/<filename>` after the prefix.
 *   4. <salesperson_id> equals the authenticated caller's me.id.
 *   5. <filename> matches `<uuid>.<jpg|png|webp|gif>`.
 */
function deriveImageStoragePath(
  imageUrl: string,
  callerId: string,
): string | null {
  if (!ALLOWED_IMAGE_PREFIX) return null;
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (!imageUrl.startsWith(ALLOWED_IMAGE_PREFIX)) return null;
  const path = imageUrl.slice(ALLOWED_IMAGE_PREFIX.length);
  // Reject deeper nesting (e.g., "a/b/c.jpg") — we only mint one level.
  const slashIdx = path.indexOf("/");
  if (slashIdx < 0) return null;
  const folder = path.slice(0, slashIdx);
  const filename = path.slice(slashIdx + 1);
  if (folder !== callerId) return null;
  if (!IMAGE_FILENAME_RE.test(filename)) return null;
  if (filename.includes("/")) return null;
  return path;
}

/** Wire shape returned by both verbs — DB row plus the aggregated reactions. */
export type TeamMessageWithReactions = TeamMessage & {
  reactions: TeamMessageReaction[];
};

/**
 * Aggregates raw reaction rows into the per-message UI shape. Reactors are
 * grouped by message → emoji → name list. `reacted` is true if the caller
 * has a row in that (message, emoji) bucket. The route returns reactors
 * sorted by created_at (the SELECT below applies that order) so the chip-
 * detail popover lists names in the order people reacted.
 */
function aggregateReactions(
  rows: (TeamMessageReactionRow & { created_at?: string })[],
  callerId: string,
): Map<string, TeamMessageReaction[]> {
  // messageId -> emoji -> { count, reacted, reactors }
  const grouped = new Map<
    string,
    Map<
      string,
      {
        count: number;
        reacted: boolean;
        reactors: TeamMessageReactor[];
      }
    >
  >();

  for (const row of rows) {
    let perMessage = grouped.get(row.message_id);
    if (!perMessage) {
      perMessage = new Map();
      grouped.set(row.message_id, perMessage);
    }
    const reactor: TeamMessageReactor = {
      salesperson_id: row.salesperson_id,
      salesperson_name: row.salesperson_name,
    };
    const existing = perMessage.get(row.emoji);
    if (existing) {
      existing.count += 1;
      existing.reactors.push(reactor);
      if (row.salesperson_id === callerId) existing.reacted = true;
    } else {
      perMessage.set(row.emoji, {
        count: 1,
        reacted: row.salesperson_id === callerId,
        reactors: [reactor],
      });
    }
  }

  const result = new Map<string, TeamMessageReaction[]>();
  for (const [messageId, perMessage] of grouped) {
    const arr: TeamMessageReaction[] = [];
    for (const [emoji, agg] of perMessage) {
      arr.push({
        emoji,
        count: agg.count,
        reacted: agg.reacted,
        reactors: agg.reactors,
      });
    }
    // Stable chip ordering: count desc, emoji asc.
    arr.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
    result.set(messageId, arr);
  }
  return result;
}

export async function GET(req: Request) {
  try {
    const me = await requireSalesperson(req);
    const supabase = getServerSupabase();

    // Pagination — accept `?before=<ISO>&limit=N`. Both optional; the
    // initial page omits `before` and the route returns the most recent
    // FEED_PAGE_SIZE messages. `limit` is clamped to [1, 100] to keep a
    // single page bounded.
    const url = new URL(req.url);
    const beforeStr = url.searchParams.get("before");
    const limitStr = url.searchParams.get("limit");

    const parsedLimit = limitStr ? Number.parseInt(limitStr, 10) : NaN;
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(100, parsedLimit))
      : FEED_PAGE_SIZE;

    if (beforeStr && Number.isNaN(Date.parse(beforeStr))) {
      throw badRequest("Invalid 'before' query parameter.");
    }

    let query = supabase
      .from(TEAM_MESSAGES_TABLE)
      .select(MESSAGE_COLUMNS)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (beforeStr) {
      query = query.lt("created_at", beforeStr);
    }

    const res = await query;
    if (res.error) {
      throw new Error(`Failed to load messages: ${res.error.message}`);
    }

    const messages = ((res.data ?? []) as TeamMessage[]).slice().reverse();

    // Hydrate reactions for this page in one round-trip. Order by
    // created_at ASC so the aggregate's reactor list reads chronologically
    // — first to react appears first.
    let reactionsByMessage: Map<string, TeamMessageReaction[]> = new Map();
    if (messages.length > 0) {
      const ids = messages.map((m) => m.id);
      const reactionsRes = await supabase
        .from(TEAM_MESSAGE_REACTIONS_TABLE)
        .select("message_id, salesperson_id, salesperson_name, emoji, created_at")
        .in("message_id", ids)
        .order("created_at", { ascending: true });

      if (reactionsRes.error) {
        throw new Error(
          `Failed to load reactions: ${reactionsRes.error.message}`,
        );
      }

      reactionsByMessage = aggregateReactions(
        (reactionsRes.data ?? []) as (TeamMessageReactionRow & {
          created_at: string;
        })[],
        me.id,
      );
    }

    const hydrated: TeamMessageWithReactions[] = messages.map((m) => ({
      ...m,
      reactions: reactionsByMessage.get(m.id) ?? [],
    }));

    return Response.json({
      messages: hydrated,
      // Heuristic — when a full page came back, assume there's another
      // older page behind it. The next call returns either more rows or
      // nothing, which is when the client flips hasMore false.
      hasMore: hydrated.length === limit,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireSalesperson(req);
    const body = await parseBody(req, CreateMessageSchema);
    const supabase = getServerSupabase();

    // Reply metadata is server-derived from the parent so the client cannot
    // forge "in reply to X" with arbitrary text. The reply pointer is also
    // refused if the parent is gone — soft-deleted parents would otherwise
    // surface a misleading "(deleted)" preview.
    let replyMetadata: {
      reply_to_message_id: string;
      reply_to_salesperson_name: string;
      reply_to_message_preview: string;
    } | null = null;

    if (body.reply_to_message_id) {
      const parentRes = await supabase
        .from(TEAM_MESSAGES_TABLE)
        .select("id, salesperson_name, message, is_deleted, media_type")
        .eq("id", body.reply_to_message_id)
        .maybeSingle();

      if (parentRes.error) {
        throw new Error(`Failed to look up parent: ${parentRes.error.message}`);
      }
      if (!parentRes.data || parentRes.data.is_deleted) {
        throw badRequest("The post you tried to reply to is no longer available.");
      }

      const parent = parentRes.data as {
        id: string;
        salesperson_name: string;
        message: string;
        media_type: "image" | "gif" | null;
      };

      // If the parent had no text (media-only post), substitute a small
      // placeholder so the quoted block doesn't read as empty. Plain
      // text takes priority over media-derived placeholder when present.
      let preview = parent.message.slice(0, REPLY_PREVIEW_MAX_LENGTH);
      if (preview.length === 0) {
        if (parent.media_type === "image") preview = "📷 Image";
        else if (parent.media_type === "gif") preview = "🎬 GIF";
      }

      replyMetadata = {
        reply_to_message_id: parent.id,
        reply_to_salesperson_name: parent.salesperson_name,
        reply_to_message_preview: preview,
      };
    }

    // Build media fields server-side. For image posts we DERIVE the
    // storage path from a validated URL; for GIFs we RE-FETCH the asset
    // from the provider by id and copy fields directly. The client's
    // only contributions are `image_url` + intrinsic dims (image) or
    // `gif_id` (gif) — every other persisted field is server-truth.
    let mediaFields: {
      media_type: "image" | "gif" | null;
      media_url: string | null;
      media_thumb_url: string | null;
      media_width: number | null;
      media_height: number | null;
      media_alt: string | null;
      media_provider: string | null;
      media_storage_path: string | null;
    } = {
      media_type: null,
      media_url: null,
      media_thumb_url: null,
      media_width: null,
      media_height: null,
      media_alt: null,
      media_provider: null,
      media_storage_path: null,
    };

    if (body.image_url) {
      const storagePath = deriveImageStoragePath(body.image_url, me.id);
      if (!storagePath) {
        // Either the URL isn't ours, isn't shaped like our signed-upload
        // output, or — most likely — belongs to a DIFFERENT user's
        // path prefix. All cases produce the same generic message so
        // we don't leak internal validation details.
        throw badRequest("Image must be uploaded through this app.");
      }
      mediaFields = {
        media_type: "image",
        media_url: body.image_url,
        media_thumb_url: null,
        media_width: body.image_width ?? null,
        media_height: body.image_height ?? null,
        media_alt: body.image_alt ?? null,
        media_provider: "supabase",
        media_storage_path: storagePath,
      };
    } else if (body.gif_id) {
      const gif = await fetchGiphyById(body.gif_id);
      if (!gif) {
        throw badRequest(
          "Couldn't verify that GIF. Please pick one from the GIF picker.",
        );
      }
      // Defense in depth — verify the URLs the upstream gave us are
      // GIPHY-hosted before persisting. Bug in formatGifResult or in
      // GIPHY's response shape can't smuggle a foreign host through.
      let fullHost = "";
      let previewHost = "";
      try {
        fullHost = new URL(gif.full_url).hostname;
        previewHost = new URL(gif.preview_url).hostname;
      } catch {
        throw badRequest("Couldn't verify that GIF.");
      }
      if (!isGiphyHost(fullHost) || !isGiphyHost(previewHost)) {
        throw badRequest("GIFs must come from the GIPHY library.");
      }
      mediaFields = {
        media_type: "gif",
        media_url: gif.full_url,
        media_thumb_url: gif.preview_url,
        media_width: gif.width,
        media_height: gif.height,
        media_alt: gif.alt,
        media_provider: "giphy",
        media_storage_path: null,
      };
    }

    const insertPayload: {
      salesperson_id: string;
      salesperson_name: string;
      message: string;
      reply_to_message_id: string | null;
      reply_to_salesperson_name: string | null;
      reply_to_message_preview: string | null;
      media_type: "image" | "gif" | null;
      media_url: string | null;
      media_thumb_url: string | null;
      media_width: number | null;
      media_height: number | null;
      media_alt: string | null;
      media_provider: string | null;
      media_storage_path: string | null;
    } = {
      salesperson_id: me.id,
      salesperson_name: me.first_name,
      message: body.message,
      reply_to_message_id: replyMetadata?.reply_to_message_id ?? null,
      reply_to_salesperson_name:
        replyMetadata?.reply_to_salesperson_name ?? null,
      reply_to_message_preview:
        replyMetadata?.reply_to_message_preview ?? null,
      ...mediaFields,
    };

    const res = await supabase
      .from(TEAM_MESSAGES_TABLE)
      .insert(insertPayload)
      .select(MESSAGE_COLUMNS)
      .single();

    if (res.error || !res.data) {
      throw new Error(res.error?.message ?? "Failed to post message.");
    }

    const message: TeamMessageWithReactions = {
      ...(res.data as TeamMessage),
      reactions: [],
    };

    // Web Push fan-out to every subscription on file except the
    // sender's own devices — Juice Box is now open to the whole team.
    // Errors (5xx, network) are swallowed inside fanOutJuiceBoxPush;
    // dead 404/410 subscriptions are GC'd from the DB inside as well.
    // No-op when VAPID env is unset, so the route stays functional
    // before push is configured.
    //
    // EXECUTION MODEL — Vercel serverless
    //   This is `await`-ed, NOT fire-and-forget. On Vercel's Node.js
    //   functions, the runtime freezes the V8 isolate as soon as the
    //   response is flushed; any Promise that hadn't already completed
    //   its first await gets killed mid-flight. Earlier diagnostics
    //   proved this: the synchronous `fan-out start` log appeared but
    //   everything after the first `await supabase…` never did.
    //   Awaiting keeps the function alive until fan-out finishes.
    //
    //   Latency cost: typically +300–500 ms (parallel sends to ~10
    //   subscriptions). Acceptable for a "Post" action; the composer
    //   already shows a "Posting…" state during the request.
    //
    // Diagnostics: a kickoff line is logged here so the trace begins
    // immediately after the insert resolves; fanOutJuiceBoxPush
    // continues logging its own lifecycle.
    console.log(
      `[team-messages] firing push fan-out sender=${me.id} message_id=${(res.data as { id: string }).id}`,
    );
    // Personalized push body: "<First name> posted in Juice Box". Sender's
    // first name is already in scope via the signed session and is what we
    // wrote into team_messages.salesperson_name above, so this exposes no
    // information the recipient couldn't already see in the feed. Trim
    // guards against whitespace; the `|| "Someone"` fallback covers any
    // future schema relaxation of salespeople.first_name. Message content,
    // last names, emails, and role flags are intentionally NOT included.
    const senderName = me.first_name?.trim() || "Someone";
    try {
      await fanOutJuiceBoxPush({
        excludeSalespersonId: me.id,
        payload: {
          // Title is the app, body is the actor + action. iOS already
          // prefixes "from Elevate App" above the title on lock screen;
          // using "Juice Box" here was redundant with the body's "posted
          // in Juice Box". Using the app name cleans up the two-line
          // notification to read like:
          //   Elevate App
          //   Ryan posted in Juice Box
          title: "Elevate App",
          body: `${senderName} posted in Juice Box`,
          url: "/juice-box",
        },
      });
    } catch (err: unknown) {
      // fanOutJuiceBoxPush swallows per-send failures internally; an
      // exception here is unexpected (DB pool issue, etc.). Log and
      // proceed — the post itself is already saved, and starving
      // notifications shouldn't fail the user's POST.
      console.error(
        `[team-messages] fan-out error sender=${me.id} err=${String(err)}`,
      );
    }

    return Response.json({ message }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
