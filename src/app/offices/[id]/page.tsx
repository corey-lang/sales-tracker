"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  History,
  MapPin,
  Navigation,
  Pencil,
  X,
} from "lucide-react";

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
// Layout, top → bottom:
//   1. Header (Back + Test pill)
//   2. Sandbox banner
//   3. Office identity card (name, address, visit summary)
//   4. PRIMARY ACTIONS — Log Visit + Open Maps
//   5. Office Notes (long-term office memory)
//   6. Next Action (text + optional due date + optional "Add to To-Dos")
//   7. Visit History (newest first, every entry editable)
//
// Log Visit + Open Maps live near the top because they're the most-used
// actions when an AE pulls up an office — the spec calls Log Visit out
// explicitly as needing to be immediately visible.
//
// Access (mirrors /api/offices/[id]):
//   * `is_test === true` salesperson — passes.
//   * juice_box_only — redirected to /juice-box.
//   * Anyone else — redirected to /dashboard.
// ---------------------------------------------------------------------------

type DetailResponse = { detail: OfficeDetail };
type PatchResponse = { office: OfficeRow };
type VisitResponse = { visit: OfficeVisitRow };
type ApiErrorShape = { error?: string };

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

/**
 * Builds a Google Maps "search" URL for an office. Falls back to lat/lng
 * when no address text is available. The universal `/maps/search`
 * endpoint lets the OS choose Maps app vs. browser (iOS will offer
 * Apple Maps if it's the user's default — better UX than hard-pinning
 * to one client).
 */
