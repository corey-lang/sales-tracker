"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { useSalesperson } from "@/lib/use-salesperson";

// The salespeople roster as the SIGNED-IN viewer may see it in admin
// selectors and name lookups (lib/roster.ts workflow-visibility rule): every
// real person, plus private test accounts the viewer owns.
//
// Served by /api/roster/visible — the server applies the rule; the browser
// never sees `test_owner_id` and never decides visibility itself. Until the
// response arrives (or if it fails) nothing test-related is shown.

export type VisibleRosterPerson = {
  id: string;
  first_name: string;
  role: string;
  is_test: boolean;
  deactivated_at: string | null;
};

export function useVisibleRoster(): { people: VisibleRosterPerson[] | null } {
  const { salesperson } = useSalesperson();
  const viewerId = salesperson?.id ?? null;
  const [people, setPeople] = useState<VisibleRosterPerson[] | null>(null);

  useEffect(() => {
    if (!viewerId) return;
    let cancelled = false;
    apiFetch("/api/roster/visible")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { people?: VisibleRosterPerson[] } | null) => {
        if (!cancelled && body?.people) setPeople(body.people);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [viewerId]);

  return { people };
}
