"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, AlertTriangle, History, MapPin } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { useSalesperson } from "@/lib/use-salesperson";
import { useLivePermissions } from "@/lib/use-live-permissions";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { formatActivityStamp } from "@/lib/dates";
import type { OfficeDetail, OfficeRow, OfficeVisitRow } from "@/lib/offices";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Office Detail — Phase 1A test-only surface.
//
// Flow:
//   Office → Read Notes → Update Next Action → Log Visit → Move on.
//
// Access (mirrors /api/offices/[id]):
//   * `is_test === true` salesperson — passes.
//   * juice_box_only — redirected to /juice-box.
//   * Anyone else — redirected to /dashboard.
//
// Live permission state comes from /api/me/permissions, but `is_test` is not
// part of that payload (it's a static account property — granting / revoking
// the test flag at runtime isn't a use case). The cached session's `is_test`
// is the authority for visibility; the server still re-checks via
// `requireTestAccount` on every read + write.
//
// Sandbox banner is intentionally loud — this surface MUST NOT silently
// graduate to real AEs.
// ---------------------------------------------------------------------------

type DetailResponse = { detail: OfficeDetail };
type PatchResponse = { office: OfficeRow };
type VisitResponse = { visit: OfficeVisitRow };
type ApiError = { error?: string };

function formatAddress(office: OfficeRow): string {
  const parts = [
    office.street,
    [office.city, office.state].filter(Boolean).join(", "),
    office.zip,
  ]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0);
  return parts.join(" · ");
}

function visitSummary(detail: OfficeDetail): string {
  if (detail.visit_count === 0) return "No visits yet";
  const last = detail.last_visit_at
    ? formatActivityStamp(detail.last_visit_at)
    : "—";
  return `Last visit ${last}`;
}

