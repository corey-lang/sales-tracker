import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError, forbidden, requireSalesperson, type AuthedSalesperson } from "@/lib/server/auth";
import { TEAM_MESSAGES_TABLE } from "@/lib/team-messages";
import {
  seenResultFor,
  type AudienceMember,
  type ReceiptIndex,
  type SeenDetail,
  type SeenPost,
  type SeenSummary,
} from "@/lib/juice-box-seen";
import { getServerSupabase } from "@/lib/supabase/server";

// Server side of "Seen by X of Y". The rules live in lib/juice-box-seen.ts;
// this module authorizes the caller and loads what the rules need.
//
// WHO MAY SEE THE LIST: an admin (Corey, Ryan), or anyone granted
// salespeople.can_view_juice_box_seen (Tonja, Leah, Faith — supabase/
// juice_box_seen_by.sql). Everyone else, including every AE, gets a 403 and
// NOTHING about anyone's read state — not a count, not a name. Counts are
// withheld too, because "3 of 11" next to a name someone already knows is
// still information about who read what.
//
// WHERE "SEEN" COMES FROM: team_message_seen receipts — posts a person's screen
// actually showed — NOT the channel read markers (those mean "nothing newer than
// here is unread" and are stamped past posts that were never loaded). See
// lib/juice-box-seen.ts.
//
// QUERY SHAPE — constant, never per post or per person:
//   1. the posts asked about            (one `.in(id, …)`)
//   2. the audience                      (one salespeople read)
//   3. the receipts for those posts      (one `.in(message_id, …)`, paged past
//                                         PostgREST's 1000-row cap — a few pages
//                                         for a worst-case 200 posts × many people)
// then every post × every person is evaluated in memory.

type Db = SupabaseClient;

export const SEEN_TABLE = "team_message_seen";
export const MARK_SEEN_RPC = "juice_box_mark_seen";

/** PostgREST truncates every response to this many rows; page below it. */
const PAGE = 1000;

/** The 503 for "juice_box_seen_by.sql hasn't been applied" (table or function missing). */
export const SEEN_MIGRATION_MESSAGE =
  "Seen-by isn't set up on this database yet. Apply supabase/juice_box_seen_by.sql, then reload.";

export function isMissingSeenMigration(
  err: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!err) return false;
  const message = (err.message ?? "").toLowerCase();
  return (
    ["42P01", "42883", "PGRST202", "PGRST205"].includes(err.code ?? "") &&
    (message.includes("team_message_seen") || message.includes("juice_box_mark_seen"))
  );
}

export const seenMigrationRequiredError = () => new ApiError(503, SEEN_MIGRATION_MESSAGE);

