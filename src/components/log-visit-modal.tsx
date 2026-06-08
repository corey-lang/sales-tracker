"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, X } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import type { OfficeRow, OfficeVisitRow } from "@/lib/offices";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// ---------------------------------------------------------------------------
// LogVisitModal — "Log Visit + Note" from the Map.
//
// The map's pin popup already has a one-tap "Log visit" (no note). This
// modal is the richer path: it logs a visit AND captures an optional
// note + optional next action in a single flow, without the AE having
// to open the full office-detail page first.
//
// WRITES
//   1. POST /api/offices/[id]/visits with the note (visited_at defaults
//      to NOW server-side — the modal is always an "I'm here right now"
//      action, so no datetime picker).
//   2. If a next action was typed, PATCH /api/offices/[id] to set it.
//      This is a SECOND, best-effort write: the visit is the primary
//      record, so a next-action failure does NOT discard the logged
//      visit — the modal surfaces a soft warning and the user can set
//      the next action from the office page.
//
// DUPLICATE-SUBMIT GUARD
//   `submitting` disables the Save button and short-circuits a second
//   handleSubmit, so a rapid double-tap can't log two visits.
//
// INVERTED CONTROL
//   On success the modal calls `onLogged` (so the parent can refresh the
//   pin's "last visit" / next action in place) then closes. The parent
//   owns the map state; the modal is just the form.
// ---------------------------------------------------------------------------

const VISIT_NOTE_MAX = 4000;
const NEXT_ACTION_MAX = 500;

type VisitResponse = { visit: OfficeVisitRow };
type PatchResponse = { office: OfficeRow };
type ApiErrorShape = { error?: string };

export type LogVisitModalResult = {
  /** ISO timestamp of the logged visit — lets the parent update the
   *  pin's "last visit" immediately. */
  visitedAt: string;
  /** The next action that was saved, when one was entered AND the PATCH
   *  succeeded. Undefined when none was entered or it failed to save. */
  nextAction?: string;
};

export function LogVisitModal({
  officeId,
  officeName,
  onClose,
  onLogged,
}: {
  officeId: string;
  officeName: string;
  onClose: () => void;
  onLogged: (result: LogVisitModalResult) => void;
}) {
  const [note, setNote] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the visit logged but the optional next-action PATCH
   *  failed. Switches the modal into a "logged, but…" close state so
   *  the user isn't told the whole action failed. */
  const [partialNotice, setPartialNotice] = useState<string | null>(null);

  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const id = window.setTimeout(() => noteRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [submitting, onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setPartialNotice(null);

    try {
      // 1. Log the visit (primary write). Empty note → server stores null.
      const visitRes = await apiFetch(`/api/offices/${officeId}/visits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visit_note: note }),
      });
      const visitData = (await visitRes.json().catch(() => null)) as
        | (VisitResponse & ApiErrorShape)
        | null;
      if (!visitRes.ok || !visitData?.visit) {
        setError(
          visitData?.error ?? `Could not log visit (${visitRes.status}).`,
        );
        setSubmitting(false);
        return;
      }
      const visitedAt = visitData.visit.visited_at;

      // 2. Optional next action (best-effort second write).
      const trimmedNextAction = nextAction.trim();
      if (trimmedNextAction.length > 0) {
        try {
          const patchRes = await apiFetch(`/api/offices/${officeId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ next_action: trimmedNextAction }),
          });
          const patchData = (await patchRes.json().catch(() => null)) as
            | (PatchResponse & ApiErrorShape)
            | null;
          if (!patchRes.ok || !patchData?.office) {
            // Visit is saved; surface a soft warning and let the parent
            // update the pin's last-visit. The user can set the next
            // action from the office page.
            onLogged({ visitedAt });
            setPartialNotice(
              "Visit logged, but the next action didn't save. Open the office to set it.",
            );
            setSubmitting(false);
            return;
          }
          onLogged({ visitedAt, nextAction: trimmedNextAction });
          onClose();
          return;
        } catch {
          onLogged({ visitedAt });
          setPartialNotice(
            "Visit logged, but the next action didn't save. Open the office to set it.",
          );
          setSubmitting(false);
          return;
        }
      }

      // No next action — visit-only success.
      onLogged({ visitedAt });
      onClose();
    } catch {
      setError("Network error while logging this visit.");
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="log-visit-title"
      // z-50 sits above the bottom nav (z-40) and the /offices map (the
      // map wrapper uses `isolate` so Leaflet's panes stay contained).
      className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center"
      style={{
        paddingTop: "calc(0.75rem + env(safe-area-inset-top))",
        paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
      }}
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => {
          if (!submitting) onClose();
        }}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm focus:outline-none"
      />
      <Card
        size="sm"
        className="relative w-full max-w-md overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150"
      >
        <CardContent className="space-y-3 px-4 py-3">
          <header className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 id="log-visit-title" className="text-base font-semibold">
                Log visit
              </h2>
              <p className="truncate text-xs text-muted-foreground">
                {officeName}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              aria-label="Close"
              className="-mr-1 -mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>

          {partialNotice ? (
            // Logged-but-next-action-failed terminal state. The visit is
            // saved; offer a single Close action rather than re-submitting.
            <div className="space-y-3">
              <p
                role="status"
                className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
              >
                {partialNotice}
              </p>
              <Button type="button" size="sm" className="w-full" onClick={onClose}>
                Done
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Logs a visit right now. Add an optional note and next action.
              </p>

              <div className="space-y-1.5">
                <label
                  htmlFor="log-visit-note"
                  className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  Note (optional)
                </label>
                <textarea
                  id="log-visit-note"
                  ref={noteRef}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={VISIT_NOTE_MAX}
                  disabled={submitting}
                  placeholder="What happened on this visit?"
                  className="w-full min-h-[80px] rounded-md border border-input bg-background p-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="log-visit-next-action"
                  className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  Next action (optional)
                </label>
                <input
                  id="log-visit-next-action"
                  type="text"
                  value={nextAction}
                  onChange={(e) => setNextAction(e.target.value)}
                  maxLength={NEXT_ACTION_MAX}
                  disabled={submitting}
                  placeholder="e.g. Drop off donuts next week"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
                />
                <p className="text-[11px] text-muted-foreground">
                  Updates this office&apos;s next action.
                </p>
              </div>

              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}

              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={submitting}>
                  {submitting ? (
                    "Logging…"
                  ) : (
                    <>
                      <CheckCircle2 aria-hidden="true" className="size-4" />
                      Log visit
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                  disabled={submitting}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
