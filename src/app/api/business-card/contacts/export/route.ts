import { getServerSupabase } from "@/lib/supabase/server";

// Build 4: CRM CSV export of verified business card contacts.
// GET /api/business-card/contacts/export
//
// Exports only contacts that are CRM-ready — verification_status of
// 'auto_approved' or 'approved'. Rejected scans, duplicates, and
// needs_review items are intentionally excluded. This reads from
// business_card_contacts only; it never reads, modifies, or deletes scans
// or business card images.

export const runtime = "nodejs";

/** CSV columns, in export order. Mirrors business_card_contacts column order. */
const COLUMNS = [
  "salesperson_name",
  "salesperson_id",
  "contact_bucket",
  "contact_type_raw",
  "full_name",
  "first_name",
  "last_name",
  "company",
  "title",
  "email",
  "phone",
  "website",
  "address",
  "image_url",
  "scan_id",
  "verification_status",
  "duplicate_status",
  "approved_by",
  "approved_at",
  "created_at",
] as const;

/** Quotes a CSV cell, escaping commas, quotes, and newlines per RFC 4180. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET() {
  const supabase = getServerSupabase();

  const res = await supabase
    .from("business_card_contacts")
    .select(COLUMNS.join(", "))
    .in("verification_status", ["auto_approved", "approved"])
    .order("created_at", { ascending: false });

  if (res.error) {
    return Response.json({ error: res.error.message }, { status: 500 });
  }

  const rows = (res.data ?? []) as unknown as Record<string, unknown>[];

  const lines = [
    COLUMNS.join(","),
    ...rows.map((row) => COLUMNS.map((col) => csvCell(row[col])).join(",")),
  ];
  const csv = lines.join("\r\n");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="business-card-contacts.csv"',
      "Cache-Control": "no-store",
    },
  });
}
