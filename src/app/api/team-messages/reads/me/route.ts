import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  badRequest,
  handleApiError,
  requireSalesperson,
} from "@/lib/server/auth";
import {
  DEFAULT_JUICE_BOX_CHANNEL,
  isJuiceBoxChannel,
  JUICE_BOX_MARK_CHANNEL_READ_RPC,
  JUICE_BOX_MARK_LEGACY_READ_RPC,
  type JuiceBoxChannel,
  type TeamMessageRead,
} from "@/lib/team-messages";
import { fetchEffectiveChannelMarker } from "@/lib/server/juice-box-reads";
import {
  isMissingChannelsMigration,
  migrationRequiredError,
} from "@/lib/server/juice-box-migration";

// Juice Box — current user's read marker for ONE channel.
//
//   GET  /api/team-messages/reads/me[?channel=ID] -> { channel, last_read_at }
//   (markers live in team_message_channel_reads; see TWO TABLES below)
//   POST /api/team-messages/reads/me  body { channel? } -> { channel, last_read_at }
//
// ACCESS
//   Both verbs require any signed-in salesperson (requireSalesperson).
//   Identity is the server-validated session, so a client can NEVER mutate
//   another user's marker.
//
// SEMANTICS
//   POST advances the marker for ONE channel to the database's `now()`. There
//   is still no "set to T" form: the only thing a client may assert is "I have
//   seen everything in THIS channel up to right now." That remains the
//   strongest guard against forward-dating a marker and silently swallowing
//   future messages — and the timestamp is now generated inside Postgres, so
//   the client's clock is not in the picture at all.
//
// MONOTONIC, ENFORCED BY THE DATABASE
//   The write goes through the `juice_box_mark_channel_read` RPC, which does
//   `INSERT … ON CONFLICT DO UPDATE SET last_read_at = GREATEST(existing,
//   incoming)` in ONE statement and RETURNS the persisted value.
//
//   The previous unconditional upsert had a real race: two requests stamping
//   T1 and T2 could reach Postgres in the reverse order, and the older T1 would
//   overwrite T2 — moving the marker BACKWARD and resurrecting already-read
//   posts as unread (stale divider, wrong initial landing). Comparing in
//   JavaScript, or reading-then-writing, just moves the race between the check
//   and the write; GREATEST inside the statement removes it. A late older write
//   is now a no-op on the value.
//
//   The response therefore carries the PERSISTED timestamp from the RPC, never
//   a locally generated one — so a request whose timestamp the database
//   rejected as older still answers with the true marker.
//
//   PER-CHANNEL ISOLATION is the point of the `channel` field: marking General
//   read must not touch Product Help or Social Media Hub. The upsert targets
//   exactly one (salesperson_id, channel) row in
//   `team_message_channel_reads` — the other channels' rows are never in the
//   statement — so reading one channel can't clear another's badge. An
//   omitted/absent channel means General, so an old cached client bundle
//   POSTing an empty body keeps marking the same feed it always did.
//
//   An UNKNOWN channel is a 400. Normalizing it to General would stamp the
//   wrong channel's marker and quietly lose someone's unread state.
//
// TWO TABLES DURING THE ROLLOUT
//   Channel markers live in the NEW `team_message_channel_reads` table. The
//   LEGACY single-marker `team_message_reads` table is deliberately left in
//   place (see supabase/juice_box_channels.sql) so the previously deployed
//   bundle and any stale browser tab keep working unchanged — their unread
//   count still reads from it.
//
//   READS are therefore resolved through `fetchEffectiveChannelMarker`, which
//   returns MAX(new General, legacy) for General and the channel-specific
//   marker alone for the other two. WRITES always land on the new table (plus
//   the General mirror below, via its own equally-monotonic RPC). Both halves
//   are temporary and disappear with the legacy table.
//
// TRANSACTIONS
//   The two RPCs are two separate statements, hence two separate transactions.
//   That is deliberate: the channel write is authoritative and commits by
//   itself, so a failing legacy mirror can neither roll it back nor fail the
//   request — the route logs the mirror error and still returns 200 with the
//   authoritative timestamp.
//
//   So that those clients don't sit on a stale badge for a feed the user has
//   already read here, a General mark-read ALSO refreshes the legacy row,
//   best-effort. It is:
//     * General-only — the legacy table has no channel dimension, and mapping
//       a Product Help read onto it would tell an old client the whole feed
//       was read when it wasn't;
//     * non-fatal — a failure is logged and the request still succeeds, since
//       the authoritative write already landed;
//     * temporary — delete this block together with the legacy table in the
//       future cleanup migration.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Body is `{ channel? }` only — no timestamp, by design (see header). */
const MarkReadSchema = z
  .object({
    channel: z
      .enum(["general", "product_help", "social_media_hub"])
      .optional(),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const me = await requireSalesperson(req);
    const supabase = getServerSupabase();

    const raw = new URL(req.url).searchParams.get("channel");
    if (raw !== null && !isJuiceBoxChannel(raw)) {
      throw badRequest("Unknown channel.");
    }
    const channel: JuiceBoxChannel = raw ?? DEFAULT_JUICE_BOX_CHANNEL;

    // Shared resolver: General folds in the legacy global marker (later of the
    // two), the other channels use their own only. Same implementation the
    // unread counts use — see src/lib/server/juice-box-reads.ts.
    const lastReadAt = await fetchEffectiveChannelMarker(
      supabase,
      me.id,
      channel,
    );

    const payload: TeamMessageRead = {
      channel,
      // Null = this user has never read this channel. Meaningful, not missing:
      // the client lands at the latest message and shows no divider.
      last_read_at: lastReadAt,
    };
    return Response.json(payload);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireSalesperson(req);
    const supabase = getServerSupabase();

    // An absent body is tolerated (a cached pre-channels client POSTs none) and
    // means General. A present body must parse — an unknown channel is a 400.
    let channel: JuiceBoxChannel = DEFAULT_JUICE_BOX_CHANNEL;
    const text = await req.text();
    if (text.trim().length > 0) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw badRequest("Request body is not valid JSON.");
      }
      const parsed = MarkReadSchema.safeParse(json);
      if (!parsed.success) {
        throw badRequest("Unknown channel.");
      }
      channel = parsed.data.channel ?? DEFAULT_JUICE_BOX_CHANNEL;
    }

    // AUTHORITATIVE WRITE. Atomic + monotonic inside Postgres; the salesperson
    // comes from the verified session and the channel from the validation
    // above, so the RPC only ever receives server-controlled values.
    const res = await supabase.rpc(JUICE_BOX_MARK_CHANNEL_READ_RPC, {
      p_salesperson_id: me.id,
      p_channel: channel,
    });

    if (res.error || typeof res.data !== "string") {
      // Raw provider text is logged, not returned (it can carry schema detail).
      console.warn(
        `[team-messages] mark-read failed caller=${me.id} channel=${channel} code=${res.error?.code ?? "?"} msg=${res.error?.message ?? "no timestamp returned"}`,
      );
      // Pre-migration: the monotonic RPCs don't exist yet. Say which migration.
      if (isMissingChannelsMigration(res.error)) throw migrationRequiredError();
      throw new Error("Failed to update read marker.");
    }
    // The value Postgres actually holds after GREATEST — which may be a marker
    // set by a concurrent, later request rather than this call's own `now()`.
    const persisted = res.data;

    // ROLLOUT COMPATIBILITY MIRROR (General only, best-effort, temporary).
    // Keeps the legacy single-marker table current for clients still running
    // the pre-channels bundle. Separate RPC → separate transaction, so a
    // failure here cannot roll back or fail the authoritative write above; it
    // is logged and the request still succeeds. Product Help and Social Media
    // Hub never reach this branch.
    if (channel === DEFAULT_JUICE_BOX_CHANNEL) {
      const legacy = await supabase.rpc(JUICE_BOX_MARK_LEGACY_READ_RPC, {
        p_salesperson_id: me.id,
      });
      if (legacy.error) {
        console.warn(
          `[team-messages] legacy read-marker mirror failed caller=${me.id} code=${legacy.error.code ?? "?"} msg=${legacy.error.message}`,
        );
      }
    }

    const payload: TeamMessageRead = {
      channel,
      last_read_at: persisted,
    };
    return Response.json(payload);
  } catch (err) {
    return handleApiError(err);
  }
}
