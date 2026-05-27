"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Locate,
  MapPin,
  Search,
  X,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { useSalesperson } from "@/lib/use-salesperson";
import { useLivePermissions } from "@/lib/use-live-permissions";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { formatActivityStamp } from "@/lib/dates";
import type { OfficeListItem } from "@/lib/offices";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// /offices — Phase 1B test-only office list + search.
//
// Audience (mirrors /offices/[id] + /api/offices):
//   * is_test === true salespeople pass.
//   * juice_box_only → /juice-box.
//   * everyone else → /dashboard.
//
// The page calls /api/offices, debouncing the search term so a fast
// typist doesn't issue a request per keystroke. The list itself is
// the discoverability surface for /offices/[id] — each row links to
// its detail page.
//
// SEARCH MATCHES
//   name / city / zip via ilike on the server. Address (street) is
//   intentionally NOT a search field — street search is mostly noise
//   ("123 Main" hits every "Main" anywhere) and name+city+zip cover
//   the "find one in seconds" use case.
//
// SORT (server-side)
//   visited offices first (most-recent first), then unvisited
//   (alphabetical). The UI doesn't re-sort — order is authoritative
//   from the API.
// ---------------------------------------------------------------------------

type ListResponse = {
  offices: OfficeListItem[];
  total_matched: number;
  truncated: boolean;
};
type ApiError = { error?: string };

// 250ms balances perceived responsiveness (user sees results almost
// as they finish typing) with not hammering the server on every
// keystroke of a longer query.
const SEARCH_DEBOUNCE_MS = 250;

function formatCityState(item: OfficeListItem): string {
  const cityState = [item.city, item.state].filter(Boolean).join(", ");
  const parts = [cityState, item.zip].filter((s) => s && s.length > 0);
  return parts.join(" ");
}

/** YYYY-MM-DD → "Jun 5, 2026" without pulling in a date lib here.
 *  Returns null for malformed input so the caller can skip rendering. */
