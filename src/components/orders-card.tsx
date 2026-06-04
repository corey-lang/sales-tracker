"use client";

import { useEffect, useState } from "react";

import { apiFetchJson } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { PaceVerdict } from "@/lib/working-days";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// AE Home "Orders" card. Month-to-date production orders vs the monthly goal,
// percent complete, order pace (business days = weekdays minus company
// holidays only — NOT PTO), and a simple Orders Today count. Reads only the
// caller's own numbers from /api/me/orders. Fails gracefully when orders are
// unavailable.

type OrderPace = {
  businessDaysTotal: number;
  businessDaysElapsed: number;
  expectedPercent: number;
};

type Orders = {
  orderCount: number;
  orderTarget: number;
  percentToGoal: number | null;
  todayOrders: number | null;
  verdict: PaceVerdict;
  pacePercent: number | null;
};

/** Pace-% color: ≥100 ahead (primary), <100 behind (amber). */
function paceClass(pacePercent: number | null): string {
  if (pacePercent === null) return "text-muted-foreground";
  return pacePercent >= 100
    ? "text-primary"
    : "text-amber-600 dark:text-amber-400";
}

type Response =
  | {
      available: true;
      startDate: string;
      endDate: string;
      pace: OrderPace | null;
      orders: Orders;
    }
  | { available: false };

type Load =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unavailable" }
  | { status: "ready"; pace: OrderPace | null; orders: Orders };

export function OrdersCard() {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    apiFetchJson<Response>("/api/me/orders")
      .then((body) => {
        if (cancelled) return;
        if (!body.available) setLoad({ status: "unavailable" });
        else setLoad({ status: "ready", pace: body.pace, orders: body.orders });
      })
      .catch(() => {
        if (cancelled) return;
        setLoad({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>🏠 Orders</CardTitle>
        <CardDescription>
          Monthly orders and today&apos;s count
        </CardDescription>
      </CardHeader>
      <CardContent>
        {load.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading orders…</p>
        ) : load.status === "error" || load.status === "unavailable" ? (
          <p className="text-sm text-muted-foreground">
            Orders are temporarily unavailable.
          </p>
        ) : (
          <OrdersBody pace={load.pace} orders={load.orders} />
        )}
      </CardContent>
    </Card>
  );
}

function OrdersBody({
  pace,
  orders,
}: {
  pace: OrderPace | null;
  orders: Orders;
}) {
  const hasGoal = orders.orderTarget > 0;
  return (
    <div className="flex flex-col gap-3">
      {/* This month */}
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Orders this month
          </p>
          <p className="text-2xl font-bold tabular-nums leading-tight">
            {orders.orderCount}
            {hasGoal && (
              <span className="text-base font-medium text-muted-foreground">
                {" "}
                / {orders.orderTarget}
              </span>
            )}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold tabular-nums leading-tight">
            {orders.percentToGoal === null ? "—" : `${orders.percentToGoal}%`}
          </p>
          <p className="text-xs text-muted-foreground">
            {hasGoal ? "complete" : "no goal set"}
          </p>
        </div>
      </div>

      {/* Pace + today */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-sm">
        {pace ? (
          <span className={cn("font-medium", paceClass(orders.pacePercent))}>
            {orders.pacePercent === null ? "—" : `${orders.pacePercent}%`} Pace
          </span>
        ) : (
          <span className="text-muted-foreground">
            Pace unavailable — holiday data could not be loaded.
          </span>
        )}
        <span className="text-muted-foreground">
          Today:{" "}
          <span className="font-semibold tabular-nums text-foreground">
            {orders.todayOrders === null ? "—" : orders.todayOrders}
          </span>
          {orders.todayOrders !== null && orders.todayOrders > 0 ? " 🎉" : ""}
        </span>
      </div>
    </div>
  );
}
