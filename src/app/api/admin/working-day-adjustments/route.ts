import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";

// /api/admin/working-day-adjustments
//
// Admin-only CRUD for the working_day_adjustments table (see
// supabase/working_day_adjustments.sql). All writes flow through here with the
// service-role key — the table is RLS-locked so anon clients can only READ.
//
//   GET  → list every adjustment (newest date first), joined to AE first_name.
//   POST → create one global (applies_to_all) or individual adjustment.
//
// DELETE lives in ./[id]/route.ts.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A global holiday carries no salesperson_id; an individual adjustment requires
// one. The two-variant union enforces the same invariant the DB CHECK does, so
// a malformed body is a clean 400 rather than a 23514 surfaced as a 500.
const GlobalSchema = z.object({
  applies_to_all: z.literal(true),
  salesperson_id: z.null().optional(),
  adjustment_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "adjustment_date must be YYYY-MM-DD."),
  reason: z.string().trim().min(1, "Reason is required.").max(120),
  note: z.string().trim().max(500).optional().nullable(),
  // Default full day off. Half-days (0.5) are supported by the schema/pace
  // math but there's no UI for them yet.
  day_value: z.union([z.literal(1), z.literal(0.5)]).optional(),
});

const IndividualSchema = z.object({
  applies_to_all: z.literal(false).optional(),
  salesperson_id: z.string().uuid("salesperson_id must be a UUID."),
  adjustment_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "adjustment_date must be YYYY-MM-DD."),
  reason: z.string().trim().min(1, "Reason is required.").max(120),
  note: z.string().trim().max(500).optional().nullable(),
  day_value: z.union([z.literal(1), z.literal(0.5)]).optional(),
});

const CreateSchema = z.union([GlobalSchema, IndividualSchema]);

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const supabase = getServerSupabase();

    const res = await supabase
      .from("working_day_adjustments")
      .select(
        "id, adjustment_date, salesperson_id, applies_to_all, day_value, reason, note, created_by, created_at, salespeople:salesperson_id(first_name)",
      )
      .order("adjustment_date", { ascending: false })
      .order("created_at", { ascending: false });

    if (res.error) {
      // Raw provider text logged server-side only; caller gets a safe message.
      console.error(
        `[working-days] list failed code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not load working day adjustments.");
    }

    // Flatten the embedded AE name to a plain field for the client.
    const adjustments = (res.data ?? []).map((row) => {
      const rel = (row as { salespeople?: unknown }).salespeople;
      const first =
        Array.isArray(rel) && rel.length > 0
          ? (rel[0] as { first_name?: unknown }).first_name
          : (rel as { first_name?: unknown } | null)?.first_name;
      const { salespeople: _drop, ...rest } = row as Record<string, unknown>;
      void _drop;
      return {
        ...rest,
        salesperson_name: typeof first === "string" ? first : null,
      };
    });

    return Response.json({ adjustments });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireAdmin(req);
    const body = await parseBody(req, CreateSchema);

    const appliesToAll = body.applies_to_all === true;
    const payload = {
      adjustment_date: body.adjustment_date,
      applies_to_all: appliesToAll,
      salesperson_id: appliesToAll ? null : body.salesperson_id,
      day_value: body.day_value ?? 1,
      reason: body.reason,
      note: body.note ?? null,
      created_by: me.id,
    };

    const supabase = getServerSupabase();
    const insRes = await supabase
      .from("working_day_adjustments")
      .insert(payload)
      .select("*")
      .maybeSingle();

    if (insRes.error) {
      // 23505 = unique_violation — a matching (date, scope) row already
      // exists. This is intentionally detected (not raw provider text), so the
      // specific 409 message is safe to surface.
      if (insRes.error.code === "23505") {
        throw new ApiError(
          409,
          appliesToAll
            ? "A holiday already exists for that date."
            : "That AE already has an adjustment for that date.",
        );
      }
      // Any other DB error: log raw server-side, return a safe message.
      console.error(
        `[working-days] create failed code=${insRes.error.code ?? "?"} msg=${insRes.error.message}`,
      );
      throw new ApiError(500, "Could not save working day adjustment.");
    }

    return Response.json({ adjustment: insRes.data });
  } catch (err) {
    return handleApiError(err);
  }
}
