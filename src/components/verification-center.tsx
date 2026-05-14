"use client";

import { useCallback, useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import { ExternalLink, RefreshCw, X } from "lucide-react";

import { supabase } from "@/lib/supabase/client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ExtractionStatus = "pending" | "completed" | "failed";

type Scan = {
  id: string;
  salesperson_id: string;
  salesperson_name: string | null;
  image_url: string;
  status: string;
  is_test_data: boolean;
  created_at: string;
  extracted_full_name: string | null;
  extracted_company: string | null;
  extracted_title: string | null;
  extracted_email: string | null;
  extracted_phone: string | null;
  extracted_website: string | null;
  extracted_address: string | null;
  extracted_contact_type: string | null;
  ai_confidence: number | null;
  extraction_status: string | null;
};

function formatTimestamp(value: string): string {
  try {
    return format(parseISO(value), "MM-dd-yyyy h:mm a");
  } catch {
    return value;
  }
}

function formatConfidence(value: number | null): string | null {
  if (value === null || Number.isNaN(value)) return null;
  const pct = value <= 1 ? value * 100 : value;
  return `${Math.round(pct)}%`;
}

type Preview = { url: string; name: string };

export function VerificationCenter() {
  const [scans, setScans] = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const result = await supabase
      .from("business_card_scans")
      .select(
        "id, salesperson_id, salesperson_name, image_url, status, is_test_data, created_at, extracted_full_name, extracted_company, extracted_title, extracted_email, extracted_phone, extracted_website, extracted_address, extracted_contact_type, ai_confidence, extraction_status",
      )
      .order("created_at", { ascending: false });

    if (result.error) {
      setError(result.error.message);
      setScans([]);
    } else {
      setScans((result.data ?? []) as Scan[]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <>
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-xl">
              Business Card Verification Center
            </CardTitle>
            <CardDescription>
              Uploaded business card scans, newest first. Display only — no
              edits, OCR, or approvals yet.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            aria-label="Refresh scans"
          >
            <RefreshCw
              aria-hidden="true"
              className={refreshing ? "animate-spin" : ""}
            />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading scans…</p>
        ) : error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            Failed to load scans: {error}
          </p>
        ) : scans.length === 0 ? (
          <p className="text-sm text-muted-foreground">No scans yet.</p>
        ) : (
          <ul className="space-y-3">
            {scans.map((scan) => (
              <li
                key={scan.id}
                className="flex flex-col gap-4 rounded-lg border bg-card p-3 sm:flex-row sm:items-start"
              >
                <a
                  href={scan.image_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey ||
                      event.button !== 0
                    ) {
                      return;
                    }
                    event.preventDefault();
                    setPreview({
                      url: scan.image_url,
                      name: scan.salesperson_name ?? "unknown",
                    });
                  }}
                  className="group block w-full shrink-0 self-start overflow-hidden rounded-md border bg-muted transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-72 md:w-96"
                  aria-label="Expand business card image"
                  title="Click to expand · ⌘/Ctrl-click to open in new tab"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={scan.image_url}
                    alt={`Business card scanned by ${scan.salesperson_name ?? "unknown"}`}
                    className="block h-auto w-full"
                    loading="lazy"
                  />
                </a>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold">
                      {scan.salesperson_name ?? "Unknown"}
                    </span>
                    <StatusBadge status={scan.status} />
                    <ExtractionStatusBadge status={scan.extraction_status} />
                    {scan.is_test_data && <TestDataBadge />}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Uploaded {formatTimestamp(scan.created_at)}
                  </p>
                  <ExtractedFields scan={scan} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
    {preview && (
      <ImageLightbox preview={preview} onClose={() => setPreview(null)} />
    )}
    </>
  );
}

function ImageLightbox({
  preview,
  onClose,
}: {
  preview: Preview;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Business card scanned by ${preview.name}`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div
        className="relative max-h-full"
        onClick={(event) => event.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={preview.url}
          alt={`Business card scanned by ${preview.name}`}
          className="block max-h-[85vh] max-w-[95vw] rounded-md object-contain shadow-2xl"
        />
        <div className="absolute right-2 top-2 flex items-center gap-2">
          <a
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex items-center gap-1 rounded-md bg-black/70 px-3 py-1.5 text-xs font-medium text-white hover:bg-black/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
            Open in new tab
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-black/70 text-white hover:bg-black/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ExtractedFields({ scan }: { scan: Scan }) {
  const fields: Array<{ label: string; value: string | null }> = [
    { label: "Full Name", value: scan.extracted_full_name },
    { label: "Company", value: scan.extracted_company },
    { label: "Title", value: scan.extracted_title },
    { label: "Email", value: scan.extracted_email },
    { label: "Phone", value: scan.extracted_phone },
    { label: "Website", value: scan.extracted_website },
    { label: "Address", value: scan.extracted_address },
    { label: "Contact Type", value: scan.extracted_contact_type },
    { label: "AI Confidence", value: formatConfidence(scan.ai_confidence) },
    { label: "Extraction Status", value: scan.extraction_status },
  ];

  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 border-t pt-2 sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {field.label}
          </dt>
          <dd className="break-words text-sm">
            {field.value && field.value.trim().length > 0 ? (
              field.value
            ) : (
              <span className="text-muted-foreground italic">
                Not processed yet
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="rounded-full border bg-muted px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
      {status}
    </span>
  );
}

function ExtractionStatusBadge({ status }: { status: string | null }) {
  const normalized = (status ?? "pending").toLowerCase() as ExtractionStatus;

  const styles: Record<ExtractionStatus, string> = {
    pending:
      "border-slate-400/40 bg-slate-400/10 text-slate-700 dark:text-slate-300",
    completed:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    failed:
      "border-destructive/40 bg-destructive/10 text-destructive",
  };

  const className =
    styles[normalized] ??
    "border-slate-400/40 bg-slate-400/10 text-slate-700 dark:text-slate-300";

  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${className}`}
    >
      {normalized}
    </span>
  );
}

function TestDataBadge() {
  return (
    <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
      Test Data
    </span>
  );
}
