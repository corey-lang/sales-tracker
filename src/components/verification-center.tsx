"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  Download,
  ExternalLink,
  Pencil,
  RefreshCw,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import {
  CONTACT_BUCKET_LABELS,
  CONTACT_BUCKET_ORDER,
  normalizeScanContactType,
  type ContactBucket,
} from "@/lib/contact-type";
import { useSalesperson } from "@/lib/use-salesperson";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

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
  /** Display rotation in degrees (0/90/180/270). Optional: absent on rows
   *  read before the image-rotation migration ran. */
  image_rotation_degrees?: number | null;
  status: string;
  is_test_data: boolean;
  created_at: string;
  extracted_first_name: string | null;
  extracted_last_name: string | null;
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
  duplicate_of_contact_id: string | null;
  rejection_reason: string | null;
  /** Set by the verification route for auto_duplicate scans only — a
   *  re-classification under the current conservative duplicate rules. */
  auto_duplicate_category?: "likely_false" | "likely_true";
  auto_duplicate_reason?: string;
};

/**
 * A verified contact loaded from `business_card_contacts` so a duplicate scan
 * can be compared side-by-side against the contact it appears to duplicate.
 */
type DuplicateContact = {
  id: string;
  full_name: string | null;
  company: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  contact_bucket: string | null;
  salesperson_name: string | null;
  verification_status: string | null;
  created_at: string | null;
};

/** A scan with its frontend-derived contact-type bucket attached. */
type ScanWithBucket = Scan & { contactBucket: ContactBucket };

/** One contact-type subsection within an AE section. */
type BucketGroup = { bucket: ContactBucket; scans: ScanWithBucket[] };

/** All scans for a single AE, split into contact-type subsections. */
type AeGroup = { name: string; total: number; buckets: BucketGroup[] };

/** Manual Tonja/admin actions, matching the /api/business-card route names. */
type ActionKind = "approve" | "reject" | "mark-duplicate";

/** The extracted contact fields the admin "Edit" sheet can change on a scan. */
type EditableScanFields = {
  first_name: string;
  last_name: string;
  full_name: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  contact_type: string;
};

/** Bucket → a canonical contact-type string the edit sheet writes back, so
 *  normalizeScanContactType re-derives the same bucket. */
const BUCKET_CONTACT_TYPE: Record<ContactBucket, string> = {
  real_estate_agent: "Real Estate Agent",
  title: "Title",
  other: "Other",
};

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

// ---------------------------------------------------------------------------
// Duplicate comparison helpers
// ---------------------------------------------------------------------------

/** Renders a stored contact_bucket key as its human label when recognized. */
function bucketLabel(value: string | null): string | null {
  if (!value || value.trim().length === 0) return null;
  return value in CONTACT_BUCKET_LABELS
    ? CONTACT_BUCKET_LABELS[value as ContactBucket]
    : value;
}

/** How a comparison field is normalized before checking match vs. different. */
type CompareKind = "email" | "phone" | "text" | "none";

/** Verdict for an important comparison field; null = not labelled. */
type MatchVerdict = "match" | "different" | null;

/**
 * Simple, deliberately un-clever comparison: normalize both sides and check
 * equality. Returns null (no label) for non-important fields or when either
 * side is blank — we only label fields we can confidently compare.
 */
function compareValues(
  kind: CompareKind,
  scanValue: string | null,
  contactValue: string | null,
): MatchVerdict {
  if (kind === "none") return null;
  const a = (scanValue ?? "").trim();
  const b = (contactValue ?? "").trim();
  if (a.length === 0 || b.length === 0) return null;

  let na: string;
  let nb: string;
  if (kind === "email") {
    na = a.toLowerCase();
    nb = b.toLowerCase();
  } else if (kind === "phone") {
    na = a.replace(/\D/g, "");
    nb = b.replace(/\D/g, "");
  } else {
    na = a.toLowerCase().replace(/\s+/g, " ");
    nb = b.toLowerCase().replace(/\s+/g, " ");
  }
  if (na.length === 0 || nb.length === 0) return null;
  return na === nb ? "match" : "different";
}

// ---------------------------------------------------------------------------
// CRM export summary
// ---------------------------------------------------------------------------

/** A business_card_contacts row, trimmed to what the export summary needs. */
type ExportContactRow = {
  salesperson_id: string | null;
  salesperson_name: string | null;
  verification_status: string | null;
  exported_at: string | null;
};

/** Shape of a GET /api/business-card/verification response. */
type VerificationPayload = {
  scans?: unknown;
  exportContacts?: unknown;
  duplicateContacts?: unknown;
  error?: string;
};

/** Per-AE CRM export counts shown in the export section. */
type ExportSummaryEntry = {
  /** Stable React key + identity for the in-flight export tracking. */
  key: string;
  salespersonId: string | null;
  salespersonName: string;
  /** Approved / auto-approved contacts not yet exported. */
  newCount: number;
  /** Approved / auto-approved contacts already exported at least once. */
  exportedCount: number;
};

