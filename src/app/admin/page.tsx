"use client";

import { useMemo, useState } from "react";
import { addDays, format, startOfWeek } from "date-fns";

import { useVisibleRoster } from "@/lib/use-visible-roster";
import { todayInAppTimezone } from "@/lib/dates";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { FiltersCard } from "@/components/admin/filters-card";
import { TotalsCard } from "@/components/admin/totals-card";
import { GoalsCard } from "@/components/admin/goals-card";
import { MessagesCard } from "@/components/admin/messages-card";
import { MaintenanceCard } from "@/components/admin/maintenance-card";

// Admin Dashboard — the /admin index. Activity totals, AE messages, weekly
// goal management, and maintenance. The admin-role guard and top chrome live
// in admin/layout.tsx; business card verification, the prior-week leaderboard,
// and activity reports are now their own pages reachable from the admin nav.

type Salesperson = { id: string; first_name: string };

export default function AdminDashboardPage() {
  // Active AEs as this admin may see them: real AEs, plus the admin's OWN
  // private test account (sorted last). Other admins' test accounts never
  // appear. The totals themselves always exclude test accounts server-side.
  const { people: roster } = useVisibleRoster();
  const people: Salesperson[] = useMemo(
    () =>
      (roster ?? [])
        .filter((p) => p.role === "ae" && p.deactivated_at === null)
        .sort((a, b) => Number(a.is_test) - Number(b.is_test))
        .map((p) => ({ id: p.id, first_name: p.first_name })),
    [roster],
  );

  // Dashboard messages can't be addressed to a private test account (they're
  // hidden from the direct API by design), so that recipient list is real
  // people only.
  const messagePeople = useMemo(
    () => (roster ?? []).filter((p) => p.role === "ae" && p.deactivated_at === null && !p.is_test)
      .map((p) => ({ id: p.id, first_name: p.first_name })),
    [roster],
  );

  useScrollToTop();

  // Default the Activity Totals range to the current Sun-Sat ACTIVITY week
  // (rolls Sunday), capped at today, so weekend logging — and today's Sunday
  // activity — is included on first load. Matches the "This week" quick filter.
  // The range engine still adjusts targets on the Mon-Fri working days inside.
  const currentActivitySunday = () =>
    startOfWeek(todayInAppTimezone(), { weekStartsOn: 0 });
  const [from, setFrom] = useState(() =>
    format(currentActivitySunday(), "yyyy-MM-dd"),
  );
  const [to, setTo] = useState(() => {
    const now = todayInAppTimezone();
    const saturday = addDays(currentActivitySunday(), 6);
    return format(now < saturday ? now : saturday, "yyyy-MM-dd");
  });
  const [salespersonFilter, setSalespersonFilter] = useState<string>("all");


  return (
    <div className="flex flex-col gap-6">
      <FiltersCard
        from={from}
        to={to}
        salespersonFilter={salespersonFilter}
        people={people}
        onChangeFrom={setFrom}
        onChangeTo={setTo}
        onChangeSalesperson={setSalespersonFilter}
      />

      <TotalsCard
        from={from}
        to={to}
        salespersonFilter={salespersonFilter}
        people={people}
      />

      <MessagesCard people={messagePeople} />

      <GoalsCard people={people} />

      <MaintenanceCard />
    </div>
  );
}
