"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, X } from "lucide-react";

import { apiFetch, apiFetchJson } from "@/lib/api-client";
import {
  SWAG_METRIC_LABELS,
  isSwagMetricKey,
  type SwagLeadsResponse,
  type SwagLeadView,
  type SwagMetricKey,
  type SwagMetrics,
} from "@/lib/swag-leads";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { LeadCard } from "./lead-card";
import { SwagLeadForm, emptyFormValues, fieldsFromValues, type LeadFormValues } from "./swag-lead-form";
import { SELECT_CLASS, errorText, messageOf } from "./shared";

// Swag Leads — the AE's "My Swag Leads" and management's team / individual-AE
// dashboard, in one component. The SERVER decides which one you get
// (`scope.is_manager`); nothing here is an authorization decision.
//
// Swag leads are social-media PROSPECTING leads — an agent asked for some of our
// swag, and the AE follows up to build a relationship and earn business. They
// are not swag orders, so there is no approval/shipping/tracking anywhere.
//
// Metrics are computed by the server FROM THE SELECTED SCOPE: choosing an AE
// recomputes every number for that AE. Clicking a metric asks the server for the
// exact leads behind it (same predicate as the count), so "12 Needs First
// Contact" opens those 12. Scope and metric live in the URL (shareable, back
// button works); search/filters are local to the list.

type YesNo = "" | "yes" | "no";
type Filters = {
  q: string;
  contacted: YesNo;
  met_in_person: YesNo;
  swag_delivered: YesNo;
  orders_received: YesNo;
  confirmed_realtor: YesNo;
  territory: string;
  from: string;
  to: string;
};
const NO_FILTERS: Filters = {
  q: "",
  contacted: "",
  met_in_person: "",
  swag_delivered: "",
  orders_received: "",
  confirmed_realtor: "",
  territory: "",
  from: "",
  to: "",
};

type Card = { key: SwagMetricKey; value: (m: SwagMetrics) => number; sub?: (m: SwagMetrics) => string };
const CARDS: Card[] = [
  { key: "total", value: (m) => m.total },
  { key: "needs_first_contact", value: (m) => m.needs_first_contact },
  { key: "contacted", value: (m) => m.contacted },
  { key: "followed_up", value: (m) => m.followed_up, sub: (m) => `${m.follow_up_attempts} follow-up${m.follow_up_attempts === 1 ? "" : "s"} logged` },
  { key: "no_follow_up", value: (m) => m.no_follow_up },
  { key: "met_in_person", value: (m) => m.met_in_person },
  { key: "swag_delivered", value: (m) => m.swag_delivered },
  { key: "with_orders", value: (m) => m.agents_with_orders, sub: (m) => `${m.total_orders} order${m.total_orders === 1 ? "" : "s"} sent` },
  { key: "ooa", value: (m) => m.ooa },
];