/** Sentinel key for the "Export All New Contacts" action. */
const EXPORT_ALL_KEY = "__all__";

/**
 * Rolls per-contact rows up into per-AE export counts. Only CRM-ready
 * contacts (auto_approved / approved) reach here; a row counts as "new" when
 * exported_at is null, otherwise "already exported".
 */
function summarizeExports(rows: ExportContactRow[]): ExportSummaryEntry[] {
  const byAe = new Map<string, ExportSummaryEntry>();
  for (const row of rows) {
    const name = row.salesperson_name ?? "Unknown";
    const key = row.salesperson_id ?? `name:${name}`;
    let entry = byAe.get(key);
    if (!entry) {
      entry = {
        key,
        salespersonId: row.salesperson_id,
        salespersonName: name,
        newCount: 0,
        exportedCount: 0,
      };
      byAe.set(key, entry);
    }
    if (row.exported_at) {
      entry.exportedCount += 1;
    } else {
      entry.newCount += 1;
    }
  }
  return [...byAe.values()].sort((a, b) =>
    a.salespersonName.localeCompare(b.salespersonName),
  );
}

type Preview = { url: string; name: string; rotation: number };
type ActionMessage = { kind: "success" | "error"; text: string };

/** Autosave state for a scan's rotation, keyed by scan id. */
type RotationStatus = "saving" | "saved" | "error";

/** Normalizes any degree value to one of 0 / 90 / 180 / 270. */
function normalizeRotation(degrees: number): number {
  return ((Math.round(degrees / 90) % 4) + 4) % 4 * 90;
}

