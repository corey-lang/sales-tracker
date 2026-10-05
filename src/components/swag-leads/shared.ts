// Small UI helpers shared by the Swag Leads components.

import { format } from "date-fns";

import { todayInAppTimezone } from "@/lib/dates";

export const FIELD_CLASS =
  "w-full rounded-md border border-border bg-background/40 px-2.5 py-2 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60 sm:text-sm";
export const SELECT_CLASS =
  "min-h-11 w-full rounded-lg border border-input bg-transparent px-2 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-sm";

/** yyyy-MM-dd for "today" on the Denver business calendar. */
export function todayIso(): string {
  return format(todayInAppTimezone(), "yyyy-MM-dd");
}

export function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The API's error text for a failed response (never the raw body). */
export async function errorText(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${fallback} (${res.status})`;
}
