"use client";

import { useEffect, useState } from "react";

import { apiFetchJson } from "@/lib/api-client";
import type { RoadView } from "@/lib/road-to-10000";

// Loads the Road to 10,000 view (GET /api/road-to-10000). Shared by the Home
// card and the detail page. The server decides what the caller may do
// (`can_update`); nothing here is an authorization decision.

export type RoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; view: RoadView };

export function useRoadView(): { state: RoadState; setView: (view: RoadView) => void } {
  const [state, setState] = useState<RoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    apiFetchJson<RoadView>("/api/road-to-10000")
      .then((view) => {
        if (!cancelled) setState({ status: "ready", view });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { state, setView: (view) => setState({ status: "ready", view }) };
}
