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

  // Anchor "this week" to the Denver business calendar so the default
  // filter on the admin dashboard agrees with the leaderboard's and
  // Weekly Focus's notion of the current week.
  const currentBusinessWeekStart = () =>
    startOfWeek(todayInAppTimezone(), { weekStartsOn: 1 });
  const [from, setFrom] = useState(() =>
    format(currentBusinessWeekStart(), "yyyy-MM-dd"),
  );
  const [to, setTo] = useState(() =>
    format(addDays(currentBusinessWeekStart(), 4), "yyyy-MM-dd"),
  );
  const [salespersonFilter, setSalespersonFilter] = useState<string>("all");

  useEffect(() => {
    let cancelled = false;
    // Admins (Corey, Ryan) don't log activity, so they shouldn't appear in any
    // admin selector — filters, totals rows, or goal scope. Assistants (Tonja)
    // are also excluded since the AE selector is meant for AEs only.
    // Test account is included but pushed to the bottom.
    supabase
      .from("salespeople")
      .select("id, first_name")
      .eq("is_admin", false)
      .neq("role", "assistant")
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
