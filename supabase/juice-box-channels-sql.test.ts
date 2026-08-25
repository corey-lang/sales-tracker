/**
 * Guard tests for supabase/juice_box_channels.sql.
 *
 * This migration's whole value is what it does NOT do: it must not touch the
 * legacy `team_message_reads` table, because the currently deployed bundle
 * still upserts read markers there with `onConflict: "salesperson_id"`. An
 * earlier draft moved that unique key and created a rollout with no safe
 * order — these assertions stop that from coming back.
 *
 * The file is applied by hand in the Supabase SQL editor (see
 * supabase/README.md) and there is no local database in this repo, so this
 * static check is the only automated gate it has. It verifies the SHAPE of the
 * statements — idempotency markers, ON CONFLICT DO NOTHING, absence of
 * destructive verbs, and the monotonic mark-read contract — not their runtime
 * effect. Behavioural coverage of the RPC contract (reversed arrival, GREATEST,
 * failure isolation) lives in src/app/api/team-messages/channels.test.ts
 * against a fake that reproduces these statements; the migration header carries
 * a copy-paste check to prove monotonicity against a real database.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** Statements only, with `--` comment lines stripped. */
function statements(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const SQL = statements(
  readFileSync(join(here, "juice_box_channels.sql"), "utf8"),
);

describe("team_messages.channel is additive and backward-compatible", () => {
  it("adds a NOT NULL column defaulting to General", () => {
    // The DEFAULT is what makes the old app — which never sends a channel —
    // keep posting into the feed the team already sees, and what backfills
    // every historical row without a table rewrite.
    expect(SQL).toMatch(
      /ALTER TABLE team_messages\s+ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'general'/i,
    );
  });

  it("constrains the channel to the three known ids", () => {
    expect(SQL).toMatch(
      /ADD CONSTRAINT team_messages_channel_allowed\s+CHECK \(channel IN \('general', 'product_help', 'social_media_hub'\)\)/i,
    );
  });

  it("adds the per-channel feed index without dropping the existing one", () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_team_messages_live_channel_created_at/i,
    );
    // The old index still serves cross-channel search and the old bundle's
    // channel-less feed query.
    expect(SQL).not.toMatch(/DROP INDEX[^;]*idx_team_messages_live_created_at/i);
  });

  it("does not rewrite or delete any message row", () => {
    expect(SQL).not.toMatch(/UPDATE\s+team_messages\b/i);
    expect(SQL).not.toMatch(/DELETE\s+FROM\s+team_messages\b/i);
    expect(SQL).not.toMatch(/DROP\s+TABLE/i);
    expect(SQL).not.toMatch(/TRUNCATE/i);
  });
});

describe("the legacy team_message_reads table is left completely alone", () => {
  it("never ALTERs it", () => {
    // Adding a column, moving its key, or changing its constraints would break
    // the deployed bundle's mark-read.
    expect(SQL).not.toMatch(/ALTER TABLE\s+team_message_reads\b/i);
  });

  it("keeps its single-column unique index", () => {
    expect(SQL).not.toMatch(/DROP INDEX[^;]*uq_team_message_reads_salesperson/i);
  });

  it("never writes to it — the backfill only reads", () => {
    expect(SQL).not.toMatch(/UPDATE\s+team_message_reads\b/i);
    expect(SQL).not.toMatch(/DELETE\s+FROM\s+team_message_reads\b/i);
    expect(SQL).not.toMatch(/INSERT INTO team_message_reads\b/i);
    // It appears exactly once as a SELECT source (plus the to_regclass guard).
    expect(SQL).toMatch(/FROM team_message_reads/i);
  });

  it("does not drop it (retirement is a separate future migration)", () => {
    expect(SQL).not.toMatch(/DROP\s+TABLE[^;]*team_message_reads/i);
  });
});

