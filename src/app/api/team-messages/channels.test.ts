/**
 * Route tests for Juice Box channels.
 *
 *   GET  /api/team-messages           — per-channel feed, no cross-channel leak
 *   POST /api/team-messages           — channel validation + reply channel rules
 *   GET  /api/team-messages/unread    — per-channel counts + combined total
 *   POST /api/team-messages/reads/me  — per-channel read markers
 *   GET  /api/team-messages/search    — cross-channel results carry `channel`
 *
 * The auth module is NOT mocked: requests carry real HMAC-signed session
 * tokens and `requireSalesperson` re-reads the caller's row from the fake
 * Supabase, so the channel behaviour is exercised through the real guard
 * chain. Only Supabase, push fan-out, and the GIF provider are faked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

// ---------------------------------------------------------------------------
// Fake Supabase
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type MessageRow = Row & {
  id: string;
  channel: string | null;
  created_at: string;
  is_deleted: boolean;
};

type FakeState = {
  people: Record<string, Row>;
  messages: MessageRow[];
  /** team_message_channel_reads rows (the channel-aware table). */
  reads: Array<{ salesperson_id: string; channel: string | null; last_read_at: string }>;
  /** team_message_reads rows — the LEGACY single-marker table, kept alive for
   *  the previously deployed bundle. Has no channel column. */
  legacyReads: Array<{ salesperson_id: string; last_read_at: string }>;
  /** Recorded writes. */
  inserts: Array<{ table: string; payload: Row }>;
  upserts: Array<{ table: string; payload: Row; options: Row | undefined }>;
  /** Recorded read filters per table, for leak assertions. */
  reads_filters: Array<{ table: string; filters: Record<string, unknown> }>;
  /** Recorded rpc() calls. */
  rpcCalls: Array<{ name: string; params: Row }>;
  /**
   * Timestamps the FAKE RPCs will stamp, consumed in order — this is how a
   * REVERSED arrival is modelled. Postgres generates the timestamp inside the
   * function (`now()`), so the only way an older value can reach the table is
   * a transaction that started earlier arriving later. Queueing [T2, T1] is
   * exactly that: the second call to land carries the OLDER stamp.
   * Falls back to a fresh ISO string when empty.
   */
  rpcNowQueue: string[];
  /** RPC names that should return an error, to test failure isolation. */
  rpcFailures: Set<string>;
  /**
   * When true, the fake answers like a database that predates
   * supabase/juice_box_channels.sql: the `channel` column, the channel-reads
   * table, and the mark-read RPCs are all missing.
   */
  preMigration: boolean;
  /** Audit rows the move RPC wrote. */
  moveAudit: Array<{
    root_message_id: string;
    from_channel: string;
    to_channel: string;
    moved_by_salesperson_id: string;
    message_count: number;
    moved_at: string;
  }>;
  /** Simulates a reply landing in the old channel mid-move → JB003 rollback. */
  moveStraggler: boolean;
  /**
   * Reproduces THE REVIEWED RACE. When set, the next single-row
   * `team_messages` read (the route's parent lookup) returns the PRE-move row
   * and then immediately applies the move — so the route derives a channel that
   * is already stale by the time it inserts. Only the insert-time check inside
   * the database can catch that, which is what the trigger does.
   */
  moveDuringReplyRead: { rootId: string; toChannel: string } | null;
};

let state: FakeState;

function freshState(): FakeState {
  return {
    people: {},
    messages: [],
    reads: [],
    legacyReads: [],
    inserts: [],
    upserts: [],
    reads_filters: [],
    rpcCalls: [],
    rpcNowQueue: [],
    rpcFailures: new Set(),
    preMigration: false,
    moveAudit: [],
    moveStraggler: false,
    moveDuringReplyRead: null,
  };
}

function makeBuilder(table: string) {
  const filters: Record<string, unknown> = {};
  let headCount = false;
  let pendingInsert: Row | null = null;
  /** Set when the modelled BEFORE INSERT trigger rejects the row. */
  let triggerError: { code: string; message: string } | null = null;

  const applyMessageFilters = () =>
    state.messages.filter((m) => {
      if (
        filters["eq:is_deleted"] !== undefined &&
        m.is_deleted !== filters["eq:is_deleted"]
      ) {
        return false;
      }
      if (
        filters["eq:channel"] !== undefined &&
        m.channel !== filters["eq:channel"]
      ) {
        return false;
      }
      if (filters["eq:id"] !== undefined && m.id !== filters["eq:id"]) return false;
      const gt = filters["gt:created_at"] as string | undefined;
      if (gt !== undefined && !(m.created_at > gt)) return false;
      const lt = filters["lt:created_at"] as string | undefined;
      if (lt !== undefined && !(m.created_at < lt)) return false;
      return true;
    });

  const resolve = (single: boolean) => {
    if (table === "salespeople") {
      const id = filters["eq:id"] as string | undefined;
      return Promise.resolve({ data: id ? (state.people[id] ?? null) : null, error: null });
    }

    if (table === "team_messages") {
      state.reads_filters.push({ table, filters: { ...filters } });
      if (state.preMigration) {
        return Promise.resolve({
          data: null,
          count: null,
          error: {
            code: "42703",
            message: "column team_messages.channel does not exist",
          },
        });
      }
      if (pendingInsert) {
        const row = {
          id: `new-${state.inserts.length + 1}`,
          created_at: "2026-08-25T12:00:00.000Z",
          is_deleted: false,
          ...pendingInsert,
        } as MessageRow;
        state.messages.push(row);
        return Promise.resolve({ data: row, error: null });
      }
      let rows = applyMessageFilters();
      // THE INTERLEAVING HOOK — see FakeState.moveDuringReplyRead. The caller
      // gets the pre-move row; the move is applied immediately afterwards.
      if (single && state.moveDuringReplyRead) {
        const { rootId, toChannel } = state.moveDuringReplyRead;
        state.moveDuringReplyRead = null;
        const snapshot = rows.map((r) => ({ ...r })) as MessageRow[];
        const ids = new Set<string>([rootId]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const m of state.messages) {
            const parent = m.reply_to_message_id as string | null;
            if (parent && ids.has(parent) && !ids.has(m.id)) {
              ids.add(m.id);
              grew = true;
            }
          }
        }
        for (const m of state.messages) if (ids.has(m.id)) m.channel = toChannel;
        return Promise.resolve({ data: snapshot[0] ?? null, error: null });
      }
      // created_at DESC, then the route's own .slice().reverse()
      rows = rows
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const limit = filters.limit as number | undefined;
      if (typeof limit === "number") rows = rows.slice(0, limit);
      if (headCount) {
        return Promise.resolve({ data: null, count: rows.length, error: null });
      }
      return Promise.resolve({
        data: single ? (rows[0] ?? null) : rows,
        error: null,
      });
    }

    if (table === "team_message_reactions") {
      return Promise.resolve({ data: [], error: null });
    }

    if (table === "team_message_channel_reads") {
      state.reads_filters.push({ table, filters: { ...filters } });
      if (state.preMigration) {
        return Promise.resolve({
          data: null,
          error: {
            code: "PGRST205",
            message:
              "Could not find the table 'public.team_message_channel_reads' in the schema cache",
          },
        });
      }
      const owner = filters["eq:salesperson_id"] as string | undefined;
      const channel = filters["eq:channel"] as string | undefined;
      const rows = state.reads.filter(
        (r) =>
          (owner === undefined || r.salesperson_id === owner) &&
          (channel === undefined || r.channel === channel),
      );
      return Promise.resolve({
        data: single ? (rows[0] ?? null) : rows,
        error: null,
      });
    }

    if (table === "team_message_reads") {
      state.reads_filters.push({ table, filters: { ...filters } });
      const owner = filters["eq:salesperson_id"] as string | undefined;
      const rows = state.legacyReads.filter(
        (r) => owner === undefined || r.salesperson_id === owner,
      );
      return Promise.resolve({
        data: single ? (rows[0] ?? null) : rows,
        error: null,
      });
    }

    return Promise.resolve({ data: single ? null : [], error: null });
  };

  const self: Record<string, unknown> = {
    select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) headCount = true;
      return self;
    },
    insert: (payload: Row) => {
      // ── Models the BEFORE INSERT trigger in section 6 of the migration ──
      // The trigger takes FOR UPDATE on the conversation ROOT and re-reads its
      // channel UNDER that lock, so the value compared here is the state at
      // INSERT time — not whatever the route read earlier. That is exactly the
      // reviewed race: `state.messages` may have been moved in between.
      if (table === "team_messages" && payload.reply_to_message_id) {
        let rootId = payload.reply_to_message_id as string;
        for (let i = 0; i < 100; i += 1) {
          const row = state.messages.find((m) => m.id === rootId);
          if (!row) break;
          const parent = row.reply_to_message_id as string | null;
          if (!parent) break;
          rootId = parent;
        }
        const root = state.messages.find((m) => m.id === rootId);
        if (!root) {
          // Stored on the builder, not returned — `.select().single()` is
          // chained after this call and would discard a replacement object.
          triggerError = {
            code: "JB011",
            message: "reply parent does not exist",
          };
          return self;
        }
        // A pre-migration row reads as General, matching normalizeChannel in
        // the real code path (the column is NOT NULL after the migration).
        const rootChannel = root.channel ?? "general";
        if (payload.channel !== rootChannel) {
          triggerError = {
            code: "JB010",
            message: `reply channel ${String(payload.channel)} does not match conversation channel ${String(rootChannel)}`,
          };
          return self;
        }
      }
      state.inserts.push({ table, payload });
      pendingInsert = payload;
      return self;
    },
    upsert: (payload: Row, options?: Row) => {
      state.upserts.push({ table, payload, options });
      const owner = payload.salesperson_id as string;
      if (table === "team_message_channel_reads") {
        const channel = (payload.channel as string) ?? "general";
        const existing = state.reads.find(
          (r) => r.salesperson_id === owner && r.channel === channel,
        );
        if (existing) existing.last_read_at = payload.last_read_at as string;
        else
          state.reads.push({
            salesperson_id: owner,
            channel,
            last_read_at: payload.last_read_at as string,
          });
      }
      if (table === "team_message_reads") {
        const existing = state.legacyReads.find(
          (r) => r.salesperson_id === owner,
        );
        if (existing) existing.last_read_at = payload.last_read_at as string;
        else
          state.legacyReads.push({
            salesperson_id: owner,
            last_read_at: payload.last_read_at as string,
          });
      }
      pendingInsert = payload;
      return self;
    },
    limit: (n: number) => {
      filters.limit = n;
      return self;
    },
    maybeSingle: () => resolve(true),
    single: () =>
      triggerError
        ? Promise.resolve({ data: null, error: triggerError })
        : table === "team_message_channel_reads" && pendingInsert
        ? Promise.resolve({
            data: {
              channel: pendingInsert.channel ?? "general",
              last_read_at: pendingInsert.last_read_at,
            },
            error: null,
          })
        : resolve(true),
    then: (onFulfilled: unknown, onRejected: unknown) =>
      resolve(false).then(onFulfilled as never, onRejected as never),
  };
  for (const method of ["eq", "gt", "lt", "gte", "lte", "is", "in", "or", "ilike", "not", "order"]) {
    self[method] = (col?: string, value?: unknown) => {
      if (col !== undefined) filters[`${method}:${col}`] = value;
      return self;
    };
  }
  return self;
}

