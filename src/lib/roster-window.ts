/**
 * Who belongs on a REPORT for a given date window.
 *
 * Live rosters (login list, selectors, today's cards) ask a simple question —
 * "is this person active right now?" — and use `deactivated_at IS NULL`.
 * Reports for a PAST (or partly past) period ask a different one: "was this
 * person on the team during that period?" Two boundaries answer it:
 *
 *   started_on     — the first day they were part of the roster (NULL = no
 *                    start boundary; every pre-existing salesperson).
 *   deactivated_at — the moment they left (NULL = still here). Their final
 *                    active DAY (America/Denver) is the boundary, so a week
 *                    that overlaps it still includes them.
 *
 * A person is on the roster for window [since, through] (inclusive yyyy-MM-dd)
 * iff they had started by `through` AND had not left before `since`. This is
 * what keeps a departed AE's results in past reports while keeping a newly
 * hired AE out of the periods before they joined — without deleting,
 * re-attributing, or re-scoring any history.
 *
 * Pure: no I/O, so every reporting surface shares exactly one rule.
 */

export type RosterTenure = {
  /** yyyy-MM-dd, or null for "no start boundary". */
  started_on?: string | null;
  /** ISO timestamp, or null/undefined while still active. */
  deactivated_at?: string | null;
};

/** yyyy-MM-dd of an instant in the app's reporting zone (America/Denver). */
export function appDateOnly(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "01";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** True when the person was on the team at any point in [since, through]. */
export function isRosteredDuring(
  person: RosterTenure,
  since: string,
  through: string,
): boolean {
  if (person.started_on && person.started_on > through) return false;
  if (person.deactivated_at && appDateOnly(person.deactivated_at) < since) {
    return false;
  }
  return true;
}