describe("team_message_channel_reads is created with the right posture", () => {
  it("is keyed by (salesperson_id, channel)", () => {
    expect(SQL).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_team_message_channel_reads_person_channel\s+ON team_message_channel_reads\(salesperson_id, channel\)/i,
    );
  });

  it("constrains the channel to the three known ids", () => {
    expect(SQL).toMatch(
      /ADD CONSTRAINT team_message_channel_reads_channel_allowed\s+CHECK \(channel IN \('general', 'product_help', 'social_media_hub'\)\)/i,
    );
  });

  it("matches the legacy table's security posture: RLS on, no policy", () => {
    expect(SQL).toMatch(
      /ALTER TABLE team_message_channel_reads ENABLE ROW LEVEL SECURITY/i,
    );
    expect(SQL).not.toMatch(/CREATE POLICY/i);
    // No TABLE-level grants: access is service-role-only, exactly like the
    // legacy table. (The file does GRANT EXECUTE on the mark-read functions —
    // that is asserted separately, and is a function grant, not a table one.)
    expect(SQL).not.toMatch(/GRANT[^;]*\bON\s+(TABLE\s+)?team_message/i);
  });

  it("is NOT published to realtime (read state is private)", () => {
    expect(SQL).not.toMatch(/ADD TABLE team_message_channel_reads/i);
    expect(SQL).not.toMatch(/supabase_realtime/i);
  });

  it("maintains updated_at with the project's per-table trigger pattern", () => {
    expect(SQL).toMatch(
      /CREATE OR REPLACE FUNCTION set_team_message_channel_reads_updated_at/i,
    );
    expect(SQL).toMatch(
      /DROP TRIGGER IF EXISTS trg_team_message_channel_reads_updated_at/i,
    );
    expect(SQL).toMatch(
      /CREATE TRIGGER trg_team_message_channel_reads_updated_at\s+BEFORE UPDATE ON team_message_channel_reads/i,
    );
  });
});

describe("the backfill is idempotent and non-destructive", () => {
  it("copies every legacy marker in as that person's General marker", () => {
    expect(SQL).toMatch(
      /INSERT INTO team_message_channel_reads \([\s\S]*?\)\s*SELECT salesperson_id, 'general', last_read_at, updated_at\s+FROM team_message_reads/i,
    );
  });

  it("uses ON CONFLICT DO NOTHING so a re-run cannot duplicate or rewind", () => {
    // DO NOTHING (not DO UPDATE) is the important half: re-running after the
    // channel-aware app has advanced a General marker must not reset it to the
    // older legacy value.
    //
    // Scoped to the BACKFILL statement — the mark-read RPCs legitimately use
    // ON CONFLICT DO UPDATE (with GREATEST), so a file-wide assertion would be
    // wrong.
    const backfill = SQL.slice(
      SQL.search(/INSERT INTO team_message_channel_reads \(/i),
    ).split(";")[0];
    expect(backfill).toMatch(/FROM team_message_reads/i);
    expect(backfill).toMatch(/ON CONFLICT \(salesperson_id, channel\) DO NOTHING/i);
    expect(backfill).not.toMatch(/DO UPDATE/i);
  });

  it("guards on the legacy table still existing, so it survives retirement", () => {
    expect(SQL).toMatch(/to_regclass\('public\.team_message_reads'\)/i);
  });
});

describe("every statement is re-runnable", () => {
  it("uses IF NOT EXISTS / OR REPLACE / DROP-then-ADD throughout", () => {
    const requiredIdempotentForms = [
      /ADD COLUMN IF NOT EXISTS/i,
      /CREATE TABLE IF NOT EXISTS team_message_channel_reads/i,
      /CREATE INDEX IF NOT EXISTS/i,
      /CREATE UNIQUE INDEX IF NOT EXISTS/i,
      /CREATE OR REPLACE FUNCTION/i,
      /DROP TRIGGER IF EXISTS/i,
      /DROP CONSTRAINT IF EXISTS/i,
    ];
    for (const form of requiredIdempotentForms) {
      expect(SQL).toMatch(form);
    }
  });

  it("contains no bare CREATE TABLE / CREATE INDEX that would fail twice", () => {
    const bareCreateTable = /CREATE TABLE (?!IF NOT EXISTS)/i.test(SQL);
    const bareCreateIndex = /CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/i.test(
      SQL,
    );
    expect(bareCreateTable).toBe(false);
    expect(bareCreateIndex).toBe(false);
  });
});

describe("mark-read RPCs are atomic and monotonic", () => {
  const CHANNEL_FN = "juice_box_mark_channel_read";
  const LEGACY_FN = "juice_box_mark_legacy_read";

  it("defines both functions with CREATE OR REPLACE (re-runnable)", () => {
    expect(SQL).toMatch(
      new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${CHANNEL_FN}\\(`,
        "i",
      ),
    );
    expect(SQL).toMatch(
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.${LEGACY_FN}\\(`, "i"),
    );
  });

  it("applies GREATEST(existing, incoming) in an ON CONFLICT DO UPDATE", () => {
    // The single-statement rule is the fix: no read-then-write, no JS compare.
    const monotonicUpdate =
      /ON CONFLICT \([^)]*\) DO UPDATE\s+SET last_read_at = GREATEST\(t\.last_read_at, EXCLUDED\.last_read_at\)/gi;
    const matches = SQL.match(monotonicUpdate) ?? [];
    // One for the channel table, one for the legacy table.
    expect(matches).toHaveLength(2);
  });

  it("never writes last_read_at unconditionally", () => {
    // This is exactly the statement that caused the backwards-moving marker.
    expect(SQL).not.toMatch(/SET last_read_at = EXCLUDED\.last_read_at/i);
  });

  it("generates the timestamp inside Postgres, not from a parameter", () => {
    // No caller-supplied timestamp argument exists to be stale…
    expect(SQL).not.toMatch(/p_last_read_at/i);
    // …the inserted value is the database's own now().
    expect(SQL).toMatch(
      /VALUES \(p_salesperson_id, p_channel, now\(\), now\(\)\)/i,
    );
    expect(SQL).toMatch(/VALUES \(p_salesperson_id, now\(\), now\(\)\)/i);
  });

  it("returns the PERSISTED timestamp so the API can answer with it", () => {
    const returning = SQL.match(/RETURNING t\.last_read_at INTO v_persisted/gi) ?? [];
    expect(returning).toHaveLength(2);
    expect(SQL).toMatch(/RETURNS TIMESTAMPTZ/i);
  });

  it("validates the channel inside the function", () => {
    expect(SQL).toMatch(
      /p_channel NOT IN \('general', 'product_help', 'social_media_hub'\)/i,
    );
    expect(SQL).toMatch(/RAISE EXCEPTION[\s\S]{0,80}unknown channel/i);
  });

  it("requires a salesperson id (server-controlled value)", () => {
    const guards = SQL.match(/p_salesperson_id IS NULL OR btrim\(p_salesperson_id\) = ''/gi) ?? [];
    expect(guards).toHaveLength(2);
  });
});

