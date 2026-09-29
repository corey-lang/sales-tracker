// Legacy Weekly Focus commitment edits — the ONE definition of what a PATCH /
// DELETE may change, shared by:
//   * PATCH/DELETE /api/admin/one-on-ones/[id]/commitments/[cid] (original
//     route, unchanged behavior, no notion of a 1:1), and
//   * PATCH/DELETE /api/admin/one-on-one-meetings/[id]/legacy-commitments/[cid]
//     (the same edit made from inside an in-progress 1:1, applied by the
//     update_legacy_commitment_in_one_on_one() transaction so it can't land
//     after that 1:1's completion snapshot).

import { z } from "zod";

import {
  COMMITMENT_CONTENT_MAX_LENGTH,
  COMMITMENT_STATUSES,
} from "@/lib/one-on-ones";

export const LegacyCommitmentUpdateSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, "Commitment cannot be empty.")
      .max(COMMITMENT_CONTENT_MAX_LENGTH)
      .optional(),
    status: z.enum(COMMITMENT_STATUSES).optional(),
    completed: z.boolean().optional(),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be YYYY-MM-DD.")
      .nullish(),
  })
  .refine(
    // Disallow both fields at once — they describe the same lifecycle
    // axis and an inconsistent pair (status=dropped + completed=true)
    // would be ambiguous. Status is authoritative; clients should send
    // that going forward.
    (b) => !(b.status !== undefined && b.completed !== undefined),
    { message: "Send either `status` or `completed`, not both." },
  );

/**
 * Translates a PATCH body into the columns to write. Status is the
 * authoritative lifecycle field; the legacy `completed` boolean and
 * `completed_at` timestamp are kept in sync from it so any external
 * report query that still filters on `completed = true` stays correct.
 */
export function buildLifecyclePatch(input: {
  status?: (typeof COMMITMENT_STATUSES)[number];
  completed?: boolean;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let nextStatus: (typeof COMMITMENT_STATUSES)[number] | undefined;
  if (input.status !== undefined) {
    nextStatus = input.status;
  } else if (input.completed !== undefined) {
    nextStatus = input.completed ? "completed" : "open";
  }
  if (nextStatus === undefined) return out;
  out.status = nextStatus;
  out.completed = nextStatus === "completed";
  // Stamp completed_at on the transition so an undone item drops the
  // timestamp too. Dropped commitments never set completed_at.
  out.completed_at =
    nextStatus === "completed" ? new Date().toISOString() : null;
  return out;
}


/**
 * Columns a legacy PATCH writes, or null when the body changes nothing.
 * Status drives `completed` / `completed_at`; content and due date pass
 * through.
 */
export function buildLegacyCommitmentPatch(
  body: z.infer<typeof LegacyCommitmentUpdateSchema>,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = { ...buildLifecyclePatch(body) };
  if (body.content !== undefined) patch.content = body.content;
  if (body.due_date !== undefined) patch.due_date = body.due_date ?? null;
  return Object.keys(patch).length ? patch : null;
}

/** DELETE is a soft drop: the row stays as coaching history. */
export const LEGACY_DROP_PATCH = {
  status: "dropped",
  completed: false,
  completed_at: null,
} as const;
