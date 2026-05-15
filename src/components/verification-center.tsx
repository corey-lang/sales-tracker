"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { Download, ExternalLink, RefreshCw, X } from "lucide-react";

import { supabase } from "@/lib/supabase/client";
import {
  CONTACT_BUCKET_LABELS,
  CONTACT_BUCKET_ORDER,
  normalizeScanContactType,
  type ContactBucket,
} from "@/lib/contact-type";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ExtractionStatus = "pending" | "completed" | "failed";

/** Verification workflow states a scan can be in (verification_status). */
type WorkflowStatus =
  | "needs_review"
  | "duplicate_review"
  | "auto_approved"
  | "approved"
  | "auto_duplicate"
  | "rejected"
  | "rejected_duplicate";

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
  raw_ocr_text: string | null;
  ai_notes: string | null;
  verification_status: string | null;
  verified_contact_id: string | null;
  duplicate_status: string | null;
  duplicate_notes: string | null;
  rejection_reason: string | null;
};

/** A scan with its frontend-derived contact-type bucket attached. */
type ScanWithBucket = Scan & { contactBucket: ContactBucket };

/** One contact-type subsection within an AE section. */
type BucketGroup = { bucket: ContactBucket; scans: ScanWithBucket[] };

/** All scans for a single AE, split into contact-type subsections. */
type AeGroup = { name: string; total: number; buckets: BucketGroup[] };

/** Manual Tonja/admin actions, matching the /api/business-card route names. */
type ActionKind = "approve" | "reject" | "mark-duplicate";

// ---------------------------------------------------------------------------
// Workflow status metadata
// ---------------------------------------------------------------------------

const WORKFLOW_STATUS_META: Record<
  WorkflowStatus,
  { label: string; className: string }
