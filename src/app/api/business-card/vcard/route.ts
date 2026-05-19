import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  forbidden,
  handleApiError,
  parseBody,
  requireSalesperson,
} from "@/lib/server/auth";

// "Scan & Add to Phone Contacts" — vCard (.vcf) generation.
// POST /api/business-card/vcard
//   body: { contactId?: string, contact: { firstName, lastName, ... notes } }
//   200:  a text/vcard file (Content-Disposition: attachment)
//
// Returns a vCard 3.0 file built from the AE-verified contact fields. The
// mobile browser opens/imports it into the native Contacts app.
//
// If `contactId` is supplied and the caller owns that contact (or is a
// reviewer), phone_contact_exported_at is stamped on it — recording that the
// AE pushed it to their phone. A missing/foreign contactId is non-fatal: the
// vCard is still generated from the body fields.
//
// AUTHORIZATION
//   requireSalesperson() — any signed-in salesperson.
//
// TEMPORARY GATE — limited live testing before rollout.
//   The phone-contact feature is gated to the test account for now: this
//   route also rejects any caller whose me.is_test is false. Remove this
//   check when the feature ships broadly.

export const runtime = "nodejs";

const ContactSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  fullName: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  website: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

const VCardSchema = z.object({
  contactId: z.string().optional(),
  contact: ContactSchema,
});

/** Trims a value to a non-empty string, or null. */
function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Escapes a value for a vCard text field per RFC 6350: backslash, newline,
 * comma and semicolon are escaped. Used for every component value.
 */
function esc(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** A filesystem-safe slug for the .vcf download filename. */
function fileSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "contact"
  );
}

export async function POST(req: Request) {
  try {
    const me = await requireSalesperson(req);

    // TEMPORARY — phone-contact feature is in limited testing. Only the test
    // account may use it; remove this gate at full rollout.
    if (!me.is_test) {
      throw forbidden("The Add to Phone Contacts feature is still in testing.");
    }

    const { contactId, contact } = await parseBody(req, VCardSchema);

    const firstName = clean(contact.firstName);
    const lastName = clean(contact.lastName);
    const company = clean(contact.company);
    const title = clean(contact.title);
    const phone = clean(contact.phone);
    const email = clean(contact.email);
    const website = clean(contact.website);
    const address = clean(contact.address);
    const notes = clean(contact.notes);

    // FN (formatted name) is required by the spec. Fall back through the
    // available identity fields so the card always has a usable label.
    const displayName =
      clean(contact.fullName) ??
      clean([firstName, lastName].filter(Boolean).join(" ")) ??
      company ??
      email ??
      "New Contact";

    // vCard 3.0 — broadly supported by iOS and Android Contacts.
    const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];
    // N: Family;Given;Additional;Prefix;Suffix
    lines.push(`N:${esc(lastName ?? "")};${esc(firstName ?? "")};;;`);
    lines.push(`FN:${esc(displayName)}`);
    if (company) lines.push(`ORG:${esc(company)}`);
    if (title) lines.push(`TITLE:${esc(title)}`);
    if (phone) lines.push(`TEL;TYPE=CELL:${esc(phone)}`);
    if (email) lines.push(`EMAIL;TYPE=INTERNET:${esc(email)}`);
    if (website) lines.push(`URL:${esc(website)}`);
    // ADR: PO;Extended;Street;Locality;Region;Postal;Country — the full
    // address goes in the Street component as a single line.
    if (address) lines.push(`ADR;TYPE=WORK:;;${esc(address)};;;;`);
    if (notes) lines.push(`NOTE:${esc(notes)}`);
    lines.push("END:VCARD");
    // vCard requires CRLF line endings.
    const vcf = lines.join("\r\n") + "\r\n";

    // Record the phone export when we can attribute it to a contact the caller
    // owns. Non-fatal — a stamping failure must not break the download.
    if (contactId) {
      const isReviewer = me.role === "admin" || me.role === "assistant";
      const ownRes = await getServerSupabase()
        .from("business_card_contacts")
        .select("id, salesperson_id")
        .eq("id", contactId)
        .maybeSingle();
      if (
        !ownRes.error &&
        ownRes.data &&
        (isReviewer || ownRes.data.salesperson_id === me.id)
      ) {
        await getServerSupabase()
          .from("business_card_contacts")
          .update({ phone_contact_exported_at: new Date().toISOString() })
          .eq("id", contactId);
      }
    }

    const filename = `${fileSlug(displayName)}.vcf`;

    return new Response(vcf, {
      status: 200,
      headers: {
        // text/vcard is the RFC 6350 type; mobile browsers open it in Contacts.
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
