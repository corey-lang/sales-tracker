"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { apiFetchJson } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Brochure overview — the "can I trust this extraction?" surface. Shows the
// extraction scorecard and a one-click "Approve & Publish" that approves the
// trustworthy (non-exception) pending rows and promotes the brochure to
// current, holding low-confidence / flagged rows as pending for spot-check.

type Brochure = {
  id: string;
  stateCode: string;
  brochureTitle: string;
  brochureVersion: string | null;
  status: string;
  trusted: boolean;
};

type SampleRow = {
  kind: "coverage" | "pricing" | "addons";
  id: string;
  sourcePage: number | null;
  sourceText: string | null;
  summary: string;
};

type Scorecard = {
  threshold: number;
  pendingTotal: number;
  byKind: { coverage: number; pricing: number; addons: number };
  confidence: { high: number; medium: number; low: number };
  flags: {
    missingSource: number;
    missingPage: number;
    missingPlan: number;
    missingPrice: number;
    duplicate: number;
    lowConfidence: number;
    citationMismatch: number;
    planUnverified: number;
    valueUnverified: number;
  };
  eligible: number;
  held: number;
  pages: { withFacts: number; min: number | null; max: number | null };
  sample: SampleRow[];
};

type PublishResult = {
  approved: number;
  held: number;
  eligible: number;
  threshold: number;
  published: boolean;
  publishNote: string | null;
};

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number | string;
  highlight?: "good" | "warn";
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2",
        highlight === "good"
          ? "border-primary/40 bg-primary/5"
          : highlight === "warn"
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-border bg-card",
      )}
    >
      <p className="text-lg font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export default function BrochureOverviewPage() {
  useScrollToTop();
  const params = useParams<{ id: string }>();
  const brochureId = params.id;

  const [brochure, setBrochure] = useState<Brochure | null>(null);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    setConfirmed(false); // re-confirm against the freshly sampled rows
    try {
      const data = await apiFetchJson<{
        brochure: Brochure;
        scorecard: Scorecard;
      }>(`/api/admin/coverage/brochures/${brochureId}/scorecard`);
      setBrochure(data.brochure);
      setScorecard(data.scorecard);
    } catch (err) {
      setLoadError(errMessage(err, "Couldn't load the extraction scorecard."));
    }
  }, [brochureId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const approveAndPublish = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setResultMsg(null);
    try {
      const data = await apiFetchJson<{ result: PublishResult }>(
        `/api/admin/coverage/brochures/${brochureId}/approve-publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmedSampleReview: true }),
        },
      );
      const r = data.result;
      setResultMsg(
        `Approved ${r.approved} eligible row(s)${r.published ? " and published the brochure as current" : ""}.` +
          (r.publishNote ? ` ${r.publishNote}` : ""),
      );
      await load();
    } catch (err) {
      setActionError(errMessage(err, "Approve & publish failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Brochure overview</h1>
          {brochure && (
            <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              <span>
                {brochure.stateCode} · {brochure.brochureTitle}
                {brochure.brochureVersion ? ` · v${brochure.brochureVersion}` : ""}{" "}
                · {brochure.status}
              </span>
              {brochure.trusted && (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-600">
                  trusted · floor 0.50
                </span>
              )}
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

      {scorecard && (
        <>
          <Card size="sm">
            <CardHeader>
              <CardTitle>Extraction scorecard</CardTitle>
              <CardDescription>
                The brochure is the source of truth — these signals are about
                trusting the <em>extraction</em>, not the brochure. Threshold:
                confidence ≥ {scorecard.threshold.toFixed(2)}.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="pending total" value={scorecard.pendingTotal} />
                <Stat
                  label="eligible to publish"
                  value={scorecard.eligible}
                  highlight="good"
                />
                <Stat
                  label="held (exceptions)"
                  value={scorecard.held}
                  highlight={scorecard.held > 0 ? "warn" : undefined}
                />
              </div>

              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Confidence
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="high ≥0.85" value={scorecard.confidence.high} />
                  <Stat label="medium" value={scorecard.confidence.medium} />
                  <Stat label="low <0.65" value={scorecard.confidence.low} />
                </div>
              </div>

              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Quality flags
                </p>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  <Stat label="missing source" value={scorecard.flags.missingSource} />
                  <Stat label="missing page" value={scorecard.flags.missingPage} />
                  <Stat label="missing plan" value={scorecard.flags.missingPlan} />
                  <Stat label="missing price" value={scorecard.flags.missingPrice} />
                  <Stat label="duplicate" value={scorecard.flags.duplicate} />
                  <Stat label="low conf" value={scorecard.flags.lowConfidence} />
                  <Stat
                    label="citation mismatch"
                    value={scorecard.flags.citationMismatch}
                  />
                  <Stat
                    label="plan unverified"
                    value={scorecard.flags.planUnverified}
                  />
                  <Stat
                    label="value unverified"
                    value={scorecard.flags.valueUnverified}
                  />
                </div>
              </div>

              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  By kind
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="coverage" value={scorecard.byKind.coverage} />
                  <Stat label="pricing" value={scorecard.byKind.pricing} />
                  <Stat label="add-ons" value={scorecard.byKind.addons} />
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                Pages with facts: {scorecard.pages.withFacts}
                {scorecard.pages.min != null
                  ? ` (p${scorecard.pages.min}–${scorecard.pages.max})`
                  : ""}
              </p>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle>Publish</CardTitle>
              <CardDescription>
                Approves the {scorecard.eligible} trustworthy row(s) and makes
                this brochure current. The {scorecard.held} exception(s) stay
                pending for review.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {scorecard.eligible === 0 ? (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
                  No eligible rows to publish — every pending row is an
                  exception. Review them first.
                </p>
              ) : (
                <>
                  {/* Spot-check sample */}
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Spot-check sample ({scorecard.sample.length} random
                      eligible rows)
                    </p>
                    <div className="flex flex-col gap-2">
                      {scorecard.sample.map((s) => (
                        <div
                          key={`${s.kind}:${s.id}`}
                          className="rounded-lg border border-border/70 bg-card px-3 py-2 text-sm"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                              {s.kind}
                            </span>
                            <span className="font-medium">{s.summary}</span>
                            <span className="text-xs text-muted-foreground">
                              page {s.sourcePage ?? "—"}
                            </span>
                          </div>
                          <p className="mt-1 rounded bg-muted/40 px-2 py-1 text-xs italic text-muted-foreground">
                            “{s.sourceText ?? "(no source text)"}”
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    I spot-checked the sample and confirm the eligible rows look
                    accurate.
                  </label>
                </>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || scorecard.eligible === 0 || !confirmed}
                  onClick={() => void approveAndPublish()}
                >
                  {busy
                    ? "Working…"
                    : `Approve & Publish (${scorecard.eligible} eligible)`}
                </Button>
                <Link
                  href={`/admin/coverage/${brochureId}/review`}
                  className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-[0.8rem] font-medium transition-colors hover:bg-muted"
                >
                  Review {scorecard.held} exception(s) →
                </Link>
              </div>
              {resultMsg && <p className="text-sm text-primary">{resultMsg}</p>}
              {actionError && (
                <p className="text-sm text-destructive">{actionError}</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
