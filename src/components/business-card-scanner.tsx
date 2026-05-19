"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

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

/** Background AI state for a single card the AE just uploaded. */
type RecentStatus = "saved" | "reading" | "complete" | "failed";

/** A card uploaded this session, tracked while AI extraction runs in the background. */
type RecentUpload = {
  scanId: string;
  fileName: string;
  status: RecentStatus;
};

/** Badge label + styling for each background-AI state in the recent list. */
const RECENT_STATUS_META: Record<
  RecentStatus,
  { label: string; className: string }
> = {
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
   * Re-opens the dashboard's camera input directly — powers "Scan Another
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
  // `uploading` covers only the brief image-upload + scan-row insert. AI
  // extraction is NEVER tracked here — it runs in the background per card.
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentUpload[]>([]);

  /** Updates one recent upload's background-AI status by scan id. */
  const setRecentStatus = useCallback(
    (scanId: string, status: RecentStatus) => {
      setRecent((prev) =>
        prev.map((item) =>
          item.scanId === scanId ? { ...item, status } : item,
        ),
      );
    },
    [],
  );

  /**
   * Runs AI extraction for an already-saved scan. Deliberately NOT awaited by
   * the upload flow: the scan row + image are already persisted, so a failure
   * here only flips this card's status to "failed". The scan still stands and
   * shows in the Verification Center (with a failed/pending extraction status)
   * for Tonja to retry — nothing is rolled back or deleted.
   */
  const runExtraction = useCallback(
    async (scanId: string) => {
      setRecentStatus(scanId, "reading");
      try {
        const res = await apiFetch("/api/business-card/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scanId }),
        });
        setRecentStatus(scanId, res.ok ? "complete" : "failed");
      } catch {
        setRecentStatus(scanId, "failed");
      }
    },
    [setRecentStatus],
  );

  const handleFile = async (picked: File) => {
    setErrorMessage(null);
    setUploading(true);

    const ext = sanitizeFilename(picked.name);
    const path = `${salesperson.id}/${Date.now()}-${ext}`;

    const upload = await supabase.storage
      .from(BUSINESS_CARD_BUCKET)
      .upload(path, picked, {
        contentType: picked.type || "image/jpeg",
        upsert: false,
      });

    if (upload.error) {
      setErrorMessage(`Upload failed: ${upload.error.message}`);
      setUploading(false);
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
        setErrorMessage(
          `Save failed: ${payload?.error ?? `server returned ${res.status}`}`,
        );
        setUploading(false);
        return;
      }
      scanId = payload.scanId;
    } catch (err) {
      setErrorMessage(
        `Save failed: ${err instanceof Error ? err.message : "network error"}`,
      );
      setUploading(false);
      return;
    }

    // The image + scan row are now fully saved. From here the UI never blocks
    // on AI: record the card as saved and fire extraction in the background so
    // the AE can immediately scan the next card without waiting.
    setRecent((prev) =>
      [
        { scanId, fileName: picked.name, status: "saved" as RecentStatus },
        ...prev,
      ].slice(0, 5),
    );
    setUploading(false);
    void runExtraction(scanId);
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
    setUploading(false);
    setErrorMessage(null);
    setRecent([]);
    onClose();
  };

  // Banner reflects the newest activity: still reading vs. all done.
  const anyReading = recent.some(
    (item) => item.status === "saved" || item.status === "reading",
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
        {uploading && (
          <p
            role="status"
            className="rounded-lg border bg-muted/30 px-3 py-3 text-center text-sm text-muted-foreground"
          >
            Saving card…
          </p>
        )}

        {recent.length > 0 && (
          <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
            <p
              role="status"
              className="text-sm font-medium text-emerald-700 dark:text-emerald-400"
            >
              {anyReading
                ? "Card saved. AI is reading it in the background."
                : "Cards saved. AI finished — review them in the Verification Center."}
            </p>
            <ul className="space-y-1.5">
              {recent.map((item) => {
                const meta = RECENT_STATUS_META[item.status];
                return (
                  <li
                    key={item.scanId}
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
          </div>
        )}

        {errorMessage && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {errorMessage}
          </p>
        )}

        {/* Batch scanning: re-opens the camera directly so the AE can scan
            card after card without returning to the dashboard. */}
        <Button
          type="button"
          className="w-full"
          onClick={onScanAnother}
          disabled={uploading}
        >
          Scan Another Card
        </Button>
      </CardContent>
    </Card>
  );
}
