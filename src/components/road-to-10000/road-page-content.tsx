"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import {
  formatBusinessDays,
  formatPace,
  formatPercent,
  formatSignedPace,
  formatWhole,
  paceStatusLabel,
  type RoadView,
  type TotalReading,
} from "@/lib/road-to-10000";
import { formatTaskMoment } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { landingPathFor } from "@/lib/role-routing";
import { useSalesperson } from "@/lib/use-salesperson";

import { Card, CardContent } from "@/components/ui/card";
import { RoadProgressBar } from "@/components/road-to-10000/progress-bar";
import { RoadStatusBadge } from "@/components/road-to-10000/status-badge";
import { UpdateTotalForm } from "@/components/road-to-10000/update-total-form";
import { ageLabel, longDate } from "@/components/road-to-10000/format";
import { useRoadView } from "@/components/road-to-10000/use-road-view";

// The full Road to 10,000 view. Everyone signed in can read it; the Update
// control appears only when the SERVER says `can_update` (Corey, Tonja) — and the
// save is re-checked server-side regardless.

export function RoadPageContent() {
  const { state, setView } = useRoadView();
  // "Home" is where this person lands (admins: /admin, everyone else: /dashboard).
  const { salesperson } = useSalesperson();
  const homeHref = salesperson ? landingPathFor(salesperson) : "/dashboard";

  return (
    <div className="flex min-w-0 flex-col gap-4 [overflow-wrap:anywhere]">
      <Link href={homeHref} className="inline-flex min-h-10 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden="true" className="size-4" />
        Home
      </Link>

      {state.status === "loading" ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : state.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          Road to 10,000 is temporarily unavailable.
        </p>
      ) : (
        <RoadPageBody view={state.view} onSaved={setView} />
      )}
    </div>
  );
}