/** RPCs the server routes call. Each needs an explicit service_role grant. */
const RPCS = [
  "juice_box_mark_channel_read",
  "juice_box_mark_legacy_read",
  "juice_box_move_conversation",
];

/** Trigger functions. Reachable ONLY through their triggers (calling one
 *  directly errors with "can only be called as a trigger"), so they carry no
 *  grants of their own — but they must still be INVOKER + search_path-pinned. */
const TRIGGER_FUNCTIONS = [
  "juice_box_enforce_reply_channel",
  "juice_box_forbid_reply_pointer_change",
  "juice_box_assert_conversation_single_channel",
];

const ALL_FUNCTIONS = [...RPCS, ...TRIGGER_FUNCTIONS];

describe("RPC privileges and security (all functions in this migration)", () => {
  it("defines exactly the expected set of functions", () => {
    const defined = (
      SQL.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/gi) ?? []
    ).map((m) => m.replace(/.*public\./i, ""));
    // set_… updated_at trigger functions are declared unqualified, so this list
    // is the schema-qualified surface: server RPCs + thread-integrity triggers.
    expect(defined.sort()).toEqual([...ALL_FUNCTIONS].sort());
  });

  it("is SECURITY INVOKER, never SECURITY DEFINER", () => {
    // DEFINER would let a lower-privileged role act on ANY salesperson's data.
    const invoker = SQL.match(/SECURITY INVOKER/gi) ?? [];
    expect(invoker).toHaveLength(ALL_FUNCTIONS.length);
    expect(SQL).not.toMatch(/SECURITY DEFINER/i);
  });

  it("pins search_path on every function", () => {
    const pinned = SQL.match(/SET search_path = pg_catalog, public/gi) ?? [];
    expect(pinned).toHaveLength(ALL_FUNCTIONS.length);
  });

  it("revokes the default PUBLIC execute grant and the anon roles", () => {
    for (const fn of RPCS) {
      for (const role of ["PUBLIC", "anon", "authenticated"]) {
        expect(SQL).toMatch(
          new RegExp(
            `REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*FROM ${role}`,
            "i",
          ),
        );
      }
    }
  });

  it("grants EXECUTE to service_role only", () => {
    const grants = SQL.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/gi) ?? [];
    expect(grants).toHaveLength(RPCS.length);
    expect(SQL).not.toMatch(/GRANT EXECUTE[\s\S]{0,160}TO (anon|authenticated|PUBLIC)/i);
  });

  it("schema-qualifies the tables it writes", () => {
    expect(SQL).toMatch(/INSERT INTO public\.team_message_channel_reads AS t/i);
    expect(SQL).toMatch(/INSERT INTO public\.team_message_reads AS t/i);
    expect(SQL).toMatch(/UPDATE public\.team_messages/i);
    expect(SQL).toMatch(/INSERT INTO public\.juice_box_conversation_moves/i);
  });
});

