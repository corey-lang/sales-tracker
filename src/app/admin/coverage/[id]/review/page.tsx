"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { apiFetchJson } from "@/lib/api-client";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// Admin review of PENDING extracted rows for one brochure. Approve / reject /
// edit-then-approve. Approved rows are brochure-backed and source-cited;
// provenance (source_text / source_page) is shown read-only and never edited.
// No AI Assistant integration.

type Brochure = {
  id: string;
  stateCode: string;
  brochureTitle: string;
  brochureVersion: string | null;
  status: string;
};

type Coverage = {
  id: string;
  stateCode: string;
  planName: string;
  coverageItem: string;
  included: boolean | null;
  coverageLimit: number | null;
  coverageLimitText: string | null;
  sourceText: string | null;
  sourcePage: number | null;
  confidence: number | null;
};
type Pricing = {
  id: string;
  stateCode: string;
  planName: string;
  priceAmount: number | null;
  priceCadence: string | null;
  currencyCode: string;
  priceText: string | null;
  sourceText: string | null;
  sourcePage: number | null;
  confidence: number | null;
};
type Addon = {
  id: string;
  stateCode: string;
  addonName: string;
  planName: string | null;
  includedInPlan: boolean | null;
  availableAsAddon: boolean | null;
  addonPriceAmount: number | null;
  addonPriceCadence: string | null;
  currencyCode: string;
  addonPriceText: string | null;
  coverageLimit: number | null;
  coverageLimitText: string | null;
  sourceText: string | null;
  sourcePage: number | null;
  confidence: number | null;
};
type Pending = { coverage: Coverage[]; pricing: Pricing[]; addons: Addon[] };

const CADENCES = [
  "one_time",
  "monthly",
  "quarterly",
  "semi_annual",
  "annual",
  "per_term",
  "per_service_request",
  "other",
];

const SELECT_CLASS =
  "h-9 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:border-primary";
const FIELD_LABEL = "text-[11px] font-medium uppercase tracking-wide text-muted-foreground";

/** Human labels for the changed-fields summary. */
const FIELD_LABELS: Record<string, string> = {
  planName: "plan",
  coverageItem: "coverage item",
  included: "included",
  coverageLimit: "limit",
  coverageLimitText: "limit text",
  priceAmount: "price",
  priceCadence: "cadence",
  currencyCode: "currency",
  priceText: "price text",
  addonName: "add-on",
  includedInPlan: "included in plan",
  availableAsAddon: "available as add-on",
  addonPriceAmount: "add-on price",
  addonPriceText: "price text",
};

