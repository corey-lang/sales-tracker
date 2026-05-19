import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, parseBody, requireAdmin } from "@/lib/server/auth";
import {
  normalizeEmail,
  normalizePhone,
} from "@/lib/server/business-card-contacts";

// Admin edit of a business card scan's extracted contact fields.
// POST /api/business-card/update-scan
//   body: { scanId: string, fields: { first_name?, last_name?, ... } }
//   200:  { ok: true, scanId }
//
// Lets an admin correct what AI extracted BEFORE the scan is approved into a
// contact — the review-queue "Edit" action in the Verification Center. Approve
// then copies these (corrected) extracted_* values onto the new contact.
//
// AUTHORIZATION
//   requireAdmin() — only admins may edit extracted contact fields. The
//   assistant can still approve/reject/mark-duplicate, but not edit.
//
// Editing is rejected once the scan already has a verified contact: at that
// point edits here would not propagate to the contact row.

export const runtime = "nodejs";

/** Editable extracted fields. All optional; omitted/blank clears the column. */
const FieldsSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  full_name: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  address: z.string().optional(),
  // Free-text contact type; the bucket (Real Estate Agent / Title / Other) is
  // derived from it elsewhere via normalizeScanContactType.
  contact_type: z.string().optional(),
});

const UpdateScanSchema = z.object({
  scanId: z.string().min(1, "scanId is required."),
  fields: FieldsSchema,
});

/** Trims a value to a non-empty string, or null (an explicit clear). */
function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export async function POST(req: Request) {
  try {
    await requireAdmin(req);
    const { scanId, fields } = await parseBody(req, UpdateScanSchema);

    const supabase = getServerSupabase();

    const scanRes = await supabase
      .from("business_card_scans")
      .select("id, verified_contact_id")
      .eq("id", scanId)
      .maybeSingle();
    if (scanRes.error) {
      return Response.json({ error: scanRes.error.message }, { status: 500 });
    }
    if (!scanRes.data) {
      return Response.json({ error: "Scan not found." }, { status: 404 });
    }
    if (scanRes.data.verified_contact_id) {
      return Response.json(
        {
          error:
            "This scan has already been approved into a contact and can no longer be edited here.",
        },
        { status: 409 },
      );
    }

    const email = clean(fields.email);
    const phone = clean(fields.phone);

    const upd = await supabase
      .from("business_card_scans")
      .update({
        extracted_first_name: clean(fields.first_name),
        extracted_last_name: clean(fields.last_name),
        extracted_full_name: clean(fields.full_name),
        extracted_company: clean(fields.company),
        extracted_title: clean(fields.title),
        extracted_email: email,
        extracted_phone: phone,
        extracted_website: clean(fields.website),
        extracted_address: clean(fields.address),
        extracted_contact_type: clean(fields.contact_type),
        // Keep the normalized columns in sync so duplicate detection compares
        // against the admin-corrected values.
        normalized_email: normalizeEmail(email),
        normalized_phone: normalizePhone(phone),
      })
      .eq("id", scanId)
      .select("id")
      .single();

    if (upd.error || !upd.data) {
      return Response.json(
        { error: upd.error?.message ?? "Failed to update scan." },
        { status: 500 },
      );
    }

    return Response.json({ ok: true, scanId });
  } catch (err) {
    return handleApiError(err);
  }
}
