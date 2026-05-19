"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { BUSINESS_CARD_BUCKET, sanitizeFilename } from "@/lib/supabase/storage";
import type { StoredSalesperson } from "@/lib/use-salesperson";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// "Scan Card & Save Contact" — the AE-facing phone-contact flow.
//
// The dashboard's "Scan Card & Save Contact" action opens the native picker
// directly; this panel receives the chosen file and drives a focused
// review-and-save workflow: upload -> create scan row -> WAIT for AI
// extraction -> AE reviews/edits the fields -> save AE-owned contact -> hand
// off a vCard to the phone. The dashboard renders this panel in a focused
// mode (the rest of the dashboard is hidden) so the AE knows this is now a
// dedicated contact-save workflow. The admin/Tonja review flow is untouched.
// (Feature is gated to the test account — see the dashboard and the
// /api/business-card/ae-contact + /vcard routes.)

type Props = {
  salesperson: StoredSalesperson;
  /** The image the AE picked from the dashboard's native file picker. */
  file: File;
  /** Bumps for every new pick — restarts the panel even for the same File. */
  fileKey: number;
  /**
   * Re-opens the dashboard's camera input directly — powers "Scan Another
   * Contact" so the AE can scan the next card without returning to the
   * dashboard.
   */
  onScanAnother: () => void;
  /** Closes the panel — the dashboard owns the open/closed state. */
  onClose: () => void;
};

/** The editable contact fields shown on the review screen. */
type ContactFields = {
  firstName: string;
  lastName: string;
  fullName: string;
  company: string;
  title: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  notes: string;
};

const EMPTY_FIELDS: ContactFields = {
  firstName: "",
  lastName: "",
  fullName: "",
  company: "",
  title: "",
  phone: "",
  email: "",
  website: "",
  address: "",
  notes: "",
};

/**
 * Workflow stages for one card.
 *  - working        upload + AI extraction in progress
 *  - extract_failed AI couldn't read the card (scan IS saved — retry possible)
 *  - review         editable fields, ready to save to phone
 *  - saved          contact saved + vCard handed to the phone
 *  - failed         upload / scan-row failure (no scan to review)
 */
type Stage = "working" | "extract_failed" | "review" | "saved" | "failed";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Reads a string field off the AI extraction payload, defaulting to "". */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Acronyms / industry + brand terms kept UPPERCASE even when 4+ letters long
 * (so they survive the title-casing below). Shorter terms like LLC, INC, HOA,
 * USA, MLS, KW, EXP are also preserved by the <=3-letter rule, but are listed
 * here too so the intent is explicit in one place. Compared case-insensitively.
 */
const PRESERVED_UPPERCASE = new Set([
  "LLC",
  "PLLC",
  "INC",
  "CORP",
  "REALTOR",
  "REALTORS",
  "HOA",
  "NASA",
  "USA",
  "MLS",
  "NMLS",
  "RE/MAX",
  "KW",
  "EXP",
  "AT&T",
]);

/**
 * Normalizes an ALL-CAPS name/company/title value to Title Case for display.
 *
 * AI/OCR often returns these fields shouting (e.g. "MIRAN WIETECHA",
 * "ESCROW ASSISTANT", "AUSTIN TITLE"). This converts them to "Miran Wietecha"
 * etc. before the review form renders. It deliberately leaves alone:
 *  - any value that already contains a lowercase letter (intentional casing);
 *  - values with no 4+ letter word, so pure short acronyms (IBM) are untouched;
 *  - short tokens (<=3 letters) inside a value — likely acronyms (LLC, TX);
 *  - tokens with slash / ampersand brand formatting (RE/MAX, AT&T);
 *  - 4+ letter acronyms in {@link PRESERVED_UPPERCASE} (NASA, REALTORS, …).
 * Apply only to name-like fields — never to emails or URLs.
 */
