"use client";

import { useCallback, useState } from "react";
import { Camera } from "lucide-react";

import { supabase } from "@/lib/supabase/client";
import type { StoredSalesperson } from "@/lib/use-salesperson";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const BUCKET = "business-card-scans";

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
};

// Live AE rollout: every AE sees the real scanner — there is no longer a
// "Coming Soon" gate. The seeded Test account still gets the scanner too; the
// only difference is `is_test_data`, which the /api/business-card/scan route
// derives server-side so the Test account's scans stay cleanly separable from
// real AE data. Either way this writes ONLY to business_card_scans + the
// business-card-scans storage bucket — it never produces leaderboard or
// metric data.
export function BusinessCardScanner({ salesperson }: Props) {
  return <ActiveScanner salesperson={salesperson} />;
}

function sanitizeFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = (dot === -1 ? name : name.slice(0, dot))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "card";
  const ext =
    dot === -1
      ? "jpg"
      : name
          .slice(dot + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 5) || "jpg";
  return `${base}.${ext}`;
}

function ActiveScanner({ salesperson }: { salesperson: StoredSalesperson }) {
  const [open, setOpen] = useState(false);
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
        const res = await fetch("/api/business-card/process", {
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

  const handleFile = async (file: File) => {
    setErrorMessage(null);
    setUploading(true);

    const ext = sanitizeFilename(file.name);
    const path = `${salesperson.id}/${Date.now()}-${ext}`;

    const upload = await supabase.storage
      .from(BUCKET)
      .upload(path, file, {
        contentType: file.type || "image/jpeg",
        upsert: false,
      });

    if (upload.error) {
      setErrorMessage(`Upload failed: ${upload.error.message}`);
      setUploading(false);
      return;
    }

    const { data: publicUrl } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(upload.data.path);

    // business_card_scans has RLS enabled and the app has no Supabase Auth, so
    // the browser's anon key cannot insert the scan row directly. The row is
    // created by a server route (service-role key, bypasses RLS) that
    // re-validates salesperson.id against the salespeople table before writing
    // — see src/app/api/business-card/scan/route.ts.
    let scanId: string;
    try {
      const res = await fetch("/api/business-card/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salespersonId: salesperson.id,
          imageUrl: publicUrl.publicUrl,
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
    // on AI: record the card as saved, return the scanner to its ready state,
    // and fire extraction in the background so the AE can immediately scan the
    // next card without waiting.
    setRecent((prev) =>
      [
        { scanId, fileName: file.name, status: "saved" as RecentStatus },
        ...prev,
      ].slice(0, 5),
    );
    setUploading(false);
    void runExtraction(scanId);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again re-fires onChange.
    e.target.value = "";
    if (!file) return;
    void handleFile(file);
  };

  const close = () => {
    setOpen(false);
    setUploading(false);
    setErrorMessage(null);
    setRecent([]);
  };

  if (!open) {
    return (
      <Button
        type="button"
        size="lg"
        className="w-full text-base font-semibold sm:w-auto sm:self-start"
        onClick={() => setOpen(true)}
      >
        <Camera aria-hidden="true" className="size-5" />
        Scan Business Card
      </Button>
    );
  }

  const labelClass = `flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary/40 bg-primary/5 px-4 py-6 text-center transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/40 ${
    uploading
      ? "cursor-not-allowed opacity-60"
      : "cursor-pointer hover:border-primary hover:bg-primary/10"
  }`;

  // Banner reflects the newest activity: still reading vs. all done.
  const anyReading = recent.some(
    (item) => item.status === "saved" || item.status === "reading",
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Scan Business Card</CardTitle>
        <CardDescription>
          Cards save instantly — AI reads each one in the background, so you
          can keep scanning. A reviewer confirms the details afterward.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Upload control stays available at all times so the AE can scan
            card after card without waiting for AI extraction. */}
        <label className={labelClass}>
          <Camera aria-hidden="true" className="size-6 text-primary" />
          <span className="text-base font-semibold text-primary">
            {uploading ? "Saving card…" : "Upload or Take Photo"}
          </span>
          <span className="text-xs text-muted-foreground">
            Choose a photo from your library or take a new photo on your phone.
          </span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            disabled={uploading}
            className="sr-only"
          />
        </label>

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

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" onClick={close}>
            Close
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
