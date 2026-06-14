"use client";

import { useEffect, useState } from "react";
import { addDays, format, startOfWeek } from "date-fns";

import { supabase } from "@/lib/supabase/client";
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
  const [people, setPeople] = useState<Salesperson[]>([]);

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

  useEffect(() => {
    let cancelled = false;
    // Real AEs only. Filtering positively on `role = 'ae'` (vs. excluding
    // known non-AE roles) keeps juice_box_only guests (Travis, Rizz, Faith,
    // …) and any future role out of the admin selector, filters, totals,
    // and goal scope automatically. role is now the single source of truth
    // for admin status (the legacy is_admin column is unused in app logic),
    // so the previous belt-and-suspenders is_admin filter is gone. The test
    // account is the lone AE-role exception we still want visible — kept
    // and pushed to the bottom of the list via the is_test ordering.
    supabase
      .from("salespeople")
      .select("id, first_name")
      .eq("role", "ae")
      .order("is_test", { ascending: true })
      .order("first_name", { ascending: true })
      .then(({ data }) => {
        if (cancelled) return;
        if (data) setPeople(data);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

      <MessagesCard people={people} />

      <GoalsCard people={people} />

      <MaintenanceCard />
    </div>
  );
}