/**
 * Faithful stand-in for the two monotonic mark-read RPCs in
 * supabase/juice_box_channels.sql. It reproduces the contract the SQL
 * enforces — validate the channel, insert when absent, otherwise
 * GREATEST(existing, incoming), return the PERSISTED value — so the route can
 * be driven through genuinely out-of-order arrivals.
 *
 * The real guarantee lives in Postgres; the SQL-contract assertions in
 * supabase/juice-box-channels-sql.test.ts pin the statement itself, and the
 * migration header carries a copy-paste monotonicity check to run against a
 * disposable branch.
 */
function fakeRpc(name: string, params: Row) {
  state.rpcCalls.push({ name, params });
  if (state.preMigration) {
    return Promise.resolve({
      data: null,
      error: {
        code: "PGRST202",
        message: `Could not find the function public.${name} in the schema cache`,
      },
    });
  }
  if (state.rpcFailures.has(name)) {
    return Promise.resolve({
      data: null,
      error: { code: "P0001", message: `simulated ${name} failure` },
    });
  }

  const incoming = state.rpcNowQueue.shift() ?? new Date().toISOString();
  const owner = params.p_salesperson_id as string;

  /** GREATEST(existing, incoming) — the whole point of the RPC. */
  const greatest = (existing: string | undefined) =>
    existing && Date.parse(existing) >= Date.parse(incoming)
      ? existing
      : incoming;

  if (name === "juice_box_mark_channel_read") {
    const channel = params.p_channel as string;
    if (!["general", "product_help", "social_media_hub"].includes(channel)) {
      return Promise.resolve({
        data: null,
        error: { code: "P0001", message: `unknown channel ${channel}` },
      });
    }
    const existing = state.reads.find(
      (r) => r.salesperson_id === owner && r.channel === channel,
    );
    const persisted = greatest(existing?.last_read_at);
    if (existing) existing.last_read_at = persisted;
    else state.reads.push({ salesperson_id: owner, channel, last_read_at: persisted });
    return Promise.resolve({ data: persisted, error: null });
  }

  if (name === "juice_box_move_conversation") {
    // Mirrors supabase/juice_box_channels.sql: validate, resolve the root by
    // walking UP, collect descendants recursively, require ONE shared source
    // channel, update every member, verify no straggler, then audit — all or
    // nothing. Error codes match the SQLSTATEs the route maps.
    const toChannel = params.p_to_channel as string;
    const actor = params.p_actor_salesperson_id as string;
    const targetId = params.p_message_id as string;
    const fail = (code: string, message: string) =>
      Promise.resolve({ data: null, error: { code, message } });

    if (!["general", "product_help", "social_media_hub"].includes(toChannel)) {
      return fail("JB004", `unknown channel ${toChannel}`);
    }
    if (!actor || actor.trim() === "") {
      return fail("JB005", "acting administrator is required");
    }
    const target = state.messages.find((m) => m.id === targetId);
    if (!target || target.is_deleted) {
      return fail("P0002", "conversation not found");
    }

    // Walk up to the root (bounded, tolerates a dangling parent pointer).
    let root = target;
    for (let i = 0; i < 100; i += 1) {
      const parentId = root.reply_to_message_id as string | null;
      if (!parentId) break;
      const parent = state.messages.find((m) => m.id === parentId);
      if (!parent) break;
      root = parent;
    }

    // Descendants at any depth.
    const ids = new Set<string>([root.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of state.messages) {
        const parentId = m.reply_to_message_id as string | null;
        if (parentId && ids.has(parentId) && !ids.has(m.id)) {
          ids.add(m.id);
          grew = true;
        }
      }
    }

    const members = state.messages.filter((m) => ids.has(m.id));
    const sources = new Set(members.map((m) => m.channel));
    if (sources.size > 1) {
      return fail("JB002", "conversation spans multiple channels");
    }
    const fromChannel = [...sources][0] as string;
    if (fromChannel === toChannel) {
      return fail("JB001", `already in channel ${toChannel}`);
    }

    // Snapshot for rollback — the SQL gets this from the transaction.
    const snapshot = members.map((m) => ({ row: m, channel: m.channel }));
    for (const m of members) m.channel = toChannel;

    if (state.moveStraggler) {
      for (const { row, channel } of snapshot) row.channel = channel;
      return fail("JB003", "conversation changed during the move");
    }

    const movedAt = "2026-08-25T12:00:00.000Z";
    state.moveAudit.push({
      root_message_id: root.id,
      from_channel: fromChannel,
      to_channel: toChannel,
      moved_by_salesperson_id: actor,
      message_count: members.length,
      moved_at: movedAt,
    });
    return Promise.resolve({
      data: {
        root_message_id: root.id,
        from_channel: fromChannel,
        to_channel: toChannel,
        message_count: members.length,
        moved_at: movedAt,
      },
      error: null,
    });
  }

  if (name === "juice_box_mark_legacy_read") {
    const existing = state.legacyReads.find((r) => r.salesperson_id === owner);
    const persisted = greatest(existing?.last_read_at);
    if (existing) existing.last_read_at = persisted;
    else state.legacyReads.push({ salesperson_id: owner, last_read_at: persisted });
    return Promise.resolve({ data: persisted, error: null });
  }

  return Promise.resolve({ data: null, error: null });
}

vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: () => ({
    from: (table: string) => makeBuilder(table),
    rpc: (name: string, params: Row) => fakeRpc(name, params),
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
  }),
}));

// Push fan-out and the GIF provider are irrelevant here and would reach the
// network / VAPID config.
vi.mock("@/lib/server/push", () => ({
  fanOutJuiceBoxPush: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/giphy", () => ({
  fetchGiphyById: vi.fn(async () => null),
  isGiphyHost: () => true,
}));

// ---------------------------------------------------------------------------
// Dynamic imports (env placeholders must be set first — @/lib/goals pulls in
// the browser Supabase client through the shared lib graph)
// ---------------------------------------------------------------------------

const { signSessionToken } = await import("@/lib/server/auth");
const { fanOutJuiceBoxPush } = await import("@/lib/server/push");
const { GET: getFeed, POST: postMessage } = await import("./route");
const { GET: getUnread } = await import("./unread/route");
const { GET: getReads, POST: postReads } = await import("./reads/me/route");
const { GET: search } = await import("./search/route");
const { GET: lookupChannel } = await import("./[id]/channel/route");
const { POST: moveConversation } = await import("./[id]/move/route");
const { getServerSupabase: getServerSupabaseForTest } = await import(
  "@/lib/supabase/server"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AE_ID = "11111111-1111-4111-8111-111111111111";
const LEAH_ID = "33333333-3333-4333-8333-333333333333";
const CHANEL_ID = "44444444-4444-4444-8444-444444444444";
const ADMIN_ID = "55555555-5555-4555-8555-555555555555";
const EX_ADMIN_ID = "66666666-6666-4666-8666-666666666666";

function seedPeople() {
  state.people[AE_ID] = {
    id: AE_ID,
    first_name: "Carli",
    role: "ae",
    is_test: false,
    can_import_offices: false,
    state_code: null,
    deactivated_at: null,
  };
  state.people[LEAH_ID] = {
    ...state.people[AE_ID],
    id: LEAH_ID,
    first_name: "Leah",
    role: "juice_box_only",
  };
  state.people[CHANEL_ID] = {
    ...state.people[AE_ID],
    id: CHANEL_ID,
    first_name: "Chanel",
    deactivated_at: "2026-08-24T17:00:00.000Z",
  };
  state.people[ADMIN_ID] = {
    ...state.people[AE_ID],
    id: ADMIN_ID,
    first_name: "Corey",
    role: "admin",
  };
  // A deactivated ADMIN: role alone must not be enough.
  state.people[EX_ADMIN_ID] = {
    ...state.people[AE_ID],
    id: EX_ADMIN_ID,
    first_name: "Ryan",
    role: "admin",
    deactivated_at: "2026-08-01T17:00:00.000Z",
  };
}

function msg(over: Partial<MessageRow>): MessageRow {
  return {
    id: "m",
    channel: "general",
    created_at: "2026-08-20T10:00:00.000Z",
    salesperson_id: AE_ID,
    salesperson_name: "Carli",
    message: "hi",
    is_deleted: false,
    reply_to_message_id: null,
    reply_to_salesperson_name: null,
    reply_to_message_preview: null,
    media_type: null,
    media_url: null,
    ...over,
  } as MessageRow;
}

function token(id: string): string {
  const row = state.people[id] as { role: string; first_name: string };
  return signSessionToken({
    sub: id,
    role: row.role as never,
    name: row.first_name,
  });
}

function get(fn: (r: Request) => Promise<Response>, path: string, id = AE_ID) {
  return fn(
    new Request(`http://localhost${path}`, {
      headers: { Authorization: `Bearer ${token(id)}` },
    }),
  );
}

function post(
  fn: (r: Request) => Promise<Response>,
  path: string,
  body: unknown,
  id = AE_ID,
) {
  return fn(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token(id)}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state = freshState();
  seedPeople();
  vi.mocked(fanOutJuiceBoxPush).mockClear();
});

// ---------------------------------------------------------------------------

