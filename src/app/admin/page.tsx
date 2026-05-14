"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { addDays, format, startOfWeek } from "date-fns";

import { supabase } from "@/lib/supabase/client";
import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { Button, buttonVariants } from "@/components/ui/button";
import { FiltersCard } from "@/components/admin/filters-card";
import { TotalsCard } from "@/components/admin/totals-card";
import { GoalsCard } from "@/components/admin/goals-card";
import { MessagesCard } from "@/components/admin/messages-card";
import { MaintenanceCard } from "@/components/admin/maintenance-card";

type Salesperson = { id: string; first_name: string };

export default function AdminPage() {
  const router = useRouter();
  const { salesperson, clear, loaded } = useSalesperson();
  const [people, setPeople] = useState<Salesperson[]>([]);

  const handleSwitchUser = () => {
    clear();
    router.push("/");
  };

  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    if (!salesperson.is_admin) {
      router.replace("/dashboard");
    }
  }, [loaded, salesperson, router]);

  useScrollToTop();
  const currentBusinessWeekStart = () =>
    startOfWeek(new Date(), { weekStartsOn: 1 });
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

  if (!loaded || !salesperson || !salesperson.is_admin) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Hi, {salesperson.first_name}
          </h1>
        </div>
        <Image
          src="/logo.png"
          alt="Elevate Homescriptions"
          width={180}
          height={55}
          priority
          className="shrink-0"
        />
        <div className="flex flex-wrap items-start gap-2">
          <Link
            href="/leaderboard"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Leaderboard
          </Link>
          <div className="flex flex-col items-end">
            <Button variant="outline" size="sm" onClick={handleSwitchUser}>
              Log out
            </Button>
            <span className="mt-0.5 max-w-[140px] text-right text-[10px] leading-tight text-muted-foreground">
              Stay signed in to skip retyping your name
            </span>
          </div>
        </div>
      </header>

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
    </main>
  );
}