function ChangedSummary({ keys }: { keys: string[] }) {
  if (keys.length === 0) return null;
  return (
    <p className="mt-2 text-xs text-primary">
      Will save edits: {keys.map((k) => FIELD_LABELS[k] ?? k).join(", ")}
    </p>
  );
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Tri-state <select> for boolean | null. */
function TriState({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const str = value === null ? "unknown" : value ? "true" : "false";
  return (
    <select
      className={SELECT_CLASS}
      value={str}
      onChange={(e) =>
        onChange(
          e.target.value === "unknown" ? null : e.target.value === "true",
        )
      }
    >
      <option value="true">Yes</option>
      <option value="false">No</option>
      <option value="unknown">Unknown</option>
    </select>
  );
}

function numToInput(n: number | null): string {
  return n === null || n === undefined ? "" : String(n);
}
function inputToNum(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function Provenance({
  state,
  page,
  confidence,
  sourceText,
}: {
  state: string;
  page: number | null;
  confidence: number | null;
  sourceText: string | null;
}) {
  return (
    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-x-3">
        <span>state {state}</span>
        <span>page {page ?? "—"}</span>
        <span>
          confidence {confidence === null ? "—" : confidence.toFixed(2)}
        </span>
      </div>
      <p className="rounded bg-muted/40 px-2 py-1 italic">
        “{sourceText ?? "(no source text)"}”
      </p>
    </div>
  );
}

export default function CoverageReviewPage() {
  useScrollToTop();
  const params = useParams<{ id: string }>();
  const brochureId = params.id;

  const [brochure, setBrochure] = useState<Brochure | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await apiFetchJson<{ brochure: Brochure; pending: Pending }>(
        `/api/admin/coverage/brochures/${brochureId}/pending`,
      );
      setBrochure(data.brochure);
      setPending(data.pending);
    } catch (err) {
      setLoadError(errMessage(err, "Couldn't load pending rows."));
    }
  }, [brochureId]);

  useEffect(() => {
    // load() updates state after an async fetch; the initial reset is the
    // canonical on-mount pattern despite the set-state-in-effect rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const review = useCallback(
    async (
      kind: "coverage" | "pricing" | "addons",
      rowId: string,
      action: "approve" | "reject",
      edits?: Record<string, unknown>,
    ) => {
      const body: Record<string, unknown> = { action };
      if (action === "approve" && edits && Object.keys(edits).length > 0) {
        body.edits = edits;
      }
      await apiFetchJson(`/api/admin/coverage/review/${kind}/${rowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // Drop the row from view on success (it's no longer pending).
      setPending((prev) =>
        prev
          ? {
              ...prev,
              [kind]: prev[kind].filter((r: { id: string }) => r.id !== rowId),
            }
          : prev,
      );
    },
    [],
  );

  const totalPending = pending
    ? pending.coverage.length + pending.pricing.length + pending.addons.length
    : 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Review pending</h1>
          {brochure && (
            <p className="text-sm text-muted-foreground">
              {brochure.stateCode} · {brochure.brochureTitle}
              {brochure.brochureVersion ? ` · v${brochure.brochureVersion}` : ""}{" "}
              · {brochure.status}
            </p>
          )}
        </div>
        <Link
          href="/admin/coverage"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          ← Back
        </Link>
      </header>

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}

      {pending && totalPending === 0 && !loadError && (
        <p className="text-sm text-muted-foreground">
          No pending rows. Run extraction first, or everything has been
          reviewed.
        </p>
      )}

      {/* Coverage */}
      {pending && pending.coverage.length > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Coverage ({pending.coverage.length})</CardTitle>
            <CardDescription>Plan coverage items.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pending.coverage.map((r) => (
              <CoverageRow key={r.id} row={r} onReview={review} />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Pricing */}
      {pending && pending.pricing.length > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Pricing ({pending.pricing.length})</CardTitle>
            <CardDescription>Plan pricing (brochure-stated only).</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pending.pricing.map((r) => (
              <PricingRow key={r.id} row={r} onReview={review} />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Add-ons */}
      {pending && pending.addons.length > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Add-ons ({pending.addons.length})</CardTitle>
            <CardDescription>Optional add-on catalog.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pending.addons.map((r) => (
              <AddonRow key={r.id} row={r} onReview={review} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

type ReviewFn = (
  kind: "coverage" | "pricing" | "addons",
  rowId: string,
  action: "approve" | "reject",
  edits?: Record<string, unknown>,
) => Promise<void>;

function NotesInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="mt-2 flex flex-col gap-1">
      <span className={FIELD_LABEL}>Reviewer notes (optional)</span>
      <Input
        value={value}
        placeholder="e.g. reason for rejection, or a correction note"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function RowShell({
  children,
  busy,
  error,
  summary,
  onApprove,
  onReject,
}: {
  children: React.ReactNode;
  busy: boolean;
  error: string | null;
  summary?: React.ReactNode;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-card px-3 py-2">
      {children}
      {summary}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-2 flex gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onApprove}>
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onReject}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

function CoverageRow({ row, onReview }: { row: Coverage; onReview: ReviewFn }) {
  const [planName, setPlanName] = useState(row.planName);
  const [coverageItem, setCoverageItem] = useState(row.coverageItem);
  const [included, setIncluded] = useState<boolean | null>(row.included);
  const [coverageLimit, setCoverageLimit] = useState(numToInput(row.coverageLimit));
  const [limitText, setLimitText] = useState(row.coverageLimitText ?? "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildEdits = (): Record<string, unknown> => {
    const e: Record<string, unknown> = {};
    if (planName !== row.planName) e.planName = planName.trim();
    if (coverageItem !== row.coverageItem) e.coverageItem = coverageItem.trim();
    if (included !== row.included) e.included = included;
    const limitNum = inputToNum(coverageLimit);
    if (limitNum !== row.coverageLimit) e.coverageLimit = limitNum;
    const lt = limitText.trim() || null;
    if (lt !== row.coverageLimitText) e.coverageLimitText = lt;
    return e;
  };

  const run = async (action: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const edits = buildEdits();
      if (notes.trim()) edits.notes = notes.trim();
      await onReview("coverage", row.id, action, edits);
    } catch (err) {
      setError(errMessage(err, "Review failed."));
      setBusy(false);
    }
  };

  return (
    <RowShell
      busy={busy}
      error={error}
      summary={<ChangedSummary keys={Object.keys(buildEdits())} />}
      onApprove={() => void run("approve")}
      onReject={() => void run("reject")}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Plan</span>
          <Input value={planName} onChange={(e) => setPlanName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Coverage item</span>
          <Input
            value={coverageItem}
            onChange={(e) => setCoverageItem(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Included</span>
          <TriState value={included} onChange={setIncluded} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Limit (number)</span>
          <Input
            type="number"
            value={coverageLimit}
            onChange={(e) => setCoverageLimit(e.target.value)}
          />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className={FIELD_LABEL}>Limit text</span>
          <Input value={limitText} onChange={(e) => setLimitText(e.target.value)} />
        </label>
      </div>
      <Provenance
        state={row.stateCode}
        page={row.sourcePage}
        confidence={row.confidence}
        sourceText={row.sourceText}
      />
      <NotesInput value={notes} onChange={setNotes} />
    </RowShell>
  );
}

function PricingRow({ row, onReview }: { row: Pricing; onReview: ReviewFn }) {
  const [planName, setPlanName] = useState(row.planName);
  const [priceAmount, setPriceAmount] = useState(numToInput(row.priceAmount));
  const [priceCadence, setPriceCadence] = useState(row.priceCadence ?? "");
  const [currencyCode, setCurrencyCode] = useState(row.currencyCode);
  const [priceText, setPriceText] = useState(row.priceText ?? "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildEdits = (): Record<string, unknown> => {
    const e: Record<string, unknown> = {};
    if (planName !== row.planName) e.planName = planName.trim();
    const amt = inputToNum(priceAmount);
    if (amt !== row.priceAmount) e.priceAmount = amt;
    const cad = priceCadence || null;
    if (cad !== row.priceCadence) e.priceCadence = cad;
    if (currencyCode.trim().toUpperCase() !== row.currencyCode)
      e.currencyCode = currencyCode.trim();
    const pt = priceText.trim() || null;
    if (pt !== row.priceText) e.priceText = pt;
    return e;
  };

  const run = async (action: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const edits = buildEdits();
      if (notes.trim()) edits.notes = notes.trim();
      await onReview("pricing", row.id, action, edits);
    } catch (err) {
      setError(errMessage(err, "Review failed."));
      setBusy(false);
    }
  };

  return (
    <RowShell
      busy={busy}
      error={error}
      summary={<ChangedSummary keys={Object.keys(buildEdits())} />}
      onApprove={() => void run("approve")}
      onReject={() => void run("reject")}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 flex flex-col gap-1">
          <span className={FIELD_LABEL}>Plan</span>
          <Input value={planName} onChange={(e) => setPlanName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Price (number)</span>
          <Input
            type="number"
            value={priceAmount}
            onChange={(e) => setPriceAmount(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Cadence</span>
          <select
            className={SELECT_CLASS}
            value={priceCadence}
            onChange={(e) => setPriceCadence(e.target.value)}
          >
            <option value="">(none)</option>
            {CADENCES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Currency</span>
          <Input
            value={currencyCode}
            maxLength={3}
            onChange={(e) => setCurrencyCode(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Price text</span>
          <Input value={priceText} onChange={(e) => setPriceText(e.target.value)} />
        </label>
      </div>
      <Provenance
        state={row.stateCode}
        page={row.sourcePage}
        confidence={row.confidence}
        sourceText={row.sourceText}
      />
      <NotesInput value={notes} onChange={setNotes} />
    </RowShell>
  );
}

function AddonRow({ row, onReview }: { row: Addon; onReview: ReviewFn }) {
  const [addonName, setAddonName] = useState(row.addonName);
  const [planName, setPlanName] = useState(row.planName ?? "");
  const [includedInPlan, setIncludedInPlan] = useState<boolean | null>(
    row.includedInPlan,
  );
  const [availableAsAddon, setAvailableAsAddon] = useState<boolean | null>(
    row.availableAsAddon,
  );
  const [priceAmount, setPriceAmount] = useState(numToInput(row.addonPriceAmount));
  const [priceText, setPriceText] = useState(row.addonPriceText ?? "");
  const [limitText, setLimitText] = useState(row.coverageLimitText ?? "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildEdits = (): Record<string, unknown> => {
    const e: Record<string, unknown> = {};
    if (addonName !== row.addonName) e.addonName = addonName.trim();
    const pn = planName.trim() || null;
    if (pn !== row.planName) e.planName = pn;
    if (includedInPlan !== row.includedInPlan) e.includedInPlan = includedInPlan;
    if (availableAsAddon !== row.availableAsAddon)
      e.availableAsAddon = availableAsAddon;
    const amt = inputToNum(priceAmount);
    if (amt !== row.addonPriceAmount) e.addonPriceAmount = amt;
    const pt = priceText.trim() || null;
    if (pt !== row.addonPriceText) e.addonPriceText = pt;
    const lt = limitText.trim() || null;
    if (lt !== row.coverageLimitText) e.coverageLimitText = lt;
    return e;
  };

  const run = async (action: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const edits = buildEdits();
      if (notes.trim()) edits.notes = notes.trim();
      await onReview("addons", row.id, action, edits);
    } catch (err) {
      setError(errMessage(err, "Review failed."));
      setBusy(false);
    }
  };

  return (
    <RowShell
      busy={busy}
      error={error}
      summary={<ChangedSummary keys={Object.keys(buildEdits())} />}
      onApprove={() => void run("approve")}
      onReject={() => void run("reject")}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Add-on</span>
          <Input value={addonName} onChange={(e) => setAddonName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Plan (optional)</span>
          <Input value={planName} onChange={(e) => setPlanName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Included in plan</span>
          <TriState value={includedInPlan} onChange={setIncludedInPlan} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Available as add-on</span>
          <TriState value={availableAsAddon} onChange={setAvailableAsAddon} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Add-on price (number)</span>
          <Input
            type="number"
            value={priceAmount}
            onChange={(e) => setPriceAmount(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Price text</span>
          <Input value={priceText} onChange={(e) => setPriceText(e.target.value)} />
        </label>
        <label className="col-span-2 flex flex-col gap-1">
          <span className={FIELD_LABEL}>Limit text</span>
          <Input value={limitText} onChange={(e) => setLimitText(e.target.value)} />
        </label>
      </div>
      <Provenance
        state={row.stateCode}
        page={row.sourcePage}
        confidence={row.confidence}
        sourceText={row.sourceText}
      />
      <NotesInput value={notes} onChange={setNotes} />
    </RowShell>
  );
}