describe("GET /api/team-messages — channel filtering", () => {
  beforeEach(() => {
    state.messages.push(
      msg({ id: "g1", channel: "general", message: "general post" }),
      msg({ id: "p1", channel: "product_help", message: "pricing question" }),
      msg({ id: "s1", channel: "social_media_hub", message: "caption idea" }),
      // A post written BEFORE the channel column existed. The migration's
      // DEFAULT backfilled these to 'general'; this row models one that a
      // hand-written insert left null.
      msg({ id: "legacy", channel: null, message: "historical post" }),
    );
  });

  it("defaults to General when no channel is given (back-compat)", async () => {
    const res = await get(getFeed, "/api/team-messages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channel: string;
      messages: Array<{ id: string }>;
    };
    expect(body.channel).toBe("general");
    expect(body.messages.map((m) => m.id)).toEqual(["g1"]);
  });

  it("returns only the requested channel — no cross-channel leak", async () => {
    const res = await get(getFeed, "/api/team-messages?channel=product_help");
    const body = (await res.json()) as {
      channel: string;
      messages: Array<{ id: string; channel: string }>;
    };
    expect(body.channel).toBe("product_help");
    expect(body.messages.map((m) => m.id)).toEqual(["p1"]);
    // The filter is in the QUERY, not applied after the fact.
    const feedRead = state.reads_filters.find(
      (f) => f.table === "team_messages" && f.filters["eq:channel"],
    );
    expect(feedRead?.filters["eq:channel"]).toBe("product_help");
  });

  it("keeps each channel's history separate", async () => {
    for (const [channel, ids] of [
      ["general", ["g1"]],
      ["product_help", ["p1"]],
      ["social_media_hub", ["s1"]],
    ] as const) {
      const res = await get(getFeed, `/api/team-messages?channel=${channel}`);
      const body = (await res.json()) as { messages: Array<{ id: string }> };
      expect(body.messages.map((m) => m.id)).toEqual(ids);
    }
  });

  it("400s an unknown channel instead of silently serving General", async () => {
    for (const bad of ["marketing", "GENERAL", "general;drop", ""]) {
      const res = await get(
        getFeed,
        `/api/team-messages?channel=${encodeURIComponent(bad)}`,
      );
      expect(res.status).toBe(400);
    }
  });

  it("403s nothing and 401s a deactivated caller (auth unchanged)", async () => {
    const res = await get(getFeed, "/api/team-messages", CHANEL_ID);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/team-messages — channel on create", () => {
  it("saves a new message to the selected channel", async () => {
    const res = await post(postMessage, "/api/team-messages", {
      message: "How do we price a duplex?",
      channel: "product_help",
    });
    expect(res.status).toBe(201);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].payload.channel).toBe("product_help");
  });

  it("defaults to General when the client omits the channel", async () => {
    const res = await post(postMessage, "/api/team-messages", {
      message: "morning all",
    });
    expect(res.status).toBe(201);
    expect(state.inserts[0].payload.channel).toBe("general");
  });

  it("400s an invalid channel and writes nothing", async () => {
    for (const bad of ["marketing", "General", 5, null]) {
      const res = await post(postMessage, "/api/team-messages", {
        message: "hi",
        channel: bad,
      });
      expect(res.status).toBe(400);
    }
    expect(state.inserts).toHaveLength(0);
  });

  it("still takes identity from the session, not the body", async () => {
    await post(postMessage, "/api/team-messages", {
      message: "hi",
      channel: "general",
      salesperson_id: LEAH_ID,
      salesperson_name: "Leah",
    });
    expect(state.inserts[0].payload.salesperson_id).toBe(AE_ID);
    expect(state.inserts[0].payload.salesperson_name).toBe("Carli");
  });

  it("names the channel in the push notification and its deep link", async () => {
    await post(postMessage, "/api/team-messages", {
      message: "caption ideas?",
      channel: "social_media_hub",
    });
    expect(fanOutJuiceBoxPush).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(fanOutJuiceBoxPush).mock.calls[0][0];
    expect(arg.payload.body).toContain("Social Media Hub");
    expect(arg.payload.url).toBe("/juice-box?channel=social_media_hub");
  });
});

