import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireReviewer } from "@/lib/server/auth";

// Build 4 + Build 6: CRM CSV export of verified business card contacts.
// GET /api/business-card/contacts/export
//
// Query params (all optional):
//   - salespersonId      export only this AE's contacts (matched by id)
//   - salespersonName    export only this AE's contacts (used when no id)
//   - includeExported    "true" re-exports already-exported contacts too
//   - exportedBy         label stored on the batch / contacts (who ran it)
//
// Exports only CRM-ready contacts — verification_status of 'auto_approved'
// or 'approved'. Rejected scans, duplicates, and needs_review items are
// intentionally excluded. By default already-exported contacts are skipped.
//
// Exporting is a "mark as exported" action, NOT a delete: after a successful
// CSV with at least one row, the exported contacts are stamped with
// exported_at / export_batch_id / exported_by, and a row is written to
// business_card_export_batches. Contacts, scans, and images are kept forever.
// This route never reads, modifies, or deletes scans or business card images.

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
  "exported_at",
  "export_batch_id",
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

/** Slug-safe fragment for the download filename. */
function fileSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "ae"
  );
}

export async function GET(req: Request) {
  // AUTHORIZATION (Phase 0): contact export is restricted to reviewers
  // (admin or assistant). The export-batch audit records the authenticated
  // reviewer — `exportedBy` is no longer accepted from a query param.
  let reviewer;
  try {
    reviewer = await requireReviewer(req);
  } catch (err) {
    return handleApiError(err);
  }

  const supabase = getServerSupabase();
  const url = new URL(req.url);

  const salespersonId =
    url.searchParams.get("salespersonId")?.trim() || null;
  const salespersonName =
    url.searchParams.get("salespersonName")?.trim() || null;
  const includeExported =
    url.searchParams.get("includeExported")?.trim() === "true";
  const exportedBy = reviewer.first_name;

  // `id` is selected for the post-export marking step; it is not a CSV column.
  let query = supabase
    .from("business_card_contacts")
    .select(["id", ...COLUMNS].join(", "))
    .in("verification_status", ["auto_approved", "approved"])
    .order("created_at", { ascending: false });

  if (salespersonId) {
    query = query.eq("salesperson_id", salespersonId);
  } else if (salespersonName) {
    query = query.eq("salesperson_name", salespersonName);
  }

  // Default: skip contacts already exported. includeExported=true re-exports
  // everything but (below) leaves the original exported_at values untouched.
  if (!includeExported) {
    query = query.is("exported_at", null);
  }

  const res = await query;
  if (res.error) {
    return Response.json({ error: res.error.message }, { status: 500 });
  }

  const rows = (res.data ?? []) as unknown as Record<string, unknown>[];

  // Mark contacts as exported only for a real, fresh export: at least one row,
  // and not a re-export (includeExported must not overwrite old export stamps).
  if (rows.length > 0 && !includeExported) {
    const ids = rows.map((row) => String(row.id));

    // Resolve the batch's AE identity from the params, falling back to the
    // first row when only one side was supplied.
    let batchSalespersonId = salespersonId;
    let batchSalespersonName = salespersonName;
    const firstRow = rows[0];
    if (!batchSalespersonId && (salespersonName || salespersonId)) {
      const fromRow = firstRow.salesperson_id;
      batchSalespersonId = typeof fromRow === "string" ? fromRow : null;
    }
    if (!batchSalespersonName && (salespersonName || salespersonId)) {
      const fromRow = firstRow.salesperson_name;
      batchSalespersonName = typeof fromRow === "string" ? fromRow : null;
    }

    const batchRes = await supabase
      .from("business_card_export_batches")
      .insert({
        salesperson_id: batchSalespersonId,
        salesperson_name: batchSalespersonName,
        contact_count: rows.length,
        exported_by: exportedBy,
      })
      .select("id")
      .single();

    if (batchRes.error || !batchRes.data) {
      return Response.json(
        {
          error: `Failed to record export batch: ${
            batchRes.error?.message ?? "no row returned"
          }`,
        },
        { status: 500 },
      );
    }

    const batchId = String(batchRes.data.id);

    // Stamp the contacts. The `.is("exported_at", null)` guard makes this a
    // no-op for any contact exported by a concurrent run — never an overwrite.
    const markRes = await supabase
      .from("business_card_contacts")
      .update({
        exported_at: new Date().toISOString(),
        export_batch_id: batchId,
        exported_by: exportedBy,
      })
      .in("id", ids)
      .is("exported_at", null);

    if (markRes.error) {
      return Response.json(
        { error: `Failed to mark contacts exported: ${markRes.error.message}` },
        { status: 500 },
      );
    }
  }

  const lines = [
    COLUMNS.join(","),
    ...rows.map((row) => COLUMNS.map((col) => csvCell(row[col])).join(",")),
  ];
  const csv = lines.join("\r\n");

  const namePart = salespersonName
    ? `-${fileSlug(salespersonName)}`
    : salespersonId
      ? `-${fileSlug(salespersonId)}`
      : "";
  const filename = `business-card-contacts${namePart}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