export function SwagLeadsBoard() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const scopeParam = searchParams.get("scope") ?? "";
  const metricParam = searchParams.get("metric");
  const metric = isSwagMetricKey(metricParam) ? metricParam : null;

  const loadVersion = useRef(0);
  const [data, setData] = useState<SwagLeadsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [addOpen, setAddOpen] = useState(false);

  const setUrl = useCallback(
    (next: { scope?: string; metric?: SwagMetricKey | null }) => {
      const p = new URLSearchParams(searchParams.toString());
      if (next.scope !== undefined) {
        if (next.scope) p.set("scope", next.scope);
        else p.delete("scope");
        p.delete("metric"); // a metric belongs to the scope it was clicked in
      }
      if (next.metric !== undefined) {
        if (next.metric) p.set("metric", next.metric);
        else p.delete("metric");
      }
      const qs = p.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (scopeParam) params.set("scope", scopeParam);
      if (metric) params.set("metric", metric);
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      const qs = params.toString();
      const res = await apiFetchJson<SwagLeadsResponse>(`/api/swag-leads${qs ? `?${qs}` : ""}`);
      if (version === loadVersion.current) setData(res);
    } catch (err) {
      if (version === loadVersion.current) setError(messageOf(err, "Couldn't load swag leads."));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [scopeParam, metric, filters]);

  // Debounce typing in the search box; everything else loads immediately.
  useEffect(() => {
    const t = setTimeout(() => void load(), filters.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, filters.q]);

  const isManager = data?.scope.is_manager === true;
  const metrics = data?.metrics;
  const viewerId = data?.scope.viewer_id ?? "";
  const scopeKind = data?.scope.kind;
  const scopeValue =
    scopeKind === "ooa" ? "ooa" : scopeKind === "ae" ? (data?.scope.ae_id ?? "") : scopeKind === "all" ? "all" : "";
  const scopeLabel =
    scopeKind === "all"
      ? "All AEs"
      : scopeKind === "ooa"
        ? "OOA (Out of Area)"
        : scopeKind === "ae"
          ? (data?.scope.ae_name ?? "AE")
          : "My leads";

  const replaceLead = (fresh: SwagLeadView | null) => {
    // Ownership / counts change on transfer and edits: refetch so every metric,
    // the AE table and the list stay consistent with the server.
    void fresh;
    void load();
  };

  const heading = isManager ? "Swag Leads" : "My Swag Leads";

  return (
    <div className="flex min-w-0 flex-col gap-4 [overflow-wrap:anywhere]">
      <header className="flex flex-wrap items-end justify-between gap-3 pt-1">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Social-media prospecting</p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{heading}</h1>
          <p className="text-sm text-muted-foreground">
            Agents who asked for our swag. Contact them, follow up, build the relationship — and see who sends us business.
          </p>
        </div>
        <Button size="lg" className="min-h-11" onClick={() => setAddOpen((o) => !o)}>
          <Plus aria-hidden="true" />
          Add lead
        </Button>
      </header>

      {/* Management: All AEs / one AE / OOA. Choosing one recomputes the numbers. */}
      {isManager ? (
        <Card size="sm">
          <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-muted-foreground sm:flex-row sm:items-center sm:gap-3">
              View
              <select
                aria-label="View"
                value={scopeValue}
                onChange={(e) => setUrl({ scope: e.target.value === "all" ? "" : e.target.value })}
                className={cn(SELECT_CLASS, "flex-1")}
              >
                <option value="all">All AEs (team)</option>
                {(data?.ae_options ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.first_name}
                    {o.is_test ? " (test)" : ""}
                  </option>
                ))}
                <option value="ooa">OOA — Out of Area</option>
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              Showing <span className="font-medium text-foreground">{scopeLabel}</span>
              {scopeKind === "all" ? " — every AE, with OOA as its own bucket" : ""}.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {addOpen && data ? (
        <AddLead
          isManager={isManager}
          viewerId={viewerId}
          aeOptions={data.ae_options}
          defaultAssignee={scopeKind === "ae" ? (data.scope.ae_id ?? "") : scopeKind === "ooa" ? "ooa" : ""}
          onCancel={() => setAddOpen(false)}
          onAdded={() => {
            setAddOpen(false);
            void load();
          }}
        />
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* Metric cards — each is a button that lists exactly those leads. */}
      {metrics ? (
        <section aria-label="Summary" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {CARDS.filter((c) => c.key !== "ooa" || scopeKind === "all").map((c) => {
            const active = metric === c.key;
            const attention = c.key === "needs_first_contact" && c.value(metrics) > 0;
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={active}
                onClick={() => setUrl({ metric: active ? null : c.key })}
                className={cn(
                  "flex min-h-20 flex-col items-start justify-between rounded-xl bg-card p-3 text-left ring-1 transition-colors",
                  active ? "ring-2 ring-primary" : "ring-foreground/10 hover:bg-muted/50",
                )}
              >
                <span className="text-xs text-muted-foreground">{SWAG_METRIC_LABELS[c.key]}</span>
                <span className={cn("text-2xl font-bold tabular-nums", attention && "text-destructive")}>
                  {c.value(metrics)}
                </span>
                {c.sub ? <span className="text-xs text-muted-foreground">{c.sub(metrics)}</span> : null}
              </button>
            );
          })}
        </section>
      ) : null}

      {/* Team view: one row per AE (OOA excluded), AEs-only subtotal, OOA apart. */}
      {data?.by_ae && data.ae_total && data.ooa_metrics ? (
        <ByAeTable
          rows={data.by_ae}
          aeTotal={data.ae_total}
          ooa={data.ooa_metrics}
          onPick={(id) => setUrl({ scope: id })}
        />
      ) : null}

      <FilterBar
        filters={filters}
        onChange={setFilters}
        territories={data?.territories ?? []}
        showTerritory={isManager}
      />

      {metric ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          Showing <span className="font-semibold">{SWAG_METRIC_LABELS[metric]}</span>
          <span className="text-muted-foreground">({data?.matched ?? "…"})</span>
          <button
            type="button"
            onClick={() => setUrl({ metric: null })}
            className="inline-flex min-h-9 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
          >
            <X aria-hidden="true" className="size-3" /> Clear
          </button>
        </p>
      ) : null}

      {loading && !data ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : data && data.leads.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {metric || Object.values(filters).some(Boolean)
            ? "No leads match."
            : isManager
              ? "No swag leads here yet."
              : "You have no swag leads yet. New ones assigned to you will show up here."}
        </p>
      ) : (
        <ul className={cn("grid gap-3 lg:grid-cols-2", loading && "opacity-60")}>
          {(data?.leads ?? []).map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              viewerId={viewerId}
              isManager={isManager}
              aeOptions={data?.ae_options ?? []}
              onChanged={replaceLead}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ByAeTable({
  rows,
  aeTotal,
  ooa,
  onPick,
}: {
  rows: NonNullable<SwagLeadsResponse["by_ae"]>;
  aeTotal: SwagMetrics;
  ooa: SwagMetrics;
  onPick: (aeId: string) => void;
}) {
  const cols: Array<[string, (m: SwagMetrics) => number]> = [
    ["Leads", (m) => m.total],
    ["Need 1st contact", (m) => m.needs_first_contact],
    ["Followed up", (m) => m.followed_up],
    ["Met", (m) => m.met_in_person],
    ["Swag", (m) => m.swag_delivered],
    ["Agents w/ orders", (m) => m.agents_with_orders],
    ["Orders", (m) => m.total_orders],
  ];
  const cell = "px-2 py-2 text-right tabular-nums";
  return (
    <section aria-label="By AE" className="overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">AE</th>
            {cols.map(([label]) => (
              <th key={label} className={cn(cell, "font-medium")}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ae_id} className="border-b border-border/60 hover:bg-muted/40">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                <button type="button" onClick={() => onPick(r.ae_id)} className="min-h-9 underline-offset-2 hover:underline">
                  {r.name}
                </button>
              </th>
              {cols.map(([label, f]) => (
                <td key={label} className={cell}>
                  {f(r.metrics)}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-b border-border bg-muted/30 font-semibold">
            <th scope="row" className="px-3 py-2 text-left">AEs only</th>
            {cols.map(([label, f]) => (
              <td key={label} className={cell}>
                {f(aeTotal)}
              </td>
            ))}
          </tr>
          <tr className="text-muted-foreground">
            <th scope="row" className="px-3 py-2 text-left font-medium">
              OOA <span className="text-xs font-normal">(not an AE)</span>
            </th>
            {cols.map(([label, f]) => (
              <td key={label} className={cell}>
                {f(ooa)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function FilterBar({
  filters,
  onChange,
  territories,
  showTerritory,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  territories: string[];
  showTerritory: boolean;
}) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...filters, [k]: v });
  const yesNo = (label: string, k: "contacted" | "met_in_person" | "swag_delivered" | "orders_received" | "confirmed_realtor") => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select value={filters[k]} onChange={(e) => set(k, e.target.value as YesNo)} className={SELECT_CLASS}>
        <option value="">Any</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  );
  const active = Object.values(filters).some(Boolean);
  return (
    <div className="flex flex-col gap-2">
      <Input
        type="search"
        aria-label="Search leads"
        placeholder="Search name or contact info"
        value={filters.q}
        onChange={(e) => set("q", e.target.value)}
        className="min-h-11"
      />
      <details className="rounded-lg border border-border/70 px-3 py-2">
        <summary className="min-h-9 cursor-pointer text-sm font-medium">
          Filters{active ? " (on)" : ""}
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {yesNo("Contacted", "contacted")}
          {yesNo("Met in person", "met_in_person")}
          {yesNo("Swag delivered", "swag_delivered")}
          {yesNo("Any orders received", "orders_received")}
          {yesNo("Confirmed realtor", "confirmed_realtor")}
          {showTerritory ? (
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Territory
              <select value={filters.territory} onChange={(e) => set("territory", e.target.value)} className={SELECT_CLASS}>
                <option value="">Any</option>
                {territories.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Received from
            <Input type="date" value={filters.from} onChange={(e) => set("from", e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Received to
            <Input type="date" value={filters.to} onChange={(e) => set("to", e.target.value)} />
          </label>
        </div>
        {active ? (
          <Button variant="outline" size="sm" className="mt-3 min-h-9" onClick={() => onChange(NO_FILTERS)}>
            Clear filters
          </Button>
        ) : null}
      </details>
    </div>
  );
}

function AddLead({
  isManager,
  viewerId,
  aeOptions,
  defaultAssignee,
  onCancel,
  onAdded,
}: {
  isManager: boolean;
  viewerId: string;
  aeOptions: NonNullable<SwagLeadsResponse["ae_options"]>;
  defaultAssignee: string;
  onCancel: () => void;
  onAdded: () => void;
}) {
  // One idempotency key per opened form: a double-tapped Save can't add it twice.
  const [requestId] = useState(() => crypto.randomUUID());
  const [assignee, setAssignee] = useState(defaultAssignee);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (values: LeadFormValues) => {
    if (isManager && !assignee) {
      setError("Choose who this lead is assigned to.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/swag-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...fieldsFromValues(values),
          request_id: requestId,
          ...(isManager ? (assignee === "ooa" ? { ooa: true } : { assigned_to: assignee }) : { assigned_to: viewerId }),
        }),
      });
      if (!res.ok) {
        setError(await errorText(res, "Couldn't add the lead"));
        return;
      }
      onAdded();
    } catch {
      setError("Couldn't reach the server — nothing was added. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Add a swag lead</h2>
        <SwagLeadForm
          mode="create"
          initial={emptyFormValues()}
          canEditIdentity
          aeOptions={isManager ? aeOptions : undefined}
          assignment={isManager ? { value: assignee, onChange: setAssignee } : undefined}
          busy={busy}
          error={error}
          onSubmit={(v) => void submit(v)}
          onCancel={onCancel}
        />
      </CardContent>
    </Card>
  );
}
