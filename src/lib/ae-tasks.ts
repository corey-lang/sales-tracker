/**
 * Shared types + constants for the AE To-Do / Follow-Up tasks feature.
 *
 * Safe to import from both client components and server routes — it contains
 * no server-only imports. The `ae_tasks` table is a standalone, lightweight
 * task system today; it is shaped so it can later grow into CRM follow-ups.
 */

/** The status values an ae_tasks row may hold. Mirrors the DB CHECK constraint. */
export const TASK_STATUSES = ["open", "done", "cancelled"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** One ae_tasks row, as returned by the /api/tasks routes. */
export type AeTask = {
  id: string;
  salesperson_id: string;
  title: string;
  description: string | null;
  /** ISO date (yyyy-mm-dd) or null when the task has no due date. */
  due_date: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

/** Type guard for an unknown string against the allowed statuses. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" &&
    (TASK_STATUSES as readonly string[]).includes(value)
  );
}