function normalizeCaps(value: string): string {
  if (!value) return value;
  // Already has lowercase → assume the casing is intentional, leave it.
  if (value !== value.toUpperCase()) return value;
  // No real word (4+ letters) → likely a pure acronym; leave it.
  if (!/[A-Z]{4,}/.test(value)) return value;
  return value.replace(/\S+/g, (token) => {
    const letterCount = (token.match(/[A-Za-z]/g) ?? []).length;
    // Keep short tokens as-is (LLC, INC, HOA, TX, &, numbers).
    if (letterCount <= 3) return token;
    // Slash / ampersand brand formatting is kept verbatim (RE/MAX, AT&T).
    if (token.includes("/") || token.includes("&")) return token;
    // Title-case each alphabetic run — but keep whitelisted acronyms in caps.
    // Handles hyphens / underscores / apostrophes: "WIETECHA-SMITH" ->
    // "Wietecha-Smith", "O'BRIEN" -> "O'Brien", "HOA_BOARD" -> "HOA_Board".
    return token.replace(/[A-Za-z]+/g, (run) =>
      PRESERVED_UPPERCASE.has(run.toUpperCase())
        ? run.toUpperCase()
        : run.charAt(0).toUpperCase() + run.slice(1).toLowerCase(),
    );
  });
}

/** Maps an AI extraction payload to the editable form fields. */
function fieldsFromExtraction(payload: Record<string, unknown>): ContactFields {
  return {
    // Name-like fields are de-shouted before display; email / website / phone
    // are copied verbatim (casing there is significant).
    firstName: normalizeCaps(str(payload.extracted_first_name)),
    lastName: normalizeCaps(str(payload.extracted_last_name)),
    fullName: normalizeCaps(str(payload.extracted_full_name)),
    company: normalizeCaps(str(payload.extracted_company)),
    title: normalizeCaps(str(payload.extracted_title)),
    phone: str(payload.extracted_phone),
    email: str(payload.extracted_email),
    website: str(payload.extracted_website),
    address: normalizeCaps(str(payload.extracted_address)),
    notes: "",
  };
}

/** Filename slug for the downloaded .vcf. */
function vcardSlug(fields: ContactFields): string {
  const name =
    fields.fullName.trim() ||
    [fields.firstName, fields.lastName].filter(Boolean).join(" ").trim() ||
    fields.company.trim() ||
    "contact";
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "contact"
  );
}

