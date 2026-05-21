"use client";

import { useState } from "react";

import { supabase } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// "Match-all" filter for Supabase deletes (.delete() requires a filter to
// avoid accidental full-table wipes).
const MATCH_ALL = "1900-01-01";

export function MaintenanceCard() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearTestData = async () => {
    if (
      !confirm(
        "Delete every activity_entries row for accounts marked is_test = true? This cannot be undone.",
      )
    )
      return;

    setBusy(true);
    setMsg(null);
    setError(null);

    const { data: testPeople, error: peopleErr } = await supabase
      .from("salespeople")
      .select("id, first_name")
      .eq("is_test", true);

    if (peopleErr) {
      setBusy(false);
      setError(peopleErr.message);
      return;
    }
    if (!testPeople || testPeople.length === 0) {
      setBusy(false);
      setMsg("No test accounts found — nothing to clear.");
      return;
    }

    const ids = testPeople.map((p) => p.id);
    const { error: delErr, count } = await supabase
      .from("activity_entries")
      .delete({ count: "exact" })
      .in("salesperson_id", ids);

    setBusy(false);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    setMsg(
      `Cleared ${count ?? 0} activity rows for ${testPeople.length} test account(s).`,
    );
  };

  const clearAllActivity = async () => {
    if (
      !confirm(
        "Delete EVERY activity_entries row in the database (all reps, every date). This is permanent. Continue?",
      )
    )
      return;
    if (!confirm("Really, really sure? Last chance.")) return;

    setBusy(true);
    setMsg(null);
    setError(null);

    const { error: delErr, count } = await supabase
      .from("activity_entries")
      .delete({ count: "exact" })
      .gte("entry_date", MATCH_ALL);

    setBusy(false);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    setMsg(`Cleared ${count ?? 0} activity rows.`);
  };

  /**
   * Calls the admin-gated maintenance route. Both goal-destructive
   * actions go through the same endpoint now that `weekly_goals` is
   * RLS-locked from the anon key — see supabase/weekly_goals_lockdown.sql.
   */
  const runGoalMaintenance = async (
    action: "clear_all" | "clear_old_versions",
  ): Promise<{ deleted: number } | null> => {
    const res = await apiFetch("/api/admin/goals/maintenance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const body = (await res.json().catch(() => null)) as
      | { deleted?: number; error?: string }
      | null;
    if (!res.ok || !body || typeof body.deleted !== "number") {
      setError(body?.error ?? `Couldn't run (${res.status}).`);
      return null;
    }
    return { deleted: body.deleted };
  };

  const clearAllGoals = async () => {
    if (
      !confirm(
        "Delete EVERY goal row, including the currently active one. The dashboard will show no targets until you add a new goal. Continue?",
      )
    )
      return;
    if (!confirm("Really, really sure? Last chance.")) return;

    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const result = await runGoalMaintenance("clear_all");
      if (result) setMsg(`Cleared ${result.deleted} goal rows.`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't clear — please retry.",
      );
    } finally {
      setBusy(false);
    }
  };

  const clearOldGoalVersions = async () => {
    if (
      !confirm(
        "Delete only OLD versions of each goal scope, keeping the most recent row per (salesperson_id / Global). This is safe for the active goal but cannot be undone.",
      )
    )
      return;

    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const result = await runGoalMaintenance("clear_old_versions");
      if (result) {
        setMsg(
          result.deleted === 0
            ? "No old versions to delete — every scope has only one row."
            : `Deleted ${result.deleted} old goal versions; latest per scope kept.`,
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't clear — please retry.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Maintenance</CardTitle>
        <CardDescription>
          Destructive operations. There&apos;s no undo — Supabase will prompt you
          to confirm each click.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={clearTestData}
            disabled={busy}
          >
            Clear test account activity
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={clearAllActivity}
            disabled={busy}
          >
            Clear ALL activity
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={clearOldGoalVersions}
            disabled={busy}
          >
            Delete old goal versions (keep latest)
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={clearAllGoals}
            disabled={busy}
          >
            Delete ALL goals (current included)
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {msg && !error && (
          <p className="text-sm text-green-600 dark:text-green-400">{msg}</p>
        )}
      </CardContent>
    </Card>
  );
}