describe("move-conversation RPC moves the WHOLE thread, atomically", () => {
  it("resolves the root by walking UP from the clicked message", () => {
    // A bounded upward walk, so moving from a reply moves the conversation.
    expect(SQL).toMatch(/WHILE v_next_id IS NOT NULL AND v_depth < 100 LOOP/i);
  });

  it("collects descendants with a recursive CTE (nested replies included)", () => {
    const recursive = SQL.match(/WITH RECURSIVE thread AS/gi) ?? [];
    // Twice in the move RPC (collect, then re-verify after the UPDATE) and once
    // in the deferred whole-conversation check.
    expect(recursive).toHaveLength(3);
    expect(SQL).toMatch(/JOIN thread t ON m\.reply_to_message_id = t\.id/i);
    // UNION (not UNION ALL) terminates even on a cyclic reply graph.
    expect(SQL).not.toMatch(/UNION ALL\s+SELECT m\.id/i);
  });

  it("locks the root and then the whole tree in a deterministic order", () => {
    expect(SQL).toMatch(
      /PERFORM 1 FROM public\.team_messages WHERE id = v_root_id FOR UPDATE/i,
    );
    expect(SQL).toMatch(/WHERE id = ANY\(v_ids\)\s+ORDER BY id\s+FOR UPDATE/i);
  });

  it("verifies one shared source channel before moving", () => {
    expect(SQL).toMatch(/count\(DISTINCT channel\)/i);
    expect(SQL).toMatch(/IF v_distinct > 1 THEN/i);
    expect(SQL).toMatch(/ERRCODE = 'JB002'/);
  });

  it("refuses a move into the channel the thread is already in", () => {
    expect(SQL).toMatch(/IF v_from_channel = p_to_channel THEN/i);
    expect(SQL).toMatch(/ERRCODE = 'JB001'/);
  });

  it("changes ONLY the channel column", () => {
    expect(SQL).toMatch(
      /UPDATE public\.team_messages\s+SET channel = p_to_channel\s+WHERE id = ANY\(v_ids\)/i,
    );
    // Author, body, timestamps, reply pointers, media and is_deleted untouched.
    for (const column of [
      "salesperson_id",
      "salesperson_name",
      "created_at",
      "message",
      "is_deleted",
      "reply_to_message_id",
      "media_url",
    ]) {
      expect(SQL).not.toMatch(new RegExp(`SET ${column} =`, "i"));
    }
  });

  it("never inserts or deletes a message (no duplicates, no new push)", () => {
    expect(SQL).not.toMatch(/INSERT INTO public\.team_messages/i);
    expect(SQL).not.toMatch(/DELETE\s+FROM\s+public\.team_messages/i);
  });

  it("re-checks for stragglers after the UPDATE and rolls back", () => {
    expect(SQL).toMatch(/SELECT 1 FROM thread WHERE channel <> p_to_channel/i);
    expect(SQL).toMatch(/ERRCODE = 'JB003'/);
  });

  it("404s a missing or soft-deleted target", () => {
    expect(SQL).toMatch(/IF NOT FOUND OR v_is_deleted THEN/i);
    expect(SQL).toMatch(/ERRCODE = 'P0002'/);
  });

  it("validates the destination channel and the acting administrator", () => {
    expect(SQL).toMatch(/ERRCODE = 'JB004'/);
    expect(SQL).toMatch(/ERRCODE = 'JB005'/);
  });

  it("returns the authoritative root, channels, count and timestamp", () => {
    expect(SQL).toMatch(/RETURN jsonb_build_object\(/i);
    for (const key of [
      "root_message_id",
      "from_channel",
      "to_channel",
      "message_count",
      "moved_at",
    ]) {
      expect(SQL).toMatch(new RegExp(`'${key}'`));
    }
  });
});

describe("move audit table", () => {
  it("records everything an admin review needs", () => {
    expect(SQL).toMatch(
      /CREATE TABLE IF NOT EXISTS juice_box_conversation_moves/i,
    );
    for (const column of [
      "root_message_id UUID NOT NULL",
      "from_channel TEXT NOT NULL",
      "to_channel TEXT NOT NULL",
      "moved_by_salesperson_id TEXT NOT NULL",
      "message_count INTEGER NOT NULL",
      "moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)",
    ]) {
      expect(SQL).toMatch(new RegExp(column, "i"));
    }
  });

  it("constrains both channels and forbids a no-op move", () => {
    expect(SQL).toMatch(/juice_box_conversation_moves_channels_allowed/i);
    expect(SQL).toMatch(/from_channel <> to_channel/i);
    expect(SQL).toMatch(/message_count > 0/i);
  });

  it("is server-only: RLS on, no policy, not in realtime", () => {
    expect(SQL).toMatch(
      /ALTER TABLE juice_box_conversation_moves ENABLE ROW LEVEL SECURITY/i,
    );
    expect(SQL).not.toMatch(/ADD TABLE juice_box_conversation_moves/i);
  });

  it("is indexed for per-conversation and recent lookups", () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_juice_box_conversation_moves_root/i,
    );
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_juice_box_conversation_moves_recent/i,
    );
  });

  it("writes the audit row inside the same function as the move", () => {
    // Same plpgsql body = same transaction: no move without a record, and no
    // record without a move.
    const fnStart = SQL.search(/CREATE OR REPLACE FUNCTION public\.juice_box_move_conversation/i);
    const fnBody = SQL.slice(fnStart);
    const auditAt = fnBody.search(/INSERT INTO public\.juice_box_conversation_moves/i);
    const updateAt = fnBody.search(/UPDATE public\.team_messages/i);
    expect(auditAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(-1);
    expect(auditAt).toBeGreaterThan(updateAt); // audit after the move, same body
  });
});

