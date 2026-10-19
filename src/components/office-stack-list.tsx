import Link from "next/link";
import { Check, CheckCircle2, Navigation, NotebookPen, Plus } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { formatActivityStamp } from "@/lib/dates";
import { addressLine, formatDueDate, mapsUrlFor } from "@/lib/office-map-display";
import type { OfficeMapPinItem } from "@/lib/offices";

/**
 * The list shown when several offices share one map location (a multi-tenant
 * building, or several MLS offices at one address). Every office in it has the
 * SAME actions as an individually-placed pin: add to / remove from the route,
 * Log visit, Log + note, Directions, and Open — and an office already chosen
 * for the route is visibly marked.
 *
 * Presentational and hook-free on purpose: the Leaflet popup supplies state and
 * handlers, which keeps this unit-testable without a browser.
 *
 * Popup surface is white; dark-theme tokens wash out, so fixed slate is used.
 */
export type OfficeStackListProps = {
  items: OfficeMapPinItem[];
  /** Offices currently chosen for the route. */
  selectedIds?: ReadonlySet<string>;
  /** Toggle one office in the route selection (omitted → no route UI). */
  onToggleSelect?: (officeId: string) => void;
  loggingId: string | null;
  logNoticeById: Map<string, string>;
  logErrorById: Map<string, string>;
  isLogDisabled: (officeId: string) => boolean;
  onLogVisit: (officeId: string) => void;
  onLogVisitWithNote: (office: { id: string; name: string }) => void;
};

export function OfficeStackList({
  items,
  selectedIds,
  onToggleSelect,
  loggingId,
  logNoticeById,
  logErrorById,
  isLogDisabled,
  onLogVisit,
  onLogVisitWithNote,
}: OfficeStackListProps) {
  const selectedCount = items.filter((i) => selectedIds?.has(i.id)).length;
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-semibold leading-snug">
        {items.length} offices at this address
        {selectedCount > 0 && (
          <span className="ml-1.5 text-[11px] font-semibold text-green-700">
            · {selectedCount} in route
          </span>
        )}
      </p>
      <ul className="max-h-60 space-y-2 overflow-y-auto pr-1">
        {items.map((item) => {
          const selected = selectedIds?.has(item.id) ?? false;
          const notice = logNoticeById.get(item.id) ?? null;
          const error = logErrorById.get(item.id) ?? null;
          const logging = loggingId === item.id;
          const disabled = isLogDisabled(item.id);
          const address = addressLine(item);
          const mapsHref = mapsUrlFor(item);
          const dueDate = formatDueDate(item.next_action_due_date);
          return (
            <li
              key={item.id}
              data-selected={selected ? "true" : "false"}
              className={
                selected
                  ? "space-y-1 rounded-md border border-green-600/50 bg-green-50 p-2"
                  : "space-y-1 border-t border-slate-200 pt-2 first:border-t-0 first:pt-0"
              }
            >
              <p className="text-xs font-semibold leading-snug">{item.name}</p>
              {address && <p className="text-[11px] text-slate-600">{address}</p>}
              {item.last_visit_at ? (
                <p className="text-[11px] text-slate-600">
                  Last visit{" "}
                  <span className="font-medium text-slate-700">
                    {formatActivityStamp(item.last_visit_at)}
                  </span>
                </p>
              ) : (
                <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
                  No visit yet
                </p>
              )}
              {item.next_action && (
                <p className="text-[11px]">
                  <span className="font-medium text-slate-700">Next:</span>{" "}
                  {item.next_action}
                  {dueDate && <span className="text-slate-600"> · due {dueDate}</span>}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {onToggleSelect && (
                  <Button
                    type="button"
                    size="sm"
                    variant={selected ? "outline" : "default"}
                    aria-pressed={selected}
                    onClick={() => onToggleSelect(item.id)}
                  >
                    {selected ? (
                      <>
                        <Check aria-hidden="true" className="size-4" />
                        In route
                      </>
                    ) : (
                      <>
                        <Plus aria-hidden="true" className="size-4" />
                        Add to route
                      </>
                    )}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onLogVisit(item.id)}
                  disabled={logging || disabled}
                >
                  {logging ? "Logging…" : "Log visit"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onLogVisitWithNote({ id: item.id, name: item.name })}
                  disabled={logging || disabled}
                >
                  <NotebookPen aria-hidden="true" className="size-4" />
                  Log + note
                </Button>
                {mapsHref && (
                  <a
                    href={mapsHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <Navigation aria-hidden="true" className="size-4" />
                    Directions
                  </a>
                )}
                <Link
                  href={`/offices/${item.id}`}
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  Open
                </Link>
              </div>
              {notice && (
                <p
                  role="status"
                  className="inline-flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400"
                >
                  <CheckCircle2 aria-hidden="true" className="size-3.5" />
                  {notice}
                </p>
              )}
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