describe("POST /api/team-messages — replies cannot cross channels", () => {
  // Real UUIDs: `reply_to_message_id` is uuid-validated on the wire.
  const PARENT_PH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PARENT_LEGACY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  beforeEach(() => {
    state.messages.push(
      msg({ id: PARENT_PH, channel: "product_help", message: "pricing?" }),
      msg({ id: PARENT_LEGACY, channel: null, message: "old post" }),
    );
  });

  it("puts a reply in the parent's channel when none is sent", async () => {
    const res = await post(postMessage, "/api/team-messages", {
      message: "answer",
      reply_to_message_id: PARENT_PH,
    });
    expect(res.status).toBe(201);
    expect(state.inserts[0].payload.channel).toBe("product_help");
    expect(state.inserts[0].payload.reply_to_message_id).toBe(PARENT_PH);
  });

  it("accepts a reply that names the parent's own channel", async () => {
    const res = await post(postMessage, "/api/team-messages", {
      message: "answer",
      reply_to_message_id: PARENT_PH,
      channel: "product_help",
    });
    expect(res.status).toBe(201);
    expect(state.inserts[0].payload.channel).toBe("product_help");
  });

  it("400s a reply that names a DIFFERENT channel — nothing is written", async () => {
    const res = await post(postMessage, "/api/team-messages", {
      message: "answer",
      reply_to_message_id: PARENT_PH,
      channel: "general",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Product Help");
    expect(state.inserts).toHaveLength(0);
  });

  it("treats a pre-channels parent as General", async () => {
    const res = await post(postMessage, "/api/team-messages", {
      message: "answer",
      reply_to_message_id: PARENT_LEGACY,
    });
    expect(res.status).toBe(201);
    expect(state.inserts[0].payload.channel).toBe("general");
  });

  it("still refuses to reply to a missing post", async () => {
    const res = await post(postMessage, "/api/team-messages", {
      message: "answer",
      reply_to_message_id: "99999999-9999-4999-8999-999999999999",
      channel: "general",
    });
    expect(res.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });
});

describe("GET /api/team-messages/unread — per channel + combined", () => {
  beforeEach(() => {
    state.messages.push(
      msg({ id: "g1", channel: "general", created_at: "2026-08-20T10:00:00.000Z" }),
      msg({ id: "g2", channel: "general", created_at: "2026-08-24T10:00:00.000Z" }),
      msg({ id: "p1", channel: "product_help", created_at: "2026-08-24T11:00:00.000Z" }),
      msg({ id: "p2", channel: "product_help", created_at: "2026-08-24T12:00:00.000Z" }),
      msg({ id: "s1", channel: "social_media_hub", created_at: "2026-08-24T13:00:00.000Z" }),
      msg({ id: "gone", channel: "general", created_at: "2026-08-24T14:00:00.000Z", is_deleted: true }),
    );
  });

  it("counts each channel against its OWN marker", async () => {
    state.reads.push(
      { salesperson_id: AE_ID, channel: "general", last_read_at: "2026-08-22T00:00:00.000Z" },
      { salesperson_id: AE_ID, channel: "product_help", last_read_at: "2026-08-24T11:30:00.000Z" },
    );
    const res = await get(getUnread, "/api/team-messages/unread");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      last_read_at: string | null;
      channels: Record<string, { count: number; last_read_at: string | null }>;
    };
    expect(body.channels.general.count).toBe(1); // g2 only; deleted excluded
    expect(body.channels.product_help.count).toBe(1); // p2 only
    expect(body.channels.social_media_hub.count).toBe(1); // no marker → all
    expect(body.channels.social_media_hub.last_read_at).toBeNull();
    expect(body.count).toBe(3); // combined = nav badge
    expect(body.last_read_at).toBe("2026-08-22T00:00:00.000Z"); // legacy field = General
  });

  it("treats a user with NO markers as fully unread per channel", async () => {
    const res = await get(getUnread, "/api/team-messages/unread");
    const body = (await res.json()) as {
      count: number;
      channels: Record<string, { count: number; last_read_at: string | null }>;
    };
    expect(body.channels.general.count).toBe(2);
    expect(body.channels.product_help.count).toBe(2);
    expect(body.channels.social_media_hub.count).toBe(1);
    expect(body.count).toBe(5);
    for (const c of Object.values(body.channels)) {
      expect(c.last_read_at).toBeNull();
    }
  });

  it("maps an existing pre-channels marker row onto General", async () => {
    // The migration relabels these to 'general'; a null models a row that
    // somehow escaped the DEFAULT.
    state.reads.push({
      salesperson_id: AE_ID,
      channel: null,
      last_read_at: "2026-08-24T09:00:00.000Z",
    });
    const res = await get(getUnread, "/api/team-messages/unread");
    const body = (await res.json()) as {
      channels: Record<string, { count: number; last_read_at: string | null }>;
    };
    expect(body.channels.general.last_read_at).toBe("2026-08-24T09:00:00.000Z");
    expect(body.channels.general.count).toBe(1); // only g2 is newer
  });

  it("never counts another user's markers", async () => {
    state.reads.push({
      salesperson_id: LEAH_ID,
      channel: "general",
      last_read_at: "2026-08-25T00:00:00.000Z",
    });
    const res = await get(getUnread, "/api/team-messages/unread");
    const body = (await res.json()) as {
      channels: Record<string, { last_read_at: string | null }>;
    };
    expect(body.channels.general.last_read_at).toBeNull();
  });
});

describe("POST /api/team-messages/reads/me — per-channel markers", () => {
  it("writes through the monotonic RPC, never a bare upsert", async () => {
    const res = await post(postReads, "/api/team-messages/reads/me", {
      channel: "product_help",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: string; last_read_at: string };
    expect(body.channel).toBe("product_help");

    // The RPC receives only server-controlled values: the session's id and the
    // validated channel.
    const call = state.rpcCalls.find(
      (c) => c.name === "juice_box_mark_channel_read",
    );
    expect(call?.params).toEqual({
      p_salesperson_id: AE_ID,
      p_channel: "product_help",
    });
    // The race-prone path must be gone entirely — no direct upsert to either
    // read-marker table.
    expect(
      state.upserts.filter(
        (u) =>
          u.table === "team_message_channel_reads" ||
          u.table === "team_message_reads",
      ),
    ).toHaveLength(0);
    // The row landed via the RPC.
    expect(state.reads).toHaveLength(1);
    expect(state.reads[0]).toMatchObject({
      salesperson_id: AE_ID,
      channel: "product_help",
    });
  });

  it("does NOT touch the legacy table for a non-General channel", async () => {
    // Mapping a Product Help read onto the legacy single marker would tell an
    // old client the whole feed had been read.
    await post(postReads, "/api/team-messages/reads/me", {
      channel: "product_help",
    });
    expect(
      state.upserts.filter((u) => u.table === "team_message_reads"),
    ).toHaveLength(0);
    expect(state.legacyReads).toHaveLength(0);
  });

  it("mirrors a General read into the legacy table via its own monotonic RPC", async () => {
    // Rollout compatibility: the previously deployed bundle reads its unread
    // count from this table. The mirror is a SEPARATE rpc (separate
    // transaction) that takes no channel argument.
    await post(postReads, "/api/team-messages/reads/me", { channel: "general" });
    const legacy = state.rpcCalls.find(
      (c) => c.name === "juice_box_mark_legacy_read",
    );
    expect(legacy?.params).toEqual({ p_salesperson_id: AE_ID });
    expect(legacy?.params).not.toHaveProperty("p_channel");
    expect(state.legacyReads).toHaveLength(1);
    // Authoritative write happened first.
    const names = state.rpcCalls.map((c) => c.name);
    expect(names.indexOf("juice_box_mark_channel_read")).toBeLessThan(
      names.indexOf("juice_box_mark_legacy_read"),
    );
  });

  it("reading one channel does NOT mark the others read", async () => {
    // General is caught up; Product Help and Social Media Hub are not.
    state.messages.push(
      msg({ id: "p1", channel: "product_help", created_at: "2026-08-24T12:00:00.000Z" }),
      msg({ id: "s1", channel: "social_media_hub", created_at: "2026-08-24T13:00:00.000Z" }),
    );
    await post(postReads, "/api/team-messages/reads/me", { channel: "general" });

    const res = await get(getUnread, "/api/team-messages/unread");
    const body = (await res.json()) as {
      count: number;
      channels: Record<string, { count: number; last_read_at: string | null }>;
    };
    expect(body.channels.general.last_read_at).not.toBeNull();
    expect(body.channels.product_help.last_read_at).toBeNull();
    expect(body.channels.product_help.count).toBe(1);
    expect(body.channels.social_media_hub.count).toBe(1);
    expect(body.count).toBe(2);
    expect(state.reads).toHaveLength(1);
    expect(state.reads[0].channel).toBe("general");
  });

  it("marks each channel independently across several calls", async () => {
    await post(postReads, "/api/team-messages/reads/me", { channel: "general" });
    await post(postReads, "/api/team-messages/reads/me", {
      channel: "product_help",
    });
    // Two distinct rows in the new table — the composite key is what makes
    // this possible; the old single-column key would have overwritten.
    expect(
      state.reads.map((r) => r.channel).sort(),
    ).toEqual(["general", "product_help"]);
    expect(state.reads[0].salesperson_id).toBe(AE_ID);
  });

  it("defaults to General for an empty body (pre-channels client)", async () => {
    const res = await postReads(
      new Request("http://localhost/api/team-messages/reads/me", {
        method: "POST",
        headers: { Authorization: `Bearer ${token(AE_ID)}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(state.rpcCalls[0]).toMatchObject({
      name: "juice_box_mark_channel_read",
      params: { p_salesperson_id: AE_ID, p_channel: "general" },
    });
  });

  it("400s an unknown channel rather than stamping the wrong marker", async () => {
    const res = await post(postReads, "/api/team-messages/reads/me", {
      channel: "marketing",
    });
    expect(res.status).toBe(400);
    // Rejected before any write is attempted.
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.reads).toHaveLength(0);
  });

  it("never accepts a caller-supplied timestamp or salesperson", async () => {
    const res = await post(postReads, "/api/team-messages/reads/me", {
      channel: "general",
      last_read_at: "2099-01-01T00:00:00.000Z",
      salesperson_id: LEAH_ID,
    });
    // Extra keys are rejected by the strict schema — a forward-dated marker
    // would silently swallow future messages. (The timestamp is generated
    // inside Postgres now, so there is nothing to forward-date anyway.)
    expect(res.status).toBe(400);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("GET returns the marker for one channel", async () => {
    state.reads.push({
      salesperson_id: AE_ID,
      channel: "product_help",
      last_read_at: "2026-08-24T12:00:00.000Z",
    });
    const ph = await get(getReads, "/api/team-messages/reads/me?channel=product_help");
    expect(await ph.json()).toEqual({
      channel: "product_help",
      last_read_at: "2026-08-24T12:00:00.000Z",
    });
    const general = await get(getReads, "/api/team-messages/reads/me");
    expect(await general.json()).toEqual({
      channel: "general",
      last_read_at: null,
    });
  });
});

describe("GET /api/team-messages/search — cross-channel navigation data", () => {
  beforeEach(() => {
    state.messages.push(
      msg({ id: "g1", channel: "general", message: "donuts" }),
      msg({ id: "p1", channel: "product_help", message: "donuts pricing" }),
    );
  });

  it("searches every channel by default and labels each hit", async () => {
    const res = await get(search, "/api/team-messages/search?q=donuts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string; channel: string }>;
    };
    // Both channels present, each carrying the channel the UI needs to switch
    // to before scrolling to it.
    expect(body.messages.map((m) => m.channel).sort()).toEqual([
      "general",
      "product_help",
    ]);
  });

  it("can scope to one channel", async () => {
    const res = await get(
      search,
      "/api/team-messages/search?q=donuts&channel=product_help",
    );
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((m) => m.id)).toEqual(["p1"]);
  });

  it("400s an unknown channel scope", async () => {
    const res = await get(search, "/api/team-messages/search?channel=marketing");
    expect(res.status).toBe(400);
  });
});

describe("migrated read markers (expand-and-migrate)", () => {
  it("treats a backfilled legacy marker as the General marker", async () => {
    // What the migration's copy produces: the person's single legacy marker
    // inserted into the new table under channel='general'.
    state.reads.push({
      salesperson_id: AE_ID,
      channel: "general",
      last_read_at: "2026-08-24T09:00:00.000Z",
    });
    state.messages.push(
      msg({ id: "g-old", channel: "general", created_at: "2026-08-23T10:00:00.000Z" }),
      msg({ id: "g-new", channel: "general", created_at: "2026-08-24T10:00:00.000Z" }),
    );

    const res = await get(getUnread, "/api/team-messages/unread");
    const body = (await res.json()) as {
      count: number;
      last_read_at: string | null;
      channels: Record<string, { count: number; last_read_at: string | null }>;
    };
    // Unread state carried over exactly: only the post after the marker.
    expect(body.channels.general.count).toBe(1);
    expect(body.channels.general.last_read_at).toBe("2026-08-24T09:00:00.000Z");
    expect(body.last_read_at).toBe("2026-08-24T09:00:00.000Z");
    // The new channels start with no marker → null keeps the
    // latest-message/no-divider behaviour.
    expect(body.channels.product_help.last_read_at).toBeNull();
    expect(body.channels.social_media_hub.last_read_at).toBeNull();
  });

  it("reads the channel table, and folds the legacy marker into GENERAL only", async () => {
    // The channel table is authoritative for every channel; the legacy row
    // additionally participates in General (later-of-the-two), which is what
    // stops a rollout-window read from resurfacing as unread. Both other
    // channels must ignore it entirely.
    state.legacyReads.push({
      salesperson_id: AE_ID,
      last_read_at: "2026-08-24T18:00:00.000Z",
    });
    state.messages.push(
      msg({ id: "g1", channel: "general", created_at: "2026-08-24T10:00:00.000Z" }),
      msg({ id: "p1", channel: "product_help", created_at: "2026-08-24T10:00:00.000Z" }),
    );
    const res = await get(getUnread, "/api/team-messages/unread");
    const body = (await res.json()) as {
      count: number;
      channels: Record<string, { count: number; last_read_at: string | null }>;
    };
    // General: the legacy marker is newer than g1 → already read.
    expect(body.channels.general.last_read_at).toBe("2026-08-24T18:00:00.000Z");
    expect(body.channels.general.count).toBe(0);
    // Product Help: legacy marker not consulted → still unread.
    expect(body.channels.product_help.last_read_at).toBeNull();
    expect(body.channels.product_help.count).toBe(1);
    expect(body.count).toBe(1);
    // The channel table was queried (it is the authoritative source).
    const reads = state.reads_filters.filter(
      (f) => f.table === "team_message_channel_reads",
    );
    expect(reads.length).toBeGreaterThan(0);
  });
});

describe("GET /api/team-messages/:id/channel — bare deep-link lookup", () => {
  const ID_GENERAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ID_PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ID_SOCIAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const ID_LEGACY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const ID_DELETED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const ID_MISSING = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  const lookup = (id: string, caller = AE_ID) =>
    lookupChannel(
      new Request(`http://localhost/api/team-messages/${id}/channel`, {
        headers: { Authorization: `Bearer ${token(caller)}` },
      }),
      { params: Promise.resolve({ id }) },
    );

  beforeEach(() => {
    state.messages.push(
      msg({ id: ID_GENERAL, channel: "general" }),
      msg({ id: ID_PRODUCT, channel: "product_help" }),
      msg({ id: ID_SOCIAL, channel: "social_media_hub" }),
      msg({ id: ID_LEGACY, channel: null }),
      msg({ id: ID_DELETED, channel: "product_help", is_deleted: true }),
    );
  });

  it("resolves a General message", async () => {
    const res = await lookup(ID_GENERAL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID_GENERAL, channel: "general" });
  });

  it("resolves a Product Help message", async () => {
    const res = await lookup(ID_PRODUCT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ID_PRODUCT,
      channel: "product_help",
    });
  });

  it("resolves a Social Media Hub message", async () => {
    const res = await lookup(ID_SOCIAL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ID_SOCIAL,
      channel: "social_media_hub",
    });
  });

  it("normalizes a legacy null channel to General", async () => {
    const res = await lookup(ID_LEGACY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID_LEGACY, channel: "general" });
  });

  it("404s a message that does not exist", async () => {
    const res = await lookup(ID_MISSING);
    expect(res.status).toBe(404);
  });

  it("404s a soft-deleted (moderated) message", async () => {
    const res = await lookup(ID_DELETED);
    expect(res.status).toBe(404);
  });

  it("400s a malformed id without hitting the database", async () => {
    const res = await lookup("not-a-uuid");
    expect(res.status).toBe(400);
    expect(
      state.reads_filters.filter((f) => f.table === "team_messages"),
    ).toHaveLength(0);
  });

  it("401s an unauthenticated caller", async () => {
    const res = await lookupChannel(
      new Request(`http://localhost/api/team-messages/${ID_PRODUCT}/channel`),
      { params: Promise.resolve({ id: ID_PRODUCT }) },
    );
    expect(res.status).toBe(401);
  });

  it("401s a deactivated caller holding a valid token", async () => {
    const res = await lookup(ID_PRODUCT, CHANEL_ID);
    expect(res.status).toBe(401);
  });

  it("allows a juice_box_only member (same gate as the feed)", async () => {
    const res = await lookup(ID_PRODUCT, LEAH_ID);
    expect(res.status).toBe(200);
  });

  it("returns ONLY the id and channel — no message content", async () => {
    const res = await lookup(ID_PRODUCT);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["channel", "id"]);
    expect(body).not.toHaveProperty("message");
    expect(body).not.toHaveProperty("salesperson_name");
  });
});

describe("General's effective marker = MAX(new, legacy) during the rollout", () => {
  const EARLY = "2026-08-24T09:00:00.000Z";
  const LATE = "2026-08-24T18:00:00.000Z";

  beforeEach(() => {
    // Two General posts either side of the two candidate markers, plus one
    // post in each other channel.
    state.messages.push(
      msg({ id: "g-before", channel: "general", created_at: "2026-08-24T08:00:00.000Z" }),
      msg({ id: "g-middle", channel: "general", created_at: "2026-08-24T12:00:00.000Z" }),
      msg({ id: "g-after", channel: "general", created_at: "2026-08-24T20:00:00.000Z" }),
      msg({ id: "p1", channel: "product_help", created_at: "2026-08-24T12:00:00.000Z" }),
      msg({ id: "s1", channel: "social_media_hub", created_at: "2026-08-24T12:00:00.000Z" }),
    );
  });

  const unread = async () => {
    const res = await get(getUnread, "/api/team-messages/unread");
    expect(res.status).toBe(200);
    return (await res.json()) as {
      count: number;
      last_read_at: string | null;
      channels: Record<string, { count: number; last_read_at: string | null }>;
    };
  };

  it("uses the NEW General marker when it is later", async () => {
    state.reads.push({ salesperson_id: AE_ID, channel: "general", last_read_at: LATE });
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: EARLY });
    const body = await unread();
    expect(body.channels.general.last_read_at).toBe(LATE);
    expect(body.channels.general.count).toBe(1); // only g-after
  });

  it("uses the LEGACY marker when it is later — the rollout-window bug", async () => {
    // The migration copied EARLY into the new table, then the still-deployed
    // old bundle advanced the legacy marker to LATE before the deploy landed.
    state.reads.push({ salesperson_id: AE_ID, channel: "general", last_read_at: EARLY });
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: LATE });
    const body = await unread();
    expect(body.channels.general.last_read_at).toBe(LATE);
    // g-middle was read on the old bundle and must NOT resurface as unread.
    expect(body.channels.general.count).toBe(1); // only g-after
  });

  it("works with only the new General marker", async () => {
    state.reads.push({ salesperson_id: AE_ID, channel: "general", last_read_at: LATE });
    const body = await unread();
    expect(body.channels.general.last_read_at).toBe(LATE);
    expect(body.channels.general.count).toBe(1);
  });

  it("works with only the legacy marker", async () => {
    // A user who never marked anything read on the new bundle yet.
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: LATE });
    const body = await unread();
    expect(body.channels.general.last_read_at).toBe(LATE);
    expect(body.channels.general.count).toBe(1);
  });

  it("returns null when neither marker exists (land at latest, no divider)", async () => {
    const body = await unread();
    expect(body.channels.general.last_read_at).toBeNull();
    // Null means "no receipt", so every live post counts — and the client
    // lands at the latest with no divider above old content.
    expect(body.channels.general.count).toBe(3);
  });

  it("is stable when both markers are the same instant", async () => {
    state.reads.push({ salesperson_id: AE_ID, channel: "general", last_read_at: LATE });
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: LATE });
    const body = await unread();
    expect(body.channels.general.last_read_at).toBe(LATE);
    expect(body.channels.general.count).toBe(1);
  });

  it("ignores a malformed marker in favour of the usable one", async () => {
    state.reads.push({
      salesperson_id: AE_ID,
      channel: "general",
      last_read_at: "not-a-timestamp",
    });
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: LATE });
    const body = await unread();
    expect(body.channels.general.last_read_at).toBe(LATE);
    expect(body.channels.general.count).toBe(1);
  });

  it("falls back to null when BOTH markers are malformed", async () => {
    state.reads.push({
      salesperson_id: AE_ID,
      channel: "general",
      last_read_at: "garbage",
    });
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: "junk" });
    const body = await unread();
    // Fails safe to "no receipt" rather than a bogus unread boundary.
    expect(body.channels.general.last_read_at).toBeNull();
    expect(body.channels.general.count).toBe(3);
  });

  it("Product Help IGNORES the legacy marker", async () => {
    // The legacy marker predates the channel; using it would hide real unread
    // Product Help posts.
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: LATE });
    const body = await unread();
    expect(body.channels.product_help.last_read_at).toBeNull();
    expect(body.channels.product_help.count).toBe(1);
  });

  it("Social Media Hub IGNORES the legacy marker", async () => {
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: LATE });
    const body = await unread();
    expect(body.channels.social_media_hub.last_read_at).toBeNull();
    expect(body.channels.social_media_hub.count).toBe(1);
  });

  it("keeps the combined nav count consistent with the effective markers", async () => {
    state.reads.push({ salesperson_id: AE_ID, channel: "general", last_read_at: EARLY });
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: LATE });
    const body = await unread();
    // General 1 (g-after) + Product Help 1 + Social 1
    expect(body.count).toBe(3);
    expect(body.last_read_at).toBe(LATE); // legacy top-level field = General
  });

  it("never reads another user's legacy marker", async () => {
    state.legacyReads.push({ salesperson_id: LEAH_ID, last_read_at: LATE });
    const body = await unread();
    expect(body.channels.general.last_read_at).toBeNull();
  });

  it("GET /reads/me returns the same effective General marker", async () => {
    state.reads.push({ salesperson_id: AE_ID, channel: "general", last_read_at: EARLY });
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: LATE });

    const general = await get(getReads, "/api/team-messages/reads/me?channel=general");
    expect(await general.json()).toEqual({
      channel: "general",
      last_read_at: LATE,
    });

    // …and does NOT fold it into another channel.
    const ph = await get(getReads, "/api/team-messages/reads/me?channel=product_help");
    expect(await ph.json()).toEqual({
      channel: "product_help",
      last_read_at: null,
    });
  });

  it("self-heals the drift on the next General mark-read", async () => {
    state.reads.push({ salesperson_id: AE_ID, channel: "general", last_read_at: EARLY });
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: LATE });

    await post(postReads, "/api/team-messages/reads/me", { channel: "general" });

    // Both tables now carry the same fresh NOW() stamp, so the two markers are
    // back in sync without any manual step.
    const newMarker = state.reads.find((r) => r.channel === "general")?.last_read_at;
    const legacyMarker = state.legacyReads[0]?.last_read_at;
    expect(newMarker).toBeDefined();
    expect(newMarker).toBe(legacyMarker);
    expect(Date.parse(newMarker as string)).toBeGreaterThan(Date.parse(LATE));

    // And the other channels are untouched by that write.
    expect(state.reads.filter((r) => r.channel !== "general")).toHaveLength(0);
  });

  it("mark-read never moves a marker backwards", async () => {
    // POST stamps NOW(), which is always >= whatever was there.
    state.reads.push({
      salesperson_id: AE_ID,
      channel: "general",
      last_read_at: "2026-08-24T09:00:00.000Z",
    });
    await post(postReads, "/api/team-messages/reads/me", { channel: "general" });
    const after = state.reads.find((r) => r.channel === "general")?.last_read_at;
    expect(Date.parse(after as string)).toBeGreaterThanOrEqual(Date.parse(EARLY));
  });
});