export function PhoneContactScanner({
  salesperson,
  file,
  fileKey,
  onScanAnother,
  onClose,
}: Props) {
  const [stage, setStage] = useState<Stage>("working");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [fields, setFields] = useState<ContactFields>(EMPTY_FIELDS);
  /** True when the AE chose to type the contact in by hand after a failed read. */
  const [manualEntry, setManualEntry] = useState(false);
  /** Consecutive AI-extraction failures for the current card. */
  const [extractionFailures, setExtractionFailures] = useState(0);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateField = (key: keyof ContactFields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Runs AI extraction for an already-saved scan. On success, populates the
   * review form; on failure, counts the attempt and shows the retry screen.
   * Used both for the first read and for "Try Again".
   */
  const runExtraction = async (id: string) => {
    setErrorMessage(null);
    setStage("working");
    try {
      const res = await apiFetch("/api/business-card/process", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ scanId: id }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { extraction?: Record<string, unknown> }
        | null;
      if (res.ok && payload?.extraction) {
        setFields(fieldsFromExtraction(payload.extraction));
        setManualEntry(false);
        setExtractionFailures(0);
        setStage("review");
        return;
      }
    } catch {
      // fall through to the failure handling below
    }
    // Extraction failed — the scan + image are still saved. Offer a retry.
    setExtractionFailures((n) => n + 1);
    setStage("extract_failed");
  };

  /**
   * Upload -> create scan row -> run AI extraction. The scan + image are saved
   * regardless of whether extraction succeeds. An upload / scan-row failure
   * has no scan to review, so it lands on the "failed" stage.
   */
  const handleFile = async (picked: File) => {
    // Reset all per-card state — handles a re-tap restarting the panel.
    setErrorMessage(null);
    setScanId(null);
    setFields(EMPTY_FIELDS);
    setManualEntry(false);
    setExtractionFailures(0);
    setDuplicateWarning(null);
    setSaving(false);
    setStage("working");

    const path = `${salesperson.id}/${Date.now()}-${sanitizeFilename(picked.name)}`;
    const upload = await supabase.storage
      .from(BUSINESS_CARD_BUCKET)
      .upload(path, picked, {
        contentType: picked.type || "image/jpeg",
        upsert: false,
      });
    if (upload.error) {
      setErrorMessage(`Upload failed: ${upload.error.message}`);
      setStage("failed");
      return;
    }

    const { data: publicUrl } = supabase.storage
      .from(BUSINESS_CARD_BUCKET)
      .getPublicUrl(upload.data.path);

    // Create the business_card_scans row via the service-role route — same
    // intake the admin scanner uses (saves salesperson, image_url, storage_path).
    let newScanId: string;
    try {
      const res = await apiFetch("/api/business-card/scan", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          imageUrl: publicUrl.publicUrl,
          storagePath: upload.data.path,
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { scanId?: string; error?: string }
        | null;
      if (!res.ok || !payload?.scanId) {
        setErrorMessage(
          `Save failed: ${payload?.error ?? `server returned ${res.status}`}`,
        );
        setStage("failed");
        return;
      }
      newScanId = payload.scanId;
    } catch (err) {
      setErrorMessage(
        `Save failed: ${err instanceof Error ? err.message : "network error"}`,
      );
      setStage("failed");
      return;
    }
    setScanId(newScanId);

    // Run AI extraction and WAIT for it — the AE needs the fields to review.
    await runExtraction(newScanId);
  };

  // Process the picked image. `fileKey` changes on every dashboard pick (even
  // when the same File is re-selected), so this runs exactly once per pick.
  // Only `fileKey` belongs in the deps: `file` and `handleFile` are
  // intentionally excluded so a re-render never re-processes the card.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void handleFile(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  /** "Try Again" — re-runs AI extraction on the same saved scan. */
  const handleRetry = () => {
    if (!scanId) return;
    void runExtraction(scanId);
  };

  /** "Enter Manually" — skip AI and fill the review form in by hand. */
  const enterManually = () => {
    setFields(EMPTY_FIELDS);
    setManualEntry(true);
    setErrorMessage(null);
    setStage("review");
  };

  /** Generates the vCard and triggers the mobile download/import. */
  const downloadVCard = async (id: string | null) => {
    const res = await apiFetch("/api/business-card/vcard", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ contactId: id, contact: fields }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(payload?.error ?? `vCard request failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${vcardSlug(fields)}.vcf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke later so the browser has time to start the download/import.
    window.setTimeout(() => URL.revokeObjectURL(url), 15000);
  };

  /** Saves the AE contact, then hands off the vCard to the phone. */
  const handleAddToPhone = async () => {
    if (!scanId) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      const res = await apiFetch("/api/business-card/ae-contact", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ scanId, contact: fields }),
      });
      const payload = (await res.json().catch(() => null)) as
        | {
            contactId?: string;
            duplicate?: { reason?: string } | null;
            error?: string;
          }
        | null;
      if (!res.ok || !payload?.contactId) {
        setErrorMessage(
          `Couldn't save: ${payload?.error ?? `server returned ${res.status}`}`,
        );
        return;
      }
      setDuplicateWarning(payload.duplicate?.reason ?? null);
      await downloadVCard(payload.contactId);
      setStage("saved");
    } catch (err) {
      setErrorMessage(
        `Couldn't save: ${err instanceof Error ? err.message : "network error"}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const errorBanner = errorMessage && (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {errorMessage}
    </p>
  );

  /** First failure leads with "Try Again"; a repeat leads with "Enter Manually". */
  const firstFailure = extractionFailures <= 1;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">
          {stage === "review"
            ? "Review Contact"
            : stage === "saved"
              ? "Saved to phone"
              : "Scan Card & Save Contact"}
        </CardTitle>
        <CardDescription>
          {stage === "review"
            ? "Edit anything AI missed, then add it to your phone."
            : stage === "saved"
              ? "Saved to app + ready for phone."
              : stage === "working"
                ? "Getting this card ready to review."
                : "Scan a business card to save it to your phone."}
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* ---- Stage: working (preparing the contact) ------------------ */}
        {stage === "working" && (
          <div
            role="status"
            className="flex flex-col items-center gap-2 rounded-lg border bg-muted/30 px-4 py-10 text-center"
          >
            <p className="text-base font-semibold text-foreground">
              Preparing contact details…
            </p>
            <p className="text-sm text-muted-foreground">
              This usually takes just a few seconds.
            </p>
            <p className="mt-3 flex items-center gap-1 text-xs font-medium text-primary">
              <ChevronDown aria-hidden="true" className="size-3.5" />
              Review and save contact next
            </p>
          </div>
        )}

        {/* ---- Stage: extract_failed (AI couldn't read the card) ------- */}
        {stage === "extract_failed" && (
          <div className="space-y-2.5 text-center">
            <p className="text-base font-semibold text-foreground">
              {firstFailure
                ? "We couldn't read this card clearly."
                : "Still having trouble reading this card."}
            </p>
            <p className="text-sm text-muted-foreground">
              {firstFailure
                ? "Give it another try, or enter the details yourself."
                : "Entering the details yourself is the quickest way from here."}
            </p>

            {errorBanner}

            {/* First failure leads with Try Again; a repeat leads with
                Enter Manually. The other action stays as the secondary. */}
            {firstFailure ? (
              <>
                <Button
                  type="button"
                  onClick={handleRetry}
                  className="h-14 w-full text-base font-semibold"
                >
                  Try Again
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={enterManually}
                  className="h-12 w-full"
                >
                  Enter Manually
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  onClick={enterManually}
                  className="h-14 w-full text-base font-semibold"
                >
                  Enter Manually
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleRetry}
                  className="h-12 w-full"
                >
                  Try Again
                </Button>
              </>
            )}
          </div>
        )}

        {/* ---- Stage: failed (upload / save error) --------------------- */}
        {stage === "failed" && (
          <>
            {errorBanner}
            <p className="text-sm text-muted-foreground">
              Tap “Scan Card &amp; Save Contact” again to retry.
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-12 w-full"
              onClick={onClose}
            >
              Close
            </Button>
          </>
        )}

        {/* ---- Stage: review ------------------------------------------- */}
        {stage === "review" && (
          <>
            {/* Primary CTA — visible immediately, no scrolling needed. */}
            <Button
              type="button"
              onClick={handleAddToPhone}
              disabled={saving}
              className="h-14 w-full text-base font-semibold"
            >
              {saving ? "Saving…" : "Add to Phone Contacts"}
            </Button>
            {/* iPhones open a contact preview but still need an explicit save. */}
            <p className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
              On iPhone: tap “Create New Contact”, then tap “Done” to save.
            </p>
            <p className="text-xs text-muted-foreground">
              {manualEntry
                ? "Enter the contact details below, then save."
                : "Editing below is optional — fix anything AI got wrong, then save."}
            </p>

            <div className="grid grid-cols-2 gap-2">
              <FieldInput
                label="First name"
                value={fields.firstName}
                onChange={(v) => updateField("firstName", v)}
              />
              <FieldInput
                label="Last name"
                value={fields.lastName}
                onChange={(v) => updateField("lastName", v)}
              />
            </div>
            <FieldInput
              label="Full name"
              value={fields.fullName}
              onChange={(v) => updateField("fullName", v)}
            />
            <FieldInput
              label="Company"
              value={fields.company}
              onChange={(v) => updateField("company", v)}
            />
            <FieldInput
              label="Title"
              value={fields.title}
              onChange={(v) => updateField("title", v)}
            />
            <FieldInput
              label="Phone"
              type="tel"
              value={fields.phone}
              onChange={(v) => updateField("phone", v)}
            />
            <FieldInput
              label="Email"
              type="email"
              value={fields.email}
              onChange={(v) => updateField("email", v)}
            />
            <FieldInput
              label="Website"
              type="url"
              value={fields.website}
              onChange={(v) => updateField("website", v)}
            />
            <FieldTextarea
              label="Address"
              value={fields.address}
              rows={2}
              onChange={(v) => updateField("address", v)}
            />
            <FieldTextarea
              label="Notes"
              value={fields.notes}
              rows={2}
              onChange={(v) => updateField("notes", v)}
            />

            {errorBanner}

            <Button
              type="button"
              onClick={handleAddToPhone}
              disabled={saving}
              className="h-12 w-full"
            >
              {saving ? "Saving…" : "Add to Phone Contacts"}
            </Button>
          </>
        )}

        {/* ---- Stage: saved -------------------------------------------- */}
        {stage === "saved" && (
          <>
            <div className="flex items-start gap-2 rounded-lg border border-emerald-600/40 bg-emerald-600/10 px-3 py-2.5">
              <Check
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-400"
              />
              <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                Saved to app + ready for phone. Your phone should prompt you to
                create the contact.
              </p>
            </div>

            {duplicateWarning && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                Heads up — this looks like a possible duplicate ({duplicateWarning}
                ). It was saved anyway.
              </p>
            )}

            {errorBanner}

            {/* Re-opens the camera directly for the next card. */}
            <Button
              type="button"
              className="h-14 w-full text-base font-semibold"
              onClick={onScanAnother}
            >
              Scan Another Contact
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-12 w-full"
              onClick={onClose}
            >
              Done
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A labeled single-line input for the review form. */
function FieldInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** A labeled multi-line input for the review form (address / notes). */
function FieldTextarea({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
      />
    </label>
  );
}
