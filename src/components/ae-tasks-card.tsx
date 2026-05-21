"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { CalendarPlus, Check, ChevronDown, Plus } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { formatDateMDY, todayInAppTimezone } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { AeTask } from "@/lib/ae-tasks";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Open-task buckets, in the order the section renders them. */
type Bucket = {
  key: "overdue" | "today" | "upcoming";
  label: string;
  tone: "bad" | "warn" | "muted";
  tasks: AeTask[];
};

/** Reads an `error` string from a parsed JSON response, if present. */
function errorOf(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

export function AeTasksCard() {
  // `null` = not loaded yet; an array (possibly empty) = loaded.
  const [tasks, setTasks] = useState<AeTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newTitle, setNewTitle] = useState("");
  const [newDueDate, setNewDueDate] = useState("");
  const [showDate, setShowDate] = useState(false);
  const [adding, setAdding] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch("/api/tasks");
      const payload = (await res.json().catch(() => null)) as
        | { tasks?: AeTask[]; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(errorOf(payload, `Request failed (${res.status})`));
      }
      setTasks(Array.isArray(payload?.tasks) ? payload.tasks : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks.");
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    // Async IIFE so the effect body sets no state synchronously.
    void (async () => {
      await load();
    })();
  }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title || adding) return;

    setAdding(true);
    setError(null);
    try {
      const res = await apiFetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, due_date: newDueDate || undefined }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { task?: AeTask; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(errorOf(payload, `Could not add task (${res.status})`));
      }
      setNewTitle("");
      setNewDueDate("");
      setShowDate(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add task.");
    } finally {
      setAdding(false);
    }
  };

  const handleComplete = async (id: string) => {
    if (completingId) return;
    setCompletingId(id);
    setError(null);
    try {
      const res = await apiFetch(`/api/tasks/${id}/complete`, {
        method: "POST",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as unknown;
        throw new Error(
          errorOf(payload, `Could not complete task (${res.status})`),
        );
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not complete task.");
    } finally {
      setCompletingId(null);
    }
  };

  const { buckets, ordered, completed, openCount } = useMemo(() => {
    // "Today" is the Denver business day so "Due today" / "Overdue"
    // bucketing stays consistent with the leaderboard / Weekly Focus
    // notion of the current day regardless of browser timezone.
    const today = format(todayInAppTimezone(), "yyyy-MM-dd");
    const overdue: AeTask[] = [];
    const dueToday: AeTask[] = [];
    const upcomingDated: AeTask[] = [];
    const noDate: AeTask[] = [];
    const done: AeTask[] = [];
    for (const task of tasks ?? []) {
      if (task.status === "done") {
        done.push(task);
        continue;
      }
      if (task.status !== "open") continue; // cancelled — not shown
      if (!task.due_date) noDate.push(task);
      else if (task.due_date < today) overdue.push(task);
      else if (task.due_date === today) dueToday.push(task);
      else upcomingDated.push(task);
    }
    done.sort((a, b) =>
      (b.completed_at ?? "").localeCompare(a.completed_at ?? ""),
    );
    // Priority order for the visible cap: overdue → today → upcoming → no date.
    const ordered = [...overdue, ...dueToday, ...upcomingDated, ...noDate];
    return {
      buckets: [
        { key: "overdue", label: "Overdue", tone: "bad", tasks: overdue },
        { key: "today", label: "Today", tone: "warn", tasks: dueToday },
        {
          key: "upcoming",
          label: "Upcoming",
          tone: "muted",
          tasks: [...upcomingDated, ...noDate],
        },
      ] as Bucket[],
      ordered,
      completed: done.slice(0, 25),
      openCount: ordered.length,
    };
  }, [tasks]);

  // Cap the dashboard at the 5 highest-priority open tasks; the rest expand
  // in place behind the "View all" control.
  const VISIBLE_LIMIT = 5;
  const overLimit = openCount > VISIBLE_LIMIT;
  const visibleIds = new Set(
    (expanded ? ordered : ordered.slice(0, VISIBLE_LIMIT)).map((t) => t.id),
  );
  const visibleBuckets = buckets
    .map((b) => ({
      ...b,
      tasks: b.tasks.filter((t) => visibleIds.has(t.id)),
    }))
    .filter((b) => b.tasks.length > 0);

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 px-0.5">
        <h2 className="text-sm font-medium text-muted-foreground">To-Do</h2>
        {openCount > 0 && (
          <span className="rounded-full bg-primary/10 px-1.5 text-xs font-semibold tabular-nums text-primary">
            {openCount}
          </span>
        )}
      </div>

      {/* Compact quick-add: one line; due date is an optional reveal. */}
      <form onSubmit={handleAdd} className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Input
            aria-label="New task"
            placeholder="Add a task…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            disabled={adding}
            maxLength={200}
            className="flex-1"
          />
          <Button
            type="submit"
            size="sm"
            disabled={adding || newTitle.trim().length === 0}
          >
            <Plus aria-hidden="true" className="size-4" />
            {adding ? "Adding…" : "Add"}
          </Button>
        </div>
        {showDate ? (
          <div className="flex items-center gap-2 pl-0.5">
            <CalendarPlus
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <Input
              aria-label="Due date"
              type="date"
              value={newDueDate}
              onChange={(e) => setNewDueDate(e.target.value)}
              disabled={adding}
              className="h-7 w-auto text-xs"
            />
            <button
              type="button"
              onClick={() => {
                setShowDate(false);
                setNewDueDate("");
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowDate(true)}
            className="inline-flex items-center gap-1 pl-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <CalendarPlus aria-hidden="true" className="size-3.5" />
            Add due date
          </button>
        )}
      </form>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {tasks === null ? (
        <p className="px-0.5 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {openCount === 0 ? (
            <p className="px-0.5 text-sm text-muted-foreground">
              {completed.length > 0
                ? "You're all caught up 🎉"
                : "No tasks yet — add one above."}
            </p>
          ) : (
            <div className="space-y-2">
              <div className="space-y-2.5">
                {visibleBuckets.map((bucket) => (
                  <div key={bucket.key} className="space-y-0.5">
                  <h3
                    className={cn(
                      "px-0.5 text-[11px] font-semibold uppercase tracking-wide",
                      bucket.tone === "bad"
                        ? "text-destructive"
                        : bucket.tone === "warn"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground",
                    )}
                  >
                    {bucket.label} · {bucket.tasks.length}
                  </h3>
                  <ul>
                    {bucket.tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        overdue={bucket.key === "overdue"}
                        busy={completingId === task.id}
                        disabled={completingId !== null}
                        onComplete={() => handleComplete(task.id)}
                      />
                    ))}
                  </ul>
                  </div>
                ))}
              </div>
              {overLimit && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="flex items-center gap-1 px-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  aria-expanded={expanded}
                >
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 transition-transform",
                      expanded && "rotate-180",
                    )}
                  />
                  {expanded ? "Show fewer" : `View all ${openCount} tasks`}
                </button>
              )}
            </div>
          )}

          {completed.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowCompleted((v) => !v)}
                className="flex items-center gap-1 px-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                aria-expanded={showCompleted}
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 transition-transform",
                    showCompleted && "rotate-180",
                  )}
                />
                Completed ({completed.length})
              </button>
              {showCompleted && (
                <ul className="mt-0.5">
                  {completed.map((task) => (
                    <li
                      key={task.id}
                      className="flex items-center gap-2.5 px-1 py-1"
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-green-600 text-white">
                        <Check aria-hidden="true" className="size-2.5" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground line-through">
                        {task.title}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** A single open task with a tap-to-complete checkbox. */
function TaskRow({
  task,
  overdue,
  busy,
  disabled,
  onComplete,
}: {
  task: AeTask;
  overdue: boolean;
  busy: boolean;
  disabled: boolean;
  onComplete: () => void;
}) {
  return (
    <li className="flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted/50">
      {/* 44px hit area for comfortable mobile tapping; the visible checkbox
          stays compact via the inner span. */}
      <button
        type="button"
        aria-label={`Mark "${task.title}" complete`}
        onClick={onComplete}
        disabled={disabled}
        className="group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex size-5 items-center justify-center rounded-full border-2 border-primary/40 text-transparent transition-colors group-hover:border-primary group-hover:bg-primary/10 group-hover:text-primary">
          <Check aria-hidden="true" className="size-3" />
        </span>
      </button>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="text-sm font-medium break-words">{task.title}</p>
        {task.description && (
          <p className="mt-0.5 text-xs text-muted-foreground break-words">
            {task.description}
          </p>
        )}
        {task.due_date && (
          <p
            className={cn(
              "mt-0.5 text-xs",
              overdue ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {overdue ? "Overdue · " : "Due "}
            {formatDateMDY(task.due_date)}
          </p>
        )}
      </div>
      {busy && (
        <span className="shrink-0 self-center text-xs text-muted-foreground">
          Saving…
        </span>
      )}
    </li>
  );
}