describe("reply creation is serialized against a move (the Critical fix)", () => {
  it("fires a BEFORE INSERT trigger on every reply", () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER trg_team_messages_reply_channel\s+BEFORE INSERT ON team_messages\s+FOR EACH ROW\s+WHEN \(NEW\.reply_to_message_id IS NOT NULL\)/i,
    );
    expect(SQL).toMatch(
      /EXECUTE FUNCTION public\.juice_box_enforce_reply_channel\(\)/i,
    );
  });

  it("locks the ROOT with FOR UPDATE — the mode that actually conflicts", () => {
    // FOR KEY SHARE would NOT conflict with the bare non-key `SET channel`
    // UPDATE (which takes FOR NO KEY UPDATE), so the race would survive.
    // FOR UPDATE conflicts with both that and the move's explicit FOR UPDATE.
    const fn = SQL.slice(
      SQL.search(/CREATE OR REPLACE FUNCTION public\.juice_box_enforce_reply_channel/i),
    ).split("$fn$;")[0];
    expect(fn).toMatch(
      /SELECT channel INTO v_root_channel\s+FROM public\.team_messages\s+WHERE id = v_root_id\s+FOR UPDATE/i,
    );
    expect(fn).not.toMatch(/FOR KEY SHARE/i);
    expect(fn).not.toMatch(/FOR SHARE/i);
  });

  it("reads the authoritative channel FROM the locked row, not before it", () => {
    const fn = SQL.slice(
      SQL.search(/CREATE OR REPLACE FUNCTION public\.juice_box_enforce_reply_channel/i),
    ).split("$fn$;")[0];
    // The comparison must come after the locking read — otherwise it is just
    // another race-prone read-then-write.
    const lockAt = fn.search(/FOR UPDATE/i);
    const compareAt = fn.search(/NEW\.channel IS DISTINCT FROM v_root_channel/i);
    expect(lockAt).toBeGreaterThan(-1);
    expect(compareAt).toBeGreaterThan(lockAt);
  });

  it("rejects the stale reply with JB010 (BEFORE INSERT → no partial row)", () => {
    expect(SQL).toMatch(/ERRCODE = 'JB010'/);
  });

  it("resolves the root by walking up, with a cycle guard", () => {
    expect(SQL).toMatch(/v_root_id := NEW\.reply_to_message_id/i);
    expect(SQL).toMatch(/ERRCODE = 'JB011'/);
  });

  it("the move still takes the root lock BEFORE collecting the tree", () => {
    // This ordering is what makes the move see a reply that committed while it
    // was waiting: the recursive CTE runs on a post-wait snapshot.
    const fn = SQL.slice(
      SQL.search(/CREATE OR REPLACE FUNCTION public\.juice_box_move_conversation/i),
    );
    const rootLockAt = fn.search(
      /PERFORM 1 FROM public\.team_messages WHERE id = v_root_id FOR UPDATE/i,
    );
    const cteAt = fn.search(/WITH RECURSIVE thread AS/i);
    expect(rootLockAt).toBeGreaterThan(-1);
    expect(cteAt).toBeGreaterThan(rootLockAt);
  });

  it("makes reply_to_message_id immutable", () => {
    expect(SQL).toMatch(
      /CREATE TRIGGER trg_team_messages_reply_pointer_immutable\s+BEFORE UPDATE ON team_messages/i,
    );
    expect(SQL).toMatch(/ERRCODE = 'JB012'/);
  });

  it("re-asserts WHOLE-CONVERSATION channel agreement at COMMIT, deferred", () => {
    // Deferred is what keeps the multi-row move — whose row order is
    // unspecified — from failing its own consistency check mid-statement.
    expect(SQL).toMatch(
      /CREATE CONSTRAINT TRIGGER trg_team_messages_conversation_channel_settled\s+AFTER UPDATE ON team_messages\s+DEFERRABLE INITIALLY DEFERRED/i,
    );
    expect(SQL).toMatch(/ERRCODE = 'JB013'/);
  });

  it("fires that check for ROOTS too, closing the root-only raw-update gap", () => {
    // The earlier version was `NEW.reply_to_message_id IS NOT NULL AND …`,
    // which never fired for a root — so raw SQL could move a root and strand
    // its replies. The condition is now channel-change alone.
    expect(SQL).toMatch(
      /WHEN \(NEW\.channel IS DISTINCT FROM OLD\.channel\)\s+EXECUTE FUNCTION public\.juice_box_assert_conversation_single_channel/i,
    );
    expect(SQL).not.toMatch(
      /WHEN \(\s*NEW\.reply_to_message_id IS NOT NULL\s+AND NEW\.channel IS DISTINCT FROM OLD\.channel\s*\)/i,
    );
  });

  it("asserts ONE channel across the root and every descendant", () => {
    const fn = SQL.slice(
      SQL.search(
        /CREATE OR REPLACE FUNCTION public\.juice_box_assert_conversation_single_channel/i,
      ),
    ).split("$fn$;")[0];
    // Resolves the root (a root is its own conversation) and counts channels
    // across the whole tree — not just a pairwise reply/root comparison.
    expect(fn).toMatch(/v_root_id := NEW\.id/i);
    expect(fn).toMatch(/count\(DISTINCT channel\) INTO v_distinct/i);
    expect(fn).toMatch(/IF v_distinct > 1 THEN/i);
    expect(fn).toMatch(/ERRCODE = 'JB013'/);
    // A cyclic chain fails safely with the existing code rather than looping.
    expect(fn).toMatch(/ERRCODE = 'JB011'/);
  });

  it("supersedes the replies-only trigger cleanly on a re-run", () => {
    expect(SQL).toMatch(
      /DROP TRIGGER IF EXISTS trg_team_messages_reply_channel_settled ON team_messages/i,
    );
    expect(SQL).toMatch(
      /DROP FUNCTION IF EXISTS public\.juice_box_assert_reply_channel_matches_root\(\)/i,
    );
  });

  it("documents the root-only raw-update verification on a branch", () => {
    const raw = readFileSync(join(here, "juice_box_channels.sql"), "utf8");
    expect(raw).toMatch(/THE LOW FINDING: raw update of the ROOT only/i);
    expect(raw).toMatch(/A ROOT-ONLY CONVERSATION \(no replies\) may still be updated/i);
    expect(raw).toMatch(/TWO CONVERSATIONS IN ONE TRANSACTION are judged independently/i);
  });

  it("documents the two-session concurrency test for a disposable branch", () => {
    const raw = readFileSync(join(here, "juice_box_channels.sql"), "utf8");
    expect(raw).toMatch(/TWO-SESSION CONCURRENCY TEST/i);
    expect(raw).toMatch(/CASE 1: reply wins the lock/i);
    expect(raw).toMatch(/CASE 2: move wins the lock/i);
    expect(raw).toMatch(/40P01/); // the deadlock code the loop test watches for
  });
});