function mapsUrl(office: OfficeRow): string | null {
  const address = formatAddress(office).replace(/\s·\s/g, ", ");
  if (address.length > 0) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${office.name} ${address}`,
    )}`;
  }
  if (office.latitude !== null && office.longitude !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${office.latitude},${office.longitude}`;
  }
  return null;
}

/**
 * Local datetime → `YYYY-MM-DDTHH:MM` for use in a
 * `<input type="datetime-local">` value. Required because the input
 * doesn't accept full ISO 8601 (with seconds/TZ); it wants the local-
 * wall-clock fragment only. We round to the minute so the input
 * doesn't flash a sub-minute value at the user.
 */
function toDateTimeLocalValue(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Parses a `<input type="datetime-local">` value (local wall clock,
 * no TZ) into a UTC ISO string the API accepts. Returns null when
 * the input is empty or unparseable so the caller can decide whether
 * to send it.
 */
function fromDateTimeLocalValue(value: string): string | null {
  if (!value) return null;
  // new Date("YYYY-MM-DDTHH:MM") is interpreted as local time per
  // the ECMAScript spec for datetime-local strings. `.toISOString()`
  // then renders the UTC equivalent.
  const ts = new Date(value);
  if (Number.isNaN(ts.getTime())) return null;
  return ts.toISOString();
}

/** YYYY-MM-DD → readable "Jun 5, 2026" without pulling in a date lib here. */
function formatDueDate(value: string | null): string | null {
  if (!value) return null;
  // Parse manually so the user's local TZ doesn't shift the date.
  const [yStr, mStr, dStr] = value.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function OfficeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: officeId } = use(params);
  const router = useRouter();
  const { salesperson, loaded: sessionLoaded } = useSalesperson();
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
  const [nextActionDueDraft, setNextActionDueDraft] = useState("");
  const [createTodo, setCreateTodo] = useState(false);
  const [savingNextAction, setSavingNextAction] = useState(false);
  const [nextActionError, setNextActionError] = useState<string | null>(null);
  /** Soft, non-blocking success / partial-success message under the
   *  Next Action card. Used for the "saved, but To-Do failed" copy. */
  const [nextActionNotice, setNextActionNotice] = useState<string | null>(
    null,
  );

  // Log Visit — datetime defaults to "now" each time the card mounts.
  // The user can adjust the value before saving. Re-defaulted after
  // each successful log so the next visit starts fresh at the new now.
  const [visitWhen, setVisitWhen] = useState<string>(() =>
    toDateTimeLocalValue(new Date()),
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
        | (DetailResponse & ApiErrorShape)
        | null;
      if (!res.ok || !data?.detail) {
        setLoadError(data?.error ?? `Could not load office (${res.status}).`);
        setLoadState("error");
        return;
      }
      setDetail(data.detail);
      setNotesDraft(data.detail.office.office_notes ?? "");
      setNextActionDraft(data.detail.office.next_action ?? "");
      setNextActionDueDraft(data.detail.office.next_action_due_date ?? "");
      setLoadState("ready");
    } catch {
      setLoadError("Network error while loading this office.");
      setLoadState("error");
    }
  }, [officeId]);

  useEffect(() => {
    if (!accessReady || !canView) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDetail();
  }, [accessReady, canView, loadDetail]);

  // ---- Save handlers -----------------------------------------------------

  async function patchOffice(
    payload: Record<string, string | null>,
  ): Promise<OfficeRow | null> {
    const res = await apiFetch(`/api/offices/${officeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => null)) as
      | (PatchResponse & ApiErrorShape)
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
      const updated = await patchOffice({ office_notes: notesDraft });
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

  /**
   * Saves the next-action text + optional due date. When `createTodo`
   * is checked AND the office save succeeds, a SEPARATE POST to
   * /api/tasks creates an AE To-Do with the same title + due date.
   * A To-Do failure is non-blocking — the office row is already saved,
   * and the user sees a soft notice telling them to add it manually.
   */
  async function handleSaveNextAction() {
    if (savingNextAction) return;
    setSavingNextAction(true);
    setNextActionError(null);
    setNextActionNotice(null);
    try {
      const updated = await patchOffice({
        next_action: nextActionDraft,
        // Empty string → null (clear the date). The server accepts
        // null explicitly; a stripped non-empty value passes Zod.
        next_action_due_date: nextActionDueDraft || null,
      });
      if (updated && detail) {
        setDetail({ ...detail, office: updated });
        setNextActionDraft(updated.next_action ?? "");
        setNextActionDueDraft(updated.next_action_due_date ?? "");
      }

      // AE To-Do dual-write. Decoupled from the office save: a To-Do
      // failure shows a soft notice but doesn't roll back the office.
      const trimmedTitle = nextActionDraft.trim();
      if (createTodo && trimmedTitle.length > 0) {
        try {
          const officeName = detail?.office.name ?? "Office";
          const taskRes = await apiFetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: trimmedTitle,
              description: `From office: ${officeName}`,
              ...(nextActionDueDraft
                ? { due_date: nextActionDueDraft }
                : {}),
            }),
          });
          if (!taskRes.ok) {
            setNextActionNotice(
              "Next Action saved, but the To-Do could not be created. You can add it manually from To-Dos.",
            );
          } else {
            setNextActionNotice(
              "Next Action saved and added to your To-Dos.",
            );
            // Auto-clear the checkbox so a follow-up save doesn't
            // unintentionally create a second To-Do.
            setCreateTodo(false);
          }
        } catch {
          setNextActionNotice(
            "Next Action saved, but the To-Do could not be created. You can add it manually from To-Dos.",
          );
        }
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
      // Convert the local-wall-clock value to ISO. If the user cleared
      // the input we fall back to NOW server-side by omitting the field.
      const visitedAtIso = fromDateTimeLocalValue(visitWhen);

      const res = await apiFetch(`/api/offices/${officeId}/visits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          visit_note: visitNote,
          ...(visitedAtIso ? { visited_at: visitedAtIso } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | (VisitResponse & ApiErrorShape)
        | null;
      if (!res.ok || !data?.visit) {
        setVisitError(
          data?.error ?? `Could not log visit (${res.status}).`,
        );
        return;
      }

      // Apply locally without a refetch. Sort visits by visited_at desc
      // so a back-dated entry slots into the right position.
      if (detail) {
        const merged = [data.visit, ...detail.visits].sort((a, b) =>
          b.visited_at.localeCompare(a.visited_at),
        );
        setDetail({
          ...detail,
          visits: merged,
          last_visit_at: merged[0].visited_at,
          visit_count: detail.visit_count + 1,
        });
      }

      // Reset form for the next log: fresh "now" + cleared note.
      setVisitWhen(toDateTimeLocalValue(new Date()));
      setVisitNote("");
    } catch {
      setVisitError("Network error while logging this visit.");
    } finally {
      setLoggingVisit(false);
    }
  }

  /**
   * Inline edit save for a single visit. Re-applied locally on success
   * (server is authoritative for the row's exact ISO string). Errors
   * surface inline in the row's edit form, not at the page level.
   */
  const handleEditVisit = useCallback(
    async (
      visitId: string,
      payload: { visited_at?: string; visit_note?: string | null },
    ): Promise<{ ok: true; visit: OfficeVisitRow } | { ok: false; error: string }> => {
      try {
        const res = await apiFetch(
          `/api/offices/${officeId}/visits/${visitId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const data = (await res.json().catch(() => null)) as
          | (VisitResponse & ApiErrorShape)
          | null;
        if (!res.ok || !data?.visit) {
          return {
            ok: false,
            error: data?.error ?? `Could not update visit (${res.status}).`,
          };
        }
        setDetail((current) => {
          if (!current) return current;
          const nextVisits = current.visits
            .map((v) => (v.id === data.visit.id ? data.visit : v))
            // Resort in case visited_at changed.
            .sort((a, b) => b.visited_at.localeCompare(a.visited_at));
          return {
            ...current,
            visits: nextVisits,
            last_visit_at: nextVisits[0]?.visited_at ?? null,
          };
        });
        return { ok: true, visit: data.visit };
      } catch {
        return {
          ok: false,
          error: "Network error while updating this visit.",
        };
      }
    },
    [officeId],
  );

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
          href="/offices"
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
    nextActionDraft !== (office.next_action ?? "") ||
    nextActionDueDraft !== (office.next_action_due_date ?? "");
  const mapsHref = mapsUrl(office);

  return (
    <main className="pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4">
      {/* Header — Back to /offices + sandbox tag. */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/offices"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back
        </Link>
        <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400">
          Test
        </span>
      </header>

      {/* Sandbox banner. */}
      <div
        role="note"
        className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p className="leading-snug">
          Sandbox office detail — visible only to the test account.
        </p>
      </div>

      {/* Office identity card. */}
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

      {/* PRIMARY ACTIONS — Log Visit + Open Maps, near the top so they're
          immediately visible without scrolling. Log Visit is the
          most-used action and is the visible default. */}
      <Card>
        <CardHeader>
          <CardTitle>Log visit</CardTitle>
          <CardDescription>{visitSummary(detail)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <label
              htmlFor="visit-when"
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              When
            </label>
            <input
              id="visit-when"
              type="datetime-local"
              value={visitWhen}
              onChange={(e) => setVisitWhen(e.target.value)}
              disabled={loggingVisit}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <p className="text-[11px] text-muted-foreground">
              Defaults to now. Adjust if you&apos;re logging this later.
            </p>
          </div>
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
            {mapsHref && (
              <a
                href={mapsHref}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <Navigation aria-hidden="true" className="size-4" />
                Open Maps
              </a>
            )}
            {visitError && (
              <span role="alert" className="text-xs text-destructive">
                {visitError}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Office notes — long-term office memory. */}
      <Card>
        <CardHeader>
          <CardTitle>Office notes</CardTitle>
          <CardDescription>
            Persistent reference info (broker name, meeting cadence, who
            to ask for).
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

      {/* Next action — office-level follow-up. Single text + optional
          due date + optional "also add to AE To-Dos" hook. */}
      <Card>
        <CardHeader>
          <CardTitle>Next action</CardTitle>
          <CardDescription>
            The single next step for this office (drop donuts, schedule
            office meeting, teach A2L class…).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            id="next-action"
            className="w-full min-h-[72px] rounded-md border border-input bg-background p-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={nextActionDraft}
            onChange={(e) => setNextActionDraft(e.target.value)}
            placeholder="e.g. Drop off donuts week of 6/3 · Follow up on A2L class"
            disabled={savingNextAction}
          />
          <div className="grid gap-1.5 sm:max-w-[14rem]">
            <label
              htmlFor="next-action-due"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Due date (optional)
            </label>
            <input
              id="next-action-due"
              type="date"
              value={nextActionDueDraft}
              onChange={(e) => setNextActionDueDraft(e.target.value)}
              disabled={savingNextAction}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={createTodo}
              onChange={(e) => setCreateTodo(e.target.checked)}
              disabled={savingNextAction || nextActionDraft.trim().length === 0}
              className="mt-0.5"
            />
            <span>
              Also add to my AE To-Dos
              <span className="block text-[11px] text-muted-foreground">
                Creates a separate To-Do task with the same title{" "}
                {nextActionDueDraft ? "and due date" : ""}.
              </span>
            </span>
          </label>
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
          {nextActionNotice && (
            <p
              role="status"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <CheckCircle2 aria-hidden="true" className="size-3.5" />
              {nextActionNotice}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Visit history — most recent first, each entry editable. */}
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
                <VisitHistoryRow
                  key={v.id}
                  visit={v}
                  onSave={handleEditVisit}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Optional read-only reminder of the next action's due date. */}
      {office.next_action && office.next_action_due_date && (
        <p className="px-1 text-[11px] text-muted-foreground">
          Next action due {formatDueDate(office.next_action_due_date)}
        </p>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// VisitHistoryRow — one row, inline-editable.
//
// Read mode: shows the visit's timestamp + note (if any) + a small
// pencil button. Tapping the pencil flips the row into edit mode with
// a datetime input + textarea + Save/Cancel.
//
// State is local to the row so a save-in-flight on one row doesn't
// affect the others. The parent owns the canonical `visits` array and
// re-renders the row with the new server-confirmed value on success.
// ---------------------------------------------------------------------------
function VisitHistoryRow({
  visit,
  onSave,
}: {
  visit: OfficeVisitRow;
  onSave: (
    visitId: string,
    payload: { visited_at?: string; visit_note?: string | null },
  ) => Promise<
    { ok: true; visit: OfficeVisitRow } | { ok: false; error: string }
  >;
}) {
  const [editing, setEditing] = useState(false);
  const [whenDraft, setWhenDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the drafts every time the row enters edit mode so opening
  // the form after a previous save reflects the current state.
  const openEdit = useCallback(() => {
    setWhenDraft(toDateTimeLocalValue(new Date(visit.visited_at)));
    setNoteDraft(visit.note ?? "");
    setError(null);
    setEditing(true);
  }, [visit.note, visit.visited_at]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setError(null);
  }, []);

  // Memo so the row title doesn't recompute the date string on every
  // keystroke in the note input.
  const displayWhen = useMemo(
    () => formatActivityStamp(visit.visited_at),
    [visit.visited_at],
  );

  if (!editing) {
    return (
      <li className="py-2 first:pt-0 last:pb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              {displayWhen}
            </p>
            {visit.note && (
              <p className="mt-0.5 whitespace-pre-wrap text-sm">
                {visit.note}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={openEdit}
            aria-label="Edit visit"
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pencil aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (saving) return;
          setSaving(true);
          setError(null);
          const visitedAtIso = fromDateTimeLocalValue(whenDraft);
          // Always send both fields — if the user cleared the note,
          // null clears the column server-side; if they cleared the
          // when input we send the previously-loaded value back so we
          // never accidentally "clear" the timestamp (which the route
          // would reject anyway since visited_at is NOT NULL).
          const payload: {
            visited_at?: string;
            visit_note?: string | null;
          } = {
            visit_note: noteDraft,
          };
          if (visitedAtIso) payload.visited_at = visitedAtIso;
          const result = await onSave(visit.id, payload);
          setSaving(false);
          if (result.ok) {
            setEditing(false);
          } else {
            setError(result.error);
          }
        }}
        className="space-y-2"
      >
        <div className="grid gap-1">
          <label
            htmlFor={`visit-when-${visit.id}`}
            className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            When
          </label>
          <input
            id={`visit-when-${visit.id}`}
            type="datetime-local"
            value={whenDraft}
            onChange={(e) => setWhenDraft(e.target.value)}
            disabled={saving}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>
        <textarea
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          disabled={saving}
          placeholder="What happened on this visit? (optional)"
          className="w-full min-h-[60px] rounded-md border border-input bg-background p-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={cancelEdit}
            disabled={saving}
          >
            <X aria-hidden="true" className="size-3.5" />
            Cancel
          </Button>
          {error && (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          )}
        </div>
      </form>
    </li>
  );
}
