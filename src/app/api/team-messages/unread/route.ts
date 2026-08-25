import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireSalesperson } from "@/lib/server/auth";
import {
  DEFAULT_JUICE_BOX_CHANNEL,
  JUICE_BOX_CHANNEL_IDS,
  TEAM_MESSAGES_TABLE,
  type JuiceBoxChannel,
  type TeamMessageChannelUnread,
  type TeamMessageUnreadSummary,
} from "@/lib/team-messages";
import {
  combinedUnreadCount,
  emptyChannelUnread,
} from "@/lib/juice-box-unread";
import { fetchEffectiveChannelMarkers } from "@/lib/server/juice-box-reads";
import {
  isMissingChannelsMigration,
  migrationRequiredError,
} from "@/lib/server/juice-box-migration";

// Juice Box — unread summary for the caller, per channel + combined.
//
//   GET /api/team-messages/unread
//     -> {
//          count,                     // COMBINED across all channels
//          last_read_at,              // General's marker (legacy field)
//          channels: {
//            general:          { count, last_read_at },
//            product_help:     { count, last_read_at },
//            social_media_hub: { count, last_read_at },
//          },
//        }
//
// WHO READS WHAT
//   * The bottom-nav badge shows `count` — one number for the whole feature,
//     so a Product Help post still pulls the user into Juice Box.
//   * Each channel tab shows `channels[id].count`.
//   * Each channel's NEW MESSAGES divider and initial scroll key off
//     `channels[id].last_read_at`.
//   * `last_read_at` at the top level is General's marker, kept so a client
//     bundle cached from before channels shipped reads a sane value.
//
// EXISTING USERS / MISSING MARKERS
//   Markers come from `fetchEffectiveChannelMarkers`, the single shared
//   resolver (src/lib/server/juice-box-reads.ts). It reads
//   `team_message_channel_reads` and, for GENERAL ONLY, takes the later of that
//   and the legacy `team_message_reads` marker — so a General post the user
//   already read on the pre-channels bundle can never come back as unread after
//   the upgrade. Product Help and Social Media Hub use their own markers only.
//
//   A channel with no marker reads as `last_read_at: null`, which is meaningful
//   rather than a bug: the client treats it as "land at the latest message and
//   show no divider above old content", and the count below falls back to
//   "every live message in that channel" (0 for a brand-new channel).
//
// ACCESS
//   Any signed-in salesperson (requireSalesperson). Identity comes from the
//   signed session — the route never reads a salesperson id from the request,
//   so one user can never see another's unread state.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const me = await requireSalesperson(req);
    const supabase = getServerSupabase();

    // EFFECTIVE markers — General folds in the legacy global marker; the other
    // two channels never do. One shared implementation, so the counts below and
    // the `last_read_at` values handed to the client can't diverge.
    const markers = await fetchEffectiveChannelMarkers(supabase, me.id);

    // Per-channel HEAD counts, in parallel. Pure counts — no row data crosses
    // the wire — and each one matches the
    // idx_team_messages_live_channel_created_at partial index. Three small
    // counts beat one unbounded fetch-and-count-in-JS, which would grow with
    // feed history.
    const counted = await Promise.all(
      JUICE_BOX_CHANNEL_IDS.map(async (id) => {
        let query = supabase
          .from(TEAM_MESSAGES_TABLE)
          .select("id", { count: "exact", head: true })
          .eq("is_deleted", false)
          .eq("channel", id);

        const marker = markers[id];
        if (marker) {
          query = query.gt("created_at", marker);
        }

        const res = await query;
        if (res.error) {
          if (isMissingChannelsMigration(res.error)) {
            throw migrationRequiredError();
          }
          throw new Error(
            `Failed to count unread messages for ${id}: ${res.error.message}`,
          );
        }
        return [id, res.count ?? 0] as const;
      }),
    );

    const channels: Record<JuiceBoxChannel, TeamMessageChannelUnread> =
      emptyChannelUnread();
    for (const [id, count] of counted) {
      // The client receives the SAME effective marker the count was computed
      // against, so the divider and the badge can never disagree.
      channels[id] = { count, last_read_at: markers[id] };
    }

    const payload: TeamMessageUnreadSummary = {
      count: combinedUnreadCount(channels),
      last_read_at: channels[DEFAULT_JUICE_BOX_CHANNEL].last_read_at,
      channels,
    };
    return Response.json(payload);
  } catch (err) {
    return handleApiError(err);
  }
}