describe("mark-read is monotonic under REVERSED arrival", () => {
  // T1 < T2, both firmly in the PAST so that an accidentally-empty stamp queue
  // (which falls back to the real clock) would produce a LATER value and fail
  // the assertion loudly rather than pass by coincidence.
  const T1 = "2026-08-20T10:00:00.000Z";
  const T2 = "2026-08-20T18:00:00.000Z";

  /** How many RPCs one mark-read issues: General also mirrors to the legacy
   *  table, the other two channels don't. */
  const rpcsPerCall = (channel: string) => (channel === "general" ? 2 : 1);

  /** Queue `stamps` so each entry is used by one full mark-read call. */
  const queueStamps = (channel: string, stamps: string[]) => {
    state.rpcNowQueue = stamps.flatMap((t) =>
      Array.from({ length: rpcsPerCall(channel) }, () => t),
    );
  };

  /**
   * Two mark-read calls whose stamps arrive NEWEST FIRST — request A (started
   * earlier, stamped T1) reaching Postgres after request B (stamped T2). An
   * unconditional upsert would store T2 and then overwrite it with T1, moving
   * the marker backwards. GREATEST must keep T2.
   */
  const reversedPair = async (channel: string) => {
    queueStamps(channel, [T2, T1]);
    const first = await post(postReads, "/api/team-messages/reads/me", {
      channel,
    });
    const second = await post(postReads, "/api/team-messages/reads/me", {
      channel,
    });
    return { first, second };
  };

  const markerFor = (channel: string) =>
    state.reads.find(
      (r) => r.salesperson_id === AE_ID && r.channel === channel,
    )?.last_read_at;

  it("Product Help: stores T2, then an older T1 arrives → stays T2", async () => {
    const { second } = await reversedPair("product_help");
    expect(markerFor("product_help")).toBe(T2);
    // …and the API answers with the PERSISTED value, not its own older stamp.
    expect(second.status).toBe(200);
    expect((await second.json()) as unknown).toEqual({
      channel: "product_help",
      last_read_at: T2,
    });
  });

  it("Social Media Hub: stores T2, then an older T1 arrives → stays T2", async () => {
    const { second } = await reversedPair("social_media_hub");
    expect(markerFor("social_media_hub")).toBe(T2);
    expect((await second.json()) as unknown).toEqual({
      channel: "social_media_hub",
      last_read_at: T2,
    });
  });

  it("General channel marker: stores T2, then an older T1 arrives → stays T2", async () => {
    const { second } = await reversedPair("general");
    expect(markerFor("general")).toBe(T2);
    expect((await second.json()) as unknown).toEqual({
      channel: "general",
      last_read_at: T2,
    });
  });

  it("General LEGACY mirror: stores T2, then an older T1 arrives → stays T2", async () => {
    await reversedPair("general");
    expect(state.legacyReads).toHaveLength(1);
    expect(state.legacyReads[0].last_read_at).toBe(T2);
    expect(markerFor("general")).toBe(T2);
  });

  it("inserts a fresh row when none exists", async () => {
    queueStamps("product_help", [T1]);
    const res = await post(postReads, "/api/team-messages/reads/me", {
      channel: "product_help",
    });
    expect(res.status).toBe(200);
    expect(state.reads).toHaveLength(1);
    expect(markerFor("product_help")).toBe(T1);
  });

  it("keeps the stored value when the incoming stamp is EQUAL", async () => {
    queueStamps("general", [T2, T2]);
    await post(postReads, "/api/team-messages/reads/me", { channel: "general" });
    await post(postReads, "/api/team-messages/reads/me", { channel: "general" });
    expect(markerFor("general")).toBe(T2);
    expect(state.legacyReads[0].last_read_at).toBe(T2);
    expect(state.reads).toHaveLength(1); // no duplicate row
  });

  it("ADVANCES when the incoming stamp is newer", async () => {
    queueStamps("product_help", [T1, T2]);
    await post(postReads, "/api/team-messages/reads/me", {
      channel: "product_help",
    });
    const second = await post(postReads, "/api/team-messages/reads/me", {
      channel: "product_help",
    });
    expect(markerFor("product_help")).toBe(T2);
    expect((await second.json()) as unknown).toEqual({
      channel: "product_help",
      last_read_at: T2,
    });
  });

  it("an older incoming stamp leaves the marker byte-identical", async () => {
    queueStamps("product_help", [T2, T1]);
    await post(postReads, "/api/team-messages/reads/me", {
      channel: "product_help",
    });
    const before = markerFor("product_help");
    await post(postReads, "/api/team-messages/reads/me", {
      channel: "product_help",
    });
    expect(markerFor("product_help")).toBe(before);
    expect(markerFor("product_help")).toBe(T2);
  });

  it("unread counts cannot regress after a reversed pair", async () => {
    // One General post BETWEEN T1 and T2: read as of T2, unread as of T1.
    state.messages.push(
      msg({ id: "g-mid", channel: "general", created_at: "2026-08-20T12:00:00.000Z" }),
    );
    await reversedPair("general");
    const res = await get(getUnread, "/api/team-messages/unread");
    const body = (await res.json()) as {
      count: number;
      channels: Record<string, { count: number; last_read_at: string | null }>;
    };
    // If the older write had won, this would be 1 and the divider would come
    // back above an already-read post.
    expect(body.channels.general.last_read_at).toBe(T2);
    expect(body.channels.general.count).toBe(0);
    expect(body.count).toBe(0);
  });

  it("a failing legacy mirror neither fails the request nor rolls back the channel write", async () => {
    queueStamps("general", [T2]);
    state.rpcFailures.add("juice_box_mark_legacy_read");
    const res = await post(postReads, "/api/team-messages/reads/me", {
      channel: "general",
    });
    // Authoritative write committed and is reported.
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({
      channel: "general",
      last_read_at: T2,
    });
    expect(markerFor("general")).toBe(T2);
    // Legacy row was never written — separate transaction, no rollback.
    expect(state.legacyReads).toHaveLength(0);
  });

  it("fails the request when the AUTHORITATIVE write fails", async () => {
    state.rpcFailures.add("juice_box_mark_channel_read");
    const res = await post(postReads, "/api/team-messages/reads/me", {
      channel: "product_help",
    });
    expect(res.status).toBe(500);
    expect(state.reads).toHaveLength(0);
    // The mirror is never attempted when the primary write failed.
    expect(
      state.rpcCalls.filter((c) => c.name === "juice_box_mark_legacy_read"),
    ).toHaveLength(0);
  });

  it("rejects an unknown channel at the RPC boundary too", async () => {
    // The route validates first (400 before any call), and the RPC itself
    // refuses as a second line of defence — mirroring the SQL's RAISE.
    const direct = await fakeRpc("juice_box_mark_channel_read", {
      p_salesperson_id: AE_ID,
      p_channel: "marketing",
    });
    expect(direct.error).not.toBeNull();
    expect(state.reads).toHaveLength(0);
  });

  it("non-General channels never invoke the legacy RPC", async () => {
    for (const channel of ["product_help", "social_media_hub"]) {
      await post(postReads, "/api/team-messages/reads/me", { channel });
    }
    expect(
      state.rpcCalls.filter((c) => c.name === "juice_box_mark_legacy_read"),
    ).toHaveLength(0);
    expect(state.legacyReads).toHaveLength(0);
  });

  it("reading one channel leaves the others' markers untouched", async () => {
    state.rpcNowQueue = [T1, T2];
    await post(postReads, "/api/team-messages/reads/me", {
      channel: "product_help",
    });
    await post(postReads, "/api/team-messages/reads/me", {
      channel: "social_media_hub",
    });
    expect(markerFor("product_help")).toBe(T1);
    expect(markerFor("social_media_hub")).toBe(T2);
    expect(markerFor("general")).toBeUndefined();
  });

  it("still resolves the General migration overlap (later of the two)", async () => {
    // Channel marker at T1 (what the migration copied), legacy advanced to T2
    // by the old bundle afterwards.
    state.reads.push({ salesperson_id: AE_ID, channel: "general", last_read_at: T1 });
    state.legacyReads.push({ salesperson_id: AE_ID, last_read_at: T2 });
    const res = await get(getReads, "/api/team-messages/reads/me?channel=general");
    expect(await res.json()).toEqual({ channel: "general", last_read_at: T2 });
  });

  it("leaves the null-marker case alone (land at latest, no divider)", async () => {
    state.messages.push(
      msg({ id: "p1", channel: "product_help", created_at: "2026-08-20T12:00:00.000Z" }),
    );
    const res = await get(getUnread, "/api/team-messages/unread");
    const body = (await res.json()) as {
      channels: Record<string, { count: number; last_read_at: string | null }>;
    };
    // No mark-read has happened, so there is no marker at all — the client
    // lands at the latest message and shows no divider.
    expect(body.channels.product_help.last_read_at).toBeNull();
    expect(body.channels.product_help.count).toBe(1);
  });
});