export default function OfficeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: officeId } = use(params);
  const router = useRouter();
  const { salesperson, loaded: sessionLoaded } = useSalesperson();
  // Live permissions only used here to confirm role state; is_test
  // remains a static account property read from the cached session.
  const { loaded: permsLoaded } = useLivePermissions();
  useScrollToTop();

  // ---- Access gate -------------------------------------------------------
  const accessReady = sessionLoaded && permsLoaded;
  const canView =
    !!salesperson &&
    salesperson.role !== "juice_box_only" &&
    salesperson.is_test === true;

  useEffect(() => {
    if (!accessReady) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    if (salesperson.role === "juice_box_only") {
      router.replace("/juice-box");
      return;
    }
    if (!canView) {
      router.replace("/dashboard");
    }
  }, [accessReady, salesperson, canView, router]);

  // ---- Detail state ------------------------------------------------------
  const [detail, setDetail] = useState<OfficeDetail | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-section drafts + save state. Drafts are user input; the saved
  // values live on `detail.office`. After a successful save we copy the
  // server-returned canonical values back onto `detail` and the drafts
  // re-sync below.
  const [notesDraft, setNotesDraft] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);

  const [nextActionDraft, setNextActionDraft] = useState("");
  const [savingNextAction, setSavingNextAction] = useState(false);
  const [nextActionError, setNextActionError] = useState<string | null>(
    null,
  );

  const [visitNote, setVisitNote] = useState("");
  const [loggingVisit, setLoggingVisit] = useState(false);
  const [visitError, setVisitError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    try {
      const res = await apiFetch(`/api/offices/${officeId}`);
      const data = (await res.json().catch(() => null)) as
        | (DetailResponse & ApiError)
        | null;
      if (!res.ok || !data?.detail) {
        setLoadError(data?.error ?? `Could not load office (${res.status}).`);
        setLoadState("error");
        return;
      }
      setDetail(data.detail);
      setNotesDraft(data.detail.office.office_notes ?? "");
      setNextActionDraft(data.detail.office.next_action ?? "");
      setLoadState("ready");
    } catch {
      setLoadError("Network error while loading this office.");
      setLoadState("error");
    }
  }, [officeId]);

  // Initial load: wait for the access gate to resolve so we don't fire
  // a 401-bound request before the session hydrates. The page-level
  // redirect handles the !canView case; we only fetch when we'll
  // actually render the detail. loadDetail starts with a synchronous
  // setState (to flip into the loading branch); calling it from the
  // effect body is the canonical fetch-on-mount pattern even though
  // the lint rule flags it.
  useEffect(() => {
    if (!accessReady || !canView) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDetail();
  }, [accessReady, canView, loadDetail]);

  // ---- Save handlers -----------------------------------------------------

  async function saveOfficeField(
    field: "office_notes" | "next_action",
    value: string,
  ): Promise<OfficeRow | null> {
    // Empty / whitespace-only clears the column (sent as empty string;
    // the server normalizes to null). Trimming on the client keeps the
    // optimistic state aligned with what the server will store.
    const payload: Record<string, string> = { [field]: value };
    const res = await apiFetch(`/api/offices/${officeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => null)) as
      | (PatchResponse & ApiError)
      | null;
    if (!res.ok || !data?.office) {
      throw new Error(data?.error ?? `Save failed (${res.status}).`);
    }
    return data.office;
  }

  async function handleSaveNotes() {
    if (savingNotes) return;
    setSavingNotes(true);
    setNotesError(null);
    try {
      const updated = await saveOfficeField("office_notes", notesDraft);
      if (updated && detail) {
        setDetail({ ...detail, office: updated });
        setNotesDraft(updated.office_notes ?? "");
      }
    } catch (err) {
      setNotesError(
        err instanceof Error ? err.message : "Could not save notes.",
      );
    } finally {
      setSavingNotes(false);
    }
  }

  async function handleSaveNextAction() {
    if (savingNextAction) return;
    setSavingNextAction(true);
    setNextActionError(null);
    try {
      const updated = await saveOfficeField("next_action", nextActionDraft);
      if (updated && detail) {
        setDetail({ ...detail, office: updated });
        setNextActionDraft(updated.next_action ?? "");
      }
    } catch (err) {
      setNextActionError(
        err instanceof Error ? err.message : "Could not save next action.",
      );
    } finally {
      setSavingNextAction(false);
    }
  }

  async function handleLogVisit() {
    if (loggingVisit) return;
    setLoggingVisit(true);
    setVisitError(null);
    try {
      const res = await apiFetch(`/api/offices/${officeId}/visits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visit_note: visitNote }),
      });
      const data = (await res.json().catch(() => null)) as
        | (VisitResponse & ApiError)
        | null;
      if (!res.ok || !data?.visit) {
        setVisitError(
          data?.error ?? `Could not log visit (${res.status}).`,
        );
        return;
      }
      // Apply the new visit locally without a full refetch. The detail
      // route returns visits newest-first, so we prepend; `last_visit_at`
      // becomes the new visit's timestamp; visit_count increments.
      if (detail) {
        setDetail({
          ...detail,
          visits: [data.visit, ...detail.visits],
          last_visit_at: data.visit.visited_at,
          visit_count: detail.visit_count + 1,
        });
      }
      setVisitNote("");
    } catch {
      setVisitError("Network error while logging this visit.");
    } finally {
      setLoggingVisit(false);
    }
  }

  // ---- Render guards -----------------------------------------------------

  if (!accessReady || !salesperson || !canView) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (loadState === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading office…</p>
      </main>
    );
  }

  if (loadState === "error" || !detail) {
    return (
      <main className="pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4">
        <Link
          href="/dashboard"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back
        </Link>
        <Card>
          <CardContent className="space-y-2">
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {loadError ?? "Office not found."}
            </p>
            <Button variant="outline" size="sm" onClick={() => void loadDetail()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const { office } = detail;
  const address = formatAddress(office);
  const notesDirty = notesDraft !== (office.office_notes ?? "");
  const nextActionDirty =
    nextActionDraft !== (office.next_action ?? "");

  return (
    <main className="pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4">
      {/* Header — Back + sandbox tag. Office name is the page title. */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/dashboard"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back
        </Link>
        <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400">
          Test
        </span>
      </header>

      {/* Sandbox banner — same posture as /office-imports. */}
      <div
        role="note"
        className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p className="leading-snug">
          Sandbox office detail — visible only to the test account.
        </p>
      </div>

      {/* Office identity card — name, address, stats. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{office.name}</CardTitle>
          {address && (
            <CardDescription className="inline-flex items-start gap-1.5">
              <MapPin
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              />
              <span>{address}</span>
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="uppercase tracking-wide text-muted-foreground">
                Visits
              </dt>
              <dd className="text-base font-semibold tabular-nums">
                {detail.visit_count}
              </dd>
            </div>
            <div>
              <dt className="uppercase tracking-wide text-muted-foreground">
                Last visit
              </dt>
              <dd className="text-sm font-medium">
                {detail.last_visit_at
                  ? formatActivityStamp(detail.last_visit_at)
                  : "—"}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Office notes — long-term memory. Auto-resize via min-h. */}
      <Card>
        <CardHeader>
          <CardTitle>Office notes</CardTitle>
          <CardDescription>
            Persistent reference info (broker name, meeting cadence, who to
            ask for).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            id="office-notes"
            className="w-full min-h-[96px] rounded-md border border-input bg-background p-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            placeholder="e.g. Broker is Sarah · Office meetings Tuesdays at 10am · Ask for Mike at front desk"
            disabled={savingNotes}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleSaveNotes}
              disabled={savingNotes || !notesDirty}
            >
              {savingNotes ? "Saving…" : "Save notes"}
            </Button>
            {notesError && (
              <span role="alert" className="text-xs text-destructive">
                {notesError}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Next action — the actionable to-do. */}
      <Card>
        <CardHeader>
          <CardTitle>Next action</CardTitle>
          <CardDescription>
            The single next step for this office.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            id="next-action"
            className="w-full min-h-[72px] rounded-md border border-input bg-background p-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={nextActionDraft}
            onChange={(e) => setNextActionDraft(e.target.value)}
            placeholder="e.g. Drop off donuts week of 6/3 · Follow up on A2L class"
            disabled={savingNextAction}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleSaveNextAction}
              disabled={savingNextAction || !nextActionDirty}
            >
              {savingNextAction ? "Saving…" : "Save next action"}
            </Button>
            {nextActionError && (
              <span role="alert" className="text-xs text-destructive">
                {nextActionError}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Log visit — the moment-of-action capture. */}
      <Card>
        <CardHeader>
          <CardTitle>Log visit</CardTitle>
          <CardDescription>{visitSummary(detail)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            id="visit-note"
            className="w-full min-h-[72px] rounded-md border border-input bg-background p-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={visitNote}
            onChange={(e) => setVisitNote(e.target.value)}
            placeholder="What happened on this visit? (optional)"
            disabled={loggingVisit}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleLogVisit}
              disabled={loggingVisit}
            >
              {loggingVisit ? "Logging…" : "Log visit"}
            </Button>
            {visitError && (
              <span role="alert" className="text-xs text-destructive">
                {visitError}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Visit history — most recent first. */}
      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-1.5">
            <History aria-hidden="true" className="size-4" />
            Visit history
          </CardTitle>
          {detail.visits.length > 0 && (
            <CardDescription>
              {detail.visit_count === 1
                ? "1 visit"
                : `${detail.visit_count} visits`}
              {detail.visit_count > detail.visits.length && (
                <> · showing most recent {detail.visits.length}</>
              )}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {detail.visits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No visits logged yet.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {detail.visits.map((v) => (
                <li key={v.id} className="py-2 first:pt-0 last:pb-0">
                  <p className="text-xs font-medium text-muted-foreground">
                    {formatActivityStamp(v.visited_at)}
                  </p>
                  {v.note && (
                    <p className="mt-0.5 whitespace-pre-wrap text-sm">
                      {v.note}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
