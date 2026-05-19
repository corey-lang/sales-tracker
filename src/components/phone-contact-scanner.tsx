"use client";

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";

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
// directly (no intermediate modal); this panel receives the chosen file and
// drives it through: upload -> create scan row -> WAIT for AI extraction ->
// AE reviews/edits the fields -> save AE-owned contact -> hand off a vCard to
// the phone. Picking another card re-taps the dashboard action, which bumps
// `fileKey` and restarts this panel with the new card. The admin/Tonja review
// flow is untouched. (Feature is gated to the test account — see the dashboard
// and the /api/business-card/ae-contact + /vcard routes.)

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

/** Workflow stages for one card. */
type Stage = "working" | "review" | "saved" | "failed";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Reads a string field off the AI extraction payload, defaulting to "". */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Maps an AI extraction payload to the editable form fields. */
function fieldsFromExtraction(payload: Record<string, unknown>): ContactFields {
  return {
    firstName: str(payload.extracted_first_name),
    lastName: str(payload.extracted_last_name),
    fullName: str(payload.extracted_full_name),
    company: str(payload.extracted_company),
    title: str(payload.extracted_title),
    phone: str(payload.extracted_phone),
    email: str(payload.extracted_email),
    website: str(payload.extracted_website),
    address: str(payload.extracted_address),
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
  const [extractionFailed, setExtractionFailed] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateField = (key: keyof ContactFields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Upload -> create scan row -> run AI extraction. The scan + image are saved
   * regardless of whether extraction succeeds; on extraction failure the AE
   * just fills the review form in by hand. An upload / scan-row failure has no
   * scan to review, so it lands on the "failed" stage to retry from scratch.
   */
  const handleFile = async (picked: File) => {
    // Reset all per-card state — handles a re-tap restarting the panel.
    setErrorMessage(null);
    setScanId(null);
    setFields(EMPTY_FIELDS);
    setExtractionFailed(false);
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
    try {
      const res = await apiFetch("/api/business-card/process", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ scanId: newScanId }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { extraction?: Record<string, unknown> }
        | null;
      if (res.ok && payload?.extraction) {
        setFields(fieldsFromExtraction(payload.extraction));
        setExtractionFailed(false);
      } else {
        // Extraction failed — the scan is still saved; enter details manually.
        setFields(EMPTY_FIELDS);
        setExtractionFailed(true);
      }
    } catch {
      setFields(EMPTY_FIELDS);
      setExtractionFailed(true);
    }
    setStage("review");
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
              : "Reading the card with AI…"}
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
        {/* ---- Stage: working (upload + AI extraction) ----------------- */}
        {stage === "working" && (
          <p
            role="status"
            className="rounded-lg border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground"
          >
            Saving the card and reading it with AI…
          </p>
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
              className="w-full"
              onClick={onClose}
            >
              Close
            </Button>
          </>
        )}

        {/* ---- Stage: review ------------------------------------------- */}
        {stage === "review" && (
          <>
            {extractionFailed && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                AI couldn&apos;t read this card. The scan was still saved —
                enter the contact details below.
              </p>
            )}

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
              className="w-full"
              onClick={handleAddToPhone}
              disabled={saving}
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
            <Button type="button" className="w-full" onClick={onScanAnother}>
              Scan Another Contact
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
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