describe("pre-migration database degrades clearly (local preview)", () => {
  beforeEach(() => {
    // A database that predates supabase/juice_box_channels.sql — exactly what a
    // developer previewing the branch locally has.
    state.preMigration = true;
  });

  const MIGRATION_HINT = /juice_box_channels\.sql/;

  it("the feed returns 503 naming the migration, not an opaque 500", async () => {
    const res = await get(getFeed, "/api/team-messages?channel=general");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(MIGRATION_HINT);
    // No invented messages — the caller gets an error, not empty "success".
    expect(body).not.toHaveProperty("messages");
  });

  it("the unread summary returns 503 rather than faking zero unread", async () => {
    const res = await get(getUnread, "/api/team-messages/unread");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(MIGRATION_HINT);
    expect(body).not.toHaveProperty("channels");
  });

  it("reads/me GET returns 503", async () => {
    const res = await get(getReads, "/api/team-messages/reads/me?channel=general");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(MIGRATION_HINT);
  });

  it("mark-read returns 503 (the monotonic RPCs don't exist yet)", async () => {
    const res = await post(postReads, "/api/team-messages/reads/me", {
      channel: "product_help",
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(MIGRATION_HINT);
  });

  it("still enforces auth first — no migration hint leaks to a bad session", async () => {
    // Authentication is unaffected by the missing migration: a deactivated
    // caller is still 401, and the message says nothing about the database.
    const res = await get(getFeed, "/api/team-messages?channel=general", CHANEL_ID);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).not.toMatch(
      MIGRATION_HINT,
    );
  });

  it("still validates the channel before reporting the migration", async () => {
    // A bad request is a bad request whatever the schema looks like.
    const res = await get(getFeed, "/api/team-messages?channel=marketing");
    expect(res.status).toBe(400);
  });

  it("keeps the generic 500 for an unrelated database error", async () => {
    state.preMigration = false;
    state.rpcFailures.add("juice_box_mark_channel_read");
    const res = await post(postReads, "/api/team-messages/reads/me", {
      channel: "general",
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).not.toMatch(
      MIGRATION_HINT,
    );
  });
});

describe("POST /:id/move — admin Move conversation", () => {
  // A nested thread in General: root → reply → nested reply.
  const ROOT = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaa1111";
  const REPLY = "aaaa2222-aaaa-4aaa-8aaa-aaaaaaaa2222";
  const NESTED = "aaaa3333-aaaa-4aaa-8aaa-aaaaaaaa3333";
  const LONE = "bbbb1111-bbbb-4bbb-8bbb-bbbbbbbb1111";
  const GONE = "cccc1111-cccc-4ccc-8ccc-cccccccc1111";
  const OTHER_THREAD = "dddd1111-dddd-4ddd-8ddd-dddddddd1111";

  const move = (
    id: string,
    body: unknown,
    caller: string | null = ADMIN_ID,
  ) =>
    moveConversation(
      new Request(`http://localhost/api/team-messages/${id}/move`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(caller ? { Authorization: `Bearer ${token(caller)}` } : {}),
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );

  const channelOf = (id: string) =>
    state.messages.find((m) => m.id === id)?.channel;

  beforeEach(() => {
    state.messages.push(
      msg({
        id: ROOT,
        channel: "general",
        message: "How do we price a duplex?",
        created_at: "2026-08-20T10:00:00.000Z",
        media_type: "image",
        media_url: "https://example.test/a.png",
      }),
      msg({
        id: REPLY,
        channel: "general",
        message: "answer",
        created_at: "2026-08-20T11:00:00.000Z",
        reply_to_message_id: ROOT,
        reply_to_salesperson_name: "Carli",
      }),
      msg({
        id: NESTED,
        channel: "general",
        message: "follow-up",
        created_at: "2026-08-20T12:00:00.000Z",
        reply_to_message_id: REPLY,
      }),
      msg({ id: LONE, channel: "general", message: "standalone" }),
      msg({ id: GONE, channel: "general", is_deleted: true }),
      msg({ id: OTHER_THREAD, channel: "general", message: "unrelated" }),
    );
  });

  // ---- Authorization -----------------------------------------------------

  it("lets an admin move a conversation", async () => {
    const res = await move(ROOT, { to_channel: "product_help" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      root_message_id: ROOT,
      from_channel: "general",
      to_channel: "product_help",
      message_count: 3,
      moved_at: "2026-08-25T12:00:00.000Z",
    });
    // Only what the client needs — no message bodies, no audit internals.
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("moved_by_salesperson_id");
  });

  it("403s a non-admin AE", async () => {
    const res = await move(ROOT, { to_channel: "product_help" }, AE_ID);
    expect(res.status).toBe(403);
    expect(channelOf(ROOT)).toBe("general");
    expect(state.moveAudit).toHaveLength(0);
  });

  it("403s a juice_box_only member", async () => {
    const res = await move(ROOT, { to_channel: "product_help" }, LEAH_ID);
    expect(res.status).toBe(403);
    expect(channelOf(ROOT)).toBe("general");
  });

  it("401s an unauthenticated request", async () => {
    const res = await move(ROOT, { to_channel: "product_help" }, null);
    expect(res.status).toBe(401);
    expect(channelOf(ROOT)).toBe("general");
  });

  it("401s a DEACTIVATED admin — role alone is not enough", async () => {
    const res = await move(ROOT, { to_channel: "product_help" }, EX_ADMIN_ID);
    expect(res.status).toBe(401);
    expect(channelOf(ROOT)).toBe("general");
    expect(state.moveAudit).toHaveLength(0);
  });

  it("ignores client-supplied actor / source / root values", async () => {
    // The strict schema rejects them outright, so there is no field to smuggle
    // an identity or a different conversation through.
    for (const extra of [
      { moved_by_salesperson_id: AE_ID },
      { salesperson_id: AE_ID },
      { is_admin: true },
      { from_channel: "social_media_hub" },
      { root_message_id: OTHER_THREAD },
      { p_actor_salesperson_id: AE_ID },
    ]) {
      const res = await move(ROOT, { to_channel: "product_help", ...extra });
      expect(res.status).toBe(400);
    }
    expect(channelOf(ROOT)).toBe("general");
    expect(state.moveAudit).toHaveLength(0);
  });

  it("audits the SESSION admin, never a body-supplied one", async () => {
    await move(ROOT, { to_channel: "product_help" });
    expect(state.moveAudit).toHaveLength(1);
    expect(state.moveAudit[0].moved_by_salesperson_id).toBe(ADMIN_ID);
  });

  // ---- Validation --------------------------------------------------------

  it("400s a malformed message id", async () => {
    const res = await move("not-a-uuid", { to_channel: "product_help" });
    expect(res.status).toBe(400);
  });

  it("404s a conversation that does not exist", async () => {
    const res = await move("99999999-9999-4999-8999-999999999999", {
      to_channel: "product_help",
    });
    expect(res.status).toBe(404);
  });

  it("404s a soft-deleted message", async () => {
    const res = await move(GONE, { to_channel: "product_help" });
    expect(res.status).toBe(404);
  });

  it("400s an invalid destination channel", async () => {
    for (const bad of ["marketing", "General", 7, null]) {
      const res = await move(ROOT, { to_channel: bad });
      expect(res.status).toBe(400);
    }
    expect(state.moveAudit).toHaveLength(0);
  });

  it("409s a move into the channel it is already in", async () => {
    const res = await move(ROOT, { to_channel: "general" });
    expect(res.status).toBe(409);
    expect(state.moveAudit).toHaveLength(0);
  });

  it("resolves the ROOT when the admin acts on a reply", async () => {
    const res = await move(REPLY, { to_channel: "social_media_hub" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root_message_id: string };
    expect(body.root_message_id).toBe(ROOT);
  });

  it("resolves the ROOT from a deeply nested reply", async () => {
    const res = await move(NESTED, { to_channel: "social_media_hub" });
    const body = (await res.json()) as {
      root_message_id: string;
      message_count: number;
    };
    expect(body.root_message_id).toBe(ROOT);
    expect(body.message_count).toBe(3);
  });

  // ---- Thread integrity --------------------------------------------------

  it("moves a root-only conversation", async () => {
    const res = await move(LONE, { to_channel: "product_help" });
    const body = (await res.json()) as { message_count: number };
    expect(body.message_count).toBe(1);
    expect(channelOf(LONE)).toBe("product_help");
  });

  it("moves the root and EVERY descendant together", async () => {
    await move(ROOT, { to_channel: "product_help" });
    expect(channelOf(ROOT)).toBe("product_help");
    expect(channelOf(REPLY)).toBe("product_help");
    expect(channelOf(NESTED)).toBe("product_help");
  });

  it("leaves no member of the thread in the source channel", async () => {
    await move(NESTED, { to_channel: "social_media_hub" });
    const stragglers = [ROOT, REPLY, NESTED].filter(
      (id) => channelOf(id) === "general",
    );
    expect(stragglers).toEqual([]);
  });

  it("does not touch unrelated conversations", async () => {
    await move(ROOT, { to_channel: "product_help" });
    expect(channelOf(LONE)).toBe("general");
    expect(channelOf(OTHER_THREAD)).toBe("general");
    expect(channelOf(GONE)).toBe("general");
  });

  it("409s and ROLLS BACK when a reply lands mid-move", async () => {
    state.moveStraggler = true;
    const res = await move(ROOT, { to_channel: "product_help" });
    expect(res.status).toBe(409);
    // Every message is back where it started…
    expect(channelOf(ROOT)).toBe("general");
    expect(channelOf(REPLY)).toBe("general");
    expect(channelOf(NESTED)).toBe("general");
    // …and no audit row was written for a move that did not happen.
    expect(state.moveAudit).toHaveLength(0);
  });

  it("409s a thread that already spans channels, changing nothing", async () => {
    const reply = state.messages.find((m) => m.id === REPLY);
    if (reply) reply.channel = "social_media_hub";
    const res = await move(ROOT, { to_channel: "product_help" });
    expect(res.status).toBe(409);
    expect(channelOf(ROOT)).toBe("general");
    expect(channelOf(REPLY)).toBe("social_media_hub");
    expect(state.moveAudit).toHaveLength(0);
  });

  it("writes exactly ONE correct audit row per successful move", async () => {
    await move(REPLY, { to_channel: "product_help" });
    expect(state.moveAudit).toHaveLength(1);
    expect(state.moveAudit[0]).toEqual({
      root_message_id: ROOT,
      from_channel: "general",
      to_channel: "product_help",
      moved_by_salesperson_id: ADMIN_ID,
      message_count: 3,
      moved_at: "2026-08-25T12:00:00.000Z",
    });
  });

  it("concurrent moves are deterministic and cannot split the thread", async () => {
    // Two admins race the same conversation. The first wins; the second finds
    // it already in that channel (409) — never a half-moved thread.
    const [first, second] = await Promise.all([
      move(ROOT, { to_channel: "product_help" }),
      move(NESTED, { to_channel: "product_help" }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    for (const id of [ROOT, REPLY, NESTED]) {
      expect(channelOf(id)).toBe("product_help");
    }
    expect(state.moveAudit).toHaveLength(1);
  });

  // ---- Everything else must be untouched ---------------------------------

  it("preserves author, body, timestamps, media and reply links", async () => {
    const before = state.messages
      .filter((m) => [ROOT, REPLY, NESTED].includes(m.id))
      .map((m) => ({ ...m }));
    await move(ROOT, { to_channel: "product_help" });
    for (const original of before) {
      const now = state.messages.find((m) => m.id === original.id);
      expect(now?.salesperson_id).toBe(original.salesperson_id);
      expect(now?.salesperson_name).toBe(original.salesperson_name);
      expect(now?.message).toBe(original.message);
      expect(now?.created_at).toBe(original.created_at);
      expect(now?.is_deleted).toBe(original.is_deleted);
      expect(now?.reply_to_message_id).toBe(original.reply_to_message_id);
      expect(now?.media_type).toBe(original.media_type);
      expect(now?.media_url).toBe(original.media_url);
      // The ONLY difference:
      expect(now?.channel).not.toBe(original.channel);
    }
  });

  it("sends no push notification", async () => {
    await move(ROOT, { to_channel: "product_help" });
    expect(fanOutJuiceBoxPush).not.toHaveBeenCalled();
  });

  it("does not change the COMBINED unread count", async () => {
    const readCount = async () => {
      const res = await get(getUnread, "/api/team-messages/unread", ADMIN_ID);
      return ((await res.json()) as { count: number }).count;
    };
    const before = await readCount();
    await move(ROOT, { to_channel: "product_help" });
    const after = await readCount();
    // The same messages exist; only their channel label changed. A move must
    // never make Juice Box look like it has new activity.
    expect(after).toBe(before);
  });

  it("does not mark anything read", async () => {
    await move(ROOT, { to_channel: "product_help" });
    expect(state.reads).toHaveLength(0);
    expect(state.legacyReads).toHaveLength(0);
  });

  it("makes the conversation appear in the destination feed, once", async () => {
    await move(ROOT, { to_channel: "product_help" });
    const dest = await get(
      getFeed,
      "/api/team-messages?channel=product_help",
      ADMIN_ID,
    );
    const destBody = (await dest.json()) as { messages: Array<{ id: string }> };
    const ids = destBody.messages.map((m) => m.id);
    expect(ids).toContain(ROOT);
    expect(ids).toContain(REPLY);
    expect(ids).toContain(NESTED);
    // No duplicates when the destination feed is fetched fresh.
    expect(new Set(ids).size).toBe(ids.length);
    // Ordering uses the ORIGINAL timestamps (oldest → newest).
    expect(ids.indexOf(ROOT)).toBeLessThan(ids.indexOf(REPLY));
    expect(ids.indexOf(REPLY)).toBeLessThan(ids.indexOf(NESTED));
  });

  it("removes the conversation from the source feed", async () => {
    await move(ROOT, { to_channel: "product_help" });
    const src = await get(
      getFeed,
      "/api/team-messages?channel=general",
      ADMIN_ID,
    );
    const srcBody = (await src.json()) as { messages: Array<{ id: string }> };
    const ids = srcBody.messages.map((m) => m.id);
    for (const gone of [ROOT, REPLY, NESTED]) expect(ids).not.toContain(gone);
    // Unrelated posts stay put.
    expect(ids).toContain(LONE);
  });

  it("search resolves the NEW channel afterwards", async () => {
    await move(ROOT, { to_channel: "product_help" });
    const res = await get(
      search,
      "/api/team-messages/search?q=duplex",
      ADMIN_ID,
    );
    const body = (await res.json()) as {
      messages: Array<{ id: string; channel: string }>;
    };
    const hit = body.messages.find((m) => m.id === ROOT);
    // This is what lets the search sheet switch tabs before scrolling to it.
    expect(hit?.channel).toBe("product_help");
  });

  it("the channel lookup resolves the NEW channel afterwards", async () => {
    await move(ROOT, { to_channel: "social_media_hub" });
    const res = await lookupChannel(
      new Request(`http://localhost/api/team-messages/${REPLY}/channel`, {
        headers: { Authorization: `Bearer ${token(ADMIN_ID)}` },
      }),
      { params: Promise.resolve({ id: REPLY }) },
    );
    expect(await res.json()).toEqual({
      id: REPLY,
      channel: "social_media_hub",
    });
  });

  it("a reply into the OLD channel is refused after the move", async () => {
    await move(ROOT, { to_channel: "product_help" });
    // Exactly what a stale open composer would send.
    const res = await post(postMessage, "/api/team-messages", {
      message: "late reply",
      reply_to_message_id: ROOT,
      channel: "general",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Product Help",
    );
    expect(state.inserts).toHaveLength(0);
  });

  it("a reply with no channel follows the conversation to its new home", async () => {
    await move(ROOT, { to_channel: "product_help" });
    const res = await post(postMessage, "/api/team-messages", {
      message: "on-topic reply",
      reply_to_message_id: ROOT,
    });
    expect(res.status).toBe(201);
    expect(state.inserts[0].payload.channel).toBe("product_help");
  });

  it("503s clearly when the migration has not been applied", async () => {
    state.preMigration = true;
    const res = await move(ROOT, { to_channel: "product_help" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /juice_box_channels\.sql/,
    );
  });
});

describe("a reply can never split a moved conversation (the Critical fix)", () => {
  const ROOT = "eeee1111-eeee-4eee-8eee-eeeeeeee1111";
  const REPLY = "eeee2222-eeee-4eee-8eee-eeeeeeee2222";
  const NESTED = "eeee3333-eeee-4eee-8eee-eeeeeeee3333";

  const move = (id: string, to: string) =>
    moveConversation(
      new Request(`http://localhost/api/team-messages/${id}/move`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token(ADMIN_ID)}`,
        },
        body: JSON.stringify({ to_channel: to }),
      }),
      { params: Promise.resolve({ id }) },
    );

  const channelsOfThread = () =>
    new Set(
      state.messages
        .filter((m) => [ROOT, REPLY, NESTED].includes(m.id))
        .map((m) => m.channel),
    );

  beforeEach(() => {
    state.messages.push(
      msg({ id: ROOT, channel: "general", message: "root" }),
      msg({
        id: REPLY,
        channel: "general",
        message: "reply",
        reply_to_message_id: ROOT,
      }),
    );
  });

  it("THE REVIEWED RACE: parent validated before the move, insert lands after", async () => {
    // The hook makes the route's parent lookup return the PRE-move row and then
    // applies the move — the precise interleaving from the review:
    //   1. reply request reads parent → general
    //   2. move locks, moves the thread, audits, COMMITS
    //   3. reply request INSERTs with its now-stale general
    // The route's own comparison cannot see step 2; only the insert-time check
    // in the database can, and it does.
    state.moveDuringReplyRead = { rootId: ROOT, toChannel: "product_help" };

    const res = await post(postMessage, "/api/team-messages", {
      message: "late reply",
      reply_to_message_id: ROOT,
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /moved to another channel/i,
    );
    // No partial message, and the thread is still whole.
    expect(state.inserts).toHaveLength(0);
    expect(state.messages.some((m) => m.message === "late reply")).toBe(false);
    expect(channelsOfThread()).toEqual(new Set(["product_help"]));
  });

  it("the same race on a DEEPLY NESTED parent is also refused", async () => {
    state.messages.push(
      msg({
        id: NESTED,
        channel: "general",
        message: "nested",
        reply_to_message_id: REPLY,
      }),
    );
    // Replying to the nested reply; the move happens between read and insert.
    state.moveDuringReplyRead = { rootId: ROOT, toChannel: "social_media_hub" };
    const res = await post(postMessage, "/api/team-messages", {
      message: "deep stale reply",
      reply_to_message_id: NESTED,
    });
    expect(res.status).toBe(409);
    expect(state.inserts).toHaveLength(0);
    expect(channelsOfThread()).toEqual(new Set(["social_media_hub"]));
  });

  it("an explicitly stale channel is refused even when nothing raced", async () => {
    // Belt and braces: the route's own guard catches the visible mismatch with
    // a 400 before the insert is attempted.
    await move(ROOT, "product_help");
    const res = await post(postMessage, "/api/team-messages", {
      message: "stale on purpose",
      reply_to_message_id: ROOT,
      channel: "general",
    });
    expect(res.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
    expect(channelsOfThread()).toEqual(new Set(["product_help"]));
  });

  it("a reply that names the CURRENT channel succeeds after the move", async () => {
    await move(ROOT, "product_help");
    const res = await post(postMessage, "/api/team-messages", {
      message: "on-topic",
      reply_to_message_id: REPLY,
      channel: "product_help",
    });
    expect(res.status).toBe(201);
    expect(state.inserts[0].payload.channel).toBe("product_help");
  });

  it("the OLD client's channel-less reply cannot split a moved thread", async () => {
    await move(ROOT, "product_help");
    // The current route derives the parent's channel, so a channel-less body is
    // simply correct…
    const res = await post(postMessage, "/api/team-messages", {
      message: "old client reply",
      reply_to_message_id: ROOT,
    });
    expect(res.status).toBe(201);
    expect(state.inserts[0].payload.channel).toBe("product_help");

    // …and the OLD bundle, which sends no channel at all and would land on the
    // column DEFAULT 'general', is refused by the trigger. (Modelled directly,
    // because the old bundle's request shape no longer exists in this code.)
    const legacyBuilder = getServerSupabaseForTest()
      .from("team_messages")
      .insert({
        channel: "general",
        salesperson_id: AE_ID,
        salesperson_name: "Carli",
        message: "old bundle reply",
        reply_to_message_id: ROOT,
      }) as unknown as {
      single: () => Promise<{ error: { code?: string } | null }>;
    };
    const legacyInsert = await legacyBuilder.single();
    expect(legacyInsert.error?.code).toBe("JB010");
    expect(channelsOfThread()).toEqual(new Set(["product_help"]));
  });

  it("a reply that commits BEFORE the move is included in it", async () => {
    // The other ordering: the reply wins the lock, so the move waits and then
    // collects a tree that contains it.
    const reply = await post(postMessage, "/api/team-messages", {
      message: "in time",
      reply_to_message_id: ROOT,
      channel: "general",
    });
    expect(reply.status).toBe(201);

    const moved = await move(ROOT, "product_help");
    const body = (await moved.json()) as { message_count: number };
    // root + original reply + the new one.
    expect(body.message_count).toBe(3);
    // Nothing left in the source channel.
    expect(
      state.messages.filter(
        (m) => m.channel === "general" && m.message !== "unrelated",
      ),
    ).toHaveLength(0);
  });

  it("BOTH orderings end with one channel for the whole thread", async () => {
    // Ordering A — reply first, then the move: the move includes the reply.
    await post(postMessage, "/api/team-messages", {
      message: "reply first",
      reply_to_message_id: ROOT,
    });
    const movedAfter = await move(ROOT, "product_help");
    expect(movedAfter.status).toBe(200);
    expect(channelsOfThread().size).toBe(1);
    for (const insert of state.inserts) {
      // The inserted reply moved with the thread.
      const row = state.messages.find(
        (m) => m.message === insert.payload.message,
      );
      expect(row?.channel).toBe("product_help");
    }

    // Ordering B — move first, then a stale reply: the reply is refused.
    state.moveDuringReplyRead = {
      rootId: ROOT,
      toChannel: "social_media_hub",
    };
    const stale = await post(postMessage, "/api/team-messages", {
      message: "reply second",
      reply_to_message_id: ROOT,
    });
    expect(stale.status).toBe(409);
    expect(channelsOfThread().size).toBe(1);
    expect(state.messages.some((m) => m.message === "reply second")).toBe(false);

    // TRUE concurrency (two transactions blocking on a row lock) cannot be
    // proven here — see the two-session test in the migration header.
  });

  it("a failed stale reply leaves no message and no audit side effect", async () => {
    state.moveDuringReplyRead = { rootId: ROOT, toChannel: "product_help" };
    const auditBefore = state.moveAudit.length;
    const res = await post(postMessage, "/api/team-messages", {
      message: "doomed",
      reply_to_message_id: ROOT,
    });
    expect(res.status).toBe(409);
    expect(state.inserts).toHaveLength(0);
    expect(state.messages.some((m) => m.message === "doomed")).toBe(false);
    expect(state.moveAudit).toHaveLength(auditBefore);
    expect(fanOutJuiceBoxPush).not.toHaveBeenCalled();
  });

  it("400s a reply whose parent has vanished (JB011)", async () => {
    const res = await post(postMessage, "/api/team-messages", {
      message: "orphan",
      reply_to_message_id: "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd",
      channel: "general",
    });
    // The route's own parent lookup catches this first; either way it is a 400
    // and nothing is written.
    expect(res.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });

  it("normal replies in an unmoved conversation still work", async () => {
    const res = await post(postMessage, "/api/team-messages", {
      message: "ordinary reply",
      reply_to_message_id: ROOT,
    });
    expect(res.status).toBe(201);
    expect(state.inserts[0].payload.channel).toBe("general");
    expect(state.inserts[0].payload.reply_to_message_id).toBe(ROOT);
  });
});