/** Admin, or the per-user flag. Fails closed on any lookup error. */
export async function canViewJuiceBoxSeen(
  supabase: Db,
  me: { id: string; role: string },
): Promise<boolean> {
  if (me.role === "admin") return true;
  const res = await supabase
    .from("salespeople")
    .select("can_view_juice_box_seen")
    .eq("id", me.id)
    .maybeSingle();
  if (res.error) {
    console.warn(
      `[juice-box-seen] permission lookup failed id=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    return false;
  }
  return (
    (res.data as { can_view_juice_box_seen?: boolean } | null)
      ?.can_view_juice_box_seen === true
  );
}

/** Signed-in AND allowed to see seen state; every other caller is a 403. */
export async function requireJuiceBoxSeenAccess(
  req: Request,
): Promise<AuthedSalesperson> {
  const me = await requireSalesperson(req);
  if (!(await canViewJuiceBoxSeen(getServerSupabase(), me))) {
    throw forbidden("Not available.");
  }
  return me;
}

/** Active, non-test people — everyone who can open Juice Box. */
async function loadAudience(supabase: Db): Promise<AudienceMember[]> {
  const res = await supabase
    .from("salespeople")
    .select("id, first_name, created_at")
    .is("deactivated_at", null)
    .eq("is_test", false);
  if (res.error) {
    throw new Error(`Failed to load the Juice Box audience: ${res.error.message}`);
  }
  return ((res.data ?? []) as Array<{
    id: string;
    first_name: string;
    created_at: string | null;
  }>).map((r) => ({ id: r.id, name: r.first_name, joined_at: r.created_at }));
}

/**
 * Who has a receipt on each of these posts. Ordered and paged so the answer can
 * never be silently cut at PostgREST's row cap.
 */
async function loadReceipts(
  supabase: Db,
  postIds: readonly string[],
): Promise<ReceiptIndex> {
  const index = new Map<string, Set<string>>();
  if (postIds.length === 0) return index;
  for (let from = 0; ; from += PAGE) {
    const res = await supabase
      .from(SEEN_TABLE)
      .select("message_id, salesperson_id")
      .in("message_id", [...postIds])
      .order("message_id", { ascending: true })
      .order("salesperson_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (res.error) {
      if (isMissingSeenMigration(res.error)) throw seenMigrationRequiredError();
      throw new Error(`Failed to load seen receipts: ${res.error.message}`);
    }
    const rows = (res.data ?? []) as Array<{ message_id: string; salesperson_id: string }>;
    for (const r of rows) {
      const set = index.get(r.message_id) ?? new Set<string>();
      set.add(r.salesperson_id);
      index.set(r.message_id, set);
    }
    if (rows.length < PAGE) break;
  }
  return index;
}

type PostRow = SeenPost & { is_deleted: boolean };

async function loadPosts(supabase: Db, ids: readonly string[]): Promise<SeenPost[]> {
  if (ids.length === 0) return [];
  const res = await supabase
    .from(TEAM_MESSAGES_TABLE)
    .select("id, created_at, salesperson_id, is_deleted")
    .in("id", [...ids]);
  if (res.error) {
    throw new Error(`Failed to load posts: ${res.error.message}`);
  }
  return ((res.data ?? []) as PostRow[])
    .filter((p) => !p.is_deleted)
    .map((p) => ({ id: p.id, created_at: p.created_at, salesperson_id: p.salesperson_id }));
}

/** Counts for many posts at once. Unknown / deleted ids are simply absent. */
export async function fetchSeenSummaries(
  supabase: Db,
  ids: readonly string[],
): Promise<Record<string, SeenSummary>> {
  const posts = await loadPosts(supabase, ids);
  if (posts.length === 0) return {};
  const audience = await loadAudience(supabase);
  const receipts = await loadReceipts(supabase, posts.map((p) => p.id));

  const out: Record<string, SeenSummary> = {};
  for (const post of posts) {
    const r = seenResultFor(post, audience, receipts);
    out[post.id] = { seen: r.seen.length, total: r.seen.length + r.not_seen.length };
  }
  return out;
}

/** The full has / hasn't-seen lists for one post, or null if it doesn't exist. */
export async function fetchSeenDetail(
  supabase: Db,
  id: string,
): Promise<SeenDetail | null> {
  const [post] = await loadPosts(supabase, [id]);
  if (!post) return null;
  const audience = await loadAudience(supabase);
  const receipts = await loadReceipts(supabase, [post.id]);
  const r = seenResultFor(post, audience, receipts);
  return {
    id: post.id,
    seen: r.seen.length,
    total: r.seen.length + r.not_seen.length,
    seen_people: r.seen,
    not_seen_people: r.not_seen,
  };
}

/**
 * Records that `personId` reached these posts. `personId` MUST be the verified
 * session's id — the route never takes it from the request. Idempotent; deleted /
 * unknown posts and the person's own posts are skipped inside the function.
 */
export async function recordSeen(
  supabase: Db,
  personId: string,
  postIds: readonly string[],
): Promise<void> {
  const res = await supabase.rpc(MARK_SEEN_RPC, {
    p_salesperson_id: personId,
    p_message_ids: [...postIds],
  });
  if (res.error) {
    console.warn(
      `[juice-box-seen] record failed caller=${personId} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    if (isMissingSeenMigration(res.error)) throw seenMigrationRequiredError();
    throw new Error("Failed to record seen posts.");
  }
}
