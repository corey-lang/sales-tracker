import { format, parseISO } from "date-fns";

/** yyyy-MM-dd -> "Oct 5, 2026". */
export const longDate = (iso: string) => format(parseISO(iso), "MMM d, yyyy");

/** "today" / "yesterday" / "3 days ago" — how old the latest total is. */
export function ageLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** yyyy-MM-dd -> "Oct 5" (compact, for the Home card). */
export const shortDate = (iso: string) => format(parseISO(iso), "MMM d");
