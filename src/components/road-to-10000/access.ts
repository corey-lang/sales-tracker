import type { UserRole } from "@/lib/permissions";

// Who is SHOWN a way into Road to 10,000 (chrome only — GET /api/road-to-10000
// re-checks every request via requireAeToolAccess, and the Update control is
// driven by the server's `can_update`, never by this).
//
// Everyone with the AE tool surface — AEs, admins (Corey, Ryan) and the assistant
// (Tonja) — gets the link. juice_box_only guests are excluded, exactly as the
// page and the API exclude them.
export function canOpenRoadToTenThousand(role: UserRole | null | undefined): boolean {
  return role === "ae" || role === "admin" || role === "assistant";
}
