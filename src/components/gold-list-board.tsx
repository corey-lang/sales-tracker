"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Plus, Search, X } from "lucide-react";

import { apiFetchJson } from "@/lib/api-client";
import { todayInAppTimezone } from "@/lib/dates";
import {
  AGENT_FIELD_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  AGENT_NOTES_MAX_LENGTH,
  DEFAULT_GOLD_LIST_SORT,
  DEFAULT_GOLD_LIST_STATUS_FILTER,
  GOLD_LIST_SORTS,
  GOLD_LIST_STATUS_FILTERS,
  activeAgents,
  agentCountLabel,
  isGoldListSort,
  sortAgents,
  visibleAgents,
  type GoldListAgentWithFollowUp,
  type GoldListSort,
  type GoldListStatusFilter,
} from "@/lib/gold-list";
import type { GoldListAgentsResponse } from "@/app/api/gold-list/agents/route";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { GoldListAgentCard } from "@/components/gold-list-agent-card";

// The Gold List board: header + count, the admin AE filter, the add form, the
// active agent cards, and the archived disclosure.
//
// WHY THE PAGE HEADER LIVES HERE (and not in page.tsx, as on /todos)
//   The header must read "Gold List — 18 agents" and the count must move the
//   instant an agent is added, archived, or restored. The count is derived
//   from the same state these mutations write, so keeping the title next to
//   that state is what makes "immediately" true without a refetch or a
//   round-trip through a parent.
//
// SEARCH / SORT / FILTER ARE CLIENT-SIDE, ON PURPOSE
//   They narrow the rows the API already returned for the current scope, which
//   `resolveGoldListScope` fixed server-side to the caller's own list (or, for
//   an admin, the AE they picked). Narrowing a set cannot widen it, so there is
//   no way to reach another AE's agents through the search box, and no search
//   endpoint to secure. It also means results update as you type, with no
//   refetch and no page reload. Changing the AE filter DOES refetch, because
//   that changes which rows the caller is authorized to hold.
//
// PERMISSIONS ARE SERVER-DECIDED
//   The route returns `scope` (who is being viewed, may the caller view all)
//   and a per-agent `can_edit`. This component only renders what those say;
//   every write is re-checked server-side by the /api/gold-list/* routes, so a
//   hand-edited client can't gain anything by pretending otherwise.

const SELECT_CLASS =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const TEXTAREA_CLASS =
  "mt-1 w-full resize-y rounded-md border border-border bg-background/40 px-2 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

