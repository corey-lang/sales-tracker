"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { formatDateMDY } from "@/lib/dates";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const ADMIN_ACTIVITY_KEYS = [
  { key: "office_visits", label: "Visits" },
  { key: "service_requests", label: "Reqs" },
  { key: "ones_scheduled", label: "1:1 Sch" },
  { key: "ones_held", label: "1:1 Held" },
  { key: "presentations", label: "Pres" },
  { key: "impressions", label: "Impr" },
  { key: "team_meetings", label: "Mtgs" },
  { key: "gold_list_touches", label: "Gold" },
] as const;

export type AdminKey = (typeof ADMIN_ACTIVITY_KEYS)[number]["key"];
export type AdminValues = Record<AdminKey, number>;

export const ZERO_ADMIN: AdminValues = {
  office_visits: 0,
  service_requests: 0,
  ones_scheduled: 0,
  ones_held: 0,
  presentations: 0,
  impressions: 0,
  team_meetings: 0,
  gold_list_touches: 0,
};

type Salesperson = { id: string; first_name: string };

type Props = {
  from: string;
  to: string;
  salespersonFilter: string; // "all" or salesperson id
  people: Salesperson[];
};

export function TotalsCard({ from, to, salespersonFilter, people }: Props) {
  const [totals, setTotals] = useState<Map<string, AdminValues>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (people.length === 0) return;
    let cancelled = false;

    const cols = ["salesperson_id", ...ADMIN_ACTIVITY_KEYS.map((a) => a.key)];
    let q = supabase
      .from("activity_entries")
      .select(cols.join(","))
      .gte("entry_date", from)
      .lte("entry_date", to);
    if (salespersonFilter !== "all") {
      q = q.eq("salesperson_id", salespersonFilter);
    }
    q.then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
      const next = new Map<string, AdminValues>();
      for (const p of people) next.set(p.id, { ...ZERO_ADMIN });
      for (const row of (data ?? []) as unknown as Array<
        Partial<AdminValues> & { salesperson_id: string }
      >) {
        const bucket = next.get(row.salesperson_id);
        if (!bucket) continue;
        for (const a of ADMIN_ACTIVITY_KEYS) {
          bucket[a.key] += Number(row[a.key] ?? 0);
        }
      }
      setTotals(next);
      setError(null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [from, to, salespersonFilter, people]);

  const filteredPeople =
    salespersonFilter === "all"
      ? people
      : people.filter((p) => p.id === salespersonFilter);

  const grand: AdminValues = { ...ZERO_ADMIN };
  for (const p of filteredPeople) {
    const t = totals.get(p.id);
    if (!t) continue;
    for (const a of ADMIN_ACTIVITY_KEYS) grand[a.key] += t[a.key];
  }
  const grandTotal = ADMIN_ACTIVITY_KEYS.reduce(
    (s, a) => s + grand[a.key],
    0,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity totals</CardTitle>
        <CardDescription>
          {formatDateMDY(from)} → {formatDateMDY(to)},{" "}
          {salespersonFilter === "all" ? "all reps" : "1 rep"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">Couldn&apos;t load: {error}</p>
        ) : filteredPeople.length === 0 ? (
          <p className="text-sm text-muted-foreground">No salespeople.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Salesperson</th>
                  {ADMIN_ACTIVITY_KEYS.map((a) => (
                    <th
                      key={a.key}
                      className="py-2 px-2 text-right font-medium"
                    >
                      {a.label}
                    </th>
                  ))}
                  <th className="py-2 pl-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {filteredPeople.map((p) => {
                  const t = totals.get(p.id) ?? ZERO_ADMIN;
                  const personTotal = ADMIN_ACTIVITY_KEYS.reduce(
                    (s, a) => s + t[a.key],
                    0,
                  );
                  return (
                    <tr key={p.id} className="border-b last:border-b-0">
                      <td className="py-2 pr-3 font-medium">{p.first_name}</td>
                      {ADMIN_ACTIVITY_KEYS.map((a) => (
                        <td
                          key={a.key}
                          className="py-2 px-2 text-right tabular-nums"
                        >
                          {t[a.key]}
                        </td>
                      ))}
                      <td className="py-2 pl-2 text-right font-semibold tabular-nums">
                        {personTotal}
                      </td>
                    </tr>
                  );
                })}
                {filteredPeople.length > 1 && (
                  <tr className={cn("bg-muted/40")}>
                    <td className="py-2 pr-3 font-semibold">Grand total</td>
                    {ADMIN_ACTIVITY_KEYS.map((a) => (
                      <td
                        key={a.key}
                        className="py-2 px-2 text-right font-semibold tabular-nums"
                      >
                        {grand[a.key]}
                      </td>
                    ))}
                    <td className="py-2 pl-2 text-right font-semibold tabular-nums">
                      {grandTotal}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
