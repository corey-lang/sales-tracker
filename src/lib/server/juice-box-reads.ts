import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_JUICE_BOX_CHANNEL,
  normalizeChannel,
  TEAM_MESSAGE_CHANNEL_READS_TABLE,
  TEAM_MESSAGE_READS_TABLE,
  type JuiceBoxChannel,
} from "@/lib/team-messages";
import { laterTimestamp } from "@/lib/juice-box-unread";
import {
  isMissingChannelsMigration,
  migrationRequiredError,
} from "@/lib/server/juice-box-migration";

// THE one place Juice Box read markers are resolved.
//
// WHY A SHARED RESOLVER
//   During the channels rollout there are TWO tables holding read state for
//   what the user experiences as one feed:
//
//     team_message_channel_reads  — per (salesperson_id, channel). What the
//                                   channel-aware app writes.
//     team_message_reads          — LEGACY, one row per salesperson, no
//                                   channel. Still written by the previously
//                                   deployed bundle and by any stale tab, and
//                                   deliberately left intact for them (see
//                                   supabase/juice_box_channels.sql).
//
//   The migration copies the legacy marker into the new table as GENERAL when
//   it RUNS. But the old app keeps running until the deploy lands, so it can
//   advance the legacy marker AFTER that copy. Reading only the new table would
//   then show General posts the user had already read as unread — a stale NEW
//   MESSAGES divider and a scroll back into old history, right after the
//   upgrade.
//
//   So GENERAL's effective marker is MAX(new General, legacy) and every read
//   path calls this module rather than doing its own lookup. That removes the
//   "deploy before the marker moves" timing dependency entirely — no manual
//   ordering step, correct whenever the deploy happens.
//
// CHANNEL ISOLATION IS ABSOLUTE
//   The legacy marker describes the pre-channels feed, which is General. It is
//   NEVER consulted for Product Help or Social Media Hub — folding it in would
//   claim the user had read posts in channels that did not exist when that
//   marker was written, silently hiding real unread content.
//
// TEMPORARY
//   This dual read exists only while the legacy table does. When the future
//   cleanup migration drops `team_message_reads`, delete `fetchLegacyMarker`
//   and the `laterTimestamp` call below, and this module collapses into a
//   single-table read. Nothing else needs to change: callers already treat the
//   returned value as "the marker".
//
// Server-only. Never import from a "use client" component.

/** Effective marker per channel. null = no read receipt for that channel. */
export type ChannelMarkers = Record<JuiceBoxChannel, string | null>;

function emptyMarkers(): ChannelMarkers {
  return { general: null, product_help: null, social_media_hub: null };
}

/**
 * Reads the LEGACY global marker for one salesperson, or null.
 *
 * Best-effort by design: a failure here (table already retired, transient
 * error) must not break unread state, so it resolves to null and the caller
 * falls back to the channel-specific marker alone. Raw provider text is logged,
 * never returned.
 */
async function fetchLegacyMarker(
  supabase: SupabaseClient,
  salespersonId: string,
): Promise<string | null> {
  const res = await supabase
    .from(TEAM_MESSAGE_READS_TABLE)
    .select("last_read_at")
    .eq("salesperson_id", salespersonId)
    .maybeSingle();

  if (res.error) {
    console.warn(
      `[team-messages] legacy read-marker lookup failed caller=${salespersonId} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    return null;
  }
  return (res.data?.last_read_at as string | undefined) ?? null;
}

/**
 * Every channel's EFFECTIVE read marker for one salesperson.
 *
 *   general           → MAX(channel-specific General, legacy global)
 *   product_help      → channel-specific only
 *   social_media_hub  → channel-specific only
 *
 * `salespersonId` MUST come from the verified session — this module never sees
 * a request and cannot be pointed at another user.
 *
 * Throws on a failure to read the CHANNEL table (that one is authoritative, so
 * a caller must fail closed rather than report everything as unread). A failure
 * to read the legacy table is swallowed — see fetchLegacyMarker.
 */
export async function fetchEffectiveChannelMarkers(
  supabase: SupabaseClient,
  salespersonId: string,
): Promise<ChannelMarkers> {
  const [channelRes, legacyMarker] = await Promise.all([
    supabase
      .from(TEAM_MESSAGE_CHANNEL_READS_TABLE)
      .select("channel, last_read_at")
      .eq("salesperson_id", salespersonId),
    fetchLegacyMarker(supabase, salespersonId),
  ]);

  if (channelRes.error) {
    // Pre-migration database: the channel-reads table doesn't exist yet. Report
    // that specifically (503 + what to run) instead of a generic failure.
    if (isMissingChannelsMigration(channelRes.error)) {
      throw migrationRequiredError();
    }
    throw new Error(
      `Failed to load read markers: ${channelRes.error.message}`,
    );
  }

  const markers = emptyMarkers();
  for (const row of (channelRes.data ?? []) as Array<{
    channel: string | null;
    last_read_at: string | null;
  }>) {
    // Defensive: the column is NOT NULL with a CHECK, so this only guards
    // against a hand-edited row. Normalizes to General either way.
    markers[normalizeChannel(row.channel)] = row.last_read_at ?? null;
  }

  // GENERAL ONLY. The channel-specific value is passed first so it wins a tie,
  // keeping the canonical table authoritative when both say the same instant.
  markers[DEFAULT_JUICE_BOX_CHANNEL] = laterTimestamp(
    markers[DEFAULT_JUICE_BOX_CHANNEL],
    legacyMarker,
  );

  return markers;
}

/**
 * One channel's effective marker. Thin wrapper over
 * `fetchEffectiveChannelMarkers` so a single-channel caller (GET
 * /api/team-messages/reads/me) cannot accidentally implement the General rule
 * differently — there is exactly one implementation of it.
 */
export async function fetchEffectiveChannelMarker(
  supabase: SupabaseClient,
  salespersonId: string,
  channel: JuiceBoxChannel,
): Promise<string | null> {
  const markers = await fetchEffectiveChannelMarkers(supabase, salespersonId);
  return markers[channel];
}