> = {
  needs_review: {
    label: "Needs Review",
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  duplicate_review: {
    label: "Duplicate Review",
    className:
      "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  },
  auto_approved: {
    label: "Auto Approved",
    className:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  approved: {
    label: "Approved",
    className:
      "border-emerald-600/50 bg-emerald-600/15 text-emerald-800 dark:text-emerald-300",
  },
  auto_duplicate: {
    label: "Auto Duplicate",
    className:
      "border-slate-400/40 bg-slate-400/10 text-slate-700 dark:text-slate-300",
  },
  rejected: {
    label: "Rejected",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  rejected_duplicate: {
    label: "Rejected Duplicate",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
};

/** Normalizes a raw verification_status; null/empty is treated as needs_review. */
function effectiveStatus(scan: Scan): WorkflowStatus {
  const raw = (scan.verification_status ?? "").toLowerCase().trim();
  if (raw.length === 0) return "needs_review";
  return raw in WORKFLOW_STATUS_META
    ? (raw as WorkflowStatus)
    : "needs_review";
}

// ---------------------------------------------------------------------------
// Status filters
// ---------------------------------------------------------------------------

/** The status filter chips shown at the top of the Verification Center. */
type FilterKey =
  | "needs_review"
  | "duplicate_review"
  | "auto_approved"
  | "auto_duplicate"
  | "approved"
  | "rejected";

const FILTER_KEYS: FilterKey[] = [
  "needs_review",
  "duplicate_review",
  "auto_approved",
  "auto_duplicate",
  "approved",
  "rejected",
];

const FILTER_LABELS: Record<FilterKey, string> = {
  needs_review: "Needs Review",
  duplicate_review: "Duplicate Review",
  auto_approved: "Auto Approved",
  auto_duplicate: "Auto Duplicates",
  approved: "Approved",
  rejected: "Rejected",
};

/** Default queue: only items that need a human — keeps Tonja's view focused. */
const DEFAULT_FILTERS: FilterKey[] = ["needs_review", "duplicate_review"];

/** "Review Queue" preset — scans that still need a human decision. */
const REVIEW_QUEUE_FILTERS: FilterKey[] = ["needs_review", "duplicate_review"];

/** "Processed" preset — scans already resolved, automatically or manually. */
const PROCESSED_FILTERS: FilterKey[] = [
  "auto_approved",
  "auto_duplicate",
  "approved",
  "rejected",
];

/** True when the active set contains exactly the given filter keys. */
function sameFilterSet(active: Set<FilterKey>, keys: FilterKey[]): boolean {
  return active.size === keys.length && keys.every((key) => active.has(key));
}

/** Chip styling for the individual multi-select status filters. */
function chipClassName(active: boolean): string {
  const base =
    "rounded-full px-3 py-1 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return active
    ? `${base} border-2 border-primary bg-primary font-semibold text-primary-foreground shadow-sm`
    : `${base} border border-input bg-background font-medium text-muted-foreground hover:bg-muted hover:text-foreground`;
}

/** Button styling for the quick-view preset toggles. */
function presetClassName(active: boolean): string {
  const base =
    "rounded-md px-3 py-1 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return active
    ? `${base} border-2 border-primary bg-primary font-semibold text-primary-foreground shadow-sm`
    : `${base} border border-input bg-background font-medium text-foreground hover:bg-muted`;
}

/** Maps a workflow status to the filter chip it belongs under. */
function filterKeyForStatus(status: WorkflowStatus): FilterKey {
  if (status === "rejected" || status === "rejected_duplicate") {
    return "rejected";
  }
  return status;
}

function groupScansByAe(scans: Scan[]): AeGroup[] {
  const byAe = new Map<string, ScanWithBucket[]>();

  for (const scan of scans) {
    const withBucket: ScanWithBucket = {
      ...scan,
      contactBucket: normalizeScanContactType(scan),
    };
    const name = scan.salesperson_name ?? "Unknown";
    const existing = byAe.get(name);
    if (existing) {
      existing.push(withBucket);
    } else {
      byAe.set(name, [withBucket]);
    }
  }

  return [...byAe.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, aeScans]) => {
      const buckets: BucketGroup[] = CONTACT_BUCKET_ORDER.map((bucket) => ({
        bucket,
        scans: aeScans.filter((scan) => scan.contactBucket === bucket),
      })).filter((group) => group.scans.length > 0);

      return { name, total: aeScans.length, buckets };
    });
}

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
type ActionMessage = { kind: "success" | "error"; text: string };

export function VerificationCenter() {
  const [scans, setScans] = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(
    () => new Set(DEFAULT_FILTERS),
  );
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(
    null,
  );

  const load = useCallback(async () => {
    setError(null);
    const result = await supabase
      .from("business_card_scans")
      .select(
        "id, salesperson_id, salesperson_name, image_url, status, is_test_data, created_at, extracted_full_name, extracted_company, extracted_title, extracted_email, extracted_phone, extracted_website, extracted_address, extracted_contact_type, ai_confidence, extraction_status, raw_ocr_text, ai_notes, verification_status, verified_contact_id, duplicate_status, duplicate_notes, rejection_reason",
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

  const handleRetry = useCallback(
    async (scanId: string) => {
      setRetryingId(scanId);
      setRetryErrors((prev) => {
        if (!(scanId in prev)) return prev;
        const next = { ...prev };
        delete next[scanId];
        return next;
      });
      try {
        const res = await fetch("/api/business-card/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scanId }),
        });
        if (!res.ok) {
          let message = `Retry failed (${res.status})`;
          try {
            const data = (await res.json()) as { error?: unknown };
            if (typeof data.error === "string" && data.error.length > 0) {
              message = data.error;
            }
          } catch {
            // ignore parse error; keep status-based message
          }
          throw new Error(message);
        }
        await load();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setRetryErrors((prev) => ({ ...prev, [scanId]: message }));
      } finally {
        setRetryingId((current) => (current === scanId ? null : current));
      }
    },
    [load],
  );

  const handleAction = useCallback(
    async (scanId: string, action: ActionKind) => {
      let body: Record<string, unknown> = { scanId };

      if (action === "reject") {
        const reason = window.prompt(
          "Reason for rejecting this scan? (optional — leave blank to skip)",
        );
        if (reason === null) return; // cancelled
        if (reason.trim().length > 0) body = { ...body, reason: reason.trim() };
      }

      setActioningId(scanId);
      setActionMessage(null);
      try {
        const res = await fetch(`/api/business-card/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          let message = `Action failed (${res.status})`;
          try {
            const data = (await res.json()) as { error?: unknown };
            if (typeof data.error === "string" && data.error.length > 0) {
              message = data.error;
            }
          } catch {
            // ignore parse error; keep status-based message
          }
          throw new Error(message);
        }
        const verb: Record<ActionKind, string> = {
          approve: "approved as a contact",
          reject: "rejected",
          "mark-duplicate": "marked as a duplicate",
        };
        setActionMessage({ kind: "success", text: `Scan ${verb[action]}.` });
        await load();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setActionMessage({ kind: "error", text: message });
      } finally {
        setActioningId((current) => (current === scanId ? null : current));
      }
    },
    [load],
  );

  const counts = useMemo(() => {
    const tally: Record<FilterKey, number> = {
      needs_review: 0,
      duplicate_review: 0,
      auto_approved: 0,
      auto_duplicate: 0,
      approved: 0,
      rejected: 0,
    };
    for (const scan of scans) {
      tally[filterKeyForStatus(effectiveStatus(scan))] += 1;
    }
    return tally;
  }, [scans]);

  const filteredScans = useMemo(
    () =>
      scans.filter((scan) =>
        activeFilters.has(filterKeyForStatus(effectiveStatus(scan))),
      ),
    [scans, activeFilters],
  );

  const allFiltersActive = activeFilters.size === FILTER_KEYS.length;
  const reviewQueueActive = sameFilterSet(activeFilters, REVIEW_QUEUE_FILTERS);
  const processedActive = sameFilterSet(activeFilters, PROCESSED_FILTERS);

  const toggleFilter = (key: FilterKey) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const aeGroups = groupScansByAe(filteredScans);

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
                Review scans, approve them into CRM contacts, and export
                verified contacts as CSV. Scans and images are kept forever.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href="/api/business-card/contacts/export"
                className={buttonVariants({ variant: "outline", size: "sm" })}
                aria-label="Export verified contacts as CRM CSV"
              >
                <Download aria-hidden="true" />
                Export CRM CSV
              </a>
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
          </div>
        </CardHeader>
        <CardContent>
          {!loading && !error && scans.length > 0 && (
            <div className="mb-4 space-y-2">
              {/* Quick-view presets — toggle a whole filter combination at once. */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Quick views
                </span>
                <button
                  type="button"
                  onClick={() => setActiveFilters(new Set(REVIEW_QUEUE_FILTERS))}
                  aria-pressed={reviewQueueActive}
                  className={presetClassName(reviewQueueActive)}
                >
                  Review Queue
                </button>
                <button
                  type="button"
                  onClick={() => setActiveFilters(new Set(PROCESSED_FILTERS))}
                  aria-pressed={processedActive}
                  className={presetClassName(processedActive)}
                >
                  Processed
                </button>
                <button
                  type="button"
                  onClick={() => setActiveFilters(new Set(DEFAULT_FILTERS))}
                  className="rounded-md border border-input bg-background px-3 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Clear Filters
                </button>
              </div>
              {/* Individual status filters — multi-select; toggle any combination. */}
              <div className="flex flex-wrap gap-2">
                {FILTER_KEYS.map((key) => {
                  const active = activeFilters.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleFilter(key)}
                      aria-pressed={active}
                      className={chipClassName(active)}
                    >
                      {FILTER_LABELS[key]} ({counts[key]})
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setActiveFilters(new Set(FILTER_KEYS))}
                  aria-pressed={allFiltersActive}
                  className={chipClassName(allFiltersActive)}
                >
                  All
                </button>
              </div>
            </div>
          )}

          {actionMessage && (
            <p
              role={actionMessage.kind === "error" ? "alert" : "status"}
              className={`mb-4 rounded-md border px-3 py-2 text-sm ${
                actionMessage.kind === "error"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              }`}
            >
              {actionMessage.text}
            </p>
          )}

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
          ) : filteredScans.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No scans match the selected filters.
            </p>
          ) : (
            <div className="space-y-6">
              {aeGroups.map((aeGroup) => (
                <section
                  key={aeGroup.name}
                  className="rounded-lg border bg-muted/30 p-3 sm:p-4"
                >
                  <h3 className="text-lg font-semibold">
                    {aeGroup.name}{" "}
                    <span className="text-muted-foreground">
                      ({aeGroup.total})
                    </span>
                  </h3>
                  <div className="mt-3 space-y-5">
                    {aeGroup.buckets.map((bucketGroup) => (
                      <div key={bucketGroup.bucket}>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {CONTACT_BUCKET_LABELS[bucketGroup.bucket]} (
                          {bucketGroup.scans.length})
                        </h4>
                        <ul className="mt-2 space-y-3">
                          {bucketGroup.scans.map((scan) => (
                            <ScanCard
                              key={scan.id}
                              scan={scan}
                              retrying={retryingId === scan.id}
                              retryDisabled={
                                retryingId !== null && retryingId !== scan.id
                              }
                              retryError={retryErrors[scan.id] ?? null}
                              onRetry={() => void handleRetry(scan.id)}
                              actioning={actioningId === scan.id}
                              actionsDisabled={actioningId !== null}
                              onAction={(action) =>
                                void handleAction(scan.id, action)
                              }
                              onPreview={setPreview}
                            />
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      {preview && (
        <ImageLightbox preview={preview} onClose={() => setPreview(null)} />
      )}
    </>
  );
}

function ScanCard({
  scan,
  retrying,
  retryDisabled,
  retryError,
  onRetry,
  actioning,
  actionsDisabled,
  onAction,
  onPreview,
}: {
  scan: Scan;
  retrying: boolean;
  retryDisabled: boolean;
  retryError: string | null;
  onRetry: () => void;
  actioning: boolean;
  actionsDisabled: boolean;
  onAction: (action: ActionKind) => void;
  onPreview: (preview: Preview) => void;
}) {
  const status = effectiveStatus(scan);
  const needsAction =
    status === "needs_review" || status === "duplicate_review";

  return (
    <li className="flex flex-col gap-4 rounded-lg border bg-card p-3 sm:flex-row sm:items-start">
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
          onPreview({
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
          <WorkflowStatusBadge status={status} />
          <StatusBadge status={scan.status} />
          <ExtractionStatusBadge status={scan.extraction_status} />
          {scan.is_test_data && <TestDataBadge />}
        </div>
        <p className="text-sm text-muted-foreground">
          Uploaded {formatTimestamp(scan.created_at)}
        </p>
        {scan.duplicate_notes && scan.duplicate_notes.trim().length > 0 && (
          <p className="rounded-md border border-orange-500/40 bg-orange-500/10 px-2 py-1 text-xs text-orange-800 dark:text-orange-300">
            <span className="font-semibold uppercase tracking-wide">
              Duplicate:
            </span>{" "}
            {scan.duplicate_notes}
          </p>
        )}
        {scan.rejection_reason && scan.rejection_reason.trim().length > 0 && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            <span className="font-semibold uppercase tracking-wide">
              Rejected:
            </span>{" "}
            {scan.rejection_reason}
          </p>
        )}
        <RetryAIControl
          extractionStatus={scan.extraction_status}
          extractedContactType={scan.extracted_contact_type}
          retrying={retrying}
          disabled={retryDisabled}
          error={retryError}
          onRetry={onRetry}
        />
        {needsAction && (
          <ScanActions
            busy={actioning}
            disabled={actionsDisabled}
            onAction={onAction}
          />
        )}
        <ExtractedFields scan={scan} />
      </div>
    </li>
  );
}

function ScanActions({
  busy,
  disabled,
  onAction,
}: {
  busy: boolean;
  disabled: boolean;
  onAction: (action: ActionKind) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-t pt-2">
      <Button
        type="button"
        size="sm"
        onClick={() => onAction("approve")}
        disabled={disabled || busy}
      >
        {busy ? "Working…" : "Approve as Contact"}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onAction("reject")}
        disabled={disabled || busy}
      >
        Reject
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onAction("mark-duplicate")}
        disabled={disabled || busy}
      >
        Mark Duplicate
      </Button>
    </div>
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

function RetryAIControl({
  extractionStatus,
  extractedContactType,
  retrying,
  disabled,
  error,
  onRetry,
}: {
  extractionStatus: string | null;
  extractedContactType: string | null;
  retrying: boolean;
  disabled: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  // Show Retry AI whenever AI / contact-type processing looks incomplete:
  // a failed / pending / missing extraction status, or a missing contact type
  // (which renders as "Not processed yet" and buckets the scan as Other).
  const status = (extractionStatus ?? "").toLowerCase().trim();
  const statusNeedsRetry =
    status === "failed" || status === "pending" || status === "";
  const contactTypeMissing =
    !extractedContactType || extractedContactType.trim().length === 0;

  if (!statusNeedsRetry && !contactTypeMissing) {
    return null;
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={retrying || disabled}
        aria-label="Retry AI extraction for this scan"
      >
        <RefreshCw
          aria-hidden="true"
          className={retrying ? "animate-spin" : ""}
        />
        {retrying ? "Retrying…" : "Retry AI"}
      </Button>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          {error}
        </p>
      )}
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
    {
      label: "Bucket",
      value: CONTACT_BUCKET_LABELS[normalizeScanContactType(scan)],
    },
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

function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  const meta = WORKFLOW_STATUS_META[status];
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${meta.className}`}
    >
      {meta.label}
    </span>
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
    failed: "border-destructive/40 bg-destructive/10 text-destructive",
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
