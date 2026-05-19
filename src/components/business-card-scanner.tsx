"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/** Lifecycle state for a single card the AE captured this session. */
type RecentStatus =
  | "uploading" // optimistic — image still uploading / scan row still saving
  | "saved" // scan row created
  | "reading" // AI extraction running
  | "complete" // AI extraction done
  | "failed" // AI extraction failed (scan exists — Tonja can retry)
  | "upload_failed"; // upload / scan-row insert failed (no scan was created)

/** A card captured this session, tracked while it processes in the background. */
type RecentUpload = {
  /** Client-generated id — stable for the whole lifecycle, before scanId exists. */
  id: string;
  /** The server scan id, once the scan row has been created. */
  scanId: string | null;
  fileName: string;
  status: RecentStatus;
};

/** Badge label + styling for each lifecycle state in the recent list. */
const RECENT_STATUS_META: Record<
  RecentStatus,
  { label: string; className: string }
> = {
  uploading: {
    label: "Saving…",
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  saved: {
    label: "Card saved",
    className:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  reading: {
    label: "AI reading…",
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  complete: {
    label: "AI complete",
    className:
      "border-emerald-600/50 bg-emerald-600/15 text-emerald-800 dark:text-emerald-300",
  },
  failed: {
    label: "AI failed — Tonja can retry",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  upload_failed: {
    label: "Upload failed — recapture",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
};

type Props = {
  salesperson: StoredSalesperson;
  /** The image the AE picked from the dashboard's native file picker. */
  file: File;
  /**
   * Bumps for every new pick. The dashboard opens the native picker directly
   * and increments this on each selection, so processing re-fires even when
   * the AE picks the same File twice.
   */
  fileKey: number;
  /**
   * Re-opens the dashboard's camera input directly — powers "Capture Another
   * Card" so the AE can batch-scan without returning to the dashboard.
   */
  onScanAnother: () => void;
  /** Closes the scan panel — the dashboard owns the open/closed state. */
  onClose: () => void;
};

// "Send Card to Admin" flow. The dashboard's "Scan Business Card" action opens
// the native picker directly (no intermediate modal); this panel receives the
// chosen file and processes it: upload image -> save business_card_scans row
// -> background AI extraction. Scanning another card re-taps the dashboard
// action, which bumps `fileKey` so the next card joins the same running list.
//
// RAPID-SCAN UX: the post-capture state ("Card Captured" + the next-action
// buttons) appears OPTIMISTICALLY the instant a photo is selected — it never
// waits on the upload, the scan API, the DB insert, or AI extraction. Those
// all run in the background and only update the secondary per-card status list.
//
// The seeded Test account uses this flow too; the only difference is
// `is_test_data`, which the /api/business-card/scan route derives server-side.
// This writes ONLY to business_card_scans + the storage bucket — it never
// produces leaderboard or metric data.
export function BusinessCardScanner(props: Props) {
  return <ActiveScanner {...props} />;
}

function ActiveScanner({
  salesperson,
  file,
  fileKey,
  onScanAnother,
  onClose,
}: Props) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentUpload[]>([]);
  // Monotonic source of stable client ids — assigned before a scan id exists.
  const localIdRef = useRef(0);

  /** Merges a patch into one recent entry, found by its client id. */
  const updateRecent = useCallback(
    (id: string, patch: Partial<RecentUpload>) => {
      setRecent((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    },
    [],
  );

  /**
   * Runs AI extraction for an already-saved scan. Deliberately fire-and-forget:
   * the scan row + image are already persisted, so a failure here only flips
   * this card's badge to "failed". The scan still stands and shows in the
   * Verification Center for Tonja to retry — nothing is rolled back or deleted.
   */
  const runExtraction = useCallback(
    async (id: string, scanId: string) => {
      updateRecent(id, { status: "reading" });
      try {
        const res = await apiFetch("/api/business-card/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scanId }),
        });
        updateRecent(id, { status: res.ok ? "complete" : "failed" });
      } catch {
        updateRecent(id, { status: "failed" });
      }
    },
    [updateRecent],
  );

  const handleFile = async (picked: File) => {
    setErrorMessage(null);

    // OPTIMISTIC: register the card and surface the post-capture UI ("Card
    // Captured" + the next-action buttons) IMMEDIATELY — before any upload,
    // API call, DB insert, or AI work. Everything below runs in the background
    // and only updates this entry's badge.
    const localId = `card-${(localIdRef.current += 1)}`;
    setRecent((prev) =>
      [
        {
          id: localId,
          scanId: null,
          fileName: picked.name,
          status: "uploading" as RecentStatus,
        },
        ...prev,
      ].slice(0, 5),
    );

    // --- Background work from here on -------------------------------------
    const ext = sanitizeFilename(picked.name);
    const path = `${salesperson.id}/${Date.now()}-${ext}`;

    const upload = await supabase.storage
      .from(BUSINESS_CARD_BUCKET)
      .upload(path, picked, {
        contentType: picked.type || "image/jpeg",
        upsert: false,
      });

    if (upload.error) {
      updateRecent(localId, { status: "upload_failed" });
      setErrorMessage(`Upload failed: ${upload.error.message}`);
      return;
    }

    const { data: publicUrl } = supabase.storage
      .from(BUSINESS_CARD_BUCKET)
      .getPublicUrl(upload.data.path);

    // business_card_scans has RLS enabled and the app has no Supabase Auth, so
    // the browser's anon key cannot insert the scan row directly. The row is
    // created by a server route (service-role key, bypasses RLS) that
    // re-validates salesperson.id against the salespeople table before writing
    // — see src/app/api/business-card/scan/route.ts.
    let scanId: string;
    try {
      const res = await apiFetch("/api/business-card/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The scan is attributed to the authenticated salesperson server-side
        // (from the session token), so no id is sent in the body.
        // storagePath is the stable Storage object path — persisted so CRM
        // code never has to depend on parsing the public image_url.
        body: JSON.stringify({
          imageUrl: publicUrl.publicUrl,
          storagePath: upload.data.path,
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { scanId?: string; error?: string }
        | null;

      if (!res.ok || !payload?.scanId) {
        updateRecent(localId, { status: "upload_failed" });
        setErrorMessage(
          `Save failed: ${payload?.error ?? `server returned ${res.status}`}`,
        );
        return;
      }
      scanId = payload.scanId;
    } catch (err) {
      updateRecent(localId, { status: "upload_failed" });
      setErrorMessage(
        `Save failed: ${err instanceof Error ? err.message : "network error"}`,
      );
      return;
    }

    // Scan row + image are saved. Fire AI extraction in the background.
    updateRecent(localId, { scanId, status: "saved" });
    void runExtraction(localId, scanId);
  };

  // Process each picked image. `fileKey` changes on every dashboard pick (even
  // when the same File is re-selected), so this runs exactly once per pick and
  // appends to the running list. Only `fileKey` belongs in the deps: `file`
  // and `handleFile` are intentionally excluded so a re-render never re-uploads.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void handleFile(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  const close = () => {
    setErrorMessage(null);
    setRecent([]);
    onClose();
  };

  // True while any card is still uploading / saving / being read by AI.
  const anyWorking = recent.some(
    (item) =>
      item.status === "uploading" ||
      item.status === "saved" ||
      item.status === "reading",
  );

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base">Scan Business Card</CardTitle>
        <CardDescription>
          Cards save instantly — AI reads each one in the background.
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={close}
            aria-label="Close scanner"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Single-frame initial state before the optimistic entry registers. */}
        {recent.length === 0 && !errorMessage && (
          <p
            role="status"
            className="rounded-lg border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground"
          >
            Capturing card…
          </p>
        )}

        {/* After a capture, the NEXT ACTION dominates: the buttons sit above
            the AI status, which is demoted to small text + the list below.
            This block appears OPTIMISTICALLY — the moment a photo is picked,
            not when the upload finishes. "Capture Another Card" re-opens the
            camera directly, with no dashboard return and no picker step. */}
        {(recent.length > 0 || errorMessage) && (
          <div className="space-y-2.5">
            {recent.length > 0 && (
              <p className="flex items-center justify-center gap-1.5 text-base font-semibold text-emerald-700 dark:text-emerald-400">
                <Check aria-hidden="true" className="size-5" />
                Card Captured
              </p>
            )}

            {errorMessage && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {errorMessage}
              </p>
            )}

            <Button
              type="button"
              onClick={onScanAnother}
              className="h-14 w-full text-base font-semibold"
            >
              Capture Another Card
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={close}
              className="h-12 w-full"
            >
              Close
            </Button>

            {recent.length > 0 && (
              <p className="text-center text-xs text-muted-foreground">
                {anyWorking
                  ? "Saving and reading your cards in the background."
                  : "AI finished — review in the Verification Center."}
              </p>
            )}
          </div>
        )}

        {/* Secondary information: per-card upload + AI-reading status. */}
        {recent.length > 0 && (
          <ul className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
            {recent.map((item) => {
              const meta = RECENT_STATUS_META[item.status];
              return (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="min-w-0 truncate text-sm text-muted-foreground">
                    {item.fileName}
                  </span>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.className}`}
                  >
                    {meta.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