export function VerificationCenter() {
  const [scans, setScans] = useState<Scan[]>([]);
  const [duplicateContactById, setDuplicateContactById] = useState<
    Map<string, DuplicateContact>
  >(() => new Map());
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
  const [exportSummary, setExportSummary] = useState<ExportSummaryEntry[]>([]);
  const [exportingKey, setExportingKey] = useState<string | null>(null);

  // Editing extracted contact fields is admin-only (the route enforces it too);
  // the assistant can still approve / reject / mark-duplicate.
  const { salesperson } = useSalesperson();
  const canEdit = Boolean(salesperson?.is_admin);
  const [editingScanId, setEditingScanId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // True while a bulk auto-duplicate reopen is in flight.
  const [bulkBusy, setBulkBusy] = useState(false);
  // Per-scan rotation autosave status, keyed by scan id.
  const [rotationStatus, setRotationStatus] = useState<
    Record<string, RotationStatus>
  >({});

  // The scan being edited is derived from `scans` (not a snapshot), so an
  // autosaved rotation made inside the edit modal is reflected live.
  const editingScan = useMemo(
    () =>
      editingScanId
        ? (scans.find((s) => s.id === editingScanId) ?? null)
        : null,
    [editingScanId, scans],
  );

  const load = useCallback(async () => {
    setError(null);

    // Verification data is read through a reviewer-guarded server route — the
    // browser no longer queries business_card_scans / business_card_contacts
    // directly. The route returns scans, export-summary contacts, and the
    // matched duplicate contacts in one response.
    let payload: VerificationPayload | null = null;
    try {
      const res = await apiFetch("/api/business-card/verification");
      payload = (await res.json().catch(() => null)) as VerificationPayload | null;
      if (!res.ok) {
        throw new Error(payload?.error ?? `Request failed (${res.status})`);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load verification data",
      );
      setScans([]);
      setDuplicateContactById(new Map());
      setExportSummary([]);
      return;
    }

    const data: VerificationPayload = payload ?? {};

    const loadedScans = (
      Array.isArray(data.scans) ? data.scans : []
    ) as Scan[];
    setScans(loadedScans);

    // CRM export summary: per-AE approved-contact counts.
    const exportContacts = (
      Array.isArray(data.exportContacts) ? data.exportContacts : []
    ) as ExportContactRow[];
    setExportSummary(summarizeExports(exportContacts));

    // Duplicate-contact lookup, keyed by id, for side-by-side comparison.
    const duplicateContacts = (
      Array.isArray(data.duplicateContacts) ? data.duplicateContacts : []
    ) as DuplicateContact[];
    const map = new Map<string, DuplicateContact>();
    for (const row of duplicateContacts) {
      map.set(row.id, row);
    }
    setDuplicateContactById(map);
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
        const res = await apiFetch("/api/business-card/process", {
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

      if (action === "mark-duplicate") {
        // Carry the detected match through so the confirmed duplicate keeps a
        // structured link to the original contact.
        const matchedId = scans.find(
          (scan) => scan.id === scanId,
        )?.duplicate_of_contact_id;
        if (matchedId) body = { ...body, duplicateOfContactId: matchedId };
      }

      setActioningId(scanId);
      setActionMessage(null);
      try {
        const res = await apiFetch(`/api/business-card/${action}`, {
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
    [load, scans],
  );

  const handleReopen = useCallback(
    async (scanId: string) => {
      setActioningId(scanId);
      setActionMessage(null);
      try {
        const res = await apiFetch("/api/business-card/reopen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scanId }),
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
        setActionMessage({
          kind: "success",
          text: "Scan sent back to manual review.",
        });
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

  const handleRotate = useCallback(
    async (scanId: string, rotation: number) => {
      const previous =
        scans.find((s) => s.id === scanId)?.image_rotation_degrees ?? 0;
      if (previous === rotation) return;
      // Optimistic — show the new orientation immediately, autosave behind it.
      setScans((prev) =>
        prev.map((s) =>
          s.id === scanId ? { ...s, image_rotation_degrees: rotation } : s,
        ),
      );
      setRotationStatus((m) => ({ ...m, [scanId]: "saving" }));
      try {
        const res = await apiFetch("/api/business-card/update-rotation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scanId, rotation }),
        });
        if (!res.ok) {
          throw new Error(`Save failed (${res.status})`);
        }
        setRotationStatus((m) => ({ ...m, [scanId]: "saved" }));
      } catch {
        // Revert so the UI matches what is actually persisted.
        setScans((prev) =>
          prev.map((s) =>
            s.id === scanId
              ? { ...s, image_rotation_degrees: previous }
              : s,
          ),
        );
        setRotationStatus((m) => ({ ...m, [scanId]: "error" }));
      }
    },
    [scans],
  );

  const handleReopenBulk = useCallback(
    async (scanIds: string[]) => {
      if (scanIds.length === 0) return;
      setBulkBusy(true);
      setActionMessage(null);
      try {
        const res = await apiFetch("/api/business-card/reopen-bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scanIds }),
        });
        const data = (await res.json().catch(() => null)) as {
          reopened?: number;
          skipped?: number;
          error?: string;
        } | null;
        if (!res.ok) {
          throw new Error(data?.error ?? `Action failed (${res.status})`);
        }
        const reopened = data?.reopened ?? 0;
        const skipped = data?.skipped ?? 0;
        setActionMessage({
          kind: "success",
          text:
            `${reopened} scan${reopened === 1 ? "" : "s"} sent back to review.` +
            (skipped > 0
              ? ` ${skipped} skipped — no longer auto-duplicates.`
              : ""),
        });
        await load();
      } catch (err) {
        setActionMessage({
          kind: "error",
          text: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setBulkBusy(false);
      }
    },
    [load],
  );

  const handleRecheckAll = useCallback(async () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "This will recheck old auto-duplicates using the new duplicate rules. It will not approve anything.",
      )
    ) {
      return;
    }
    setBulkBusy(true);
    setActionMessage(null);
    try {
      const res = await apiFetch(
        "/api/business-card/recheck-auto-duplicates",
        { method: "POST" },
      );
      const data = (await res.json().catch(() => null)) as {
        totalChecked?: number;
        kept?: number;
        movedToDuplicateReview?: number;
        movedToNeedsReview?: number;
        skipped?: number;
        hitCap?: boolean;
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `Action failed (${res.status})`);
      }
      const total = data?.totalChecked ?? 0;
      const kept = data?.kept ?? 0;
      const review = data?.movedToDuplicateReview ?? 0;
      const needs = data?.movedToNeedsReview ?? 0;
      const skipped = data?.skipped ?? 0;
      setActionMessage({
        kind: "success",
        text:
          `Rechecked ${total} auto-duplicate${total === 1 ? "" : "s"}: ` +
          `kept ${kept} · moved ${review} to review · ${needs} to needs review` +
          (skipped > 0 ? ` · ${skipped} skipped` : "") +
          (data?.hitCap
            ? " · more remain — run again to continue."
            : "."),
      });
      await load();
    } catch (err) {
      setActionMessage({
        kind: "error",
        text: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBulkBusy(false);
    }
  }, [load]);

  const handleExport = useCallback(
    async (target: {
      key: string;
      salespersonId: string | null;
      salespersonName: string | null;
    }) => {
      setExportingKey(target.key);
      setActionMessage(null);
      try {
        const params = new URLSearchParams();
        // Prefer the stable id; fall back to name when the AE has no id.
        if (target.salespersonId) {
          params.set("salespersonId", target.salespersonId);
        } else if (target.salespersonName) {
          params.set("salespersonName", target.salespersonName);
        }
        const qs = params.toString();
        const res = await apiFetch(
          `/api/business-card/contacts/export${qs ? `?${qs}` : ""}`,
        );
        if (!res.ok) {
          let message = `Export failed (${res.status})`;
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

        // Stream the CSV to a download without leaving the page, so counts can
        // be refreshed straight afterwards.
        const blob = await res.blob();
        const disposition = res.headers.get("Content-Disposition") ?? "";
        const match = /filename="([^"]+)"/.exec(disposition);
        const filename = match?.[1] ?? "business-card-contacts.csv";
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);

        setActionMessage({
          kind: "success",
          text: "CSV exported. Those contacts are now marked as exported.",
        });
        // Refresh so exported contacts drop out of the "new" counts.
        await load();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setActionMessage({ kind: "error", text: message });
      } finally {
        setExportingKey((current) =>
          current === target.key ? null : current,
        );
      }
    },
    [load],
  );

  const handleSaveEdit = useCallback(
    async (scanId: string, fields: EditableScanFields) => {
      setSavingEdit(true);
      setEditError(null);
      try {
        const res = await apiFetch("/api/business-card/update-scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scanId, fields }),
        });
        if (!res.ok) {
          let message = `Save failed (${res.status})`;
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
        setEditingScanId(null);
        setActionMessage({
          kind: "success",
          text: "Contact details updated.",
        });
        await load();
      } catch (err) {
        setEditError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setSavingEdit(false);
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

  // Every auto-marked duplicate, regardless of the active status filters —
  // the cleanup panel always has the full set to categorize.
  const autoDuplicateScans = useMemo(
    () => scans.filter((scan) => effectiveStatus(scan) === "auto_duplicate"),
    [scans],
  );

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

          {!loading && !error && exportSummary.length > 0 && (
            <ExportSection
              summary={exportSummary}
              exportingKey={exportingKey}
              onExport={handleExport}
            />
          )}

          {!loading && !error && autoDuplicateScans.length > 0 && (
            <AutoDuplicateCleanup
              scans={autoDuplicateScans}
              busy={bulkBusy}
              onBulkReopen={handleReopenBulk}
              onReopenOne={(scanId) => void handleReopen(scanId)}
              onRecheckAll={() => void handleRecheckAll()}
              onPreview={setPreview}
            />
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
                              duplicateContact={
                                scan.duplicate_of_contact_id
                                  ? duplicateContactById.get(
                                      scan.duplicate_of_contact_id,
                                    )
                                  : undefined
                              }
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
                              canEdit={canEdit}
                              onEdit={() => {
                                setEditError(null);
                                setEditingScanId(scan.id);
                              }}
                              onReopen={() => void handleReopen(scan.id)}
                              rotationStatus={rotationStatus[scan.id]}
                              onRotate={(rotation) =>
                                void handleRotate(scan.id, rotation)
                              }
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
      {editingScan && (
        <EditScanSheet
          key={editingScan.id}
          scan={editingScan}
          saving={savingEdit}
          error={editError}
          rotationStatus={rotationStatus[editingScan.id]}
          onRotate={(rotation) => void handleRotate(editingScan.id, rotation)}
          onSave={handleSaveEdit}
          onClose={() => {
            setEditingScanId(null);
            setEditError(null);
          }}
        />
      )}
    </>
  );
}

/**
 * CRM Export panel: per-AE counts of approved contacts available to export,
 * plus per-AE and "all new" CSV export buttons. Exporting marks contacts as
 * exported (it never deletes them); after a run the counts are refreshed so
 * already-exported contacts drop out of the "new" total.
 */
function ExportSection({
  summary,
  exportingKey,
  onExport,
}: {
  summary: ExportSummaryEntry[];
  exportingKey: string | null;
  onExport: (target: {
    key: string;
    salespersonId: string | null;
    salespersonName: string | null;
  }) => void;
}) {
  const totalNew = summary.reduce((sum, ae) => sum + ae.newCount, 0);
  const anyExporting = exportingKey !== null;

  return (
    <section className="mb-4 rounded-lg border bg-muted/30 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">CRM Export</h3>
          <p className="text-xs text-muted-foreground">
            Export approved contacts to CSV per AE. Exported contacts are
            marked and skipped next time — nothing is ever deleted.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() =>
            onExport({
              key: EXPORT_ALL_KEY,
              salespersonId: null,
              salespersonName: null,
            })
          }
          disabled={totalNew === 0 || anyExporting}
        >
          <Download aria-hidden="true" />
          {exportingKey === EXPORT_ALL_KEY
            ? "Exporting…"
            : `Export All New Contacts (${totalNew})`}
        </Button>
      </div>

      <ul className="mt-3 space-y-2">
        {summary.map((ae) => {
          const busy = exportingKey === ae.key;
          return (
            <li
              key={ae.key}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  {ae.salespersonName}
                </p>
                <p className="text-xs text-muted-foreground">
                  New approved contacts:{" "}
                  <span className="font-medium text-foreground">
                    {ae.newCount}
                  </span>{" "}
                  · Already exported:{" "}
                  <span className="font-medium text-foreground">
                    {ae.exportedCount}
                  </span>
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onExport({
                    key: ae.key,
                    salespersonId: ae.salespersonId,
                    salespersonName: ae.salespersonName,
                  })
                }
                disabled={ae.newCount === 0 || anyExporting}
              >
                <Download aria-hidden="true" />
                {busy ? "Exporting…" : "Export New CSV"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Auto-Duplicate Cleanup — splits old auto_duplicate scans into "likely false"
 * (safe to bulk send back to review) and "likely true" (one-by-one only),
 * using the verification route's re-classification under the current
 * conservative rules. Sending scans back to review NEVER approves anything —
 * it only moves them into manual duplicate_review.
 */
function AutoDuplicateCleanup({
  scans,
  busy,
  onBulkReopen,
  onReopenOne,
  onRecheckAll,
  onPreview,
}: {
  scans: Scan[];
  busy: boolean;
  onBulkReopen: (scanIds: string[]) => void;
  onReopenOne: (scanId: string) => void;
  /** Reclassifies every auto-duplicate scan under the current rules. */
  onRecheckAll: () => void;
  onPreview: (preview: Preview) => void;
}) {
  // An unclassified scan (route couldn't match it) defaults to "likely false"
  // — safe, since the bulk action only sends scans to manual review.
  const likelyFalse = scans.filter(
    (s) => s.auto_duplicate_category !== "likely_true",
  );
  const likelyTrue = scans.filter(
    (s) => s.auto_duplicate_category === "likely_true",
  );

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState(true);

  // Selection is intersected with the rows still present, so ids that were
  // already reopened (and dropped from the list) are simply ignored.
  const falseIds = likelyFalse.map((s) => s.id);
  const selectedIds = falseIds.filter((id) => selected.has(id));
  const allSelected =
    likelyFalse.length > 0 && selectedIds.length === likelyFalse.length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(falseIds));

  return (
    <section className="mb-4 rounded-lg border border-orange-500/40 bg-orange-500/5 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            Auto-Duplicate Cleanup ({scans.length})
          </h3>
          <p className="text-xs text-muted-foreground">
            Old cards auto-flagged as duplicates, re-checked under the current
            rules. Sending cards back to review never approves anything — a
            human still decides.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRecheckAll}
            disabled={busy}
          >
            {busy ? "Working…" : "Re-run duplicate check"}
          </Button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="rounded-md border border-input bg-background px-3 py-1 text-xs font-medium text-foreground transition hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-4">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Likely false duplicates — needs review ({likelyFalse.length})
            </h4>
            {likelyFalse.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                None — no likely-false auto-duplicates.
              </p>
            ) : (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="size-4"
                    />
                    Select all visible
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {selectedIds.length} selected
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onBulkReopen(selectedIds)}
                    disabled={busy || selectedIds.length === 0}
                  >
                    {busy ? "Working…" : "Send selected back to review"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onBulkReopen(falseIds)}
                    disabled={busy || likelyFalse.length === 0}
                  >
                    Send all likely false back to review
                  </Button>
                </div>
                <ul className="mt-2 max-h-[420px] space-y-1.5 overflow-y-auto">
                  {likelyFalse.map((scan) => (
                    <AutoDuplicateRow
                      key={scan.id}
                      scan={scan}
                      selectable
                      checked={selected.has(scan.id)}
                      onToggle={() => toggle(scan.id)}
                      onPreview={onPreview}
                    />
                  ))}
                </ul>
              </>
            )}
          </div>

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Likely true duplicates ({likelyTrue.length})
            </h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              These look like real duplicates — not bulk-moved. Send one back
              individually only if you need to re-check it.
            </p>
            {likelyTrue.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="mt-2 max-h-[320px] space-y-1.5 overflow-y-auto">
                {likelyTrue.map((scan) => (
                  <AutoDuplicateRow
                    key={scan.id}
                    scan={scan}
                    onPreview={onPreview}
                    action={
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onReopenOne(scan.id)}
                        disabled={busy}
                      >
                        Send Back to Review
                      </Button>
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** One scan row inside the Auto-Duplicate Cleanup panel. */
function AutoDuplicateRow({
  scan,
  selectable = false,
  checked = false,
  onToggle,
  onPreview,
  action,
}: {
  scan: Scan;
  selectable?: boolean;
  checked?: boolean;
  onToggle?: () => void;
  onPreview: (preview: Preview) => void;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 rounded-md border bg-card p-2">
      {selectable && (
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="size-4 shrink-0"
          aria-label={`Select card from ${scan.salesperson_name ?? "unknown"}`}
        />
      )}
      <button
        type="button"
        onClick={() =>
          onPreview({
            url: scan.image_url,
            name: scan.salesperson_name ?? "unknown",
            rotation: scan.image_rotation_degrees ?? 0,
          })
        }
        className="shrink-0 overflow-hidden rounded border focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Preview business card"
      >
        <RotatableImage
          src={scan.image_url}
          alt=""
          rotation={scan.image_rotation_degrees ?? 0}
          className="size-14"
        />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {scan.extracted_full_name?.trim() ||
            scan.extracted_company?.trim() ||
            "Unnamed card"}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {scan.salesperson_name ?? "Unknown"}
          {scan.auto_duplicate_reason
            ? ` · ${scan.auto_duplicate_reason}`
            : ""}
        </p>
      </div>
      {action}
    </li>
  );
}

/**
 * Displays a scan image at its saved rotation. The image sits in a SQUARE box
 * with object-contain, so any 0/90/180/270 rotation always fits fully — never
 * clipped, never blurred. `className` sizes the square box.
 */
function RotatableImage({
  src,
  alt,
  rotation,
  className,
}: {
  src: string;
  alt: string;
  rotation: number;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-center overflow-hidden bg-muted ${
        className ?? ""
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        style={{ transform: `rotate(${rotation}deg)` }}
        className="max-h-full max-w-full object-contain transition-transform duration-200"
      />
    </div>
  );
}

/**
 * Rotate-left / rotate-right (+ reset) controls with an autosave indicator.
 * `onRotate` receives the new absolute rotation (0/90/180/270).
 */
function RotationControls({
  rotation,
  status,
  onRotate,
}: {
  rotation: number;
  status: RotationStatus | undefined;
  onRotate: (next: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onRotate(normalizeRotation(rotation - 90))}
        aria-label="Rotate image left"
      >
        <RotateCcw aria-hidden="true" />
        Left
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onRotate(normalizeRotation(rotation + 90))}
        aria-label="Rotate image right"
      >
        <RotateCw aria-hidden="true" />
        Right
      </Button>
      {rotation !== 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRotate(0)}
        >
          Reset
        </Button>
      )}
      {status === "saving" && (
        <span className="text-xs text-muted-foreground">Saving…</span>
      )}
      {status === "saved" && (
        <span className="text-xs text-emerald-600 dark:text-emerald-400">
          Saved
        </span>
      )}
      {status === "error" && (
        <span className="text-xs text-destructive">Save failed</span>
      )}
    </div>
  );
}

function ScanCard({
  scan,
  duplicateContact,
  retrying,
  retryDisabled,
  retryError,
  onRetry,
  actioning,
  actionsDisabled,
  onAction,
  onPreview,
  canEdit,
  onEdit,
  onReopen,
  rotationStatus,
  onRotate,
}: {
  scan: Scan;
  duplicateContact: DuplicateContact | undefined;
  retrying: boolean;
  retryDisabled: boolean;
  retryError: string | null;
  onRetry: () => void;
  actioning: boolean;
  actionsDisabled: boolean;
  onAction: (action: ActionKind) => void;
  onPreview: (preview: Preview) => void;
  /** True for admins — gates the Edit action (the route enforces it too). */
  canEdit: boolean;
  onEdit: () => void;
  /** Sends an auto-marked duplicate back to manual duplicate review. */
  onReopen: () => void;
  /** Current rotation autosave state for this scan. */
  rotationStatus: RotationStatus | undefined;
  /** Persists a new display rotation (autosaved) for this scan. */
  onRotate: (rotation: number) => void;
}) {
  const status = effectiveStatus(scan);
  const needsAction =
    status === "needs_review" || status === "duplicate_review";
  const isDuplicateReview = status === "duplicate_review";

  // Show the side-by-side comparison whenever this scan is tied to an existing
  // contact: an active duplicate review, a flagged possible duplicate, or any
  // scan that carries a duplicate_of_contact_id (covers auto_duplicate audits).
  const showDuplicatePanel =
    status === "duplicate_review" ||
    (scan.duplicate_status ?? "").toLowerCase().trim() ===
      "possible_duplicate" ||
    Boolean(scan.duplicate_of_contact_id);

  return (
    <li className="flex flex-col gap-4 rounded-lg border bg-card p-3 sm:flex-row sm:items-start">
      <div className="w-full shrink-0 self-start space-y-1.5 sm:w-72 md:w-96">
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
              rotation: scan.image_rotation_degrees ?? 0,
            });
          }}
          className="block overflow-hidden rounded-md border transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Expand business card image"
          title="Click to expand · ⌘/Ctrl-click to open in new tab"
        >
          <RotatableImage
            src={scan.image_url}
            alt={`Business card scanned by ${scan.salesperson_name ?? "unknown"}`}
            rotation={scan.image_rotation_degrees ?? 0}
            className="aspect-square w-full"
          />
        </a>
        <RotationControls
          rotation={scan.image_rotation_degrees ?? 0}
          status={rotationStatus}
          onRotate={onRotate}
        />
      </div>
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
        {showDuplicatePanel && (
          <DuplicateComparisonPanel scan={scan} contact={duplicateContact} />
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
            duplicateReview={isDuplicateReview}
            onAction={onAction}
            canEdit={canEdit}
            onEdit={onEdit}
          />
        )}
        {status === "auto_duplicate" && (
          <div className="flex flex-col gap-1.5 border-t pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReopen}
              disabled={actionsDisabled || actioning}
              className="self-start"
            >
              {actioning ? "Working…" : "Send Back to Review"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Auto-marked a duplicate. Send it back to manually approve it as a
              contact, confirm the duplicate, or reject it.
            </p>
          </div>
        )}
        <ExtractedFields scan={scan} />
      </div>
    </li>
  );
}

function ScanActions({
  busy,
  disabled,
  duplicateReview,
  onAction,
  canEdit,
  onEdit,
}: {
  busy: boolean;
  disabled: boolean;
  /** Duplicate-review cards get clearer, decision-specific button text. */
  duplicateReview: boolean;
  onAction: (action: ActionKind) => void;
  /** Admins get an Edit action to correct extracted fields before approving. */
  canEdit: boolean;
  onEdit: () => void;
}) {
  // Same three routes (approve / mark-duplicate / reject) either way — only
  // the labels change so a duplicate review reads as an explicit choice.
  const approveLabel = duplicateReview
    ? "Approve as New Contact"
    : "Approve as Contact";
  const duplicateLabel = duplicateReview
    ? "Confirm Duplicate"
    : "Mark Duplicate";
  const rejectLabel = duplicateReview ? "Reject Scan" : "Reject";

  return (
    <div className="flex flex-wrap gap-2 border-t pt-2">
      {canEdit && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onEdit}
          disabled={disabled || busy}
        >
          <Pencil aria-hidden="true" />
          Edit
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        onClick={() => onAction("approve")}
        disabled={disabled || busy}
      >
        {busy ? "Working…" : approveLabel}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onAction("mark-duplicate")}
        disabled={disabled || busy}
      >
        {duplicateLabel}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onAction("reject")}
        disabled={disabled || busy}
      >
        {rejectLabel}
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
        <RotatableImage
          src={preview.url}
          alt={`Business card scanned by ${preview.name}`}
          rotation={preview.rotation}
          className="aspect-square w-[min(85vh,92vw)] rounded-md shadow-2xl"
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

/**
 * Side-by-side comparison of a duplicate scan's new extraction against the
 * existing contact it was matched to. Read-only: this panel never edits,
 * merges, or deletes anything — it only helps Tonja decide.
 */
function DuplicateComparisonPanel({
  scan,
  contact,
}: {
  scan: Scan;
  contact: DuplicateContact | undefined;
}) {
  const matchedIdShort = scan.duplicate_of_contact_id
    ? scan.duplicate_of_contact_id.slice(0, 8)
    : null;

  const rows: Array<{
    label: string;
    scanValue: string | null;
    contactValue: string | null;
    compare: CompareKind;
  }> = [
    {
      label: "Full Name",
      scanValue: scan.extracted_full_name,
      contactValue: contact?.full_name ?? null,
      compare: "text",
    },
    {
      label: "Company",
      scanValue: scan.extracted_company,
      contactValue: contact?.company ?? null,
      compare: "text",
    },
    {
      label: "Title",
      scanValue: scan.extracted_title,
      contactValue: contact?.title ?? null,
      compare: "none",
    },
    {
      label: "Email",
      scanValue: scan.extracted_email,
      contactValue: contact?.email ?? null,
      compare: "email",
    },
    {
      label: "Phone",
      scanValue: scan.extracted_phone,
      contactValue: contact?.phone ?? null,
      compare: "phone",
    },
    {
      label: "Website",
      scanValue: scan.extracted_website,
      contactValue: contact?.website ?? null,
      compare: "none",
    },
    {
      label: "Address",
      scanValue: scan.extracted_address,
      contactValue: contact?.address ?? null,
      compare: "none",
    },
    {
      label: "Contact Bucket",
      scanValue: CONTACT_BUCKET_LABELS[normalizeScanContactType(scan)],
      contactValue: bucketLabel(contact?.contact_bucket ?? null),
      compare: "none",
    },
    {
      label: "Salesperson",
      scanValue: scan.salesperson_name,
      contactValue: contact?.salesperson_name ?? null,
      compare: "none",
    },
    {
      label: "Verification Status",
      scanValue: scan.verification_status,
      contactValue: contact?.verification_status ?? null,
      compare: "none",
    },
    {
      label: "Created",
      scanValue: formatTimestamp(scan.created_at),
      contactValue: contact?.created_at
        ? formatTimestamp(contact.created_at)
        : null,
      compare: "none",
    },
  ];

  return (
    <div className="rounded-md border border-orange-500/40 bg-orange-500/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-xs font-semibold uppercase tracking-wide text-orange-800 dark:text-orange-300">
          Duplicate Comparison
        </h5>
        {matchedIdShort && (
          <span className="text-[10px] text-muted-foreground">
            Matched contact #{matchedIdShort}
          </span>
        )}
      </div>

      {!contact ? (
        <p className="mt-2 text-sm italic text-muted-foreground">
          Matched contact could not be loaded.
        </p>
      ) : (
        <dl className="mt-3 space-y-2">
          <div className="grid grid-cols-2 gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>New Scanned Card</span>
            <span>Existing Contact Match</span>
          </div>
          {rows.map((row) => {
            const verdict = compareValues(
              row.compare,
              row.scanValue,
              row.contactValue,
            );
            return (
              <div
                key={row.label}
                className="border-t border-orange-500/20 pt-2"
              >
                <dt className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {row.label}
                  {verdict && <MatchBadge verdict={verdict} />}
                </dt>
                <dd className="mt-0.5 grid grid-cols-2 gap-2">
                  <ComparisonValue value={row.scanValue} />
                  <ComparisonValue value={row.contactValue} />
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

/** Subtle "Match" / "Different" label for an important comparison field. */
function MatchBadge({ verdict }: { verdict: "match" | "different" }) {
  const className =
    verdict === "match"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400";
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal ${className}`}
    >
      {verdict === "match" ? "Match" : "Different"}
    </span>
  );
}

/** One value cell inside the duplicate comparison grid. */
function ComparisonValue({ value }: { value: string | null }) {
  const hasValue = value !== null && value.trim().length > 0;
  return (
    <span className="min-w-0 break-words text-sm">
      {hasValue ? (
        value
      ) : (
        <span className="italic text-muted-foreground">—</span>
      )}
    </span>
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

/** A labeled form field inside the edit sheet. */
function SheetField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * Admin-only centered modal for correcting a scan's extracted contact fields
 * before it is approved into a contact. The card image sits beside the form
 * (stacked on mobile) so the admin can read the card while editing — the image
 * is never blurred. Save persists via the admin-guarded
 * /api/business-card/update-scan route; the Verification Center then refreshes.
 * After editing, the admin can still approve / reject / mark-duplicate.
 */
function EditScanSheet({
  scan,
  saving,
  error,
  rotationStatus,
  onRotate,
  onSave,
  onClose,
}: {
  scan: Scan;
  saving: boolean;
  error: string | null;
  rotationStatus: RotationStatus | undefined;
  onRotate: (rotation: number) => void;
  onSave: (scanId: string, fields: EditableScanFields) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    first_name: scan.extracted_first_name ?? "",
    last_name: scan.extracted_last_name ?? "",
    full_name: scan.extracted_full_name ?? "",
    company: scan.extracted_company ?? "",
    title: scan.extracted_title ?? "",
    email: scan.extracted_email ?? "",
    phone: scan.extracted_phone ?? "",
    website: scan.extracted_website ?? "",
    address: scan.extracted_address ?? "",
  });
  // Bucket is editable as a 3-way choice; it starts from the scan's derived
  // contact-type bucket.
  const [bucket, setBucket] = useState<ContactBucket>(() =>
    normalizeScanContactType(scan),
  );

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

  const set = (key: keyof typeof form, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    onSave(scan.id, { ...form, contact_type: BUCKET_CONTACT_TYPE[bucket] });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit contact details"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-background shadow-2xl"
      >
        <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Edit Contact</h2>
            <p className="text-xs text-muted-foreground">
              Compare the card to the fields, fix what AI missed, then approve.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close edit"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:flex-row">
            {/* Card image — left on desktop, stacked on top on mobile. Sits
                inside the modal (never blurred) so it can be read against the
                fields. */}
            <div className="space-y-2 sm:w-2/5 sm:shrink-0">
              <a
                href={scan.image_url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open the full image in a new tab"
                className="block overflow-hidden rounded-md border focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotatableImage
                  src={scan.image_url}
                  alt="Scanned business card"
                  rotation={scan.image_rotation_degrees ?? 0}
                  className="aspect-square w-full"
                />
              </a>
              <RotationControls
                rotation={scan.image_rotation_degrees ?? 0}
                status={rotationStatus}
                onRotate={onRotate}
              />
            </div>
            {/* Editable fields — right on desktop, below the image on mobile. */}
            <div className="min-w-0 flex-1 space-y-3">
              <div className="grid grid-cols-2 gap-2">
              <SheetField label="First name">
                <Input
                  value={form.first_name}
                  onChange={(e) => set("first_name", e.target.value)}
                />
              </SheetField>
              <SheetField label="Last name">
                <Input
                  value={form.last_name}
                  onChange={(e) => set("last_name", e.target.value)}
                />
              </SheetField>
            </div>
            <SheetField label="Full name">
              <Input
                value={form.full_name}
                onChange={(e) => set("full_name", e.target.value)}
              />
            </SheetField>
            <SheetField label="Company">
              <Input
                value={form.company}
                onChange={(e) => set("company", e.target.value)}
              />
            </SheetField>
            <SheetField label="Title">
              <Input
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
              />
            </SheetField>
            <SheetField label="Email">
              <Input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
              />
            </SheetField>
            <SheetField label="Phone">
              <Input
                type="tel"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
              />
            </SheetField>
            <SheetField label="Website">
              <Input
                type="url"
                value={form.website}
                onChange={(e) => set("website", e.target.value)}
              />
            </SheetField>
            <SheetField label="Address">
              <textarea
                value={form.address}
                rows={2}
                onChange={(e) => set("address", e.target.value)}
                className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
              />
            </SheetField>
            <SheetField label="Contact type / bucket">
              <select
                value={bucket}
                onChange={(e) => setBucket(e.target.value as ContactBucket)}
                className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {CONTACT_BUCKET_ORDER.map((value) => (
                  <option key={value} value={value}>
                    {CONTACT_BUCKET_LABELS[value]}
                  </option>
                ))}
              </select>
            </SheetField>

            {error && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}
            </div>
          </div>

          <footer className="flex gap-2 border-t px-4 py-3">
            <Button type="submit" className="flex-1" disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}