function formatDueDate(value: string | null): string | null {
  if (!value) return null;
  const [yStr, mStr, dStr] = value.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function OfficesListPage() {
  const router = useRouter();
  const { salesperson, loaded: sessionLoaded } = useSalesperson();
  // useLivePermissions is loaded for parity with /offices/[id] — the
  // permission state isn't directly consulted here (is_test is a
  // static account property, not a live grant) but waiting on it
  // keeps the redirect timing identical between the two pages so a
  // user moving between them sees the same loading boundary.
  const { loaded: permsLoaded } = useLivePermissions();
  useScrollToTop();

  // ---- Access gate ------------------------------------------------------
  const accessReady = sessionLoaded && permsLoaded;
  const canView =
    !!salesperson &&
    salesperson.role !== "juice_box_only" &&
    salesperson.is_test === true;

  useEffect(() => {
    if (!accessReady) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    if (salesperson.role === "juice_box_only") {
      router.replace("/juice-box");
      return;
    }
    if (!canView) {
      router.replace("/dashboard");
    }
  }, [accessReady, salesperson, canView, router]);

  // ---- Search + results state -------------------------------------------
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [items, setItems] = useState<OfficeListItem[] | null>(null);
  const [totalMatched, setTotalMatched] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);

  // Debounce the search term. Trimming here so trailing whitespace
  // doesn't trigger a refetch the user can't see.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // Fetch results whenever the access gate flips green or the
  // debounced query changes. `cancelled` guards against a stale
  // response overwriting a newer one when the user types fast.
  useEffect(() => {
    if (!accessReady || !canView) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadState("loading");
    setError(null);
    const url = debouncedQuery
      ? `/api/offices?q=${encodeURIComponent(debouncedQuery)}`
      : "/api/offices";
    void apiFetch(url)
      .then(async (res) => {
        if (cancelled) return;
        const data = (await res.json().catch(() => null)) as
          | (ListResponse & ApiError)
          | null;
        if (!res.ok || !data?.offices) {
          setError(
            data?.error ?? `Could not load offices (${res.status}).`,
          );
          setLoadState("error");
          return;
        }
        setItems(data.offices);
        setTotalMatched(data.total_matched ?? data.offices.length);
        setTruncated(data.truncated === true);
        setLoadState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setError("Network error while loading offices.");
        setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [accessReady, canView, debouncedQuery]);

  // Derive a stable "showing X of Y" label without re-rendering on
  // every keystroke (the underlying counts only change after a fetch
  // settles).
  const countLabel = useMemo(() => {
    if (loadState !== "ready" || !items) return null;
    if (totalMatched === 0) return null;
    if (totalMatched <= items.length) {
      return `${items.length} office${items.length === 1 ? "" : "s"}`;
    }
    return `Showing ${items.length} of ${totalMatched}${truncated ? "+" : ""}`;
  }, [loadState, items, totalMatched, truncated]);

  // ---- Render guards ----------------------------------------------------
  if (!accessReady || !salesperson || !canView) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <main className="pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4">
      {/* Header — Back + sandbox tag + page title. */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/dashboard"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back
        </Link>
        <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400">
          Test
        </span>
      </header>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            My Offices
          </h1>
          <p className="text-xs text-muted-foreground">
            Sandbox office list — visible only to the test account.
          </p>
        </div>
        {/* "Nearby" entry point — opens the geolocation-driven
            /offices/nearby surface. Lives in the header so it's
            visible without scrolling and doesn't compete with the
            search input for the primary thumb position. */}
        <Link
          href="/offices/nearby"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <Locate aria-hidden="true" className="size-4" />
          Nearby
        </Link>
      </div>

      {/* Search box — name / city / zip. */}
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, city, or zip"
          aria-label="Search offices"
          className="h-10 pl-8 pr-9"
          inputMode="search"
          autoComplete="off"
          enterKeyHint="search"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>

      {/* Result count + truncation hint. */}
      {countLabel && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{countLabel}</span>
          {truncated && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <AlertTriangle aria-hidden="true" className="size-3" />
              Refine your search to see more
            </span>
          )}
        </div>
      )}

      {/* Loading / error / empty / results. */}
      {loadState === "loading" && !items && (
        <p className="px-1 text-sm text-muted-foreground">Loading offices…</p>
      )}

      {loadState === "error" && (
        <Card>
          <CardContent>
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error ?? "Could not load offices."}
            </p>
          </CardContent>
        </Card>
      )}

      {loadState === "ready" && items && items.length === 0 && (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {debouncedQuery.length > 0
                ? `No offices match "${debouncedQuery}". Try a different search.`
                : "No offices in your sandbox yet. Import some via Office Imports."}
            </p>
          </CardContent>
        </Card>
      )}

      {items && items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((item) => {
            const cityState = formatCityState(item);
            return (
              <li key={item.id}>
                <Link
                  href={`/offices/${item.id}`}
                  className="group block rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-start gap-3 p-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      {/* Name + visit count badge. */}
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="truncate text-base font-semibold leading-snug">
                          {item.name}
                        </p>
                        <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground tabular-nums">
                          {item.visit_count === 0
                            ? "Never visited"
                            : `${item.visit_count} visit${item.visit_count === 1 ? "" : "s"}`}
                        </span>
                      </div>

                      {/* Street, then city/state/zip on its own line. */}
                      {(item.street || cityState) && (
                        <div className="flex items-start gap-1 text-xs text-muted-foreground">
                          <MapPin
                            aria-hidden="true"
                            className="mt-0.5 size-3 shrink-0"
                          />
                          <div className="min-w-0">
                            {item.street && (
                              <p className="truncate">{item.street}</p>
                            )}
                            {cityState && (
                              <p className="truncate">{cityState}</p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Last visit + next action (when present). */}
                      <div className="space-y-0.5">
                        {item.last_visit_at && (
                          <p className="text-[11px] text-muted-foreground">
                            Last visit{" "}
                            <span className="font-medium text-foreground/80">
                              {formatActivityStamp(item.last_visit_at)}
                            </span>
                          </p>
                        )}
                        {item.next_action && (
                          <p className="line-clamp-2 text-xs">
                            <span className="font-medium text-foreground/80">
                              Next:
                            </span>{" "}
                            {item.next_action}
                            {(() => {
                              const due = formatDueDate(
                                item.next_action_due_date,
                              );
                              return due ? (
                                <span className="text-muted-foreground">
                                  {" "}
                                  · due {due}
                                </span>
                              ) : null;
                            })()}
                          </p>
                        )}
                      </div>
                    </div>

                    <ChevronRight
                      aria-hidden="true"
                      className="mt-1 size-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
                    />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
