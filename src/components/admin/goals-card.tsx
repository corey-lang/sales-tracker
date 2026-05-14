"use client";

import { useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";

import { supabase } from "@/lib/supabase/client";
import { formatDateMDY } from "@/lib/dates";
import { fetchActiveGoalForScope } from "@/lib/goals";
import { useSalesperson } from "@/lib/use-salesperson";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  ADMIN_ACTIVITY_KEYS,
  ZERO_ADMIN,
  type AdminKey,
  type AdminValues,
} from "@/components/admin/totals-card";

type Salesperson = { id: string; first_name: string };

type GoalRow = AdminValues & {
  id: string;
  salesperson_id: string | null;
  effective_from: string;
  created_at?: string;
  created_by?: string | null;
};

const GLOBAL_SCOPE = "__global__";
const FILTER_ALL = "__all__";

type Props = {
  people: Salesperson[];
};

export function GoalsCard({ people }: Props) {
  const { salesperson } = useSalesperson();
  // Full salespeople list (including admins) — used only for resolving
  // created_by IDs in the audit line, since the `people` prop intentionally
  // excludes admins from the scope dropdown.
  const [allPeople, setAllPeople] = useState<Salesperson[]>([]);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  // Unfiltered copy of goals for computing active overrides + global, so the
  // overrides section stays accurate regardless of the history filter.
  const [allGoals, setAllGoals] = useState<GoalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [historyFilter, setHistoryFilter] = useState<string>(FILTER_ALL);
  const [expanded, setExpanded] = useState(false);

  const changeHistoryFilter = (next: string) => {
    setHistoryFilter(next);
    setExpanded(false);
  };

  // Form state — every save INSERTs, so no editingId concept.
  const [scope, setScope] = useState<string>(GLOBAL_SCOPE);
  const [effectiveFrom, setEffectiveFrom] = useState<string>(() =>
    format(new Date(), "yyyy-MM-dd"),
  );
  const [values, setValues] = useState<AdminValues>({ ...ZERO_ADMIN });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let q = supabase
      .from("weekly_goals")
      .select("*")
      .order("created_at", { ascending: false });
    if (historyFilter === GLOBAL_SCOPE) {
      q = q.is("salesperson_id", null);
    } else if (historyFilter !== FILTER_ALL) {
      q = q.eq("salesperson_id", historyFilter);
    }
    q.then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
      setGoals((data ?? []) as GoalRow[]);
      setError(null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshTick, historyFilter]);

  const refresh = () => setRefreshTick((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("salespeople")
      .select("id, first_name")
      .then(({ data }) => {
        if (cancelled) return;
        if (data) setAllPeople(data as Salesperson[]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Unfiltered fetch for the overrides + active global views.
  useEffect(() => {
    let cancelled = false;
    supabase
      .from("weekly_goals")
      .select("*")
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (cancelled) return;
        if (data) setAllGoals(data as GoalRow[]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const todayIso = format(new Date(), "yyyy-MM-dd");

  const activeGlobal = useMemo<GoalRow | null>(() => {
    for (const g of allGoals) {
      if (g.salesperson_id == null && g.effective_from <= todayIso) return g;
    }
    return null;
  }, [allGoals, todayIso]);

  const overrides = useMemo(() => {
    const byPerson = new Map<string, GoalRow>();
    for (const g of allGoals) {
      if (g.salesperson_id == null) continue;
      if (g.effective_from > todayIso) continue;
      if (!byPerson.has(g.salesperson_id)) {
        byPerson.set(g.salesperson_id, g);
      }
    }
    return [...byPerson.entries()]
      .map(([id, goal]) => ({
        id,
        name:
          allPeople.find((p) => p.id === id)?.first_name ?? "Unknown",
        goal,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allGoals, allPeople, todayIso]);

  // On mount: pre-fill the form with the currently active Global default so
  // the admin only has to type what they're changing.
  useEffect(() => {
    let cancelled = false;
    fetchActiveGoalForScope(null).then(({ data: goal }) => {
      if (cancelled || !goal) return;
      const next: AdminValues = { ...ZERO_ADMIN };
      for (const a of ADMIN_ACTIVITY_KEYS) {
        next[a.key] = Number(goal[a.key] ?? 0);
      }
      setValues(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-load current effective goal when the user changes the Scope picker.
  // Reset and "Use as template" bypass this by setting `scope` directly.
  const handleScopeChange = (next: string) => {
    setScope(next);
    setSaveError(null);
    setSavedMsg(null);
    const scopeArg = next === GLOBAL_SCOPE ? null : next;
    fetchActiveGoalForScope(scopeArg).then(({ data: goal }) => {
      const filled: AdminValues = { ...ZERO_ADMIN };
      if (goal) {
        for (const a of ADMIN_ACTIVITY_KEYS) {
          filled[a.key] = Number(goal[a.key] ?? 0);
        }
      }
      setValues(filled);
    });
  };

  const resetForm = () => {
    setScope(GLOBAL_SCOPE);
    setEffectiveFrom(format(new Date(), "yyyy-MM-dd"));
    setValues({ ...ZERO_ADMIN });
    setSaveError(null);
  };

  const loadIntoForm = (g: GoalRow) => {
    setScope(g.salesperson_id ?? GLOBAL_SCOPE);
    setEffectiveFrom(g.effective_from);
    const next: AdminValues = { ...ZERO_ADMIN };
    for (const a of ADMIN_ACTIVITY_KEYS) {
      next[a.key] = Number(g[a.key] ?? 0);
    }
    setValues(next);
    setSaveError(null);
    setSavedMsg(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSavedMsg(null);
    const payload = {
      salesperson_id: scope === GLOBAL_SCOPE ? null : scope,
      effective_from: effectiveFrom,
      created_by: salesperson?.id ?? null,
      ...values,
    };
    const { data, error } = await supabase
      .from("weekly_goals")
      .insert(payload)
      .select();
    setSaving(false);
    if (error) {
      setSaveError(error.message);
      return;
    }
    if (!data || data.length === 0) {
      setSaveError(
        "Insert returned no row. Make sure the schema migration ran.",
      );
      return;
    }
    setSavedMsg("Goal saved.");
    refresh();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this goal row from history?")) return;
    const { error } = await supabase.from("weekly_goals").delete().eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    refresh();
  };

  const personById = (id: string | null) => {
    if (!id) return "Global default";
    return allPeople.find((p) => p.id === id)?.first_name ?? "Unknown";
  };

  const formatTimestamp = (ts: string | undefined) => {
    if (!ts) return "";
    return `${formatDateMDY(ts)} ${format(parseISO(ts), "h:mm a")}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Goals</CardTitle>
        <CardDescription>
          Set Monday-Friday weekly goals for each activity. Daily entries feed
          weekly progress. Each save adds a new row below — old goals stay so
          you can see what changed. The app uses the newest goal that has
          already started. A person&apos;s own goal is used if they have one;
          otherwise the team default is used.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3 rounded-md border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">Add or change goal</h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetForm}
            >
              Reset
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="goal-scope">Scope</Label>
              <Select value={scope} onValueChange={handleScopeChange}>
                <SelectTrigger id="goal-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={GLOBAL_SCOPE}>Global default</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.first_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-from">Starts on</Label>
              <Input
                id="goal-from"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {ADMIN_ACTIVITY_KEYS.map((a) => (
              <div key={a.key} className="space-y-1.5">
                <Label htmlFor={`goal-${a.key}`}>{a.label}</Label>
                <Input
                  id={`goal-${a.key}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  placeholder="0"
                  value={values[a.key] === 0 ? "" : values[a.key]}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const next =
                      raw === ""
                        ? 0
                        : Math.max(0, Math.floor(Number(raw) || 0));
                    setValues((v) => ({
                      ...v,
                      [a.key as AdminKey]: next,
                    }));
                  }}
                />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save goal"}
            </Button>
            {saveError && (
              <p className="text-sm text-destructive">{saveError}</p>
            )}
            {savedMsg && !saveError && (
              <p className="text-sm text-green-600 dark:text-green-400">
                {savedMsg}
              </p>
            )}
          </div>
        </section>

        {overrides.length > 0 && (
          <section className="space-y-3 rounded-md border p-4">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">
                Active per-person overrides ({overrides.length})
              </h3>
              <p className="text-xs text-muted-foreground">
                These reps have their own goal rows — changing the Global
                default below won&apos;t affect them. Values that differ from
                the current Global default are highlighted.
              </p>
            </div>
            <ul className="space-y-3">
              {overrides.map((o) => (
                <li key={o.id} className="space-y-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold">{o.name}</span>
                    <span className="text-xs text-muted-foreground">
                      since {formatDateMDY(o.goal.effective_from)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    {ADMIN_ACTIVITY_KEYS.map((a) => {
                      const personal = Number(o.goal[a.key] ?? 0);
                      const globalVal = Number(
                        activeGlobal?.[a.key] ?? 0,
                      );
                      const differs =
                        activeGlobal != null && personal !== globalVal;
                      return (
                        <span
                          key={a.key}
                          className={
                            differs
                              ? "font-semibold text-foreground"
                              : "text-muted-foreground"
                          }
                        >
                          {a.label}:{" "}
                          <span className="tabular-nums">{personal}</span>
                          {differs && (
                            <span className="ml-1 text-muted-foreground">
                              (G: {globalVal})
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Goal history</h3>
            <div className="flex items-center gap-2">
              <Label htmlFor="history-filter" className="text-xs">
                Show
              </Label>
              <Select
                value={historyFilter}
                onValueChange={changeHistoryFilter}
              >
                <SelectTrigger id="history-filter" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={GLOBAL_SCOPE}>Global default</SelectItem>
                  <SelectItem value={FILTER_ALL}>All scopes</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.first_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="text-sm text-destructive">Couldn&apos;t load: {error}</p>
          ) : goals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No goals match this filter yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {(expanded ? goals : goals.slice(0, 3)).map((g) => (
                <li key={g.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <span className="font-semibold">
                        {personById(g.salesperson_id)}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        — starts {formatDateMDY(g.effective_from)}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => loadIntoForm(g)}
                      >
                        Use as template
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDelete(g.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                  {g.created_at && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Edited {formatTimestamp(g.created_at)}
                      {g.created_by &&
                        ` by ${personById(g.created_by)}`}
                    </p>
                  )}
                  <p className="mt-1.5 tabular-nums text-muted-foreground">
                    {ADMIN_ACTIVITY_KEYS.map((a) => (
                      <span key={a.key} className="mr-3">
                        {a.label}:{" "}
                        <span className="text-foreground">
                          {Number(g[a.key] ?? 0)}
                        </span>
                      </span>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {goals.length > 3 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded
                ? "Show less"
                : `Show all (${goals.length})`}
            </Button>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
