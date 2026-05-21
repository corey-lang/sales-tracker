import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireSalesperson } from "@/lib/server/auth";
import {
  TEAM_MESSAGE_READS_TABLE,
  type TeamMessageRead,
} from "@/lib/team-messages";

// Juice Box — current user's read marker.
//
//   GET  /api/team-messages/reads/me   -> { last_read_at: string | null }
//   POST /api/team-messages/reads/me   -> { last_read_at: string }
//
// ACCESS
//   Both verbs require any signed-in salesperson (requireSalesperson).
//   Identity is the server-validated session — the body is intentionally
//   unused so a client can NEVER mutate another user's marker.
//
// SEMANTICS
//   POST stamps last_read_at = NOW() and upserts on salesperson_id. There
//   is no "set to T" form: the only thing a client is allowed to assert is
//   "I have seen everything up to right now." This is the strongest guard
//   against forward-dating the marker and silently swallowing future
//   messages.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const me = await requireSalesperson(req);
    const supabase = getServerSupabase();

    const res = await supabase
      .from(TEAM_MESSAGE_READS_TABLE)
      .select("last_read_at")
      .eq("salesperson_id", me.id)
      .maybeSingle();

    if (res.error) {
      throw new Error(`Failed to load read marker: ${res.error.message}`);
    }

    const payload: TeamMessageRead = {
      last_read_at: (res.data?.last_read_at as string | undefined) ?? null,
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

    // Stamp NOW() server-side. Body is intentionally ignored — see header.
    const now = new Date().toISOString();
    const res = await supabase
      .from(TEAM_MESSAGE_READS_TABLE)
      .upsert(
        {
          salesperson_id: me.id,
          last_read_at: now,
          updated_at: now,
        },
        { onConflict: "salesperson_id" },
      )
      .select("last_read_at")
      .single();

    if (res.error || !res.data) {
      throw new Error(
        res.error?.message ?? "Failed to update read marker.",
      );
    }

    const payload: TeamMessageRead = {
      last_read_at: res.data.last_read_at as string,
    };
    return Response.json(payload);
  } catch (err) {
    return handleApiError(err);
  }
}
