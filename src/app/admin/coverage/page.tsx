"use client";

import { useCallback, useEffect, useState } from "react";

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
import { Label } from "@/components/ui/label";

// TEMPORARY admin testing surface for Coverage Intelligence Phase 2.
// Register brochures, list them, run extraction, and inspect the summary.
// NO review workflow here yet — extracted rows land as review_status='pending'
// and are not surfaced/approved on this page. Admin-gated by /admin/layout.tsx
// (client) and by requireAdmin on every /api/admin/coverage/* route (server).

type Brochure = {
  id: string;
  stateCode: string;
  brochureTitle: string;
  brochureVersion: string | null;
  effectiveDate: string | null;
  sourceUrl: string | null;
  fileHash: string | null;
  importedAt: string;
  status: string;
  notes: string | null;
};

type InsertCount = { inserted: number; skipped: number };

type ExtractSummary = {
  brochureId: string;
  stateCode: string;
  fileHash: string;
  hashAction: "backfilled" | "verified";
  pagesTotal: number;
  pagesWithText: number;
  pagesExtracted: number;
  pagesCapped: boolean;
  candidates: { coverageItems: number; pricing: number; addons: number };
  pending: {
    coverageItems: InsertCount;
    pricing: InsertCount;
    addons: InsertCount;
  };
  note: string;
};