/** Sentinel for the AE filter's "every AE" option. */
const ALL_AES = "all";

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function GoldListBoard() {
  const loadVersion = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const [followUpIds, setFollowUpIds] = useState<string[]>([]);
  const previousFollowUps = useRef<string[]>([]);
  useEffect(() => {
    const closed = previousFollowUps.current.some(
      (id) => !followUpIds.includes(id),
    );
    previousFollowUps.current = followUpIds;
    if (closed && document.activeElement === document.body)
      searchInput.current?.focus();
  }, [followUpIds]);
  const keepFollowUpVisible = useCallback((id: string, keep: boolean) => {
    setFollowUpIds((ids) =>
      keep ? [...new Set([...ids, id])] : ids.filter((value) => value !== id),
    );
  }, []);
  const [data, setData] = useState<GoldListAgentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** AE filter (admins only). `ALL_AES` = every AE's Gold List. */
  const searchParams = useSearchParams();
  const [aeFilter, setAeFilter] = useState<string>(
    searchParams.get("ae_id") ?? ALL_AES,
  );
  const [showArchived, setShowArchived] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // The three board controls. All three are pure view state: nothing here is
  // sent to the server, and clearing them restores the full scoped list.
  // These controls intentionally persist when changing the selected AE.
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<GoldListSort>(DEFAULT_GOLD_LIST_SORT);
  const [status, setStatus] = useState<GoldListStatusFilter>(
    DEFAULT_GOLD_LIST_STATUS_FILTER,
  );

  // One "today" for the whole board, in the app's business timezone
  // (America/Denver) so an AE travelling east doesn't see yesterday's
  // follow-ups flip to overdue early. Refresh across midnight even when the
  // board remains open.
  const [todayIso, setTodayIso] = useState(() =>
    format(todayInAppTimezone(), "yyyy-MM-dd"),
  );
  useEffect(() => {
    const timer = setInterval(
      () => setTodayIso(format(todayInAppTimezone(), "yyyy-MM-dd")),
      30_000,
    );
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (aeFilter !== ALL_AES) params.set("ae_id", aeFilter);
      if (showArchived) params.set("include_archived", "1");
      const queryString = params.toString();
      const res = await apiFetchJson<GoldListAgentsResponse>(
        `/api/gold-list/agents${queryString ? `?${queryString}` : ""}`,
      );
      if (version === loadVersion.current) setData(res);
    } catch (err) {
      if (version === loadVersion.current) {
        setData(null);
        setError(messageOf(err, "Could not load the Gold List."));
      }
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [aeFilter, showArchived]);

  useEffect(() => {
    // Async IIFE so the effect body sets no state synchronously (same pattern
    // as <AeTasksCard>); `load` is a useCallback keyed on the filter + archive
    // toggle, so changing either re-runs this.
    void (async () => {
      await load();
    })();
    return () => {
      loadVersion.current += 1;
    };
  }, [load]);

  /** Replaces one agent in place — how every card mutation reaches the count. */
  const handleAgentChange = useCallback(
    (updated: GoldListAgentWithFollowUp) => {
      setData((prev) =>
        prev
          ? {
              ...prev,
              agents: prev.agents.map((a) =>
                a.id === updated.id ? updated : a,
              ),
            }
          : prev,
      );
    },
    [],
  );

  const handleAgentAdded = useCallback((agent: GoldListAgentWithFollowUp) => {
    setData((prev) =>
      prev && (prev.scope.view_all || prev.scope.ae_id === agent.salesperson_id)
        ? {
            ...prev,
            agents: [agent, ...prev.agents.filter((a) => a.id !== agent.id)],
          }
        : prev,
    );
    setAddOpen(false);
  }, []);

  const agents = useMemo(() => data?.agents ?? [], [data]);
  const active = useMemo(() => activeAgents(agents), [agents]);
  const archived = useMemo(
    () => agents.filter((a) => a.archived_at !== null),
    [agents],
  );

  // THE HEADER COUNT counts every ACTIVE agent in the current scope, before
  // search and filters. It answers "how big is this Gold List", not "how many
  // rows are on screen" — narrowing the view must never make the list look
  // like it shrank. Derived from local state, so it still moves the moment a
  // card reports an add, archive or restore.
  const activeCount = active.length;

  const visible = useMemo(
    () => visibleAgents(active, { query, status, sort, todayIso }),
    [active, query, status, sort, todayIso],
  );
  // Completing under Overdue/Today changes the matching status immediately.
  // Keep that card mounted until the user schedules the next activity or skips.
  const displayed = useMemo(
    () =>
      sortAgents(
        [
          ...visible,
          ...active.filter(
            (a) =>
              followUpIds.includes(a.id) && !visible.some((v) => v.id === a.id),
          ),
        ],
        sort,
      ),
    [visible, active, followUpIds, sort],
  );
  const visibleArchived = useMemo(
    () => visibleAgents(archived, { query, status, sort, todayIso }),
    [archived, query, status, sort, todayIso],
  );
  /** True when the controls are hiding some of the scoped list. */
  const narrowed =
    query.trim() !== "" || status !== DEFAULT_GOLD_LIST_STATUS_FILTER;
  const clearControls = () => {
    setQuery("");
    setStatus(DEFAULT_GOLD_LIST_STATUS_FILTER);
    searchInput.current?.focus();
  };

  const canViewAll = data?.scope.can_view_all === true;
  const viewerId = data?.scope.viewer_id ?? null;
  const viewingOwnList = data != null && data.scope.ae_id === viewerId;
  const viewingAll = data?.scope.view_all === true;
  const viewedAeName = data?.ae_options?.find(
    (o) => o.id === data.scope.ae_id,
  )?.first_name;

  return (
    <div className="flex min-w-0 flex-col gap-4 [overflow-wrap:anywhere] [&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base [&_textarea]:text-base [&_select]:min-h-11 [&_select]:max-w-full">
      <header className="space-y-1 pt-1">
        <p className="text-sm text-muted-foreground">Relationships</p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Gold List{" "}
          <span
            // Announced on change so the count is not a purely visual update.
            aria-live="polite"
            className="font-semibold text-muted-foreground"
          >
            — {data && !loading ? agentCountLabel(activeCount) : "…"}
          </span>
        </h1>
        <p className="text-sm text-muted-foreground">
          Add an agent, schedule the next touch, and complete it when it
          happens. Completed activities stay in history.
        </p>
      </header>

      {/* Admin-only AE filter. Non-admins never receive `ae_options` and the
          API rejects an ae_id that isn't theirs, so there is nothing to hide. */}
      {canViewAll ? (
        <Card size="sm">
          <CardContent className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 w-full flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center">
              AE
              <select
                aria-label="AE"
                value={aeFilter}
                onChange={(e) => {
                  loadVersion.current += 1;
                  setLoading(true);
                  setAeFilter(e.target.value);
                  setAddOpen(false);
                  setFollowUpIds([]);
                }}
                className={`${SELECT_CLASS} min-w-0 w-full flex-1`}
              >
                <option value={ALL_AES}>All AEs</option>
                {(data?.ae_options ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.first_name}
                    {option.id === viewerId ? " (me)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {viewingAll ? (
              <p className="text-xs text-muted-foreground">
                Showing every AE&apos;s Gold List. You can only edit your own.
              </p>
            ) : !viewingOwnList ? (
              <p className="text-xs text-muted-foreground">
                Viewing {viewedAeName ?? "this AE"}&apos;s Gold List —
                read-only.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Search + sort + status filters. Rendered as soon as there is data so
          the row doesn't appear and disappear while an AE change reloads. */}
      {data ? (
        <Card size="sm">
          <CardContent className="space-y-3">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={searchInput}
                type="search"
                value={query}
                aria-label="Search agents"
                aria-describedby="gold-list-search-help"
                placeholder="Search agents"
                onChange={(e) => setQuery(e.target.value)}
                className="w-full pl-9 pr-11"
              />
              {query ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery("");
                    searchInput.current?.focus();
                  }}
                  // min-w-11 pairs with the board's [&_button]:min-h-11 for a
                  // full 44px tap target; the input's pr-11 reserves room for
                  // it so it never sits on top of the text being cleared.
                  className="absolute right-1 top-1/2 min-w-11 -translate-y-1/2"
                >
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </div>

            <p
              id="gold-list-search-help"
              className="text-xs text-muted-foreground"
            >
              Name, brokerage, phone or email
            </p>

            <label className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              Sort
              <select
                aria-label="Sort agents"
                value={sort}
                onChange={(e) =>
                  setSort(
                    isGoldListSort(e.target.value)
                      ? e.target.value
                      : DEFAULT_GOLD_LIST_SORT,
                  )
                }
                className={`${SELECT_CLASS} min-w-0 flex-1`}
              >
                {GOLD_LIST_SORTS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {/* Four short chips. `flex-wrap` lets them take two rows at 320px
                rather than overflowing the card or scrolling the page. */}
            <div
              role="group"
              aria-label="Filter by activity status"
              className="flex flex-wrap gap-1.5"
            >
              {GOLD_LIST_STATUS_FILTERS.map((option) => (
                <Button
                  key={option.key}
                  type="button"
                  size="sm"
                  variant={status === option.key ? "default" : "outline"}
                  aria-pressed={status === option.key}
                  onClick={() => setStatus(option.key)}
                >
                  {option.label}
                </Button>
              ))}
            </div>

            {/* Subtle secondary count. Deliberately NOT the header number:
                that one keeps reporting the whole active list. */}
            {narrowed && !loading ? (
              <p aria-live="polite" className="text-xs text-muted-foreground">
                Matches: {visible.length}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Adding always creates on YOUR list (the server assigns the owner), so
          the form is only offered while your own list is what's on screen. */}
      {viewingOwnList && !loading ? (
        addOpen ? (
          <AddAgentForm
            onCancel={() => setAddOpen(false)}
            onAdded={handleAgentAdded}
          />
        ) : (
          <Button onClick={() => setAddOpen(true)}>
            <Plus aria-hidden="true" />
            Add agent
          </Button>
        )
      ) : null}

      {error ? (
        <Card size="sm">
          <CardContent className="space-y-2">
            <p className="text-sm text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : null}

      {/* TRULY EMPTY — this Gold List has no active agents at all. */}
      {data && active.length === 0 && !loading ? (
        <Card size="sm">
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {viewingOwnList
                ? "No agents yet. Add the first person you want to stay in front of."
                : "No active agents on this Gold List."}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* NO RESULTS — the list has agents, the current search/filter just
          doesn't match any. Says so explicitly, and offers the way back, so it
          can't be mistaken for an empty Gold List. */}
      {data && active.length > 0 && displayed.length === 0 && !loading ? (
        <Card size="sm">
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              No agents match your search or filters.{" "}
              {agentCountLabel(activeCount)} on this Gold List.
            </p>
            <Button size="sm" variant="outline" onClick={clearControls}>
              Clear search and filters
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3">
        {!loading &&
          displayed.map((agent) => (
            <GoldListAgentCard
              key={agent.id}
              agent={agent}
              todayIso={todayIso}
              showOwner={viewingAll}
              onAgentChange={handleAgentChange}
              onKeepVisibleChange={keepFollowUpVisible}
              outsideFilters={!visible.some((a) => a.id === agent.id)}
            />
          ))}
      </div>

      {/* Archived agents keep their history and can be restored. Fetching them
          is opt-in so the everyday list stays small. */}
      <div className="space-y-3">
        <button
          type="button"
          aria-expanded={showArchived}
          onClick={() => setShowArchived((v) => !v)}
          className="text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {showArchived ? "Hide archived" : "Show archived"}
        </button>
        {showArchived && !loading ? (
          visibleArchived.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {archived.length === 0
                ? "Nothing archived."
                : "No archived agents match your search or filters."}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {visibleArchived.map((agent) => (
                <GoldListAgentCard
                  key={agent.id}
                  agent={agent}
                  todayIso={todayIso}
                  showOwner={viewingAll}
                  onAgentChange={handleAgentChange}
                />
              ))}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

/** Add one agent. Only the name is required — everything else can wait. */
function AddAgentForm({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: (agent: GoldListAgentWithFollowUp) => void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const [duplicates, setDuplicates] = useState<Array<{
    id: string;
    agent_name: string;
    archived: boolean;
  }> | null>(null);
  const [name, setName] = useState("");
  const [brokerage, setBrokerage] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetchJson<{
        agent?: GoldListAgentWithFollowUp;
        duplicates?: Array<{
          id: string;
          agent_name: string;
          archived: boolean;
        }>;
      }>("/api/gold-list/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: requestId,
          confirm_duplicate: duplicates !== null,
          agent_name: trimmed,
          brokerage: brokerage.trim() || null,
          phone: phone.trim() || null,
          email: email.trim() || null,
          notes: notes.trim() || null,
        }),
      });
      if (res.duplicates) setDuplicates(res.duplicates);
      else if (res.agent) onAdded(res.agent);
    } catch (err) {
      setError(messageOf(err, "Could not add that agent."));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Card size="sm">
      <CardContent>
        <form
          className="space-y-2"
          onSubmit={submit}
          onChange={() => setDuplicates(null)}
        >
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Add agent
          </p>
          <Input
            value={name}
            required
            autoFocus
            maxLength={AGENT_NAME_MAX_LENGTH}
            aria-label="Agent name"
            placeholder="Agent name"
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            value={brokerage}
            maxLength={AGENT_FIELD_MAX_LENGTH}
            aria-label="Brokerage"
            placeholder="Brokerage (optional)"
            onChange={(e) => setBrokerage(e.target.value)}
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={phone}
              type="tel"
              maxLength={AGENT_FIELD_MAX_LENGTH}
              aria-label="Phone"
              placeholder="Phone (optional)"
              onChange={(e) => setPhone(e.target.value)}
            />
            <Input
              value={email}
              type="email"
              maxLength={AGENT_FIELD_MAX_LENGTH}
              aria-label="Email"
              placeholder="Email (optional)"
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <textarea
            value={notes}
            rows={2}
            maxLength={AGENT_NOTES_MAX_LENGTH}
            aria-label="Notes"
            placeholder="Notes (optional)"
            onChange={(e) => setNotes(e.target.value)}
            className={TEXTAREA_CLASS}
          />
          {duplicates ? (
            <div role="alert" className="space-y-1 text-sm">
              <p>Possible matches on your Gold List:</p>
              <ul>
                {duplicates.map((a) => (
                  <li key={a.id}>
                    {a.agent_name}
                    {a.archived
                      ? " (archived — you can restore this agent)"
                      : " (active)"}
                  </li>
                ))}
              </ul>
              <p>Review these records, or confirm this is a separate agent.</p>
            </div>
          ) : null}
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>
              {busy ? "Adding…" : duplicates ? "Confirm and add" : "Add agent"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
