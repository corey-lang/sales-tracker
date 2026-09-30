/**
 * What the goal editor may tell the manager after PUT /api/admin/coaching/
 * [ae_id]/goals — the ONLY place that decides whether "Saved" is shown.
 *
 * Inside a 1:1 (`inMeeting`) a save only counts if the server says the change
 * became part of the meeting (`recorded_in_meeting: true`). The route already
 * refuses with a 409 when it can't (it never answers 200 for an unrecorded
 * change); this is the client-side backstop so a 200 without that flag — an
 * older server, a proxy, a future regression — can never show "Saved" for a
 * change the completed 1:1 would omit.
 */
export type GoalSaveOutcome =
  | { saved: true }
  | { saved: false; error: string; /** live goals may have moved: re-sync */ resync: boolean };

export const GOAL_NOT_RECORDED_MESSAGE =
  "The goal change was not recorded on this 1:1. Reload and check the goals before relying on them.";

export async function interpretGoalSaveResponse(
  res: Pick<Response, "ok" | "status" | "json">,
  inMeeting: boolean,
): Promise<GoalSaveOutcome> {
  if (!res.ok) {
    const reason = (await res.json().catch(() => null)) as { error?: string } | null;
    return {
      saved: false,
      error: reason?.error ?? `Couldn't save (${res.status}).`,
      resync: false,
    };
  }
  if (inMeeting) {
    const body = (await res.json().catch(() => null)) as {
      recorded_in_meeting?: boolean;
    } | null;
    if (body?.recorded_in_meeting !== true) {
      return { saved: false, error: GOAL_NOT_RECORDED_MESSAGE, resync: true };
    }
  }
  return { saved: true };
}
