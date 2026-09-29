// Server-side enforcement of the workflow-visibility rule (lib/roster.ts).
//
// Every route that takes a salesperson id from the URL/body — or that serves
// data owned by one — funnels through here, so another admin can't reach a
// private test account by typing its id. A salesperson the viewer can't see
// is a 404, indistinguishable from one that doesn't exist.

import type { SupabaseClient } from "@supabase/supabase-js";

import { canSeeSalesperson, visibleRosterOr } from "@/lib/roster";
import { ApiError, notFound } from "@/lib/server/auth";
import { selectAllPages } from "@/lib/server/paginate";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Throws 404 unless `viewer` may see salesperson `id` in workflows. */
export async function requireVisibleSalesperson(
  supabase: Db,
  viewer: { id: string },
  id: string,
  message = "Not found.",
): Promise<void> {
  const res = await supabase
    .from("salespeople")
    .select("id, is_test, test_owner_id")
    .eq("id", id)
    .maybeSingle();
  if (res.error) {
    throw new ApiError(500, "Could not load that salesperson.");
  }
  const row = res.data as { is_test: boolean | null; test_owner_id: string | null } | null;
  if (!row || !canSeeSalesperson(viewer, row)) throw notFound(message);
}

/**
 * Ids of every salesperson `viewer` may see in workflows (real people plus
 * the viewer's OWN test accounts). Used to scope reads of per-person rows
 * (goals, adjustments…) IN the query, so another admin's private rows are
 * never loaded, let alone sent to a browser.
 */
export async function visibleSalespersonIds(
  supabase: Db,
  viewer: { id: string },
): Promise<string[]> {
  const res = await selectAllPages<{ id: string }>(() =>
    supabase
      .from("salespeople")
      .select("id")
      .or(visibleRosterOr(viewer.id))
      .order("id", { ascending: true }),
  );
  if (res.error) throw new ApiError(500, "Could not load the roster.");
  return res.data.map((r) => r.id);
}

/**
 * Ids of test accounts `viewer` may NOT see — for filtering rows that were
 * loaded in bulk (e.g. an "All AEs" view). Small: test accounts are a
 * handful of rows at most.
 */
export async function hiddenTestSalespersonIds(
  supabase: Db,
  viewer: { id: string },
): Promise<Set<string>> {
  const res = await supabase
    .from("salespeople")
    .select("id, is_test, test_owner_id")
    .eq("is_test", true);
  if (res.error) {
    throw new ApiError(500, "Could not load the roster.");
  }
  const hidden = new Set<string>();
  for (const row of (res.data ?? []) as Array<{
    id: string;
    is_test: boolean | null;
    test_owner_id: string | null;
  }>) {
    if (!canSeeSalesperson(viewer, row)) hidden.add(row.id);
  }
  return hidden;
}

/** Ids of EVERY test account, whoever owns it — for excluding them from aggregates. */
export async function allTestSalespersonIds(supabase: Db): Promise<Set<string>> {
  const res = await selectAllPages<{ id: string }>(() =>
    supabase
      .from("salespeople")
      .select("id")
      .eq("is_test", true)
      .order("id", { ascending: true }),
  );
  if (res.error) throw new ApiError(500, "Could not load the roster.");
  return new Set(res.data.map((r) => r.id));
}

/** Ids of the test accounts `viewer` OWNS (the only test accounts visible to them). */
export async function ownedTestSalespersonIds(
  supabase: Db,
  viewer: { id: string },
): Promise<string[]> {
  const res = await selectAllPages<{ id: string }>(() =>
    supabase
      .from("salespeople")
      .select("id")
      .eq("is_test", true)
      .eq("test_owner_id", viewer.id)
      .order("id", { ascending: true }),
  );
  if (res.error) throw new ApiError(500, "Could not load the roster.");
  return res.data.map((r) => r.id);
}

/**
 * Whether `viewer` may link `scan` to the existing contact `contactId` as its
 * duplicate original. The contact must exist, belong to someone the viewer can
 * see, and be on the SAME side of the test/real line as the scan (a real scan
 * never points at a test contact and vice versa — duplicate detection itself
 * never crosses that line). Throws 404 otherwise, so an unknown, hidden or
 * cross-side UUID is indistinguishable.
 */
export async function requireLinkableDuplicateContact(
  supabase: Db,
  viewer: { id: string },
  scanId: string,
  contactId: string,
): Promise<void> {
  const [scanRes, contactRes] = await Promise.all([
    supabase
      .from("business_card_scans")
      .select("id, is_test_data")
      .eq("id", scanId)
      .maybeSingle(),
    supabase
      .from("business_card_contacts")
      .select("id, salesperson_id, is_test_data")
      .eq("id", contactId)
      .maybeSingle(),
  ]);
  if (scanRes.error || contactRes.error) {
    throw new ApiError(500, "Could not verify the duplicate contact.");
  }
  const scan = scanRes.data as { is_test_data: boolean | null } | null;
  const contact = contactRes.data as {
    salesperson_id: string | null;
    is_test_data: boolean | null;
  } | null;
  if (!scan) throw notFound("Scan not found.");
  if (!contact) throw notFound("Contact not found.");
  const hidden = await hiddenTestSalespersonIds(supabase, viewer);
  const contactHidden =
    contact.salesperson_id !== null && hidden.has(contact.salesperson_id);
  if (contactHidden || (contact.is_test_data === true) !== (scan.is_test_data === true)) {
    throw notFound("Contact not found.");
  }
}

/**
 * For legacy Weekly Focus routes keyed by week id: 404 unless the week's AE
 * is visible to `viewer`. A missing week is also a 404 (same message).
 */
export async function requireVisibleWeek(
  supabase: Db,
  weekId: string,
  viewer: { id: string },
  message = "Weekly focus not found.",
): Promise<void> {
  const res = await supabase
    .from("one_on_ones")
    .select("ae_id")
    .eq("id", weekId)
    .maybeSingle();
  if (res.error) throw new ApiError(500, "Could not load that week.");
  const row = res.data as { ae_id: string } | null;
  if (!row) throw notFound(message);
  await requireVisibleSalesperson(supabase, viewer, row.ae_id, message);
}

/**
 * For reviewer routes that act on scans by id: 404 unless every scan's AE is
 * visible to `viewer` — a private test account's scans are reachable only by
 * that account's owner. Missing scans are left to the route's own handling.
 */
export async function requireVisibleScans(
  supabase: Db,
  viewer: { id: string },
  scanIds: readonly string[],
): Promise<void> {
  if (scanIds.length === 0) return;
  const hidden = await hiddenTestSalespersonIds(supabase, viewer);
  if (hidden.size === 0) return;
  const res = await supabase
    .from("business_card_scans")
    .select("id, salesperson_id")
    .in("id", scanIds as string[]);
  if (res.error) throw new ApiError(500, "Could not load those scans.");
  for (const row of (res.data ?? []) as Array<{ salesperson_id: string | null }>) {
    if (row.salesperson_id && hidden.has(row.salesperson_id)) {
      throw notFound("Scan not found.");
    }
  }
}
