import { format, parseISO } from "date-fns";

// User-facing date display: mm-dd-yyyy.
// Inputs and DB values stay yyyy-mm-dd (ISO) so they remain sortable / valid
// for Postgres DATE and HTML <input type="date">.
export function formatDateMDY(input: string | Date): string {
  const d = typeof input === "string" ? parseISO(input) : input;
  return format(d, "MM-dd-yyyy");
}
