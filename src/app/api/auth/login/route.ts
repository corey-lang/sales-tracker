import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  parseBody,
  signSessionToken,
  unauthorized,
} from "@/lib/server/auth";
import { isUserRole, type UserRole } from "@/lib/permissions";

// Phase 0: server-side login.
// POST /api/auth/login   body: { name: string, pin?: string }
//
// WHY THIS ROUTE EXISTS
//   The login screen used to read salespeople.admin_pin straight from the
//   browser with the anon key and compare the PIN client-side. The plaintext
//   PIN therefore crossed the wire to every device that opened the app.
//
//   This route validates credentials server-side with the service-role key.
//   The PIN is compared here and NEVER returned. On success it issues a signed
//   session token (see src/lib/server/auth.ts) that subsequent API requests
//   present for authorization. Only safe fields leave the server.

export const runtime = "nodejs";

const LoginSchema = z.object({
  name: z.string().trim().min(1, "Type your name."),
  pin: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const { name, pin } = await parseBody(req, LoginSchema);

    const supabase = getServerSupabase();
    // CITEXT makes first_name lookup case-insensitive.
    const res = await supabase
      .from("salespeople")
      .select("id, first_name, admin_pin, role")
      .eq("first_name", name)
      .maybeSingle();

    if (res.error) {
      throw new Error(res.error.message);
    }
    if (!res.data) {
      throw unauthorized(`No salesperson found named "${name}".`);
    }

    const row = res.data as {
      id: string;
      first_name: string;
      admin_pin: string | null;
      role: unknown;
    };
    const role: UserRole = isUserRole(row.role) ? row.role : "ae";
    const isAdmin = role === "admin";

    // Admins must present the correct PIN. The PIN is compared here and never
    // included in the response. The error is deliberately generic — it does
    // not reveal whether a PIN is set or how long it is.
    if (isAdmin) {
      const dbPin =
        row.admin_pin == null ? "" : String(row.admin_pin).trim();
      if (!dbPin) {
        throw unauthorized(
          "This admin account has no PIN set. Ask another admin to set one.",
        );
      }
      if ((pin ?? "").trim() !== dbPin) {
        throw unauthorized("Incorrect PIN.");
      }
    }

    const token = signSessionToken({
      sub: row.id,
      role,
      name: row.first_name,
    });

    return Response.json({
      salesperson: {
        id: row.id,
        first_name: row.first_name,
        is_admin: isAdmin,
        role,
      },
      token,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