const EMPTY_FORM = {
  stateCode: "",
  brochureTitle: "",
  brochureVersion: "",
  effectiveDate: "",
  sourceUrl: "",
  notes: "",
};

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function AdminCoveragePage() {
  useScrollToTop();

  const [brochures, setBrochures] = useState<Brochure[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerOk, setRegisterOk] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [summaries, setSummaries] = useState<Record<string, ExtractSummary>>({});

  const loadBrochures = useCallback(async () => {
    setListError(null);
    try {
      const data = await apiFetchJson<{ brochures: Brochure[] }>(
        "/api/admin/coverage/brochures",
      );
      setBrochures(data.brochures ?? []);
    } catch (err) {
      setListError(errMessage(err, "Couldn't load brochures."));
      setBrochures([]);
    }
  }, []);

  useEffect(() => {
    void loadBrochures();
  }, [loadBrochures]);

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    if (registering) return;
    setRegisterError(null);
    setRegisterOk(null);
    setRegistering(true);
    try {
      const body: Record<string, string> = {
        stateCode: form.stateCode.trim().toUpperCase(),
        brochureTitle: form.brochureTitle.trim(),
      };
      if (form.brochureVersion.trim()) body.brochureVersion = form.brochureVersion.trim();
      if (form.effectiveDate.trim()) body.effectiveDate = form.effectiveDate.trim();
      if (form.sourceUrl.trim()) body.sourceUrl = form.sourceUrl.trim();
      if (form.notes.trim()) body.notes = form.notes.trim();

      const data = await apiFetchJson<{ brochure: Brochure }>(
        "/api/admin/coverage/brochures",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setRegisterOk(
        `Registered ${data.brochure.brochureTitle} (${data.brochure.stateCode}).`,
      );
      setForm({ ...EMPTY_FORM });
      await loadBrochures();
    } catch (err) {
      setRegisterError(errMessage(err, "Could not register the brochure."));
    } finally {
      setRegistering(false);
    }
  };

  const runExtraction = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setRowError((prev) => ({ ...prev, [id]: "" }));
    try {
      const summary = await apiFetchJson<ExtractSummary>(
        `/api/admin/coverage/brochures/${id}/extract`,
        { method: "POST" },
      );
      setSummaries((prev) => ({ ...prev, [id]: summary }));
      await loadBrochures(); // file_hash may have been backfilled
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [id]: errMessage(err, "Extraction failed."),
      }));
    } finally {
      setBusyId(null);
    }
  };

  const promote = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setRowError((prev) => ({ ...prev, [id]: "" }));
    try {
      await apiFetchJson<{ brochure: Brochure }>(
        `/api/admin/coverage/brochures/${id}/promote`,
        { method: "POST" },
      );
      await loadBrochures();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [id]: errMessage(err, "Promotion failed."),
      }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold tracking-tight">
          Coverage Intelligence
        </h1>
        <p className="text-sm text-muted-foreground">
          Phase 2 testing surface. Register a brochure, run extraction, and
          inspect the result. Extracted rows are saved as{" "}
          <span className="font-medium">pending</span> review — nothing is
          approved or served to the AI Assistant yet.
        </p>
      </header>

      {/* Register */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Register a brochure</CardTitle>
          <CardDescription>
            Source URL must be https on an allowed Elevate host.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={register} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="stateCode">State (2-letter)</Label>
                <Input
                  id="stateCode"
                  value={form.stateCode}
                  maxLength={2}
                  placeholder="UT"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, stateCode: e.target.value }))
                  }
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="brochureVersion">Version (optional)</Label>
                <Input
                  id="brochureVersion"
                  value={form.brochureVersion}
                  placeholder="2025.7"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, brochureVersion: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="brochureTitle">Title</Label>
              <Input
                id="brochureTitle"
                value={form.brochureTitle}
                placeholder="Utah Home Warranty Brochure"
                onChange={(e) =>
                  setForm((f) => ({ ...f, brochureTitle: e.target.value }))
                }
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="sourceUrl">Source URL (PDF)</Label>
              <Input
                id="sourceUrl"
                type="url"
                value={form.sourceUrl}
                placeholder="https://app.elevateh.com/.../utah.pdf"
                onChange={(e) =>
                  setForm((f) => ({ ...f, sourceUrl: e.target.value }))
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="effectiveDate">Effective date (optional)</Label>
                <Input
                  id="effectiveDate"
                  type="date"
                  value={form.effectiveDate}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, effectiveDate: e.target.value }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="notes">Notes (optional)</Label>
                <Input
                  id="notes"
                  value={form.notes}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, notes: e.target.value }))
                  }
                />
              </div>
            </div>
            {registerError && (
              <p className="text-sm text-destructive">{registerError}</p>
            )}
            {registerOk && (
              <p className="text-sm text-primary">{registerOk}</p>
            )}
            <div>
              <Button type="submit" size="sm" disabled={registering}>
                {registering ? "Registering…" : "Register brochure"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* List */}
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span>Brochures</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadBrochures()}
            >
              Refresh
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {listError && <p className="text-sm text-destructive">{listError}</p>}
          {brochures === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : brochures.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No brochures registered yet.
            </p>
          ) : (
            brochures.map((b) => {
              const summary = summaries[b.id];
              const error = rowError[b.id];
              const busy = busyId === b.id;
              return (
                <div
                  key={b.id}
                  className="rounded-lg border border-border/70 bg-card px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold">
                      {b.stateCode}
                    </span>
                    <span className="text-sm font-medium">
                      {b.brochureTitle}
                    </span>
                    {b.brochureVersion && (
                      <span className="text-xs text-muted-foreground">
                        v{b.brochureVersion}
                      </span>
                    )}
                    <span
                      className={
                        b.status === "current"
                          ? "rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary"
                          : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground"
                      }
                    >
                      {b.status}
                    </span>
                  </div>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {b.sourceUrl ?? "(no source URL)"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    file_hash:{" "}
                    {b.fileHash ? `${b.fileHash.slice(0, 12)}…` : "(none yet)"}
                  </p>

                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !b.sourceUrl}
                      onClick={() => void runExtraction(b.id)}
                    >
                      {busy ? "Working…" : "Run extraction"}
                    </Button>
                    {b.status !== "current" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void promote(b.id)}
                      >
                        Make current
                      </Button>
                    )}
                  </div>

                  {error && (
                    <p className="mt-2 text-sm text-destructive">{error}</p>
                  )}

                  {summary && (
                    <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
                      <p>
                        hash <span className="font-medium">{summary.hashAction}</span>{" "}
                        · pages {summary.pagesWithText}/{summary.pagesTotal} with
                        text, {summary.pagesExtracted} scanned
                        {summary.pagesCapped ? " (capped)" : ""}
                      </p>
                      <p className="mt-1">
                        candidates — coverage {summary.candidates.coverageItems},
                        pricing {summary.candidates.pricing}, add-ons{" "}
                        {summary.candidates.addons}
                      </p>
                      <p>
                        pending inserted — coverage{" "}
                        {summary.pending.coverageItems.inserted} (
                        {summary.pending.coverageItems.skipped} skipped), pricing{" "}
                        {summary.pending.pricing.inserted} (
                        {summary.pending.pricing.skipped} skipped), add-ons{" "}
                        {summary.pending.addons.inserted} (
                        {summary.pending.addons.skipped} skipped)
                      </p>
                      <p className="mt-1 italic text-muted-foreground">
                        {summary.note}
                      </p>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