/** The loaded page body. Exported so it can be rendered in tests. */
export function RoadPageBody({ view, onSaved }: { view: RoadView; onSaved: (v: RoadView) => void }) {
  const m = view.metrics;

  if (!view.configured) {
    return (
      <>
        <Header />
        <Card>
          <CardContent className="space-y-2">
            <p className="font-medium">Road to 10,000 isn&apos;t set up yet.</p>
            <p className="text-sm text-muted-foreground">
              The database update that stores the total hasn&apos;t been applied to this environment
              (<code className="text-xs">supabase/road_to_10000.sql</code>). Once it is, the first total can be
              entered here.
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <Header />

      {/* The big picture */}
      <Card className="gap-4 bg-gradient-to-br from-primary/10 via-card to-card ring-1 ring-primary/30">
        <CardContent className="flex flex-col gap-4">
          {m && view.latest ? (
            <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <p className="text-5xl font-bold leading-none tabular-nums tracking-tight sm:text-6xl">
                  {formatWhole(m.total)}
                  <span className="text-xl font-medium text-muted-foreground sm:text-2xl"> / {formatWhole(m.target)}</span>
                </p>
                <p className="text-right leading-none">
                  <span className="text-3xl font-bold tabular-nums sm:text-4xl">{formatPercent(m.percentComplete)}%</span>
                  <span className="block text-sm text-muted-foreground">Complete</span>
                </p>
              </div>
              <div>
                <RoadProgressBar percent={m.percentComplete} size="lg" />
                <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground" aria-hidden="true">
                  <span>0</span>
                  <span>2,500</span>
                  <span>5,000</span>
                  <span>7,500</span>
                  <span>10,000 🏁</span>
                </div>
              </div>
              <p className="text-lg">
                <span className="font-bold tabular-nums">{formatWhole(m.remaining)}</span>{" "}
                <span className="text-muted-foreground">Homescriptions to go</span>
              </p>
              <RoadStatusBadge metrics={m} className="self-start" />
            </>
          ) : (
            <>
              <p className="text-4xl font-bold">
                — <span className="text-xl font-medium text-muted-foreground">/ {formatWhole(view.goal.target)}</span>
              </p>
              <RoadProgressBar percent={0} size="lg" />
              <p className="text-sm text-muted-foreground">
                No total has been recorded yet.{view.can_update ? " Enter the first one below." : ""}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {m && view.latest ? (
        <>
          <section aria-label="Pace" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Metric label="Current pace" value={formatPace(m.currentPace)} unit="per business day" />
            <Metric label="Required pace" value={formatPace(m.requiredPace)} unit="per business day" />
            <Metric
              label={paceStatusLabel(m.status)}
              value={formatSignedPace(m.paceDifference)}
              unit="per business day"
              tone={m.status === "behind" ? "warn" : m.status === "ahead" ? "good" : undefined}
            />
            <Metric
              label="Projected finish"
              value={m.projectedFinish === null ? "—" : formatWhole(m.projectedFinish)}
              unit="Homescriptions"
            />
            <Metric label="Business days elapsed" value={formatBusinessDays(m.businessDaysElapsed)} unit="through the last update" />
            <Metric label="Business days remaining" value={formatBusinessDays(m.businessDaysRemaining)} unit="from today through Dec 31" />
          </section>

          <LastUpdated view={view} latest={view.latest} />
        </>
      ) : null}

      {view.can_update ? (
        <Card>
          <CardContent>
            <UpdateTotalForm view={view} onSaved={onSaved} />
          </CardContent>
        </Card>
      ) : null}

      <History history={view.history} />

      <Card>
        <CardContent>
          <details>
            <summary className="min-h-9 cursor-pointer text-sm font-medium">How this is calculated</summary>
            <div className="mt-3 space-y-3 text-sm text-muted-foreground">
              <p>
                A <span className="font-medium text-foreground">business day</span> is Monday through Friday, minus the
                company holidays below. The <em>current pace</em> is measured through the date the latest total was recorded
                {view.latest ? ` (${longDate(view.latest.recordedOn)})` : ""}; the <em>time left</em> to December 31 is measured
                from today.
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Percent complete = total ÷ {formatWhole(view.goal.target)}</li>
                <li>Homescriptions to go = {formatWhole(view.goal.target)} − total</li>
                <li>
                  Current pace = total ÷ business days elapsed (Jan 1 through the update date), allowing for the
                  Closed Transactions report running about {m?.reportingLagBusinessDays ?? 3} business days behind
                </li>
                <li>Required pace = Homescriptions to go ÷ business days remaining (from today through Dec 31)</li>
                <li>Ahead/behind = current pace − required pace</li>
                <li>Projected finish = total + current pace × business days remaining (from today through Dec 31)</li>
              </ul>
              <div>
                <p className="font-medium text-foreground">Company holidays counted in {view.goal.year}</p>
                <ul className="mt-1 space-y-0.5">
                  {view.holidays.map((h) => (
                    <li key={h.date} className="tabular-nums">
                      {longDate(h.date)} — {h.name}
                      {h.value < 1 ? " (half day)" : ""}
                      {h.source === "admin" ? " · added in Working Days" : ""}
                    </li>
                  ))}
                </ul>
                {view.extraHolidaysUnavailable ? (
                  <p className="mt-2 text-amber-700 dark:text-amber-300">
                    Extra company days entered in Working Days couldn&apos;t be loaded just now, so only the standard
                    holidays are counted.
                  </p>
                ) : null}
              </div>
            </div>
          </details>
        </CardContent>
      </Card>
    </>
  );
}

function Header() {
  return (
    <header className="space-y-1 pt-1">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-primary">🏁 Road to 10,000</p>
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">10,000 Homescriptions Sold</h1>
      <p className="text-sm text-muted-foreground">Our company goal for 2026 — by December 31.</p>
    </header>
  );
}

function Metric({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string;
  unit: string;
  tone?: "good" | "warn";
}) {
  return (
    <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-2xl font-bold tabular-nums leading-tight",
          tone === "good" && "text-primary",
          tone === "warn" && "text-amber-700 dark:text-amber-300",
        )}
      >
        {value}
      </p>
      <p className="text-[11px] text-muted-foreground">{unit}</p>
    </div>
  );
}

function LastUpdated({ view, latest }: { view: RoadView; latest: TotalReading }) {
  const age = ageLabel(view.daysSinceUpdate);
  const stale = (view.daysSinceUpdate ?? 0) > 0;
  return (
    <p className={cn("text-sm", stale ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>
      Last updated: <span className="font-medium">{longDate(latest.recordedOn)}</span>
      {age ? ` (${age})` : ""}
      {latest.enteredByName ? ` · entered by ${latest.enteredByName}` : ""}
      {stale ? " — pace is measured through that date." : ""}
    </p>
  );
}

function History({ history }: { history: TotalReading[] }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold">History</h2>
          <p className="text-xs text-muted-foreground">Every total ever recorded, newest first. It can&apos;t be edited — a mistake is fixed with a correction.</p>
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-2 pr-3 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="py-2 pl-3 text-left font-medium">Entered by</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={h.id} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {formatTaskMoment(h.recordedAt)}
                      {i === 0 ? <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">Current</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatWhole(h.total)}</td>
                    <td className="py-2 pl-3">
                      {h.enteredByName ?? "—"}
                      {h.isCorrection ? (
                        <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-300">
                          Correction{h.note ? `: ${h.note}` : ""}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
